/// <reference types="jest" />
// fiscal-api:FAMILIA.E5.P7 (S3 da ficha) — o COFRE com DOIS DONOS: o A1 e a senha da conta de e-mail usam o mesmo anel de chave-mestra, então
// tudo o que decide sobre a chave (versões em uso, o que falta regravar, a rotação, a prova da chave do servidor) percorre a lista fechada
// `SEALED_STORES`. O que se fixa: quem rotaciona SÓ o A1 continua vendo a versão antiga em uso (não tira a chave); `rotateStoredKeys` regrava
// os dois donos, um segredo por transação, com FOR UPDATE, selo conferido antes do UPDATE, intocado quando não abre, idempotente; depois dela o
// anel só com a chave nova abre o A1 e a senha; a prova da chave acusa chave errada também quando só há senha guardada; nenhum segredo no
// relatório. Banco FALSO na fronteira; a prova no motor está em `rotacao-chave-mestra.live.test.ts`.
import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import { MasterKeyRing } from '../secret/cipher'
import { SEALED_STORES, StoredKeyRotationAborted, rotateStoredKeys, storedSecretsOutsideKeyVersion } from '../secret/sealed-stores'
import type { SealedStore } from '../secret/sealed-store'
import { rotateCertificateKeys, storedKeyVersions, verifyStoredKeys, certificateAad } from '../establishment/establishment'
import { CERTIFICATE_SEALED_STORE, getCertificate } from '../establishment/establishment.repository'
import { SMTP_CREDENTIAL_SEALED_STORE } from '../smtp-credential/smtp-credential.repository'
import { openSmtpCredential, smtpCredentialAad, storeSmtpCredential } from '../smtp-credential/smtp-credential'
import { ErrorCodes } from '../errors/error-codes'
import * as barrel from '../index'
import { stripComments } from './fence'
import { smtpFakeDb } from './smtp-credential-fake'

const KEY_PEM = (id: number) => `-----BEGIN PRIVATE KEY-----\nchave-de-teste-${id}-${randomBytes(6).toString('hex')}\n-----END PRIVATE KEY-----\n`
const PASSWORD = (id: number) => `senha-de-teste-${id}-${randomBytes(12).toString('base64')}`   // geradas na hora

interface CertRow { pem: string; cipher: Buffer | null; iv: Buffer | null; tag: Buffer | null; version: number | null; deleted: 'N' | 'S' }

