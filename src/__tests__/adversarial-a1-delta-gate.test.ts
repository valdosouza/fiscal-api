/// <reference types="jest" />
// RE-GATE testar-adversarial do RETRABALHO da costura A1 (passo 4 do plano 10-21 — `Infra-IA/prompts/prompt_frente_auth_api.md`;
// skill `Infra-IA/skills-genericas/testar-adversarial.md`), lado do NÚCLEO: o 503 SESSION_UNAVAILABLE do `productAuth` (a nfse-api usa
// este middleware) e a forma canônica da chave na biblioteca `access`. 2026-11-01.
//   [RESISTIU] = `it` que passa (a defesa segurou);
//   [ACHADO]   = `it.failing` com a asserção SEGURA (o código de hoje a quebra; vira `it` com a correção).
// A semântica das VIEWS (PAD SPACE, Unicode, NULL, D-PV62) foi provada AO VIVO em banco descartável por
// `setes-api/scripts/adv-a1-delta-probe.ts views` — aqui só a forma da leitura, com dublê do banco.
import { generateKeyPairSync } from 'crypto'
import jwt from 'jsonwebtoken'
import { HttpError } from '../errors/http-error'
import { ProductTokenVerifier, ProductAuthError, productAuth, AuthReject } from '../auth/product-jwt'
import { liveIdentity, accessVerdict, reachableKeys, grantedKeys, accessRows } from '../access/access'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const verifier = ProductTokenVerifier.of({ k1: pubPem })
const claims = { institutionId: 7, userId: 30, role: 'admin', schemaName: 'setes_cliente' }
const token = () => `Bearer ${jwt.sign(claims, privPem, { algorithm: 'RS256', keyid: 'k1', expiresIn: '1h' })}`

async function call(check: (p: any, iat: number) => Promise<any>) {
  const seen: AuthReject[] = []
  const mw = productAuth(verifier, check, r => { seen.push(r) })
  const res: any = { status: jest.fn(function (this: any) { return this }), json: jest.fn() }
  const next = jest.fn()
  const req: any = { headers: { authorization: token() }, method: 'POST', baseUrl: '/v1/nfse', path: '/1/transmit' }
  await mw(req, res, next)
  return { seen, res, next, req, status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] }
}

/** O banco do nfse-api com a SESSÃO REAL da biblioteca (`access.liveIdentity`, a mesma função do app.ts). */
function dbAnswering(answer: () => any) {
  return { query: jest.fn(async () => [answer(), []]) } as any
}

