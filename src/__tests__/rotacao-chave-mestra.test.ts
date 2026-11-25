/// <reference types="jest" />
// DEPLOY.E3.P1.T2 (D-F16) — ROTAÇÃO da chave-mestra do cofre: o A1 reabre com a chave ANTIGA e é regravado com a NOVA
// (`cipher_key_version`). O que se fixa: só a cifra muda (certificado e metadados intactos); depois da rotação o anel SÓ com a
// chave nova abre o A1; A1 que não abre (versão ausente, chave errada) fica INTOCADO e é relatado; linha trocada no meio não é
// sobrescrita; idempotente; a leitura trava a linha EXCLUSIVO (FOR UPDATE); nenhum segredo em claro vai ao banco.
import { randomBytes } from 'crypto'
import { MasterKeyRing } from '../secret/cipher'
import { rotateCertificateKeys, certificateAad, storedKeyVersions, verifyStoredKeys, KeyRotationAborted } from '../establishment/establishment'
import { getCertificate } from '../establishment/establishment.repository'

const KEY_PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC-chave-de-teste\n-----END PRIVATE KEY-----\n'
const pemOf = (id: number) => KEY_PEM.replace('teste', `teste-${id}`)

interface Row { certificate_pem: string; cipher: Buffer | null; iv: Buffer | null; tag: Buffer | null; version: number | null; deleted: 'N' | 'S'; subject: string }

function fakeDb(opts: { beforeLock?: (id: number, rows: Map<number, Row>) => void; failOnLock?: (id: number) => unknown } = {}) {
  const rows = new Map<number, Row>()
  const sqls: string[] = []
  const updates: any[][] = []
  const viaConn: string[] = []
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    sqls.push(sql)
    // FAMILIA.E5.P7: o cofre tem um 2º dono (a senha da conta de e-mail); aqui a tabela dele está VAZIA — os dois donos juntos estão em
    // `familia-e5-p7-sealed-stores.test.ts`
    if (/tb_establishment_smtp_credential/.test(sql)) return [[]]
    if (/ROW_NUMBER\(\) OVER \(PARTITION BY cipher_key_version ORDER BY tb_institution_id\)/.test(sql)) {   // amostra por versão
      const live = [...rows.entries()].filter(([, r]) => r.deleted === 'N' && r.version != null)
        .sort((a, b) => a[1].version! - b[1].version! || a[0] - b[0])
      const seen = new Map<number, number>()
      return [live.filter(([, r]) => { const n = (seen.get(r.version!) ?? 0) + 1; seen.set(r.version!, n); return n <= p[0] })
        .map(([id, r]) => ({ v: r.version, id, cipher: r.cipher, iv: r.iv, tag: r.tag }))]
    }
    if (/SELECT tb_institution_id AS id FROM tb_establishment_certificate/.test(sql)) {
      return [[...rows.entries()].filter(([, r]) => r.deleted === 'N' && r.version != null && r.version !== p[0]).map(([id]) => ({ id }))]
    }
    if (/SELECT DISTINCT cipher_key_version AS v/.test(sql)) {
      return [[...new Set([...rows.values()].filter(r => r.deleted === 'N').map(r => r.version))].map(v => ({ v }))]
    }
    if (/FROM tb_establishment_certificate/.test(sql)) {             // getCertificate
      if (/FOR UPDATE/.test(sql)) { const e = opts.failOnLock?.(p[0]); if (e) throw e }
      opts.beforeLock?.(p[0], rows)
      const r = rows.get(p[0])
      return [r && r.deleted === 'N' ? [{
        institutionId: p[0], cnpj: '12345678000195', certificatePem: r.certificate_pem, cipher: r.cipher, iv: r.iv, tag: r.tag,
        version: r.version, subject: r.subject, issuedBy: null, notBefore: null, notAfter: null, fingerprint256: null, userId: 7,
      }] : []]
    }
    if (/UPDATE tb_establishment_certificate\s+SET private_key_cipher = \?/.test(sql)) {
      updates.push(p)
      const r = rows.get(p[4])
      if (!r || r.deleted !== 'N' || r.version !== p[5]) return [{ affectedRows: 0 }]
      Object.assign(r, { cipher: p[0], iv: p[1], tag: p[2], version: p[3] })
      return [{ affectedRows: 1 }]
    }
    throw new Error(`SQL inesperado no falso: ${sql}`)
  })
  // pool e conexão SEPARADOS: a leitura travante e o UPDATE têm que ir pela conexão da transação (gate adversarial, item 5)
  const connQuery = jest.fn(async (sql: string, p?: any[]) => { viaConn.push(sql); return query(sql, p) })
  const conn = { query: connQuery, beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
  const pool = { query, getConnection: jest.fn(async () => conn) } as any
  const seed = (id: number, ring: MasterKeyRing) => {
    const s = ring.seal(pemOf(id), certificateAad(id))
    rows.set(id, { certificate_pem: `CERT-${id}`, cipher: s.cipher, iv: s.iv, tag: s.tag, version: s.version, deleted: 'N', subject: `CN=${id}` })
  }
  return { pool, conn, rows, sqls, updates, viaConn, seed }
}