/** Os DOIS donos num banco falso só: o A1 (interpretado aqui) e a conta de e-mail (`smtpFakeDb`), despachados pela tabela do SQL. */
function vault(opts: { failOnLock?: (store: string, id: number) => unknown; beforeSmtpLock?: (id: number) => void } = {}) {
  const certs = new Map<number, CertRow>()
  const smtp = smtpFakeDb({ failOnLock: id => opts.failOnLock?.('tb_establishment_smtp_credential', id) })
  const sqls: string[] = []
  const viaConn: string[] = []
  const live = () => [...certs.entries()].filter(([, r]) => r.deleted === 'N' && r.version != null)
  const query = jest.fn(async (sql: string, p: any[] = []): Promise<[any, any]> => {
    sqls.push(sql)
    if (/tb_establishment_smtp_credential/.test(sql)) {
      if (/FOR UPDATE/.test(sql)) opts.beforeSmtpLock?.(p[0])
      return smtp.query(sql, p)
    }
    if (/ROW_NUMBER\(\) OVER \(PARTITION BY cipher_key_version ORDER BY tb_institution_id\)/.test(sql)) {
      const seen = new Map<number, number>()
      return [live().sort((a, b) => a[1].version! - b[1].version! || a[0] - b[0])
        .filter(([, r]) => { const n = (seen.get(r.version!) ?? 0) + 1; seen.set(r.version!, n); return n <= p[0] })
        .map(([id, r]) => ({ v: r.version, id, cipher: r.cipher, iv: r.iv, tag: r.tag })), []]
    }
    if (/SELECT tb_institution_id AS id FROM tb_establishment_certificate/.test(sql)) {
      return [live().filter(([, r]) => r.version !== p[0]).sort((a, b) => a[0] - b[0]).map(([id]) => ({ id })), []]
    }
    if (/SELECT DISTINCT cipher_key_version AS v/.test(sql)) return [[...new Set(live().map(([, r]) => r.version))].map(v => ({ v })), []]
    if (/UPDATE tb_establishment_certificate\s+SET private_key_cipher = \?/.test(sql)) {
      const r = certs.get(p[4])
      if (!r || r.deleted !== 'N' || r.version !== p[5]) return [{ affectedRows: 0 }, []]
      Object.assign(r, { cipher: p[0], iv: p[1], tag: p[2], version: p[3] })
      return [{ affectedRows: 1 }, []]
    }
    if (/FROM tb_establishment_certificate/.test(sql)) {
      if (/FOR UPDATE/.test(sql)) { const e = opts.failOnLock?.('tb_establishment_certificate', p[0]); if (e) throw e }
      const r = certs.get(p[0])
      return [r && r.deleted === 'N' ? [{
        institutionId: p[0], cnpj: null, certificatePem: `CERT-${p[0]}`, cipher: r.cipher, iv: r.iv, tag: r.tag, version: r.version,
        subject: null, issuedBy: null, notBefore: null, notAfter: null, fingerprint256: null, userId: null,
      }] : [], []]
    }
    throw new Error(`SQL inesperado no falso do cofre: ${sql}`)
  })
  const commit = jest.fn()
  const conn = {
    query: jest.fn(async (sql: string, p?: any[]) => { viaConn.push(sql); return query(sql, p) }),
    beginTransaction: jest.fn(), commit, rollback: jest.fn(), release: jest.fn(),
  }
  const pool = { query, getConnection: jest.fn(async () => conn) } as any
  const seedCert = (id: number, ring: MasterKeyRing) => {
    const pem = KEY_PEM(id)
    const s = ring.seal(pem, certificateAad(id))
    certs.set(id, { pem, cipher: s.cipher, iv: s.iv, tag: s.tag, version: s.version, deleted: 'N' })
    return pem
  }
  const seedSmtp = async (id: number, ring: MasterKeyRing) => {
    const password = PASSWORD(id)
    await storeSmtpCredential({ pool: smtp.pool, keyring: ring }, id, {
      host: 'smtp.exemplo.invalid', port: 587, security: 'starttls', username: `u${id}`, senderAddress: `u${id}@exemplo.invalid`, password, userId: null,
    })
    return password
  }
  return { pool, conn, commit, certs, smtp, sqls, viaConn, seedCert, seedSmtp }
}

const K1 = randomBytes(32)
const K2 = randomBytes(32)
const OLD = MasterKeyRing.of({ 1: K1 })
const BOTH = MasterKeyRing.of({ 1: K1, 2: K2 })
const NEW_ONLY = MasterKeyRing.of({ 2: K2 })
const CERT = 'tb_establishment_certificate'
const SMTP = 'tb_establishment_smtp_credential'

async function certKey(pool: any, ring: MasterKeyRing, id: number): Promise<string> {
  return ring.open((await getCertificate(pool, id))!.sealedKey!, certificateAad(id)).toString('utf8')
}

