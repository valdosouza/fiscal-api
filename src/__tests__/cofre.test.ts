/// <reference types="jest" />
// D-F16 — cofre CIFRADO do A1 no fiscal_api + certificado (D-N5/D-N29/D-N31).
// O que se fixa: AES-256-GCM com AAD = identidade da linha (copiar a cifra para outro estabelecimento
// NÃO abre); rotação por versão; chave-mestra ausente = 503 próprio; o PKCS#12 abre na chamada e só o
// par válido do e-CNPJ do PRÓPRIO emitente passa; openIssuer falha na ORDEM e decifra só na chamada.
import { randomBytes } from 'crypto'
import forge from 'node-forge'
import { MasterKeyRing } from '../secret/cipher'
import { pkcs12ToPem, validateIssuerPair, cnpjFromSubject, cpfFromSubject, certificateInfo, ICP_OID_PF_HOLDER, ICP_OID_PJ_HOLDER } from '../secret/certificate'
import { storeCertificate, openIssuer, certificateStatus, certificateAad, isIssuerEnabled, authorityOf, storedKeyVersions, anyEmissionStillInErp } from '../establishment/establishment'
import { clearCertificate } from '../emitter/emitter'   // apagar o A1 é ato do EMITTER (D-NE9 — parte 2 da NE-1a)
import { acquireRefreshLease, releaseRefreshLease, nextDpsNumber, lockIssuerRows, ISSUER_MODELS, assertIssuerModelDomainEnforced } from '../establishment/establishment.repository'
import { makePfx } from './helpers'
import { OPENSSL_LEGACY_ECNPJ_PEM, OPENSSL_SES_PEM } from './certificados-openssl.fixture'

// D-CJ2: CNPJ com DV VÁLIDO — a conferência do A1 lê o CNPJ do ERP pela peça da inscrição federal (forma + DV), não pelo comprimento
const CNPJ = '12345678000195'
const PASSWORD = 'senha-do-pfx'

describe('MasterKeyRing — AES-256-GCM com AAD e versão', () => {
  const k1 = randomBytes(32), k2 = randomBytes(32)

  it('sela e abre; a cifra nunca contém o texto; IV novo a cada selo', () => {
    const ring = MasterKeyRing.of({ 1: k1 })
    const a = ring.seal('-----BEGIN PRIVATE KEY-----X', 'tb_establishment_certificate:1')
    const b = ring.seal('-----BEGIN PRIVATE KEY-----X', 'tb_establishment_certificate:1')
    expect(a.version).toBe(1)
    expect(a.cipher.toString('utf8')).not.toContain('PRIVATE KEY')
    expect(a.iv.equals(b.iv)).toBe(false)
    expect(ring.open(a, 'tb_establishment_certificate:1').toString('utf8')).toBe('-----BEGIN PRIVATE KEY-----X')
  })

  it('AAD de OUTRA linha (cifra copiada para outro estabelecimento) NÃO abre', () => {
    const ring = MasterKeyRing.of({ 1: k1 })
    const sealed = ring.seal('segredo', certificateAad(1))
    expect(() => ring.open(sealed, certificateAad(2))).toThrow()
  })

  it('rotação: a MAIOR versão sela; a antiga continua abrindo o que selou; versão ausente → 503 FISCAL_MASTER_KEY_UNAVAILABLE', () => {
    const old = MasterKeyRing.of({ 1: k1 }).seal('x', 'a')
    const ring = MasterKeyRing.of({ 1: k1, 2: k2 })
    expect(ring.seal('y', 'a').version).toBe(2)
    expect(ring.open(old, 'a').toString()).toBe('x')
    expect(() => MasterKeyRing.of({ 2: k2 }).open(old, 'a')).toThrow(expect.objectContaining({ statusCode: 503, code: 'FISCAL_MASTER_KEY_UNAVAILABLE' }))
    expect(() => MasterKeyRing.of({}).seal('x', 'a')).toThrow(expect.objectContaining({ statusCode: 503 }))
  })

  it('fromEnv: lista "v:base64" e atalho FISCAL_MASTER_KEY; tamanho errado falha alto; selfTest prova a chave', () => {
    const ring = MasterKeyRing.fromEnv({ FISCAL_MASTER_KEYS: `1:${k1.toString('base64')},3:${k2.toString('base64')}` } as any)
    expect(ring.currentVersion).toBe(3)
    expect(ring.selfTest()).toBe(true)
    expect(MasterKeyRing.fromEnv({ FISCAL_MASTER_KEY: k1.toString('base64') } as any).currentVersion).toBe(1)
    expect(() => MasterKeyRing.fromEnv({ FISCAL_MASTER_KEY: 'curta' } as any)).toThrow(/32 bytes/)
    expect(MasterKeyRing.fromEnv({} as any).selfTest()).toBe(false)
  })
})

