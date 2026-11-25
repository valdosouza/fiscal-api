// fiscal-api:DEPLOY.E3.P1 — a ROTAÇÃO da chave-mestra e a prova do health (D-F16, D-F243) no MOTOR real do banco. Suíte AO VIVO: só roda
// com FISCAL_ENGINE_LIVE=1 (o `npm test` e o pack-release a pulam); mesma credencial do DONO da `motor-banco.live.test.ts`
// (DB_HOST/DB_PORT/DB_USER/DB_PASSWORD do ambiente ou do arquivo em FISCAL_ENGINE_ENV_FILE).
//
// Banco DESCARTÁVEL `fiscal_eng_<hex>_rot` com as migrations do núcleo, apagado no fim. Nunca `setes_*`. Chaves-mestras de TESTE geradas
// aqui (nunca a do servidor). O que o falso da suíte comum não mostra e esta prova: o FOR UPDATE real, a gravação real dos VARBINARY
// (cifra, IV, tag) e da versão, a rotação esperando (sem deadlock) um leitor que segura o A1 em modo COMPARTILHADO como o `openIssuer`,
// e a amostra por versão (ROW_NUMBER) do `verifyStoredKeys` no motor.
import fs from 'fs'
import crypto from 'crypto'
import mysql, { Connection, Pool } from 'mysql2/promise'
import { runMigrations, CORE_MIGRATIONS_DIR, CORE_MIGRATIONS_PROJECT } from '../db/migrations'
import { createFiscalPool, FiscalDbConfig } from '../db/pool'
import { MasterKeyRing } from '../secret/cipher'
import { rotateCertificateKeys, verifyStoredKeys, storedKeyVersions, certificateAad } from '../establishment/establishment'
import { getCertificate } from '../establishment/establishment.repository'
import { rotateStoredKeys, storedSecretsOutsideKeyVersion } from '../secret/sealed-stores'
import { openSmtpCredential, storeSmtpCredential } from '../smtp-credential/smtp-credential'

const LIVE = process.env.FISCAL_ENGINE_LIVE === '1'
const d = LIVE ? describe : describe.skip

function readEnvFile(file: string | undefined): Record<string, string> {
  if (!file) return {}
  const out: Record<string, string> = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}
const fileEnv = readEnvFile(process.env.FISCAL_ENGINE_ENV_FILE)
const env = (k: string): string | undefined => process.env[k] ?? fileEnv[k]

const DB = `fiscal_eng_${crypto.randomBytes(4).toString('hex')}_rot`
const owner = { host: env('DB_HOST') ?? 'localhost', port: Number(env('DB_PORT') ?? 3306), user: env('DB_USER') ?? '', password: env('DB_PASSWORD') ?? '' }

const K1 = crypto.randomBytes(32)
const K2 = crypto.randomBytes(32)
const OLD = MasterKeyRing.of({ 1: K1 })
const BOTH = MasterKeyRing.of({ 1: K1, 2: K2 })
const NEW_ONLY = MasterKeyRing.of({ 2: K2 })
const pemOf = (id: number) => `-----BEGIN PRIVATE KEY-----\nchave-de-teste-${id}-${'x'.repeat(1600)}\n-----END PRIVATE KEY-----\n`

const report: Record<string, unknown> = {}