describe('FAMILIA.E5.P7 — a lista fechada dos donos do cofre', () => {
  it('dois donos, congelada, cada um com a sua tabela, a sua AAD e o seu código de "não abre"', () => {
    expect(SEALED_STORES.map(s => s.name)).toEqual([CERT, SMTP])
    expect(Object.isFrozen(SEALED_STORES)).toBe(true)
    expect(SEALED_STORES.every(s => Object.isFrozen(s))).toBe(true)
    expect([CERTIFICATE_SEALED_STORE.aad(7), SMTP_CREDENTIAL_SEALED_STORE.aad(7)]).toEqual([`${CERT}:7`, `${SMTP}:7`])
    expect([certificateAad(7), smtpCredentialAad(7)]).toEqual([`${CERT}:7`, `${SMTP}:7`])
    expect(SEALED_STORES.map(s => s.unreadableCode)).toEqual([ErrorCodes.FISCAL_CERT_INVALID, ErrorCodes.SMTP_CREDENTIAL_UNREADABLE])
  })
  it('toda tabela do núcleo com coluna de cifra por versão está na lista (dono novo fora dela perderia o segredo na rotação)', () => {
    const dir = path.resolve(__dirname, '..', 'migrations', 'sql')
    const owners: string[] = []
    for (const file of fs.readdirSync(dir).sort()) {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8')
      for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS `([a-z_0-9]+)` \(([\s\S]*?)\n\) ENGINE/g)) {
        if (/`cipher_key_version`/.test(m[2])) owners.push(m[1])
      }
    }
    expect(owners.sort()).toEqual(SEALED_STORES.map(s => s.name).sort())
  })
  it('sai pelo barrel do núcleo', () => {
    expect(barrel.SEALED_STORES).toBe(SEALED_STORES)
    expect(barrel.rotateStoredKeys).toBe(rotateStoredKeys)
    expect(barrel.storedSecretsOutsideKeyVersion).toBe(storedSecretsOutsideKeyVersion)
    expect(barrel.StoredKeyRotationAborted).toBe(StoredKeyRotationAborted)
    expect(barrel.rotateCertificateKeys).toBe(rotateCertificateKeys)          // a antiga continua onde estava
  })
})

describe('FAMILIA.E5.P7 — versões em uso e o que falta regravar somam os dois donos', () => {
  it('quem rotaciona SÓ o A1 continua vendo a versão antiga em uso pela senha de e-mail — e não tira a chave do anel', async () => {
    const db = vault()
    db.seedCert(10, OLD)
    await db.seedSmtp(10, OLD)
    const r = await rotateCertificateKeys({ pool: db.pool, keyring: BOTH })
    expect(r.rewrapped).toEqual([{ institutionId: 10, from: 1 }])
    expect((await storedKeyVersions(db.pool)).sort()).toEqual([1, 2])           // a 1 ainda cifra a senha
    expect(await storedSecretsOutsideKeyVersion(db.pool, 2)).toEqual([{ store: SMTP, institutionId: 10 }])
  })
  it('sem repetição quando os dois donos estão na mesma versão; vazio sem segredo guardado', async () => {
    const db = vault()
    expect(await storedKeyVersions(db.pool)).toEqual([])
    db.seedCert(10, OLD); await db.seedSmtp(11, OLD)
    expect(await storedKeyVersions(db.pool)).toEqual([1])
    expect(await storedSecretsOutsideKeyVersion(db.pool, 1)).toEqual([])
    expect(await storedSecretsOutsideKeyVersion(db.pool, 2)).toEqual([{ store: CERT, institutionId: 10 }, { store: SMTP, institutionId: 11 }])
  })
})