describe('certificado A1 — PKCS#12 → par PEM validado', () => {
  it('senha ERRADA ou arquivo que não é PKCS#12 → 400 FISCAL_CERT_INVALID no campo pfx', () => {
    const { pfx } = makePfx({ cn: `SETES:${CNPJ}`, password: PASSWORD })
    expect(() => pkcs12ToPem(pfx, 'errada')).toThrow(expect.objectContaining({ statusCode: 400, code: 'FISCAL_CERT_INVALID' }))
    expect(() => pkcs12ToPem(Buffer.from('lixo'), PASSWORD)).toThrow(expect.objectContaining({ statusCode: 400 }))
  })

  it('senha certa → a FOLHA (não a AC da cadeia) + chave; CNPJ do CN; e-CNPJ de OUTRO emitente / e-CPF / CN sem CNPJ → 409', () => {
    const { pfx, certPem } = makePfx({ cn: `SETES SISTEMAS:${CNPJ}`, password: PASSWORD })
    const pair = pkcs12ToPem(pfx, PASSWORD)
    expect(pair.certPem.replace(/\r/g, '')).toBe(certPem.replace(/\r/g, ''))
    const info = validateIssuerPair(pair.certPem, pair.keyPem, CNPJ)
    expect(info.cnpj).toBe(CNPJ)
    expect(() => validateIssuerPair(pair.certPem, pair.keyPem, '98765432000198')).toThrow(expect.objectContaining({ statusCode: 409, code: 'FISCAL_CERT_INVALID' }))
    const cpf = pkcs12ToPem(makePfx({ cn: 'FULANO:12345678909', password: PASSWORD }).pfx, PASSWORD)
    expect(() => validateIssuerPair(cpf.certPem, cpf.keyPem, CNPJ)).toThrow(/e-CPF/)
    const plain = pkcs12ToPem(makePfx({ cn: 'SEM PADRAO', password: PASSWORD }).pfx, PASSWORD)
    expect(() => validateIssuerPair(plain.certPem, plain.keyPem, CNPJ)).toThrow(/sem a inscrição do titular/)
    expect(cnpjFromSubject(`CN=X:${CNPJ}, O=Y`)).toBe(CNPJ)
    expect(cpfFromSubject('CN=X:12345678901')).toBe('12345678901')
  })

  it('VENCIDO → 409 FISCAL_CERT_EXPIRED; ainda não vigente → 409 FISCAL_CERT_INVALID', () => {
    const exp = pkcs12ToPem(makePfx({ cn: `S:${CNPJ}`, password: PASSWORD, notAfter: new Date(Date.now() - 3_600_000), notBefore: new Date(Date.now() - 86_400_000 * 2) }).pfx, PASSWORD)
    expect(() => validateIssuerPair(exp.certPem, exp.keyPem, CNPJ)).toThrow(expect.objectContaining({ code: 'FISCAL_CERT_EXPIRED' }))
    const fut = pkcs12ToPem(makePfx({ cn: `S:${CNPJ}`, password: PASSWORD, notBefore: new Date(Date.now() + 86_400_000) }).pfx, PASSWORD)
    expect(() => validateIssuerPair(fut.certPem, fut.keyPem, CNPJ)).toThrow(/só vale a partir/)
  })

  it('FAIL-CLOSED (gates da F1): estabelecimento sem CNPJ válido no ERP → 422 FISCAL_EMITTER_INCOMPLETE, nunca "aceita qualquer A1"', () => {
    const pair = pkcs12ToPem(makePfx({ cn: `SETES:${CNPJ}`, password: PASSWORD }).pfx, PASSWORD)
    for (const bad of [null, '', '123', '1234567800019']) {
      expect(() => validateIssuerPair(pair.certPem, pair.keyPem, bad)).toThrow(expect.objectContaining({ statusCode: 422, code: 'FISCAL_EMITTER_INCOMPLETE' }))
    }
  })
  it('D-CJ2: CNPJ do ERP em TRÊS estados — ausente ≠ inválido (máscara, minúscula, DV errado, letra mutilável) ≠ válido; nunca mutilado', () => {
    const pair = pkcs12ToPem(makePfx({ cn: `SETES:${CNPJ}`, password: PASSWORD }).pfx, PASSWORD)
    for (const absent of [null, '', '0', { state: 'absent' } as const]) {
      expect(() => validateIssuerPair(pair.certPem, pair.keyPem, absent)).toThrow(/sem CNPJ no cadastro/)
    }
    // antes: '12.345.678/0001-95' passava (tirava a máscara); 'X12345678000195' virava o CNPJ do certificado ao perder a letra
    for (const invalid of ['12.345.678/0001-95', '12345678000199', 'pc3d315k000193', 'X2345678000195', { state: 'invalid', raw: 'X' } as const]) {
      expect(() => validateIssuerPair(pair.certPem, pair.keyPem, invalid)).toThrow(expect.objectContaining({
        statusCode: 422, code: 'FISCAL_EMITTER_INCOMPLETE', message: expect.stringMatching(/CNPJ do estabelecimento inválido/) }))
    }
    expect(validateIssuerPair(pair.certPem, pair.keyPem, { state: 'valid', id: { kind: 'cnpj', value: CNPJ } }).cnpj).toBe(CNPJ)
    // CNPJ alfanumérico VÁLIDO no ERP: conferido como está (o CN do A1 de teste é numérico → outro CNPJ, 409 — nunca "sem CNPJ")
    expect(() => validateIssuerPair(pair.certPem, pair.keyPem, 'PC3D315K000193')).toThrow(expect.objectContaining({ statusCode: 409, code: 'FISCAL_CERT_INVALID' }))
  })
})

