/// <reference types="jest" />
// D-F157 (= Q-F165 (a), Valdo 2026-10-13 — gate socrático da F2b, F2B-SOCD-01): a CLASSE de cada 401 do produto vai ao LOG (nunca o token),
// com o kid SANEADO e limite por classe por minuto (`prompt_apis_fiscais_isoladas.md` §7, §22.20).
import { generateKeyPairSync } from 'crypto'
import jwt from 'jsonwebtoken'
import { HttpError } from '../errors/http-error'
import { ProductTokenVerifier, productAuth, authRejectLog, safeKid, AuthReject } from '../auth/product-jwt'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const verifier = ProductTokenVerifier.of({ k1: pubPem })
const claims = { institutionId: 3, userId: 7, role: 'admin', schemaName: 'setes_x' }
const sign = (c: object, kid = 'k1', opts: jwt.SignOptions = {}) => jwt.sign(c, privPem, { algorithm: 'RS256', keyid: kid, expiresIn: '1h', ...opts })

async function call(authorization: string | undefined, check?: (p: any) => Promise<void>) {
  const seen: AuthReject[] = []
  const mw = productAuth(verifier, check, r => { seen.push(r) })
  const res: any = { status: jest.fn(function (this: any) { return this }), json: jest.fn() }
  const next = jest.fn()
  await mw({ headers: authorization === undefined ? {} : { authorization }, method: 'GET', baseUrl: '/v1/nfse', path: '/x' } as any, res, next)
  return { seen, res, next }
}