describe('FAMILIA.E5.P7 — rotateStoredKeys: a rotação da chave-mestra sobre os dois donos', () => {
  it('reabre com a ANTIGA e regrava com a NOVA nos dois donos: depois o anel só com a nova abre o A1 e a senha', async () => {
    const db = vault()
    const pem10 = db.seedCert(10, OLD)
    const pem20 = db.seedCert(20, OLD)
    const pass10 = await db.seedSmtp(10, OLD)
    const pass30 = await db.seedSmtp(30, OLD)
    const report = await rotateStoredKeys({ pool: db.pool, keyring: BOTH })
    expect(report).toEqual({
      currentVersion: 2,
      rewrapped: [
        { store: CERT, institutionId: 10, from: 1 }, { store: CERT, institutionId: 20, from: 1 },
        { store: SMTP, institutionId: 10, from: 1 }, { store: SMTP, institutionId: 30, from: 1 },
      ],
      failed: [], skipped: [],
    })
    expect(await storedKeyVersions(db.pool)).toEqual([2])
    expect(await storedSecretsOutsideKeyVersion(db.pool, 2)).toEqual([])
    expect([await certKey(db.pool, NEW_ONLY, 10), await certKey(db.pool, NEW_ONLY, 20)]).toEqual([pem10, pem20])
    expect((await openSmtpCredential({ pool: db.pool, keyring: NEW_ONLY }, 10)).password).toBe(pass10)
    expect((await openSmtpCredential({ pool: db.pool, keyring: NEW_ONLY }, 30)).password).toBe(pass30)
    expect((await verifyStoredKeys({ pool: db.pool, keyring: NEW_ONLY })).ok).toBe(true)
    // um segredo por transação, lido com FOR UPDATE e regravado pela MESMA conexão
    expect(db.commit).toHaveBeenCalledTimes(4)
    expect(db.viaConn.filter(s => /FOR UPDATE/.test(s))).toHaveLength(4)
    expect(db.viaConn.filter(s => /^\s*UPDATE/.test(s))).toHaveLength(4)
  })

  it('só a cifra da senha muda: host, usuário, remetente, autor e data ficam como estavam', async () => {
    const db = vault()
    await db.seedSmtp(10, OLD)
    const before = { ...db.smtp.rows.get(10)! }
    await rotateStoredKeys({ pool: db.pool, keyring: BOTH })
    const after = db.smtp.rows.get(10)!
    expect({ ...after, cipher: null, iv: null, tag: null, version: null }).toEqual({ ...before, cipher: null, iv: null, tag: null, version: null })
    expect([after.version, after.cipher!.equals(before.cipher!)]).toEqual([2, false])
  })

  it('nenhum segredo no relatório, no log nem no que foi ao banco', async () => {
    const db = vault()
    const pem = db.seedCert(10, OLD)
    const password = await db.seedSmtp(10, OLD)
    const report = await rotateStoredKeys({ pool: db.pool, keyring: BOTH })
    const text = JSON.stringify(report)
    expect(text).not.toContain(password)
    expect(text).not.toContain(pem.split('\n')[1])
    const sent = Buffer.concat(db.smtp.params.flat().map(v => (Buffer.isBuffer(v) ? v : Buffer.from(String(v)))))
    expect(sent.includes(Buffer.from(password))).toBe(false)
  })

  it('idempotente: rodar de novo não acha nada; sem chave atual → 503 do cofre', async () => {
    const db = vault()
    db.seedCert(10, OLD); await db.seedSmtp(10, OLD)
    await rotateStoredKeys({ pool: db.pool, keyring: BOTH })
    expect(await rotateStoredKeys({ pool: db.pool, keyring: BOTH })).toEqual({ currentVersion: 2, rewrapped: [], failed: [], skipped: [] })
    await expect(rotateStoredKeys({ pool: db.pool, keyring: MasterKeyRing.of({}) })).rejects.toMatchObject({ statusCode: 503, code: ErrorCodes.FISCAL_MASTER_KEY_UNAVAILABLE })
  })

  it('senha que NÃO abre fica INTOCADA e vai para failed com o código do dono; os outros seguem', async () => {
    const db = vault()
    db.seedCert(10, OLD)
    await db.seedSmtp(10, OLD)
    await db.seedSmtp(20, OLD)
    const bad = db.smtp.rows.get(10)!
    bad.cipher = Buffer.from(bad.cipher!); bad.cipher[0] ^= 0xff
    const frozen = Buffer.from(bad.cipher)
    const report = await rotateStoredKeys({ pool: db.pool, keyring: BOTH })
    expect(report.failed).toEqual([{ store: SMTP, institutionId: 10, from: 1, code: ErrorCodes.SMTP_CREDENTIAL_UNREADABLE }])
    expect(report.rewrapped).toEqual([{ store: CERT, institutionId: 10, from: 1 }, { store: SMTP, institutionId: 20, from: 1 }])
    expect([bad.version, bad.cipher.equals(frozen)]).toEqual([1, true])
    expect((await storedKeyVersions(db.pool)).sort()).toEqual([1, 2])            // a versão 1 continua em uso: a chave não sai
  })

  it('versão ausente do anel → failed FISCAL_MASTER_KEY_UNAVAILABLE, nada gravado', async () => {
    const db = vault()
    await db.seedSmtp(10, MasterKeyRing.of({ 5: randomBytes(32) }))
    const report = await rotateStoredKeys({ pool: db.pool, keyring: BOTH })
    expect(report.failed).toEqual([{ store: SMTP, institutionId: 10, from: 5, code: ErrorCodes.FISCAL_MASTER_KEY_UNAVAILABLE }])
    expect(db.smtp.rows.get(10)!.version).toBe(5)
  })

  it('conta apagada ou trocada entre a lista e a trava → skipped, nada sobrescrito', async () => {
    let swapped = ''
    const db = vault({
      beforeSmtpLock: id => {
        if (id === 10) Object.assign(db.smtp.rows.get(10)!, { cipher: null, iv: null, tag: null, version: null, deleted: 'S' })
        if (id === 20 && !swapped) {
          swapped = PASSWORD(20)
          const s = BOTH.seal(swapped, smtpCredentialAad(20))
          Object.assign(db.smtp.rows.get(20)!, { cipher: s.cipher, iv: s.iv, tag: s.tag, version: s.version })
        }
      },
    })
    await db.seedSmtp(10, OLD); await db.seedSmtp(20, OLD)
    const report = await rotateStoredKeys({ pool: db.pool, keyring: BOTH })
    expect(report).toMatchObject({ rewrapped: [], failed: [], skipped: [{ store: SMTP, institutionId: 10 }, { store: SMTP, institutionId: 20 }] })
    expect((await openSmtpCredential({ pool: db.pool, keyring: BOTH }, 20)).password).toBe(swapped)
  })

  it('linha em contenção (1205/1213) → failed RESOURCE_BUSY e os outros seguem; erro de infraestrutura → aborta com o relatório do que já gravou', async () => {
    const busy = vault({ failOnLock: (store, id) => (store === SMTP && id === 10 ? Object.assign(new Error('Lock wait timeout exceeded'), { errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT' }) : null) })
    busy.seedCert(10, OLD); await busy.seedSmtp(10, OLD); await busy.seedSmtp(20, OLD)
    const r = await rotateStoredKeys({ pool: busy.pool, keyring: BOTH })
    expect(r.failed).toEqual([{ store: SMTP, institutionId: 10, from: null, code: ErrorCodes.RESOURCE_BUSY }])
    expect(r.rewrapped.map(x => `${x.store}:${x.institutionId}`)).toEqual([`${CERT}:10`, `${SMTP}:20`])

    const down = vault({ failOnLock: (store, id) => (store === SMTP && id === 20 ? new Error('conexão caiu') : null) })
    down.seedCert(10, OLD); await down.seedSmtp(10, OLD); await down.seedSmtp(20, OLD)
    const err: any = await rotateStoredKeys({ pool: down.pool, keyring: BOTH }).catch(e => e)
    expect(err).toBeInstanceOf(StoredKeyRotationAborted)
    expect(err.inDoubt).toEqual({ store: SMTP, institutionId: 20 })
    expect(err.report.rewrapped).toEqual([{ store: CERT, institutionId: 10, from: 1 }, { store: SMTP, institutionId: 10, from: 1 }])
  })

  it('o selo novo é conferido ANTES do UPDATE: selo que não confere → failed KEY_ROTATION_RESEAL_MISMATCH, linha intocada', async () => {
    const rows = new Map<number, { sealed: any }>()
    const aad = (id: number) => `dono-de-teste:${id}`
    rows.set(1, { sealed: OLD.seal('segredo-de-teste', aad(1)) })
    const rewrap = jest.fn(async () => true)
    const store: SealedStore = {
      name: 'dono-de-teste', unreadableCode: 'NAO_ABRE', aad,
      keyVersions: async () => [1], outsideKeyVersion: async () => [1], samplePerKeyVersion: async () => [],
      readSealedForUpdate: async (_c, id) => rows.get(id)!.sealed, rewrap,
    }
    // anel cuja cifragem "nova" volta outro texto: abre a antiga, mas o que ele sela não reabre igual
    const ring = MasterKeyRing.of({ 1: K1, 2: K2 })
    const seal = ring.seal.bind(ring)
    jest.spyOn(ring, 'seal').mockImplementation((_plain: any, a: string) => seal('outro-texto', a))
    const db = vault()
    const report = await rotateStoredKeys({ pool: db.pool, keyring: ring }, [store])
    expect(report.failed).toEqual([{ store: 'dono-de-teste', institutionId: 1, from: null, code: 'KEY_ROTATION_RESEAL_MISMATCH' }])
    expect(rewrap).not.toHaveBeenCalled()
  })
})

describe('FAMILIA.E5.P7 — verifyStoredKeys: a prova da chave do servidor olha os dois donos', () => {
  it('só há senha de e-mail guardada e a chave do servidor é a ERRADA → não ok, com o código da senha', async () => {
    const db = vault()
    await db.seedSmtp(10, OLD); await db.seedSmtp(11, OLD)
    const wrong = MasterKeyRing.of({ 1: randomBytes(32) })
    expect(await verifyStoredKeys({ pool: db.pool, keyring: wrong }))
      .toEqual({ ok: false, degraded: false, versions: [{ version: 1, ok: false, code: ErrorCodes.SMTP_CREDENTIAL_UNREADABLE, unreadable: 2 }] })
    expect(await verifyStoredKeys({ pool: db.pool, keyring: OLD }))
      .toEqual({ ok: true, degraded: false, versions: [{ version: 1, ok: true, unreadable: 0 }] })
  })
  it('mesma versão nos dois donos: UMA linha por versão; a regra da D-F243 vale entre donos — A1 abre e a senha não = ok e DEGRADED (alarme, não queda)', async () => {
    const db = vault()
    db.seedCert(10, OLD); await db.seedSmtp(10, OLD)
    expect(await verifyStoredKeys({ pool: db.pool, keyring: OLD }))
      .toEqual({ ok: true, degraded: false, versions: [{ version: 1, ok: true, unreadable: 0 }] })
    const bad = db.smtp.rows.get(10)!
    bad.cipher = Buffer.from(bad.cipher!); bad.cipher[0] ^= 0xff                 // a única senha da versão não abre; o A1 abre
    expect(await verifyStoredKeys({ pool: db.pool, keyring: OLD }))
      .toEqual({ ok: true, degraded: true, versions: [{ version: 1, ok: true, unreadable: 1 }] })
    // e a chave ERRADA continua derrubando: nenhuma amostra de nenhum dono abre → o código do 1º dono que falhou (o A1)
    expect(await verifyStoredKeys({ pool: db.pool, keyring: MasterKeyRing.of({ 1: randomBytes(32) }) }))
      .toEqual({ ok: false, degraded: false, versions: [{ version: 1, ok: false, code: ErrorCodes.FISCAL_CERT_INVALID, unreadable: 2 }] })
  })
  it('versões diferentes por dono saem em ordem; versão da senha ausente do anel → FISCAL_MASTER_KEY_UNAVAILABLE', async () => {
    const db = vault()
    db.seedCert(10, NEW_ONLY); await db.seedSmtp(10, OLD)
    expect((await verifyStoredKeys({ pool: db.pool, keyring: BOTH })).versions.map(v => [v.version, v.ok])).toEqual([[1, true], [2, true]])
    expect(await verifyStoredKeys({ pool: db.pool, keyring: NEW_ONLY })).toEqual({
      ok: false, degraded: false,
      versions: [{ version: 1, ok: false, code: ErrorCodes.FISCAL_MASTER_KEY_UNAVAILABLE, unreadable: 1 }, { version: 2, ok: true, unreadable: 0 }],
    })
  })
  it('uma senha ilegível com outra boa na mesma versão → ok e degraded (não derruba o serviço de todos); leitura sem trava', async () => {
    const db = vault()
    await db.seedSmtp(10, OLD); await db.seedSmtp(11, OLD)
    const bad = db.smtp.rows.get(10)!
    bad.cipher = Buffer.from(bad.cipher!); bad.cipher[0] ^= 0xff
    db.sqls.length = 0
    expect(await verifyStoredKeys({ pool: db.pool, keyring: OLD }))
      .toEqual({ ok: true, degraded: true, versions: [{ version: 1, ok: true, unreadable: 1 }] })
    expect(db.sqls).toHaveLength(2)
    for (const q of db.sqls) expect(q).not.toMatch(/FOR UPDATE|LOCK IN SHARE MODE/)
  })
})

describe('FAMILIA.E5.P7 — re-gate (achados dos gates de 2026-11-25)', () => {
  it('M2: banco SEM a 009 (pré-deploy contra o banco antigo) → a senha conta como "dono sem segredo"; outro erro do banco sobe como está', async () => {
    const db = vault()
    db.seedCert(10, OLD)
    const noTable = Object.assign(new Error("Table 'fiscal_api.tb_establishment_smtp_credential' doesn't exist"), { errno: 1146, code: 'ER_NO_SUCH_TABLE' })
    db.smtp.query.mockImplementation(async () => { throw noTable })
    expect(await storedKeyVersions(db.pool)).toEqual([1])
    expect(await storedSecretsOutsideKeyVersion(db.pool, 2)).toEqual([{ store: CERT, institutionId: 10 }])
    expect(await verifyStoredKeys({ pool: db.pool, keyring: OLD })).toEqual({ ok: true, degraded: false, versions: [{ version: 1, ok: true, unreadable: 0 }] })
    const down = Object.assign(new Error('Lost connection'), { errno: 2013, code: 'PROTOCOL_CONNECTION_LOST' })
    db.smtp.query.mockImplementation(async () => { throw down })
    await expect(storedKeyVersions(db.pool)).rejects.toBe(down)
    await expect(verifyStoredKeys({ pool: db.pool, keyring: OLD })).rejects.toBe(down)
  })
  it('L5: linha viva com `security` fora do domínio (motor sem o CHECK) é ROTACIONADA, não pulada — a versão antiga não fica presa', async () => {
    const db = vault()
    const password = await db.seedSmtp(10, OLD)
    db.smtp.rows.get(10)!.security = 'none'
    const report = await rotateStoredKeys({ pool: db.pool, keyring: BOTH })
    expect(report).toEqual({ currentVersion: 2, rewrapped: [{ store: SMTP, institutionId: 10, from: 1 }], failed: [], skipped: [] })
    expect(await storedKeyVersions(db.pool)).toEqual([2])
    const row = db.smtp.rows.get(10)!
    expect(NEW_ONLY.open({ cipher: row.cipher!, iv: row.iv!, tag: row.tag!, version: 2 }, smtpCredentialAad(10)).toString('utf8')).toBe(password)
  })
})

describe('FAMILIA.E5.P7 — cercas do cofre', () => {
  const code = fs.readFileSync(path.resolve(__dirname, '..', 'secret', 'sealed-stores.ts'), 'utf8')
  it('lista em array congelado (sem Map/Set de controle) e nenhum SQL com nome de tabela vindo de fora', () => {
    expect(stripComments(code)).not.toMatch(/new (Map|Set)\b/)
    expect(stripComments(code)).not.toMatch(/\.query\(/)
  })
  it('o runbook da rotação do A1 aponta para a rotação de todos os donos', () => {
    const est = fs.readFileSync(path.resolve(__dirname, '..', 'establishment', 'establishment.ts'), 'utf8')
    expect(est).toMatch(/rodar a rotação de TODOS os donos \(`rotateStoredKeys`\)/)
    expect(code).toMatch(/a do A1 sozinha, `rotateCertificateKeys`, deixa a senha da conta de e-mail na chave antiga/)
  })
})