// ---------------------------------------------------------------------------
// CNPJ.E4.P1 — titular por CONSENSO das fontes (D-CJ6 + D-CJ33): otherName 2.16.76.1.3.3 × serialNumber × CN legado
// ---------------------------------------------------------------------------
describe('titular do certificado por consenso das fontes (D-CJ6/D-CJ33)', () => {
  const ALFA = 'PC3D315K000193'                         // CNPJ alfanumérico com DV certo (vetor da peça federal-id)
  const OTHER = '98765432000198'
  const PF_CONTENT = '01011980' + '12345678909' + '0'.repeat(36)
  // otherNames do e-CNPJ do perfil ANTIGO que NÃO são o titular (vistos no A1 real de 2026-10-05: .2 nome e .4 dados do responsável, .7 CEI)
  const RESPONSAVEL = [
    { oid: '2.16.76.1.3.2', value: 'FULANO DE TAL' },
    { oid: '2.16.76.1.3.4', value: '01011980' + '12345678909' + '0'.repeat(26) },
    { oid: '2.16.76.1.3.7', value: '000000000000' },
  ]
  const pairOf = (o: Parameters<typeof makePfx>[0]) => pkcs12ToPem(makePfx(o).pfx, o.password)
  const accept = (o: Parameters<typeof makePfx>[0], expected: string) => { const p = pairOf(o); return validateIssuerPair(p.certPem, p.keyPem, expected) }
  const reject = (o: Parameters<typeof makePfx>[0], expected: string, msg: RegExp) => {
    const p = pairOf(o)
    let err: any
    try { validateIssuerPair(p.certPem, p.keyPem, expected) } catch (e) { err = e }
    expect(err).toMatchObject({ statusCode: 409, code: 'FISCAL_CERT_INVALID' })
    expect(err.message).toMatch(msg)
    return err
  }

  it('perfil ANTIGO (CN "RAZÃO:CNPJ" + OID .3.3, com responsável e CEI presentes) → uma inscrição, duas fontes; o CPF do responsável nunca é o titular', () => {
    const info = accept({ cn: `SETES:${CNPJ}`, password: PASSWORD, otherNames: [...RESPONSAVEL, { oid: ICP_OID_PJ_HOLDER, value: CNPJ }] }, CNPJ)
    expect(info.cnpj).toBe(CNPJ)
    expect(info.holder).toEqual({ state: 'found', id: { kind: 'cnpj', value: CNPJ }, sources: ['cn', 'otherName-pj'] })
  })

  it('perfil SE-S (CN = só a razão social + OID .3.3 + serialNumber canônico) → aceito, também com CNPJ alfanumérico', () => {
    for (const cnpj of [CNPJ, ALFA]) {
      const info = accept({ cn: 'SETES SISTEMAS LTDA', password: PASSWORD, serialNumber: cnpj, otherNames: [{ oid: ICP_OID_PJ_HOLDER, value: cnpj }] }, cnpj)
      expect(info.cnpj).toBe(cnpj)
      expect(info.holder).toMatchObject({ state: 'found', sources: ['serialNumber', 'otherName-pj'] })
    }
  })

  it('uma fonte só vale: só o OID .3.3; só o serialNumber com a máscara oficial; só o CN legado alfanumérico', () => {
    expect(accept({ cn: 'RAZAO', password: PASSWORD, otherNames: [{ oid: ICP_OID_PJ_HOLDER, value: ALFA }] }, ALFA).cnpj).toBe(ALFA)
    expect(accept({ cn: 'RAZAO', password: PASSWORD, serialNumber: '12.345.678/0001-95' }, CNPJ).cnpj).toBe(CNPJ)
    expect(accept({ cn: `SETES:${ALFA}`, password: PASSWORD }, ALFA).cnpj).toBe(ALFA)
  })

  it('duas fontes divergentes → 409 "certificado incoerente" que diz quem disse o quê (OID × CN; serialNumber × OID)', () => {
    const a = reject({ cn: `SETES:${CNPJ}`, password: PASSWORD, otherNames: [{ oid: ICP_OID_PJ_HOLDER, value: OTHER }] }, CNPJ, /incoerente/)
    expect(a.message).toContain(OTHER)
    expect(a.message).toContain(CNPJ)
    reject({ cn: 'RAZAO', password: PASSWORD, serialNumber: CNPJ, otherNames: [{ oid: ICP_OID_PJ_HOLDER, value: OTHER }] }, CNPJ, /incoerente/)
    // mesmo que UMA das fontes bata com o estabelecimento: contraditório nunca passa ("a primeira que casa vence" deixaria)
    reject({ cn: `SETES:${OTHER}`, password: PASSWORD, serialNumber: CNPJ }, CNPJ, /incoerente/)
  })

  it('titular PF e PJ no mesmo certificado → incoerente, e o CPF não aparece na mensagem', () => {
    const err = reject({ cn: 'X', password: PASSWORD, otherNames: [{ oid: ICP_OID_PF_HOLDER, value: PF_CONTENT }, { oid: ICP_OID_PJ_HOLDER, value: CNPJ }] }, CNPJ, /incoerente/)
    expect(err.message).not.toContain('12345678909')
    expect(err.message).toContain('um CPF')
  })

  it('nenhuma fonte → 409 "sem a inscrição do titular"', () => {
    reject({ cn: 'SETES SISTEMAS LTDA', password: PASSWORD, otherNames: RESPONSAVEL }, CNPJ, /sem a inscrição do titular/)
  })

  it('e-CPF pelo OID .3.1, pelo serialNumber de 11 dígitos ou pelo CN "NOME:CPF" → 409 e-CPF', () => {
    reject({ cn: 'FULANO', password: PASSWORD, otherNames: [{ oid: ICP_OID_PF_HOLDER, value: PF_CONTENT }] }, CNPJ, /e-CPF/)
    reject({ cn: 'FULANO', password: PASSWORD, serialNumber: '12345678909' }, CNPJ, /e-CPF/)
    reject({ cn: 'FULANO:12345678909', password: PASSWORD }, CNPJ, /e-CPF/)
  })

  it('D-CJ33: campo presente em formato que não sabemos ler → 409 "não reconhece o formato" (nunca aceito por suposição, nunca "sem titular")', () => {
    const cases: Array<[Parameters<typeof makePfx>[0], RegExp]> = [
      [{ cn: `SETES:${CNPJ}`, password: PASSWORD, serialNumber: `TINBR-${CNPJ}` }, /serialNumber/],          // prefixo (ETSI) — não suposto
      [{ cn: `SETES:${CNPJ}`, password: PASSWORD, serialNumber: '12 345 678 0001 95' }, /serialNumber/],      // máscara que não é a oficial
      [{ cn: `SETES:${CNPJ}`, password: PASSWORD, serialNumber: '12345678000199' }, /serialNumber/],          // DV errado
      [{ cn: `SETES:${CNPJ}`, password: PASSWORD, otherNames: [{ oid: ICP_OID_PJ_HOLDER, value: ` ${CNPJ}` }] }, /2\.16\.76\.1\.3\.3/],
      [{ cn: `SETES:${CNPJ}`, password: PASSWORD, otherNames: [{ oid: ICP_OID_PJ_HOLDER, value: '12.345.678/0001-95' }] }, /2\.16\.76\.1\.3\.3/],
      [{ cn: 'FULANO', password: PASSWORD, otherNames: [{ oid: ICP_OID_PF_HOLDER, value: '0101' }] }, /2\.16\.76\.1\.3\.1/],
      [{ cn: 'SETES:12345678000199', password: PASSWORD }, /CN/],                                              // CN legado com DV errado
    ]
    for (const [opts, field] of cases) {
      const err = reject(opts, CNPJ, /não reconhece o formato/)
      expect(err.message).toMatch(field)
      expect(err.message).not.toMatch(/sem a inscrição/)
    }
  })

  it('o OID .3.3 em outro tipo de string (UTF8String, OCTET STRING, IA5String) é lido igual; byte de controle é formato desconhecido', () => {
    const T = forge.asn1.Type
    for (const type of [T.UTF8, T.OCTETSTRING, T.IA5STRING]) {
      expect(accept({ cn: 'RAZAO', password: PASSWORD, otherNames: [{ oid: ICP_OID_PJ_HOLDER, value: CNPJ, type }] }, CNPJ).cnpj).toBe(CNPJ)
    }
    reject({ cn: 'RAZAO', password: PASSWORD, otherNames: [{ oid: ICP_OID_PJ_HOLDER, value: CNPJ + '\u0000', type: T.OCTETSTRING }] }, CNPJ, /não reconhece o formato/)
  })

  it('certificateInfo NUNCA lança por titular incoerente (o cofre lê o certificado guardado): cnpj null e o estado no holder', () => {
    const p = pairOf({ cn: `SETES:${CNPJ}`, password: PASSWORD, serialNumber: OTHER })
    const info = certificateInfo(p.certPem)
    expect(info.cnpj).toBeNull()
    expect(info.holder.state).toBe('conflict')
  })
})