const K1 = randomBytes(32)
const K2 = randomBytes(32)
const OLD = MasterKeyRing.of({ 1: K1 })
const BOTH = MasterKeyRing.of({ 1: K1, 2: K2 })
const NEW_ONLY = MasterKeyRing.of({ 2: K2 })

async function openWith(pool: any, ring: MasterKeyRing, id: number): Promise<string> {
  const row = await getCertificate(pool, id)
  return ring.open(row!.sealedKey!, certificateAad(id)).toString('utf8')
}

describe('DEPLOY.E3.P1.T2 — rotação da chave-mestra do A1 (D-F16)', () => {
  it('reabre com a ANTIGA e regrava com a NOVA: depois só a chave nova abre; certificado e metadados intactos', async () => {
    const db = fakeDb()
    db.seed(10, OLD); db.seed(11, OLD); db.seed(12, NEW_ONLY)          // 12 já está na versão nova
    const before10 = { ...db.rows.get(10)! }

    const rep = await rotateCertificateKeys({ pool: db.pool, keyring: BOTH })

    expect(rep).toEqual({ currentVersion: 2, rewrapped: [{ institutionId: 10, from: 1 }, { institutionId: 11, from: 1 }], failed: [], skipped: [] })
    for (const id of [10, 11, 12]) {
      expect(db.rows.get(id)!.version).toBe(2)
      expect(await openWith(db.pool, NEW_ONLY, id)).toBe(pemOf(id))  // o anel SEM a antiga abre tudo
    }
    const after10 = db.rows.get(10)!
    expect(after10.certificate_pem).toBe(before10.certificate_pem)
    expect(after10.subject).toBe(before10.subject)
    expect(after10.cipher!.equals(before10.cipher!)).toBe(false)       // cifra e IV novos
    expect(after10.iv!.equals(before10.iv!)).toBe(false)
    expect(await storedKeyVersions(db.pool)).toEqual([2])               // o health já pode largar a versão 1
  })

  it('idempotente: com o mesmo anel, a 2ª rodada não acha nada e não grava nada', async () => {
    const db = fakeDb()
    db.seed(10, OLD)
    await rotateCertificateKeys({ pool: db.pool, keyring: BOTH })
    db.updates.length = 0
    const rep = await rotateCertificateKeys({ pool: db.pool, keyring: BOTH })
    expect(rep.rewrapped).toEqual([]); expect(rep.failed).toEqual([]); expect(rep.skipped).toEqual([])
    expect(db.updates).toEqual([])
  })

  it('a leitura do A1 trava a linha EXCLUSIVO (FOR UPDATE, nunca S→X) e o UPDATE só grava se a linha ainda está na versão aberta', async () => {
    const db = fakeDb()
    db.seed(10, OLD)
    await rotateCertificateKeys({ pool: db.pool, keyring: BOTH })
    const read = db.sqls.find(s => /certificate_pem AS certificatePem/.test(s))!
    expect(read).toMatch(/FOR UPDATE/)
    expect(read).not.toMatch(/LOCK IN SHARE MODE/)
    const upd = db.sqls.find(s => /SET private_key_cipher = \?/.test(s))!
    expect(upd).toMatch(/deleted = 'N' AND cipher_key_version = \?/)
    expect(upd).not.toMatch(/certificate_pem|tb_user_id|updated_at/)  // trocar a chave-mestra não é trocar o A1
    expect(db.viaConn).toContain(read)                                // pela CONEXÃO da transação, nunca pelo pool
    expect(db.viaConn).toContain(upd)
    expect(db.conn.commit).toHaveBeenCalled()
  })

  it('nenhum segredo em claro vai ao banco: os parâmetros do UPDATE não contêm a chave privada', async () => {
    const db = fakeDb()
    db.seed(10, OLD)
    await rotateCertificateKeys({ pool: db.pool, keyring: BOTH })
    const flat = Buffer.concat(db.updates[0].filter(Buffer.isBuffer))
    expect(flat.includes(Buffer.from('chave-de-teste'))).toBe(false)
  })

  it('A1 que NÃO abre fica INTOCADO e é relatado (versão ausente do anel · chave errada na mesma versão); os outros rodam', async () => {
    const db = fakeDb()
    db.seed(10, MasterKeyRing.of({ 5: randomBytes(32) }))              // versão 5 não está no anel
    db.seed(11, MasterKeyRing.of({ 1: randomBytes(32) }))              // versão 1, mas OUTRA chave
    db.seed(12, OLD)
    const snap10 = { ...db.rows.get(10)! }, snap11 = { ...db.rows.get(11)! }

    const rep = await rotateCertificateKeys({ pool: db.pool, keyring: BOTH })

    expect(rep.failed).toEqual([
      { institutionId: 10, from: 5, code: 'FISCAL_MASTER_KEY_UNAVAILABLE' },
      { institutionId: 11, from: 1, code: 'FISCAL_CERT_INVALID' },
    ])
    expect(rep.rewrapped).toEqual([{ institutionId: 12, from: 1 }])
    expect(db.rows.get(10)).toEqual(snap10)
    expect(db.rows.get(11)).toEqual(snap11)
    expect(db.updates.map(u => u[4])).toEqual([12])
  })

  it('linha trocada entre a lista e a trava (A1 novo já na versão atual, ou apagado) → pulada, nada sobrescrito', async () => {
    const db = fakeDb({
      beforeLock: (id, rows) => {
        if (id === 10) { const r = rows.get(10)!; const s = BOTH.seal('A1-NOVO', certificateAad(10)); Object.assign(r, { cipher: s.cipher, iv: s.iv, tag: s.tag, version: s.version }) }
        if (id === 11) rows.get(11)!.deleted = 'S'
      },
    })
    db.seed(10, OLD); db.seed(11, OLD)
    const rep = await rotateCertificateKeys({ pool: db.pool, keyring: BOTH })
    expect(rep).toEqual({ currentVersion: 2, rewrapped: [], failed: [], skipped: [10, 11] })
    expect(db.updates).toEqual([])
    expect(await openWith(db.pool, NEW_ONLY, 10)).toBe('A1-NOVO')
  })

  it('UPDATE que acha a linha já mudada (0 linhas) → pulada, nunca "regravada"', async () => {
    const db = fakeDb()
    db.seed(10, OLD)
    const real = db.conn.query.getMockImplementation()!
    db.conn.query.mockImplementation((async (sql: string, p?: any[]) =>
      /SET private_key_cipher = \?/.test(sql) ? [{ affectedRows: 0 }] : real(sql, p)) as any)
    const rep = await rotateCertificateKeys({ pool: db.pool, keyring: BOTH })
    expect(rep.rewrapped).toEqual([]); expect(rep.skipped).toEqual([10])
  })

  it('sem chave-mestra configurada → 503 FISCAL_MASTER_KEY_UNAVAILABLE antes de ler o banco', async () => {
    const db = fakeDb()
    await expect(rotateCertificateKeys({ pool: db.pool, keyring: MasterKeyRing.fromEnv({}) }))
      .rejects.toMatchObject({ statusCode: 503, code: 'FISCAL_MASTER_KEY_UNAVAILABLE' })
    expect(db.sqls).toEqual([])
  })

  it('o selo novo continua amarrado à LINHA: a cifra regravada copiada para outro estabelecimento NÃO abre', async () => {
    const db = fakeDb()
    db.seed(10, OLD)
    await rotateCertificateKeys({ pool: db.pool, keyring: BOTH })
    const row = await getCertificate(db.pool, 10)
    expect(() => NEW_ONLY.open(row!.sealedKey!, certificateAad(11))).toThrow()
  })

  it('A1 de versão MAIOR que a atual (anel atrasado) → falha relatada, nunca rebaixado', async () => {
    const db = fakeDb()
    db.seed(10, MasterKeyRing.of({ 3: randomBytes(32) }))
    const snap = { ...db.rows.get(10)! }
    const rep = await rotateCertificateKeys({ pool: db.pool, keyring: BOTH })
    expect(rep.failed).toEqual([{ institutionId: 10, from: 3, code: 'FISCAL_MASTER_KEY_UNAVAILABLE' }])
    expect(db.rows.get(10)).toEqual(snap)
  })

  it('UMA linha em contenção (1205 / 1213 repetido) vai para failed RESOURCE_BUSY e as outras seguem (gate adversarial, item 1)', async () => {
    const lockWait = Object.assign(new Error('Lock wait timeout exceeded'), { code: 'ER_LOCK_WAIT_TIMEOUT' })
    const deadlock = Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK' })
    const db = fakeDb({ failOnLock: id => (id === 10 ? lockWait : id === 11 ? deadlock : null) })
    db.seed(10, OLD); db.seed(11, OLD); db.seed(12, OLD)
    const rep = await rotateCertificateKeys({ pool: db.pool, keyring: BOTH })
    expect(rep.failed).toEqual([
      { institutionId: 10, from: null, code: 'RESOURCE_BUSY' },
      { institutionId: 11, from: null, code: 'RESOURCE_BUSY' },
    ])
    expect(rep.rewrapped).toEqual([{ institutionId: 12, from: 1 }])
    expect(db.rows.get(10)!.version).toBe(1)
  })

  it('erro de infraestrutura no meio → KeyRotationAborted com o relatório do que JÁ foi commitado', async () => {
    const db = fakeDb({ failOnLock: id => (id === 11 ? Object.assign(new Error('conexão caiu'), { code: 'PROTOCOL_CONNECTION_LOST' }) : null) })
    db.seed(10, OLD); db.seed(11, OLD); db.seed(12, OLD)
    const err = await rotateCertificateKeys({ pool: db.pool, keyring: BOTH }).catch(e => e)
    expect(err).toBeInstanceOf(KeyRotationAborted)
    expect((err as KeyRotationAborted).report.rewrapped).toEqual([{ institutionId: 10, from: 1 }])
    expect((err as KeyRotationAborted).inDoubt).toBe(11)
    expect(err.message).not.toMatch(/PRIVATE KEY|chave-de-teste/)
    expect(db.rows.get(12)!.version).toBe(1)                          // parou: a 12 fica para a próxima rodada
  })

  it('duas rotações seguidas pelo mesmo anel (a 2ª chega depois): a 2ª não regrava nada', async () => {
    const db = fakeDb()
    db.seed(10, OLD); db.seed(11, OLD)
    const a = await rotateCertificateKeys({ pool: db.pool, keyring: BOTH })
    const b = await rotateCertificateKeys({ pool: db.pool, keyring: BOTH })
    expect(a.rewrapped).toHaveLength(2)
    expect(b).toEqual({ currentVersion: 2, rewrapped: [], failed: [], skipped: [] })
  })
})