describe('D-F157 — a CLASSE do 401 no log (nunca o token)', () => {
  it('cada recusa diz a classe: ausente, malformado, kid desconhecido (com o kid), expirado, assinatura, sem identidade, institution divergente', async () => {
    const expired = jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 10 }, privPem, { algorithm: 'RS256', keyid: 'k1' })
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const cases: [string | undefined, string, ((p: any) => Promise<void>)?][] = [
      [undefined, 'missing'],
      ['Bearer xxx', 'malformed'],
      [`Bearer ${sign(claims, 'k9')}`, 'unknown_kid'],
      [`Bearer ${expired}`, 'expired'],
      [`Bearer ${jwt.sign(claims, other, { algorithm: 'RS256', keyid: 'k1' })}`, 'invalid'],
      [`Bearer ${sign({ userId: 7, scope: 'select-institution' })}`, 'no_identity'],
      [`Bearer ${sign(claims)}`, 'identity_mismatch', async () => { throw new HttpError(401, 'Token não corresponde', undefined, 'INSTITUTION_MISMATCH') }],
    ]
    for (const [auth, cls, check] of cases) {
      const { seen, res, next } = await call(auth, check)
      expect([cls, res.status.mock.calls[0]?.[0], next.mock.calls.length, seen.map(s => s.authClass)]).toEqual([cls, 401, 0, [cls]])
      expect(seen[0].route).toBe('GET /v1/nfse/x')
      // o token NUNCA vai ao log
      if (auth) expect(JSON.stringify(seen)).not.toContain(auth.slice(7))
    }
    const unknown = (await call(`Bearer ${sign(claims, 'k9')}`)).seen[0]
    expect([unknown.kid, (await call(`Bearer ${sign(claims, 'k9')}`)).res.json.mock.calls[0][0].error]).toEqual(['k9', 'Token assinado com chave desconhecida (kid k9)'])
    expect((await call(`Bearer ${sign(claims)}`, async () => { throw new HttpError(401, 'x') })).seen[0].institutionId).toBe(3)
  })

  it('sucesso e falha que NÃO é 401 (o banco fora no check) não vão ao log do 401', async () => {
    expect((await call(`Bearer ${sign(claims)}`)).seen).toEqual([])
    const down = await call(`Bearer ${sign(claims)}`, async () => { throw new HttpError(503, 'banco fora') })
    expect([down.seen, down.res.status.mock.calls[0][0]]).toEqual([[], 503])
  })

  it('o kid do ATACANTE vai saneado e curto (log e frase); o log que lança nunca derruba a resposta', async () => {
    expect(safeKid('a\nb"c<script>' + 'x'.repeat(100))).toBe(('a?b?c?script?' + 'x'.repeat(100)).slice(0, 64))
    const mw = productAuth(verifier, undefined, () => { throw new Error('log quebrado') })
    const res: any = { status: jest.fn(function (this: any) { return this }), json: jest.fn() }
    await mw({ headers: {}, method: 'GET', baseUrl: '', path: '/v1/nfse' } as any, res, jest.fn())
    expect(res.status).toHaveBeenCalledWith(401)
  })

  it('limite por classe por minuto: 5 linhas; o excedente vira UMA linha de "suprimidas" na janela seguinte; classes não se misturam', () => {
    const warn = jest.fn()
    let t = 0
    const log = authRejectLog({ warn }, 5, () => t)
    for (let i = 0; i < 8; i++) log({ authClass: 'expired', route: 'GET /x' })
    log({ authClass: 'unknown_kid', kid: 'k9', route: 'GET /x' })
    expect(warn).toHaveBeenCalledTimes(6)
    t = 60_000
    log({ authClass: 'expired', route: 'GET /x' })
    expect(warn.mock.calls.slice(6).map(c => c[1])).toEqual([
      { authClass: 'expired', suppressed: 3, windowStartedAt: new Date(0).toISOString() },     // R6-SOC-02: QUANDO foi
      { windowStartedAt: new Date(0).toISOString(), topKids: [{ authClass: 'unknown_kid', kid: 'k9', count: 1 }] },   // D-F170
      { authClass: 'expired', route: 'GET /x' },
    ])
  })

  it('gate socrático da Rodada 6: a rota do atacante vai curta e só ASCII visível (R6-SOC-03); HS256 = invalid COM o alg no log e kid não-texto/vazio dito como tal (R6-SOC-04)', async () => {
    const warn = jest.fn()
    authRejectLog({ warn })({ authClass: 'missing', route: 'GET /v1/nfse/' + 'é'.repeat(300) + 'x'.repeat(8000) })
    expect(warn.mock.calls[0][1].route).toMatch(/^GET \/v1\/nfse\/\?+$/)
    expect(warn.mock.calls[0][1].route.length).toBe(200)
    const hs = (await call(`Bearer ${jwt.sign(claims, pubPem, { algorithm: 'HS256', keyid: 'k1' })}`)).seen[0]
    expect([hs.authClass, hs.alg]).toEqual(['invalid', 'HS256'])
  })

  it('D-F165 (= Q-F173 (a)): kid e exp OBRIGATÓRIOS como no setes-api — sem kid (ausente, vazio, não-texto) = malformed; sem exp = invalid', async () => {
    const noKid = jwt.sign(claims, privPem, { algorithm: 'RS256', expiresIn: '1h' })
    const kidNum = jwt.sign(claims, privPem, { algorithm: 'RS256', expiresIn: '1h', header: { alg: 'RS256', kid: 5 } as any })
    const kidEmpty = jwt.sign(claims, privPem, { algorithm: 'RS256', expiresIn: '1h', header: { alg: 'RS256', kid: '' } as any })
    for (const tok of [noKid, kidNum, kidEmpty]) {
      const r = await call(`Bearer ${tok}`)
      expect([r.seen[0].authClass, r.res.json.mock.calls[0][0].error]).toEqual(['malformed', 'Token sem kid (a chave que o assinou)'])
    }
    const noExp = await call(`Bearer ${jwt.sign(claims, privPem, { algorithm: 'RS256', keyid: 'k1' })}`)
    expect([noExp.seen[0].authClass, noExp.res.json.mock.calls[0][0].error]).toEqual(['invalid', 'Token sem validade (exp)'])
    expect((await call(`Bearer ${sign(claims)}`)).next).toHaveBeenCalled()                      // com kid e exp: passa
  })
})