// ---------------------------------------------------------------------------
// Peça do estabelecimento sobre um banco FALSO em memória (linhas das duas tabelas comuns)
// ---------------------------------------------------------------------------
function fakeDb() {
  const certs = new Map<number, any>()
  const issuers = new Map<string, any>()
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    // lockIssuerRows: as LINHAS da PK (institution × modelos pedidos), vivas ou excluídas — `c` = cutover_at
    // (sessão 2026-10-04: antes este falso devolvia ZERO linhas para a trava por acaso — chave `1:undefined`)
    if (/SELECT model, cutover_at AS c FROM tb_establishment_issuer[\s\S]*FOR UPDATE/.test(sql)) {
      return [[...issuers.values()].filter(r => r.institutionId === p[0] && p.slice(1).includes(r.model)).map(r => ({ model: r.model, c: r.cutoverAt ?? null }))]
    }
    if (/SELECT COUNT\(\*\) AS n, SUM\(cutover_at IS NULL\) AS r, SUM\(model = \?\) AS s FROM tb_establishment_issuer/.test(sql)) {     // issuerRowsState
      const all = [...issuers.values()].filter(r => r.institutionId === p[1])
      return [[{ n: all.length, r: all.filter(r => r.cutoverAt == null).length, s: all.filter(r => r.model === p[0]).length }]]
    }
    if (/FROM tb_establishment_issuer/.test(sql)) {
      const row = issuers.get(`${p[0]}:${p[1]}`)
      return [row && row.deleted === 'N' ? [row] : []]
    }
    if (/FROM tb_establishment_certificate/.test(sql)) {
      const r = certs.get(p[0])
      return [r && r.deleted === 'N' ? [{
        institutionId: p[0], cnpj: r.cnpj, certificatePem: r.certificate_pem, cipher: r.cipher, iv: r.iv, tag: r.tag, version: r.version,
        subject: r.subject, issuedBy: r.issued_by, notBefore: r.not_before, notAfter: r.not_after, fingerprint256: r.fp, userId: r.user,
      }] : []]
    }
    if (/INSERT INTO tb_establishment_certificate/.test(sql)) {
      certs.set(p[0], { cnpj: p[1], certificate_pem: p[2], cipher: p[3], iv: p[4], tag: p[5], version: p[6], subject: p[7], issued_by: p[8], not_before: p[9], not_after: p[10], fp: p[11], user: p[12], deleted: 'N' })
      return [{ affectedRows: 1 }]
    }
    if (/UPDATE tb_establishment_certificate/.test(sql)) {
      const r = certs.get(p[1]); if (r) Object.assign(r, { certificate_pem: null, cipher: null, iv: null, tag: null, version: null, deleted: 'S' })
      return [{ affectedRows: r ? 1 : 0 }]
    }
    return [[]]
  })
  const conn = { query, beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
  const pool = { query, getConnection: jest.fn(async () => conn) } as any
  return { pool, certs, issuers, query }
}