describe('DEPLOY.E3.P1.T1 — D-F243: o health prova que a chave do SERVIDOR abre os A1 guardados', () => {
  const sampleReads = (db: ReturnType<typeof fakeDb>) => db.sqls.filter(s => /ROW_NUMBER\(\)/.test(s))

  it('o selfTest do anel passa com QUALQUER chave — por isso não basta (o achado que gerou a D-F243)', () => {
    expect(MasterKeyRing.of({ 1: randomBytes(32) }).selfTest()).toBe(true)
  })

  it('chave certa → ok por versão em uso, numa leitura SÓ (versão e cifra da mesma instrução), sem trava', async () => {
    const db = fakeDb()
    db.seed(20, OLD); db.seed(10, OLD); db.seed(30, NEW_ONLY)
    const r = await verifyStoredKeys({ pool: db.pool, keyring: BOTH })
    expect(r).toEqual({ ok: true, degraded: false, versions: [{ version: 1, ok: true, unreadable: 0 }, { version: 2, ok: true, unreadable: 0 }] })
    // FAMILIA.E5.P7: UMA leitura por DONO do cofre (o A1 e a senha da conta de e-mail) — cada uma com versão e cifra da mesma instrução
    expect(db.sqls).toHaveLength(2)
    expect(sampleReads(db)).toHaveLength(2)
    expect(db.sqls.filter(q => /FROM tb_establishment_certificate/.test(q))).toHaveLength(1)
    for (const q of db.sqls) expect(q).not.toMatch(/FOR UPDATE|LOCK IN SHARE MODE/)
  })

  it('chave ERRADA com o mesmo número de versão → não ok (FISCAL_CERT_INVALID), embora storedKeyVersions e selfTest digam ok', async () => {
    const db = fakeDb()
    db.seed(10, OLD); db.seed(11, OLD)
    const wrong = MasterKeyRing.of({ 1: randomBytes(32) })
    expect(wrong.selfTest()).toBe(true)
    expect((await storedKeyVersions(db.pool)).every(v => wrong.hasVersion(v))).toBe(true)
    expect(await verifyStoredKeys({ pool: db.pool, keyring: wrong }))
      .toEqual({ ok: false, degraded: false, versions: [{ version: 1, ok: false, code: 'FISCAL_CERT_INVALID', unreadable: 2 }] })
  })

  it('UMA linha ilegível (a de menor id) e a seguinte boa → versão ok e degraded: não derruba o serviço de todos', async () => {
    const db = fakeDb()
    db.seed(10, MasterKeyRing.of({ 1: randomBytes(32) }))              // versão 1 com outra chave = linha ilegível
    db.seed(11, OLD)
    expect(await verifyStoredKeys({ pool: db.pool, keyring: BOTH }))
      .toEqual({ ok: true, degraded: true, versions: [{ version: 1, ok: true, unreadable: 1 }] })
  })

  it('tenta no máximo [perVersion] amostras: as 3 primeiras ilegíveis → não ok, mesmo com a 4ª boa', async () => {
    const db = fakeDb()
    for (const id of [10, 11, 12]) db.seed(id, MasterKeyRing.of({ 1: randomBytes(32) }))
    db.seed(13, OLD)
    const r = await verifyStoredKeys({ pool: db.pool, keyring: BOTH })
    expect(r.ok).toBe(false)
    expect(r.versions).toEqual([{ version: 1, ok: false, code: 'FISCAL_CERT_INVALID', unreadable: 3 }])
    expect((await verifyStoredKeys({ pool: db.pool, keyring: BOTH }, 4)).ok).toBe(true)
  })

  it('versão em uso ausente do anel → não ok (FISCAL_MASTER_KEY_UNAVAILABLE), nenhuma decifragem tentada', async () => {
    const db = fakeDb()
    db.seed(10, OLD)
    const ring = MasterKeyRing.of({ 2: K2 })
    const open = jest.spyOn(ring, 'open')
    expect(await verifyStoredKeys({ pool: db.pool, keyring: ring }))
      .toEqual({ ok: false, degraded: false, versions: [{ version: 1, ok: false, code: 'FISCAL_MASTER_KEY_UNAVAILABLE', unreadable: 1 }] })
    expect(open).not.toHaveBeenCalled()
  })

  it('sem A1 guardado → ok (nada a provar)', async () => {
    expect(await verifyStoredKeys({ pool: fakeDb().pool, keyring: BOTH })).toEqual({ ok: true, degraded: false, versions: [] })
  })

  it('cada texto claro é zerado depois de aberto; nada do segredo sai no resultado', async () => {
    const db = fakeDb()
    db.seed(10, OLD)
    const opened: Buffer[] = []
    const realOpen = BOTH.open.bind(BOTH)
    const spy = jest.spyOn(BOTH, 'open').mockImplementation((s, aad) => { const b = realOpen(s, aad); opened.push(b); return b })
    try {
      const r = await verifyStoredKeys({ pool: db.pool, keyring: BOTH })
      expect(JSON.stringify(r)).not.toMatch(/PRIVATE|chave-de-teste|CERT-10/)
      expect(opened).toHaveLength(1)
      expect(opened[0].every(b => b === 0)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('rotação — o novo selo que LANÇA ao reabrir conta como "não confere" (gate adversarial, reconferência)', () => {
  it('vai para failed KEY_ROTATION_RESEAL_MISMATCH, nada gravado, e a rodada segue', async () => {
    const db = fakeDb()
    db.seed(10, OLD); db.seed(11, OLD)
    const ring = MasterKeyRing.of({ 1: K1, 2: K2 })
    const realOpen = ring.open.bind(ring)
    let calls = 0
    jest.spyOn(ring, 'open').mockImplementation((s, aad) => {
      calls++
      if (calls === 2) throw new Error('GCM: tag inválida')            // 1ª = abrir o antigo do 10; 2ª = conferir o selo novo do 10
      return realOpen(s, aad)
    })
    const rep = await rotateCertificateKeys({ pool: db.pool, keyring: ring })
    expect(rep.failed).toEqual([{ institutionId: 10, from: null, code: 'KEY_ROTATION_RESEAL_MISMATCH' }])
    expect(rep.rewrapped).toEqual([{ institutionId: 11, from: 1 }])
    expect(db.rows.get(10)!.version).toBe(1)
  })
})