describe('[RESISTIU] 503 × 401 no productAuth da nfse-api — a SESSÃO REAL (`access.liveIdentity`) atrás do middleware', () => {
  it('banco recusando a conexão → 503 SESSION_UNAVAILABLE, a rota NÃO roda, nada no log do 401, nada da causa na resposta', async () => {
    const q = { query: jest.fn(async () => { throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:3306'), { code: 'ECONNREFUSED', errno: -4078 }) }) }
    const r = await call((p, iat) => liveIdentity(q as any, p, iat))
    expect([r.status, r.body]).toEqual([503, { error: 'Serviço indisponível — tente novamente', code: 'SESSION_UNAVAILABLE' }])
    expect([r.next.mock.calls.length, r.seen.length, r.req.institution]).toEqual([0, 0, undefined])
    expect(JSON.stringify(r.body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.9|3306/)
  })

  it('erro de driver SEM código (mysql2: conexão em estado fechado / pool fechado) e lançamento de não-Error → 503, nunca 401 nem 500', async () => {
    for (const thrown of [Object.assign(new Error("Can't add new command when connection is in closed state"), { fatal: true }),
      new Error('Pool is closed.'), 'string lançada', null, new TypeError("Cannot read properties of undefined (reading 'profile')")]) {
      const q = { query: jest.fn(async () => { throw thrown }) }
      const r = await call((p, iat) => liveIdentity(q as any, p, iat))
      expect([String(thrown), r.status, r.body?.code, r.next.mock.calls.length]).toEqual([String(thrown), 503, 'SESSION_UNAVAILABLE', 0])
    }
  })

  it('a view sem a linha (vínculo inativo) → 401 SESSION_REVOKED com o código e a classe no log (não vira 503)', async () => {
    const r = await call((p, iat) => liveIdentity(dbAnswering(() => []), p, iat))
    expect([r.status, r.body.code, r.seen.map(s => s.authClass)]).toEqual([401, 'SESSION_REVOKED', ['identity_mismatch']])
  })

  it('a view com DUAS linhas ou perfil fora do domínio → 401 (falha fechada), nunca 503', async () => {
    for (const rows of [[{ profile: 'admin', vendor: 'N' }, { profile: 'admin', vendor: 'N' }], [{ profile: 'admin ', vendor: 'N' }],
      [{ profile: 'Admin', vendor: 'N' }], [{ profile: null, vendor: 'N' }]]) {
      const r = await call((p, iat) => liveIdentity(dbAnswering(() => rows), p, iat))
      expect([JSON.stringify(rows), r.status]).toEqual([JSON.stringify(rows), 401])
    }
  })

  it('o check que lança ProductAuthError/HttpError próprio mantém o status e o código (não é engolido pelo 503)', async () => {
    const auth = await call(async () => { throw new ProductAuthError('x', 'expired', 'k1') })
    expect([auth.status, auth.seen.map(s => s.authClass)]).toEqual([401, ['expired']])
    const forbidden = await call(async () => { throw new HttpError(403, 'Proibido', undefined, 'ADMIN_REQUIRED') })
    expect([forbidden.status, forbidden.body.code, forbidden.seen.length]).toEqual([403, 'ADMIN_REQUIRED', 0])
  })

  it('a sessão viva troca o role do token pelo perfil vivo (o token dizia admin, o vínculo diz user)', async () => {
    const r = await call((p, iat) => liveIdentity(dbAnswering(() => [{ profile: 'user', vendor: 'N' }]), p, iat))
    expect([r.next.mock.calls.length, r.req.institution.role]).toEqual([1, 'user'])
  })
})

describe('[RESISTIU] a chave fora da forma canônica nunca vai ao banco (as 3 leituras por chave julgam igual)', () => {
  const WHO = { userId: 9, institutionId: 7, schemaName: 'setes_acme' }
  it('quebra de linha no fim, Unicode, largura total, NBSP, nulo, número, objeto, chave gigante — nenhuma leitura', async () => {
    const q = { query: jest.fn(async () => [[{ 1: 1 }, { k: 'orders' }], []]) }
    const bad: unknown[] = ['orders\n', 'orders\r\n', 'ordérs', 'ｏｒｄｅｒｓ', 'orders ', 'orders​', '\u0000orders', null, undefined, 42,
      { toString: () => 'orders' }, ['orders'], 'a' + '-a'.repeat(20000) + '!']
    const t0 = Date.now()
    for (const k of bad) {
      expect(await accessVerdict(q as any, WHO, [k as any], 'FATURAR')).toBe('not-contracted')
      expect(await reachableKeys(q as any, WHO, [k as any])).toEqual([])
      expect(await grantedKeys(q as any, WHO, [k as any], 'FATURAR')).toEqual([])
    }
    expect(Date.now() - t0).toBeLessThan(500)                 // a forma não tem retrocesso catastrófico
    expect(q.query).not.toHaveBeenCalled()
  })

  it("o verbo fora do vocabulário ('FATURAR ', 'faturar', 'FATURAR\\u00A0') → no-privilege sem ir ao banco", async () => {
    const q = { query: jest.fn(async () => [[{ 1: 1 }], []]) }
    for (const v of ['FATURAR ', 'faturar', 'FATURAR ', ' FATURAR', '']) {
      expect(await accessVerdict(q as any, WHO, ['orders'], v as any)).toBe('no-privilege')
    }
    expect(q.query).not.toHaveBeenCalled()
  })
})

describe('[ACHADO LOW] accessRows devolve a chave do catálogo FORA da forma canônica — a 4ª leitura discorda das outras 3', () => {
  // Provado ao vivo (scripts/adv-a1-delta-probe.ts views, item (c)): com as interfaces 'Orders', 'orders\t' e 'orders<NBSP>' (o predicado do
  // sql/70 tira só o espaço ASCII à direita) contratadas, o menu (accessRows) do admin traz "Orders:FATURAR", "orders\t:FATURAR"… — e
  // accessVerdict/reachableKeys/grantedKeys para essas MESMAS chaves dizem 'not-contracted'/[] (a chave nem vai ao banco). O docstring da
  // biblioteca promete "as quatro leituras julgam IGUAL". Hoje nenhum escritor HTTP grava chave fora da forma (DTO com INTERFACE_KEY_PATTERN)
  // e o boot do setes-api acusa `nonCanonicalKeys` — latente (escrita direta no banco / linha antiga). Efeito: botão/menu que a API nega.
  it('accessRows só devolve linhas de chave canônica (o MESMO filtro das outras leituras)', async () => {
    const q = dbAnswering(() => [
      { interfaceId: 10, interfaceKey: 'orders', privilege: 'FATURAR' },
      { interfaceId: 30, interfaceKey: 'Orders', privilege: 'FATURAR' },
      { interfaceId: 63, interfaceKey: 'orders\t', privilege: 'FATURAR' },
      { interfaceId: 64, interfaceKey: 'orders ', privilege: 'FATURAR' },
    ])
    const rows = await accessRows(q, { userId: 31, institutionId: 3, schemaName: 'setes_acme' })
    expect(rows.map(r => r.interfaceKey)).toEqual(['orders'])
  })
})
