/// <reference types="jest" />
// NE-1a parte 2 — passo 6: D-NE57 (= Q-NE57 (a), Valdo 2026-10-11) — a cadeia do SERVIDOR do fisco (`prompt_onda_nfe_sefaz.md` §12.9.7).
//  - o transporte aceita `ca` (raízes do servidor — a SEFAZ usa ICP-Brasil) e só o passa ao Node quando DITO: no Node, `ca` SUBSTITUI a loja
//    padrão (conhecimento negativo — nunca no ADN);
//  - falha de verificação do certificado do SERVIDOR (código do Node/OpenSSL, nunca a mensagem) → 409 FISCAL_AUTHORITY_CHAIN_UNTRUSTED, voz F
//    inalterada (antes do aperto de mão nada chegou), em EMITTER_FAILURE_CODES, `logger.error`;
//  - cerca: nenhum `rejectUnauthorized` em código de produção do núcleo e das famílias.
import fs from 'fs'
import path from 'path'
import https from 'https'
import { EventEmitter } from 'events'
import ts from 'typescript'
import { httpsRequest, authorityJson, transport, isServerChainError, isTlsCredentialError } from '../transport/https-json'
import { classifyAuthorityError, OUTCOME_KIND, EMITTER_FAILURE_CODES } from '../voice/outcome'
import { ErrorCodes, ErrorCatalog } from '../errors/error-codes'
import { logger } from '../log/logger'

/** `https.request` FALSO: guarda as opções e falha a conexão (nenhum socket). */
function captureRequest(): { options: () => any; restore: () => void } {
  let captured: any = null
  const spy = jest.spyOn(https, 'request').mockImplementation(((opts: any) => {
    captured = opts
    const req: any = new EventEmitter()
    req.write = () => undefined
    req.end = () => setImmediate(() => req.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })))
    req.destroy = () => undefined
    return req
  }) as any)
  return { options: () => captured, restore: () => spy.mockRestore() }
}

describe('transporte — `ca` só quando dito (D-NE57)', () => {
  it('sem `ca` na chamada, a opção NEM EXISTE (loja padrão do Node); com `ca`, vai exatamente o que foi dito', async () => {
    const r = captureRequest()
    try {
      await httpsRequest({ url: 'https://exemplo.invalid/x', method: 'GET' }).catch(() => undefined)
      expect(Object.prototype.hasOwnProperty.call(r.options(), 'ca')).toBe(false)
      const ca = [Buffer.from('raiz-icp-brasil')]
      await httpsRequest({ url: 'https://exemplo.invalid/x', method: 'GET', ca }).catch(() => undefined)
      expect(r.options().ca).toBe(ca)
      expect(Object.prototype.hasOwnProperty.call(r.options(), 'rejectUnauthorized')).toBe(false)
    } finally { r.restore() }
  })
})

describe('cadeia do SERVIDOR → FISCAL_AUTHORITY_CHAIN_UNTRUSTED (D-NE57)', () => {
  const real = transport.request
  afterEach(() => { transport.request = real; jest.restoreAllMocks() })
  const failWith = (err: unknown) => { transport.request = async () => { throw err } }

  it('decide o CÓDIGO, nunca a mensagem: código de verificação X.509 = cadeia; a mesma frase sem código segue credencial', () => {
    expect(isServerChainError(Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }))).toBe(true)
    expect(isServerChainError(new Error('certificate has expired'))).toBe(false)
    expect(isServerChainError(Object.assign(new Error('x'), { code: 'EPROTO' }))).toBe(false)
    expect(isServerChainError(Object.assign(new Error('x'), { code: 'ERR_OSSL_PEM_NO_START_LINE' }))).toBe(false)
    expect(isTlsCredentialError(new Error('certificate has expired'))).toBe(true)
  })
  it('antes do aperto de mão: 409 com código e mensagem PRÓPRIOS (não manda conferir/renovar o A1), `logger.error` (semente do alarme) e voz F pela classificação EXPLÍCITA', async () => {
    const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined)
    failWith(Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', afterHandshake: false }))
    const err: any = await authorityJson({ url: 'https://sefaz.invalid/ws', method: 'POST' }, 'teste').catch(e => e)
    expect([err.statusCode, err.code, err.authorityStatus, err.body]).toEqual([409, ErrorCodes.FISCAL_AUTHORITY_CHAIN_UNTRUSTED, 0, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])
    expect(err.message).toMatch(/servidor do fisco/)
    expect(err.message).not.toMatch(/confira o A1|renove|\.pfx/i)
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/SERVIDOR do fisco não confiável/), expect.objectContaining({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }))
    expect(classifyAuthorityError(err)).toBe('chain_untrusted')
    expect(OUTCOME_KIND.chain_untrusted).toBe('F')
    expect(EMITTER_FAILURE_CODES.has(ErrorCodes.FISCAL_AUTHORITY_CHAIN_UNTRUSTED)).toBe(true)
    expect(ErrorCatalog.FISCAL_AUTHORITY_CHAIN_UNTRUSTED).toMatch(/não é o A1/)
  })
  it('depois do aperto de mão segue AMBÍGUO (Q-ADV1a — 503, em voo); credencial LOCAL segue FISCAL_CERT_INVALID; o resto do TLS segue AUTH_FAILED', async () => {
    failWith(Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED', afterHandshake: true }))
    await expect(authorityJson({ url: 'https://x.invalid', method: 'GET' }, 't')).rejects.toMatchObject({ statusCode: 503, code: ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE })
    failWith(Object.assign(new Error('PEM routines'), { code: 'ERR_OSSL_PEM_NO_START_LINE' }))
    await expect(authorityJson({ url: 'https://x.invalid', method: 'GET' }, 't')).rejects.toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_CERT_INVALID })
    failWith(Object.assign(new Error('write EPROTO'), { code: 'EPROTO' }))
    await expect(authorityJson({ url: 'https://x.invalid', method: 'GET' }, 't')).rejects.toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED })
  })
})

describe('cerca — nenhum `rejectUnauthorized` em produção (núcleo e famílias)', () => {
  const WORKSPACE = path.resolve(__dirname, '..', '..', '..')
  const walk = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? (d.name === '__tests__' || d.name === 'node_modules' ? [] : walk(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []))
  /** Identificadores/propriedades `rejectUnauthorized` e a variável de ambiente que desliga a verificação do Node, por AST (comentário fora). */
  const hits = (code: string): string[] => {
    const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const out: string[] = []
    const visit = (n: ts.Node): void => {
      if ((ts.isIdentifier(n) || ts.isStringLiteral(n)) && /^(?:rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED)$/.test(n.text)) out.push(n.text)
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return out
  }
  it('a cerca não é cega e o código real está limpo', () => {
    expect(hits("https.request({ rejectUnauthorized: false })\nprocess.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'")).toEqual(['rejectUnauthorized', 'NODE_TLS_REJECT_UNAUTHORIZED'])
    expect(hits('// rejectUnauthorized: false')).toEqual([])
    const files = [
      ...walk(path.join(WORKSPACE, 'fiscal-api', 'src')), ...walk(path.join(WORKSPACE, 'nfse-api', 'src')),
      ...walk(path.join(WORKSPACE, 'nfse-api', 'scripts')), ...walk(path.join(WORKSPACE, 'nfe-api', 'src')),
    ]
    expect(files.length).toBeGreaterThan(30)
    expect(files.flatMap(f => hits(fs.readFileSync(f, 'utf8')).map(h => `${path.relative(WORKSPACE, f)}: ${h}`))).toEqual([])
  })
})