describe('peça do estabelecimento — A1 cifrado no fiscal_api + habilitação (D-F16/D-F34)', () => {
  const ring = MasterKeyRing.of({ 1: randomBytes(32) })

  it('upload grava o certificado PÚBLICO + a chave CIFRADA (nunca a chave em claro, nunca a senha); status com CNPJ', async () => {
    const db = fakeDb()
    const { pfx } = makePfx({ cn: `SETES:${CNPJ}`, password: PASSWORD })
    const status = await storeCertificate({ pool: db.pool, keyring: ring }, 1, pfx, PASSWORD, { expectedCnpj: CNPJ, userId: 7, schemaName: 'setes_setes' })
    expect(status).toMatchObject({ certificate: true, privateKey: true, certificateInfo: expect.objectContaining({ cnpj: CNPJ }) })
    const row = db.certs.get(1)
    expect(Buffer.from(row.cipher).toString('utf8')).not.toContain('PRIVATE KEY')
    const everything = JSON.stringify(db.query.mock.calls)
    expect(everything).not.toContain(PASSWORD)
    expect(everything).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(isIssuerEnabled(status)).toBe(true)
  })

  it('upload inválido (senha errada / outro CNPJ) NÃO toca o par existente — cofre = último par válido', async () => {
    const db = fakeDb()
    const { pfx } = makePfx({ cn: `SETES:${CNPJ}`, password: PASSWORD })
    await storeCertificate({ pool: db.pool, keyring: ring }, 1, pfx, PASSWORD, { expectedCnpj: CNPJ, userId: 7, schemaName: 'setes_setes' })
    const before = { ...db.certs.get(1) }
    await expect(storeCertificate({ pool: db.pool, keyring: ring }, 1, pfx, 'errada', { expectedCnpj: CNPJ, userId: 7, schemaName: 'setes_setes' })).rejects.toMatchObject({ statusCode: 400 })
    const other = makePfx({ cn: 'OUTRA:98765432000198', password: PASSWORD }).pfx
    await expect(storeCertificate({ pool: db.pool, keyring: ring }, 1, other, PASSWORD, { expectedCnpj: CNPJ, userId: 7, schemaName: 'setes_setes' })).rejects.toMatchObject({ statusCode: 409 })
    expect(db.certs.get(1)).toEqual(before)
  })

  it('openIssuer falha na ORDEM: sem linha → FISCAL_ISSUER_MISSING; sem A1 → FISCAL_CERT_MISSING; com os dois decifra o par', async () => {
    const db = fakeDb()
    await expect(openIssuer({ pool: db.pool, keyring: ring }, 1, 'SE')).rejects.toMatchObject({ code: 'FISCAL_ISSUER_MISSING' })
    db.issuers.set('1:SE', { institutionId: 1, model: 'SE', environment: 'H', serie: '1', userId: null, cutoverAt: '2026-10-04 00:00:00', deleted: 'N' })
    await expect(openIssuer({ pool: db.pool, keyring: ring }, 1, 'SE')).rejects.toMatchObject({ code: 'FISCAL_CERT_MISSING' })
    const { pfx } = makePfx({ cn: `SETES:${CNPJ}`, password: PASSWORD })
    await storeCertificate({ pool: db.pool, keyring: ring }, 1, pfx, PASSWORD, { expectedCnpj: CNPJ, userId: 7, schemaName: 'setes_setes' })
    const opened = await openIssuer({ pool: db.pool, keyring: ring }, 1, 'SE', { forUpdate: true })
    expect(opened.issuer).toMatchObject({ model: 'SE', environment: 'H', serie: '1' })
    expect(opened.key.toString()).toMatch(/BEGIN (RSA )?PRIVATE KEY/)
    expect(opened.info.cnpj).toBe(CNPJ)
    expect(db.query.mock.calls.some(([sql]) => /tb_establishment_issuer[\s\S]*FOR UPDATE/.test(sql))).toBe(true)
  })

  it('chave-mestra TROCADA (cifra não abre) → 409 FISCAL_CERT_INVALID legível, nunca 500', async () => {
    const db = fakeDb()
    db.issuers.set('1:SE', { institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: null, cutoverAt: '2026-10-04 00:00:00', deleted: 'N' })
    const { pfx } = makePfx({ cn: `SETES:${CNPJ}`, password: PASSWORD })
    await storeCertificate({ pool: db.pool, keyring: ring }, 1, pfx, PASSWORD, { expectedCnpj: CNPJ, userId: 7, schemaName: 'setes_setes' })
    const otherRing = MasterKeyRing.of({ 1: randomBytes(32) })
    await expect(openIssuer({ pool: db.pool, keyring: otherRing }, 1, 'SE')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CERT_INVALID' })
  })

  it('excluir o A1 zera os segredos (chave excluída não fica guardada); autoridade é FUNÇÃO do modelo', async () => {
    const db = fakeDb()
    const { pfx } = makePfx({ cn: `SETES:${CNPJ}`, password: PASSWORD })
    await storeCertificate({ pool: db.pool, keyring: ring }, 1, pfx, PASSWORD, { expectedCnpj: CNPJ, userId: 7, schemaName: 'setes_setes' })
    const st = await clearCertificate({ pool: db.pool, keyring: ring }, 1, 7, { schemaName: 'setes_setes' })
    expect(st).toEqual({ certificate: false, privateKey: false, certificateInfo: null })
    expect(db.certs.get(1)).toMatchObject({ cipher: null, iv: null, tag: null, deleted: 'S' })
    expect(await certificateStatus(db.pool, 1)).toMatchObject({ certificate: false })
    expect([authorityOf('SE'), authorityOf('55'), authorityOf('65')]).toEqual(['ADN', 'SEFAZ', 'SEFAZ'])
  })

  // parte 2 da NE-1a (D-NE9): a guarda INJETADA pela família morreu — o EMITTER do núcleo conta as vivas de TODAS as famílias pela leitura
  // publicada (view); a promessa é a mesma: recusou DENTRO da transação, depois da trava → segredos intactos, rollback
  it('guarda das VIVAS roda DENTRO da transação antes de apagar: recusou → segredos intactos, rollback', async () => {
    const db = fakeDb()
    const { pfx } = makePfx({ cn: `SETES:${CNPJ}`, password: PASSWORD })
    await storeCertificate({ pool: db.pool, keyring: ring }, 1, pfx, PASSWORD, { expectedCnpj: CNPJ, userId: 7, schemaName: 'setes_setes' })
    const before = { ...db.certs.get(1) }
    const plain = db.query.getMockImplementation()!
    db.query.mockImplementation(async (sql: string, p: any[] = []) => (/COUNT\(\*\) AS n FROM vw_invoice_service_transmission/.test(sql) ? [[{ n: 1 }]] : plain(sql, p)))
    db.query.mockClear()
    await expect(clearCertificate({ pool: db.pool, keyring: ring }, 1, 7, { schemaName: 'setes_setes' })).rejects.toMatchObject({ code: 'FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS' })
    const sqls = db.query.mock.calls.map(([sql]) => String(sql))
    expect(sqls.findIndex(s => /FOR UPDATE/.test(s))).toBeLessThan(sqls.findIndex(s => /FROM vw_invoice_service_transmission/.test(s)))   // trava ANTES de contar
    expect(db.certs.get(1)).toEqual(before)
    const conn = await db.pool.getConnection()
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('versões de chave-mestra que ainda cifram A1 vivo (o health confere contra o anel)', async () => {
    const q = { query: jest.fn(async () => [[{ v: 1 }, { v: 3 }, { v: null }]]) } as any
    expect(await storedKeyVersions(q)).toEqual([1, 3])
    expect(q.query.mock.calls[0][0]).toMatch(/deleted = 'N'/)
  })
})

describe('ALUGUEL da consulta ativa (migration 002 — gates da F1): UPDATE atômico, nenhuma conexão retida, devolução só pelo DONO', () => {
  it('ganha só quem mudou a linha (aluguel livre ou vencido) e recebe o TOKEN; ocupado/sem linha → null', async () => {
    const q = { query: jest.fn(async (sql: string) => (/^\s*UPDATE/.test(sql) ? [{ affectedRows: 1 }] : [[{ token: '2026-10-04 12:01:00' }]])) } as any
    expect(await acquireRefreshLease(q, 1, 'SE', 60)).toBe('2026-10-04 12:01:00')
    const [sql, params] = q.query.mock.calls[0]
    expect(sql).toMatch(/refresh_lease_until IS NULL OR refresh_lease_until < NOW\(\)/)
    expect(params).toEqual([60, 1, 'SE'])
    q.query.mockResolvedValueOnce([{ affectedRows: 0 }])
    expect(await acquireRefreshLease(q, 1, 'SE', 60)).toBeNull()
  })

  it('devolver apaga SÓ o aluguel do próprio dono (gate adversarial R2: a passada que estourou não apaga o da seguinte)', async () => {
    const q = { query: jest.fn(async () => [{ affectedRows: 0 }]) } as any
    expect(await releaseRefreshLease(q, 1, 'SE', '2026-10-04 12:01:00')).toBe(false)     // já é de outro
    const [sql, params] = q.query.mock.calls[0]
    expect(sql).toMatch(/SET refresh_lease_until = NULL[\s\S]*refresh_lease_until = \?/)
    expect(params).toEqual([1, 'SE', '2026-10-04 12:01:00'])
    q.query.mockResolvedValueOnce([{ affectedRows: 1 }])
    expect(await releaseRefreshLease(q, 1, 'SE', '2026-10-04 12:01:00')).toBe(true)
  })
})

describe('D-F45 — boot confere que o motor APLICA o CHECK do domínio do modelo (migration 004)', () => {
  const poolWith = (insert: () => Promise<any>) => {
    const conn = { beginTransaction: jest.fn(), rollback: jest.fn(), release: jest.fn(), query: jest.fn(async () => insert()) }
    return { conn, pool: { getConnection: jest.fn(async () => conn) } as any }
  }
  it('o banco RECUSA o modelo fora do domínio (MariaDB 4025 / MySQL 3819) pelo CHECK BINÁRIO da 005 (D-NE84; a recusa conta só se vier dele — F2A1-05) → boot segue; a transação é sempre desfeita', async () => {
    for (const errno of [4025, 3819]) {
      const { conn, pool } = poolWith(async () => { throw Object.assign(new Error('CONSTRAINT `ck_establishment_issuer_model_bin` failed'), { errno }) })
      await expect(assertIssuerModelDomainEnforced(pool)).resolves.toBeUndefined()
      expect(conn.rollback).toHaveBeenCalledTimes(1)
      expect(conn.release).toHaveBeenCalledTimes(1)
    }
  })
  it('o banco ACEITA o modelo fora do domínio (motor que ignora CHECK) → boot FALHA ALTO, e nada fica gravado (rollback)', async () => {
    const { conn, pool } = poolWith(async () => [{ affectedRows: 1 }])
    await expect(assertIssuerModelDomainEnforced(pool)).rejects.toThrow(/não aplica CHECK/)
    expect(conn.rollback).toHaveBeenCalledTimes(1)
  })
  it('[F2A1-05, F2a] a recusa pelo CHECK _ci ANTIGO da 004 (`ck_establishment_issuer_model`) NÃO prova o domínio binário — falha ALTO com o diagnóstico ("recusada por OUTRO CHECK")', async () => {
    const e = Object.assign(new Error('CONSTRAINT `ck_establishment_issuer_model` failed'), { errno: 4025 })
    const { pool } = poolWith(async () => { throw e })
    await expect(assertIssuerModelDomainEnforced(pool)).rejects.toThrow(/recusada por OUTRO CHECK, não pelo ck_establishment_issuer_model_bin/)
  })
  it('outro erro (ex.: sem permissão) sobe como está — nunca vira "o motor aplica"', async () => {
    const { pool } = poolWith(async () => { throw Object.assign(new Error('INSERT command denied'), { errno: 1142, code: 'ER_TABLEACCESS_DENIED_ERROR' }) })
    await expect(assertIssuerModelDomainEnforced(pool)).rejects.toMatchObject({ errno: 1142 })
  })
})

describe('sessão 2026-10-04 — trava da habilitação POR LINHA e réplica excluída no openIssuer', () => {
  it('lockIssuerRows trava as LINHAS da PK (institution × cada modelo), nunca a FAIXA da institution (promoção de trava → 1213 no aluguel)', async () => {
    const q = { query: jest.fn(async () => [[{ model: 'SE', c: null }, { model: '55', c: '2026-10-04 00:00:00' }]] as any) }
    expect(await lockIssuerRows(q, 7)).toEqual({ rows: 2, replicas: 1, serviceRows: 1 })                 // D-F57: a contagem SE vem junto
    const [sql, params] = (q.query.mock.calls[0] as unknown) as [string, unknown[]]
    expect(sql).toMatch(/WHERE tb_institution_id = \? AND model IN \(\?, \?, \?\) FOR UPDATE/)
    expect(params).toEqual([7, ...ISSUER_MODELS])
  })

  it('openIssuer: réplica EXCLUÍDA → 409 FISCAL_CUTOVER_PENDING (excluir não apaga a virada); sem linha nenhuma → FISCAL_ISSUER_MISSING', async () => {
    const ring = MasterKeyRing.of({ 1: randomBytes(32) })
    const db = fakeDb()
    await expect(openIssuer({ pool: db.pool, keyring: ring }, 1, 'SE')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_ISSUER_MISSING' })
    db.issuers.set('1:SE', { institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: null, cutoverAt: null, deleted: 'S' })
    await expect(openIssuer({ pool: db.pool, keyring: ring }, 1, 'SE')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CUTOVER_PENDING' })
    db.issuers.set('1:SE', { institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: null, cutoverAt: '2026-10-04 00:00:00', deleted: 'S' })
    await expect(openIssuer({ pool: db.pool, keyring: ring }, 1, 'SE')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_ISSUER_MISSING' })   // virada e excluída: configurar de novo
  })
})

describe('openIssuer na DECISÃO que grava (gate adversarial R2): o A1 é lido ATUAL, não do snapshot', () => {
  it('forUpdate → habilitação FOR UPDATE e A1 LOCK IN SHARE MODE (nessa ordem); leitura comum não trava', async () => {
    const db = fakeDb()
    db.issuers.set('1:SE', { institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: null, cutoverAt: '2026-10-04 00:00:00', deleted: 'N' })
    const { pfx } = makePfx({ cn: `SETES:${CNPJ}`, password: PASSWORD })
    const ring = MasterKeyRing.of({ 1: randomBytes(32) })
    await storeCertificate({ pool: db.pool, keyring: ring }, 1, pfx, PASSWORD, { expectedCnpj: CNPJ, userId: 7, schemaName: 'setes_setes' })
    db.query.mockClear()
    await openIssuer({ pool: db.pool, keyring: ring }, 1, 'SE', { forUpdate: true })
    const sqls = db.query.mock.calls.map(([sql]) => String(sql))
    const iIssuer = sqls.findIndex(x => /tb_establishment_issuer[\s\S]*FOR UPDATE/.test(x))
    const iCert = sqls.findIndex(x => /tb_establishment_certificate[\s\S]*LOCK IN SHARE MODE/.test(x))
    expect(iIssuer).toBeGreaterThanOrEqual(0)
    expect(iCert).toBeGreaterThan(iIssuer)
    db.query.mockClear()
    await openIssuer({ pool: db.pool, keyring: ring }, 1, 'SE')
    expect(db.query.mock.calls.some(([sql]) => /LOCK IN SHARE MODE|FOR UPDATE/.test(String(sql)))).toBe(false)
  })
})

describe('VIRADA da emissão como FATO na habilitação (D-F39 — migration 003)', () => {
  const ring = MasterKeyRing.of({ 1: randomBytes(32) })

  it('RÉPLICA do ERP (cutover_at NULL) não ABRE o emissor: 409 FISCAL_CUTOVER_PENDING antes do A1', async () => {
    const db = fakeDb()
    db.issuers.set('1:SE', { institutionId: 1, model: 'SE', environment: 'P', serie: '1', userId: null, cutoverAt: null, deleted: 'N' })
    await expect(openIssuer({ pool: db.pool, keyring: ring }, 1, 'SE')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CUTOVER_PENDING' })
    expect(db.query.mock.calls.some(([sql]) => /tb_establishment_certificate/.test(String(sql)))).toBe(false)
  })

  it('a condição está NO comando que cunha o nDPS e no do aluguel (`cutover_at IS NOT NULL`); réplica viva → 409, sem linha → erro técnico', async () => {
    const calls: string[] = []
    const conn = { query: jest.fn(async (sql: string) => { calls.push(sql); return /^\s*UPDATE/.test(sql) ? [{ affectedRows: 0 }] : [[{ x: 1 }]] }) } as any
    await expect(nextDpsNumber(conn, 1)).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CUTOVER_PENDING' })
    expect(calls[0]).toMatch(/cutover_at IS NOT NULL/)
    const none = { query: jest.fn(async (sql: string) => (/^\s*UPDATE/.test(sql) ? [{ affectedRows: 0 }] : [[]])) } as any
    await expect(nextDpsNumber(none, 1)).rejects.toThrow(/habilitação ausente/)
    const q = { query: jest.fn(async () => [{ affectedRows: 0 }]) } as any
    expect(await acquireRefreshLease(q, 1, 'SE', 60)).toBeNull()
    expect(q.query.mock.calls[0][0]).toMatch(/cutover_at IS NOT NULL/)
  })

  it('escrever/apagar o A1 (gates R4): a 1ª instrução da transação é a TRAVA das linhas da habilitação; réplica (viva ou excluída) e lacuna (b) recusam', async () => {
    const calls: string[] = []
    const mkConn = (rows: any[], erpHas: boolean) => ({
      query: jest.fn(async (sql: string) => {
        calls.push(sql)
        if (/SELECT model, cutover_at AS c FROM tb_establishment_issuer[\s\S]*FOR UPDATE/.test(sql)) return [rows]
        if (/`setes_setes`\.tb_establishment_issuer/.test(sql)) return [erpHas ? [{ x: 1 }] : []]
        return [[]]
      }),
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    })
    const run = async (rows: any[], erpHas: boolean) => {
      calls.length = 0
      const conn = mkConn(rows, erpHas)
      const pool = { query: conn.query, getConnection: jest.fn(async () => conn) } as any
      return clearCertificate({ pool, keyring: ring }, 1, 7, { schemaName: 'setes_setes' }).then(() => 'ok', (e: any) => e.code)
    }
    expect(await run([{ model: 'SE', c: null }], false)).toBe('FISCAL_CUTOVER_PENDING')   // réplica (viva ou excluída: a trava lê todas)
    expect(calls[0]).toMatch(/FOR UPDATE/)                                                  // 1ª instrução = trava
    expect(await run([], true)).toBe('FISCAL_CUTOVER_PENDING')                              // lacuna (b): sem linha, SE no ERP
    expect(await run([{ model: 'SE', c: '2026-10-04 00:00:00' }], true)).toBe('ok')         // SE virada: o ERP não decide mais
    expect(await run([], false)).toBe('ok')                                                 // institution nova
    // D-F57 (= Q-F64 (a)): uma 55 VIRADA (nasce virada — D-F42) NÃO esconde a SE que o ERP ainda emite
    expect(await run([{ model: '55', c: '2026-10-04 00:00:00' }], true)).toBe('FISCAL_CUTOVER_PENDING')
    expect(await run([{ model: '55', c: '2026-10-04 00:00:00' }], false)).toBe('ok')
  })

  it('predicado "ainda emitido pelo ERP": réplica (viva ou excluída) → sim; só linhas viradas → não; nenhuma linha → a habilitação SE do ERP decide (tabela ausente = não)', async () => {
    const mk = (state: { n: number; r: number; s?: number }, erp: 'tem' | 'nao' | 'sem-tabela') => ({
      query: jest.fn(async (sql: string) => {
        if (/COUNT\(\*\) AS n, SUM\(cutover_at IS NULL\) AS r, SUM\(model = \?\) AS s/.test(sql)) return [[{ n: state.n, r: state.r, s: state.s ?? state.n }]]
        if (/`setes_setes`\.tb_establishment_issuer/.test(sql)) {
          if (erp === 'sem-tabela') throw Object.assign(new Error("Table doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })
          return [erp === 'tem' ? [{ x: 1 }] : []]
        }
        return [[]]
      }),
    }) as any
    expect(await anyEmissionStillInErp(mk({ n: 1, r: 1 }, 'nao'), 'setes_setes', 1)).toBe(true)
    expect(await anyEmissionStillInErp(mk({ n: 2, r: 0 }, 'tem'), 'setes_setes', 1)).toBe(false)     // virada: o ERP não decide mais
    expect(await anyEmissionStillInErp(mk({ n: 0, r: 0 }, 'tem'), 'setes_setes', 1)).toBe(true)      // lacuna: ainda não migrada
    expect(await anyEmissionStillInErp(mk({ n: 0, r: 0 }, 'nao'), 'setes_setes', 1)).toBe(false)     // institution nova
    expect(await anyEmissionStillInErp(mk({ n: 0, r: 0 }, 'sem-tabela'), 'setes_setes', 1)).toBe(false)
    // D-F57 (= Q-F64 (a)): só a 55 virada no fiscal_api + SE no ERP → AINDA do ERP (antes: "há linha" escondia a SE)
    expect(await anyEmissionStillInErp(mk({ n: 1, r: 0, s: 0 }, 'tem'), 'setes_setes', 1)).toBe(true)
    expect(await anyEmissionStillInErp(mk({ n: 1, r: 0, s: 0 }, 'nao'), 'setes_setes', 1)).toBe(false)
  })
})

// Gates de 2026-11-18 (socrático 0,80 · adversarial 0,82, nenhum HIGH): MEDIUM e LOW corrigidos, cada um com o seu teste
describe('titular por consenso — correções dos gates (CNPJ.E4.P1)', () => {
  const OTHER = '98765432000198'
  const pairOf = (o: Parameters<typeof makePfx>[0]) => pkcs12ToPem(makePfx(o).pfx, o.password)
  const holderOf = (o: Parameters<typeof makePfx>[0]) => certificateInfo(pairOf(o).certPem).holder
  const T = forge.asn1.Type

  it('[MEDIUM, os dois gates] certificado do OPENSSL (não do forge): perfil antigo com CN acentuado + responsável/CEI, e SE-S com serialNumber', () => {
    expect(certificateInfo(OPENSSL_LEGACY_ECNPJ_PEM).holder).toEqual({ state: 'found', id: { kind: 'cnpj', value: CNPJ }, sources: ['cn', 'otherName-pj'] })
    expect(certificateInfo(OPENSSL_SES_PEM).holder).toEqual({ state: 'found', id: { kind: 'cnpj', value: 'PC3D315K000193' }, sources: ['serialNumber', 'otherName-pj'] })
    expect(certificateInfo(OPENSSL_SES_PEM).cnpj).toBe('PC3D315K000193')
  })

  it('[MEDIUM] CN com acento em UTF8String conta como fonte: sozinho vale; divergente do OID dá incoerente (antes saía da conta e escondia)', () => {
    const cn = (cnpj: string) => ({ cn: `EMPRESA SÃO JOÃO:${cnpj}`, password: PASSWORD })
    expect(holderOf(cn(CNPJ))).toMatchObject({ state: 'found', sources: ['cn'] })
    expect(holderOf({ ...cn(OTHER), otherNames: [{ oid: ICP_OID_PJ_HOLDER, value: CNPJ }] }).state).toBe('conflict')
  })

  it('[MEDIUM] CN que não decodifica mas termina numa inscrição → não suportado (nunca "sem fonte")', () => {
    // T61String com byte de controle antes da inscrição: não decodifica como texto, os bytes terminam em ":<CNPJ>"
    const p = makePfx({ cn: 'X', password: PASSWORD })
    const cert = forge.pki.certificateFromPem(p.certPem)
    const subj = cert.subject.attributes.map(a => a.shortName === 'CN' ? { ...a, value: `X\u0001:${CNPJ}` } : a)
    const keys = forge.pki.rsa.generateKeyPair(1024)
    cert.publicKey = keys.publicKey; cert.setSubject(subj as forge.pki.CertificateField[]); cert.sign(keys.privateKey, forge.md.sha256.create())
    expect(certificateInfo(forge.pki.certificateToPem(cert)).holder).toEqual({ state: 'unsupported', source: 'cn' })
  })

  it('[LOW, adversarial] SubjectAltName fora da forma (otherName primitivo, tipo que não é OID) → DER que não fecha, nunca pulado', () => {
    const { asn1 } = forge
    const build = (san: forge.asn1.Asn1) => {
      const keys = forge.pki.rsa.generateKeyPair(1024)
      const c = forge.pki.createCertificate()
      c.publicKey = keys.publicKey; c.serialNumber = '01'
      c.validity.notBefore = new Date(Date.now() - 86_400_000); c.validity.notAfter = new Date(Date.now() + 86_400_000)
      c.setSubject([{ name: 'commonName', value: `S:${CNPJ}` }]); c.setIssuer([{ name: 'commonName', value: 'AC' }])
      c.setExtensions([{ id: '2.5.29.17', value: san }]); c.sign(keys.privateKey, forge.md.sha256.create())
      return certificateInfo(forge.pki.certificateToPem(c)).holder
    }
    const seq = (items: forge.asn1.Asn1[]) => asn1.create(asn1.Class.UNIVERSAL, T.SEQUENCE, true, items)
    expect(build(seq([asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, false, 'x')]))).toEqual({ state: 'unsupported', source: 'der' })
    expect(build(seq([asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [asn1.create(asn1.Class.UNIVERSAL, T.PRINTABLESTRING, false, 'x')])])))
      .toEqual({ state: 'unsupported', source: 'der' })
    expect(build(asn1.create(asn1.Class.UNIVERSAL, T.OCTETSTRING, false, 'abc'))).toEqual({ state: 'unsupported', source: 'der' })
  })

  it('[LOW, socrático] casos que faltavam: BMPString, dois serialNumber divergentes, outro CNPJ só pelo OID ou só pelo serialNumber, CPF mascarado', () => {
    expect(holderOf({ cn: 'R', password: PASSWORD, otherNames: [{ oid: ICP_OID_PJ_HOLDER, value: Buffer.from(CNPJ, 'utf16le').swap16().toString('binary'), type: T.BMPSTRING }] }))
      .toMatchObject({ state: 'found', id: { value: CNPJ } })
    const two = makePfx({ cn: 'R', password: PASSWORD, serialNumber: CNPJ })
    const c = forge.pki.certificateFromPem(two.certPem)
    const keys = forge.pki.rsa.generateKeyPair(1024)
    c.publicKey = keys.publicKey
    c.setSubject([...c.subject.attributes, { type: '2.5.4.5', value: OTHER, valueTagClass: T.PRINTABLESTRING } as unknown as forge.pki.CertificateField] as forge.pki.CertificateField[])
    c.sign(keys.privateKey, forge.md.sha256.create())
    expect(certificateInfo(forge.pki.certificateToPem(c)).holder.state).toBe('conflict')
    for (const o of [{ otherNames: [{ oid: ICP_OID_PJ_HOLDER, value: OTHER }] }, { serialNumber: OTHER }]) {
      const p = pairOf({ cn: 'R', password: PASSWORD, ...o })
      expect(() => validateIssuerPair(p.certPem, p.keyPem, CNPJ)).toThrow(new RegExp(`Certificado do CNPJ ${OTHER}`))
    }
    expect(holderOf({ cn: 'R', password: PASSWORD, serialNumber: '123.456.789-09' })).toEqual({ state: 'unsupported', source: 'serialNumber' })
  })

  it('[LOW, socrático] e-CPF com acento no órgão expedidor do .3.1 segue "e-CPF" (só as 19 primeiras posições são lidas)', () => {
    const p = pairOf({ cn: 'FULANO', password: PASSWORD, otherNames: [{ oid: ICP_OID_PF_HOLDER, value: forge.util.encodeUtf8('01011980' + '12345678909' + '0'.repeat(26) + 'SSPÃOSP'), type: T.UTF8 }] })
    expect(() => validateIssuerPair(p.certPem, p.keyPem, CNPJ)).toThrow(/e-CPF/)
  })

  it('[LOW, socrático] dois CPFs diferentes em conflito: legível ("um CPF (1)" × "(2)") sem mostrar nenhum', () => {
    const p = pairOf({ cn: 'FULANO:52998224725', password: PASSWORD, serialNumber: '12345678909' })
    let err: any
    try { validateIssuerPair(p.certPem, p.keyPem, CNPJ) } catch (e) { err = e }
    expect(err.message).toMatch(/um CPF \(1\).*um CPF \(2\)/)
    expect(err.message).not.toMatch(/52998224725|12345678909/)
  })
})