d('DEPLOY.E3.P1 — rotação da chave-mestra e prova do health no motor real', () => {
  let root: Connection
  let pool: Pool

  async function seed(id: number, ring: MasterKeyRing) {
    const s = ring.seal(pemOf(id), certificateAad(id))
    await root.query(
      `INSERT INTO \`${DB}\`.tb_establishment_certificate
         (tb_institution_id, cnpj, certificate_pem, private_key_cipher, private_key_iv, private_key_tag, cipher_key_version, subject,
          created_at, updated_at, deleted)
       VALUES (?, '12345678000195', ?, ?, ?, ?, ?, ?, NOW(), '2026-01-01 00:00:00', 'N')`,
      [id, `CERT-${id}`, s.cipher, s.iv, s.tag, s.version, `CN=${id}`])
  }

  beforeAll(async () => {
    if (!owner.user) throw new Error('FISCAL_ENGINE_LIVE=1 sem DB_USER do dono (ambiente ou FISCAL_ENGINE_ENV_FILE)')
    root = await mysql.createConnection({ ...owner, timezone: 'Z' })
    const [who] = await root.query<any[]>('SELECT VERSION() AS v')
    report.version = who[0].v
    const cfg: FiscalDbConfig = { ...owner, database: DB, connectionLimit: 6 }
    await runMigrations(cfg, [{ project: CORE_MIGRATIONS_PROJECT, dir: CORE_MIGRATIONS_DIR }])
    pool = createFiscalPool(cfg)
  })

  afterAll(async () => {
    await pool?.end().catch(() => undefined)
    if (root) {
      await root.query(`DROP DATABASE IF EXISTS \`${DB}\``).catch(() => undefined)
      await root.end()
    }
    // eslint-disable-next-line no-console
    console.log(`Relatório da rotação no motor (DEPLOY.E3.P1): ${JSON.stringify(report, null, 2)}`)
  })

  it('T2: reabre com a antiga, regrava com a nova; o anel SÓ com a nova abre tudo; certificado e updated_at intocados', async () => {
    for (const id of [101, 102, 103]) await seed(id, OLD)
    await seed(104, NEW_ONLY)
    const before = await getCertificate(pool, 101)

    const rep = await rotateCertificateKeys({ pool, keyring: BOTH })

    expect(rep).toEqual({ currentVersion: 2, failed: [], skipped: [],
      rewrapped: [{ institutionId: 101, from: 1 }, { institutionId: 102, from: 1 }, { institutionId: 103, from: 1 }] })
    for (const id of [101, 102, 103, 104]) {
      const row = await getCertificate(pool, id)
      expect(row!.sealedKey!.version).toBe(2)
      expect(NEW_ONLY.open(row!.sealedKey!, certificateAad(id)).toString('utf8')).toBe(pemOf(id))
    }
    const after = await getCertificate(pool, 101)
    expect(after!.certificatePem).toBe(before!.certificatePem)
    expect(after!.sealedKey!.iv.equals(before!.sealedKey!.iv)).toBe(false)
    const [u] = await root.query<any[]>(`SELECT DATE_FORMAT(updated_at, '%Y-%m-%d') AS u FROM \`${DB}\`.tb_establishment_certificate WHERE tb_institution_id = 101`)
    expect(u[0].u).toBe('2026-01-01')
    expect(await storedKeyVersions(pool)).toEqual([2])
    expect(await rotateCertificateKeys({ pool, keyring: BOTH })).toEqual({ currentVersion: 2, rewrapped: [], failed: [], skipped: [] })
    report.rotated = rep.rewrapped.length
  })

  it('T2: com um leitor segurando o A1 em modo COMPARTILHADO (como o openIssuer), a rotação ESPERA e conclui depois — sem deadlock', async () => {
    await seed(201, OLD)
    const reader = await mysql.createConnection({ ...owner, database: DB, timezone: 'Z' })
    try {
      await reader.query('START TRANSACTION')
      await reader.query(`SELECT cipher_key_version FROM tb_establishment_certificate WHERE tb_institution_id = 201 LOCK IN SHARE MODE`)
      const t0 = Date.now()
      const running = rotateCertificateKeys({ pool, keyring: BOTH })
      await new Promise(r => setTimeout(r, 1500))
      await reader.query('COMMIT')
      const rep = await running
      const waited = Date.now() - t0
      expect(rep.rewrapped).toEqual([{ institutionId: 201, from: 1 }])
      expect(waited).toBeGreaterThanOrEqual(1400)                     // esperou de verdade a trava S (FOR UPDATE real)
      report.waitedForShareLockMs = waited
    } finally {
      await reader.end()
    }
  })

  it('D-F243: a amostra por versão (ROW_NUMBER) no motor — chave certa ok; chave errada não; uma linha ilegível = degradado', async () => {
    expect(await verifyStoredKeys({ pool, keyring: NEW_ONLY })).toMatchObject({ ok: true, degraded: false, versions: [{ version: 2, ok: true }] })
    expect(await verifyStoredKeys({ pool, keyring: MasterKeyRing.of({ 2: crypto.randomBytes(32) }) }))
      .toMatchObject({ ok: false, versions: [{ version: 2, ok: false, code: 'FISCAL_CERT_INVALID', unreadable: 3 }] })
    // a linha de menor id fica ilegível (cifra trocada por outra da mesma versão): a chave segue provada pelas outras
    const bad = MasterKeyRing.of({ 2: crypto.randomBytes(32) }).seal('lixo', certificateAad(101))
    await root.query(`UPDATE \`${DB}\`.tb_establishment_certificate SET private_key_cipher = ?, private_key_iv = ?, private_key_tag = ?
      WHERE tb_institution_id = 101`, [bad.cipher, bad.iv, bad.tag])
    expect(await verifyStoredKeys({ pool, keyring: NEW_ONLY }))
      .toEqual({ ok: true, degraded: true, versions: [{ version: 2, ok: true, unreadable: 1 }] })
    report.verifyStoredKeys = 'ok'
  })

  it('FAMILIA.E5.P7: o cofre com DOIS donos no motor — a rotação só do A1 deixa a senha de e-mail na chave antiga; `rotateStoredKeys` regrava os dois', async () => {
    const TABLE = 'tb_establishment_smtp_credential'
    const passwords: Record<number, string> = {}
    for (const id of [301, 302]) {
      passwords[id] = `senha-de-teste-${id}-${crypto.randomBytes(18).toString('base64')}`   // gerada na hora
      await storeSmtpCredential({ pool, keyring: OLD }, id, { host: 'smtp.exemplo.invalid', port: 587, security: 'starttls',
        username: `u${id}@exemplo.invalid`, senderAddress: `u${id}@exemplo.invalid`, password: passwords[id], userId: null })
    }
    await root.query(`UPDATE \`${DB}\`.${TABLE} SET updated_at = '2026-01-01 00:00:00'`)
    await seed(301, OLD)

    // quem roda só a rotação do A1 continua vendo a versão 1 em uso — e não tira a chave
    expect((await rotateCertificateKeys({ pool, keyring: BOTH })).rewrapped).toEqual([{ institutionId: 301, from: 1 }])
    expect((await storedKeyVersions(pool)).sort()).toEqual([1, 2])
    expect(await storedSecretsOutsideKeyVersion(pool, 2)).toEqual([{ store: TABLE, institutionId: 301 }, { store: TABLE, institutionId: 302 }])
    await expect(openSmtpCredential({ pool, keyring: NEW_ONLY }, 301)).rejects.toMatchObject({ statusCode: 503, code: 'FISCAL_MASTER_KEY_UNAVAILABLE' })

    const rep = await rotateStoredKeys({ pool, keyring: BOTH })
    expect(rep).toEqual({ currentVersion: 2, failed: [], skipped: [],
      rewrapped: [{ store: TABLE, institutionId: 301, from: 1 }, { store: TABLE, institutionId: 302, from: 1 }] })
    expect(await storedKeyVersions(pool)).toEqual([2])
    for (const id of [301, 302]) expect((await openSmtpCredential({ pool, keyring: NEW_ONLY }, id)).password).toBe(passwords[id])
    // só a cifra mudou: a data da conta fica como estava, e nada do que está na tabela contém a senha
    const [rows] = await root.query<any[]>(`SELECT * FROM \`${DB}\`.${TABLE} ORDER BY tb_institution_id`)
    expect(rows.map(r => [r.cipher_key_version, new Date(r.updated_at).toISOString().slice(0, 10)])).toEqual([[2, '2026-01-01'], [2, '2026-01-01']])
    const everything = Buffer.concat(rows.flatMap(r => Object.values(r)).map(v => (Buffer.isBuffer(v) ? v : Buffer.from(String(v)))))
    for (const id of [301, 302]) expect(everything.includes(Buffer.from(passwords[id]))).toBe(false)
    expect(JSON.stringify(rep)).not.toContain(passwords[301])
    expect(await rotateStoredKeys({ pool, keyring: BOTH })).toEqual({ currentVersion: 2, rewrapped: [], failed: [], skipped: [] })
    // a prova da chave olha os dois donos: chave errada falha também pela senha; a certa passa (o A1 101 ilegível do teste anterior = degradado)
    expect((await verifyStoredKeys({ pool, keyring: NEW_ONLY })).ok).toBe(true)
    expect((await verifyStoredKeys({ pool, keyring: MasterKeyRing.of({ 2: crypto.randomBytes(32) }) })).ok).toBe(false)
    report.sealedStoresRotated = rep.rewrapped.length
  })

  it('FAMILIA.E5.P7: com um leitor segurando a conta de e-mail, a rotação ESPERA a trava (FOR UPDATE real) e conclui — sem deadlock', async () => {
    const password = `senha-de-teste-${crypto.randomBytes(18).toString('base64')}`
    await storeSmtpCredential({ pool, keyring: OLD }, 401, { host: 'smtp.exemplo.invalid', port: 465, security: 'tls',
      username: 'u401', senderAddress: 'u401@exemplo.invalid', password, userId: null })
    const reader = await mysql.createConnection({ ...owner, database: DB, timezone: 'Z' })
    try {
      await reader.query('START TRANSACTION')
      await reader.query(`SELECT cipher_key_version FROM tb_establishment_smtp_credential WHERE tb_institution_id = 401 LOCK IN SHARE MODE`)
      const t0 = Date.now()
      const running = rotateStoredKeys({ pool, keyring: BOTH })
      await new Promise(r => setTimeout(r, 1500))
      await reader.query('COMMIT')
      const rep = await running
      expect(rep.rewrapped).toEqual([{ store: 'tb_establishment_smtp_credential', institutionId: 401, from: 1 }])
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1400)
      expect((await openSmtpCredential({ pool, keyring: NEW_ONLY }, 401)).password).toBe(password)
    } finally {
      await reader.end()
    }
  })
})
