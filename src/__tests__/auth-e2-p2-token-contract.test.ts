/// <reference types="jest" />
// fiscal-api:ACESSO.E2.P2 (D-AU3, D-AU16, D-AU19 — `Vault/prompts/prompt_frente_auth_api.md` §5; ficha
// `Vault/projetos/fiscal-api/SUBJECT/ACESSO/ficha-acesso-e2-p2-token-sem-role.md`): o verificador do núcleo aceita o token da auth-api SEM
// `role` e o do setes-api COM `role` ("tolerado e IGNORADO"); "admin"/"super" só do PERFIL VIVO (`access.liveIdentity`). A prova é contra
// o VETOR DE CONTRATO publicado pela auth-api (`auth-api/contract/token-vector.json` — par de chaves SÓ DE TESTE, nunca em produção), com
// o `kid` dela entrando pela lista `JWT_PUBLIC_KEYS` ao lado de uma chave "do setes-api" (a rotação que já existe — D-AU16).
// O vetor é lido de `AUTH_API_DIR` (padrão: a pasta irmã `auth-api` do workspace); não achado = REPROVA (molde `setes-api-dir.ts`: a cerca
// que some calada não prova nada).
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateKeyPairSync } from 'crypto'
import jwt from 'jsonwebtoken'
import { ProductTokenVerifier, ProductAuthError, productAuth, isAdmin, isSuper, InstitutionPayload } from '../auth/product-jwt'
import { liveIdentity } from '../access/access'
import { WORKSPACE } from './setes-api-dir'

const AUTH_API_DIR = path.resolve(process.env.AUTH_API_DIR ?? path.join(WORKSPACE, 'auth-api'))
const VECTOR_PATH = path.join(AUTH_API_DIR, 'contract', 'token-vector.json')
if (!fs.existsSync(VECTOR_PATH)) {
  throw new Error(`ACESSO.E2.P2: o vetor de contrato da auth-api não está em ${VECTOR_PATH} — clone a auth-api ao lado do núcleo ou aponte AUTH_API_DIR`)
}
const vector = JSON.parse(fs.readFileSync(VECTOR_PATH, 'utf8')) as {
  alg: string; kid: string; publicKeyPem: string
  claims: { institutionId: number; userId: number; schemaName: string }
  iat: number
  cases: Record<'final_sem_role' | 'final_com_role_legado' | 'selecao' | 'final_sem_iat', { token: string; expect: string }>
}

// a chave "do setes-api" (par gerado aqui) e a da auth-api (do vetor) — os dois PEM em arquivos, como o `.env` dos consumidores os aponta
const setes = generateKeyPairSync('rsa', { modulusLength: 2048 })
const setesPub = setes.publicKey.export({ type: 'spki', format: 'pem' }) as string
const setesPriv = setes.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
let tmp: string
let verifier: ProductTokenVerifier

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fiscal-acesso-e2p2-'))
  fs.writeFileSync(path.join(tmp, 'setes.pem'), setesPub)
  fs.writeFileSync(path.join(tmp, 'auth-api.pem'), vector.publicKeyPem)
  verifier = ProductTokenVerifier.fromEnv({
    JWT_PUBLIC_KEYS: `setes-k1=${path.join(tmp, 'setes.pem')},${vector.kid}=${path.join(tmp, 'auth-api.pem')}`,
  } as NodeJS.ProcessEnv)
})
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

const WHO = { institutionId: vector.claims.institutionId, userId: vector.claims.userId, schemaName: vector.claims.schemaName }

function rejection(token: string): ProductAuthError {
  try { verifier.verifyWithIat(token) } catch (e) { return e as ProductAuthError }
  throw new Error('o token deveria ser recusado')
}

describe('vetor de contrato da auth-api (D-AU19) — a chave e o `kid` dela pela lista JWT_PUBLIC_KEYS (D-AU16)', () => {
  it('o vetor é o RS256 com o kid de TESTE (nunca o de produção)', () => {
    expect(vector.alg).toBe('RS256')
    expect(vector.kid).toBe('auth-api-contract-test')
  })

  it('final_sem_role → ACEITO: a identidade do token, `role` vazio (perfil ainda não lido) — nunca admin nem super', () => {
    const { payload, iat } = verifier.verifyWithIat(vector.cases.final_sem_role.token)
    expect(payload).toEqual({ ...WHO, role: '' })
    expect(iat).toBe(vector.iat)
    expect(isAdmin(payload)).toBe(false)
    expect(isSuper(payload)).toBe(false)
  })

  it('final_com_role_legado → ACEITO e o `role: "super"` IGNORADO — na institution da Setes, ainda assim nem super nem admin', () => {
    expect(WHO.institutionId).toBe(1)                     // o caso só prova algo porque a institution é a da Setes (isSuper exigiria 1)
    const { payload } = verifier.verifyWithIat(vector.cases.final_com_role_legado.token)
    expect(payload).toEqual({ ...WHO, role: '' })
    expect(isSuper(payload)).toBe(false)
    expect(isAdmin(payload)).toBe(false)
  })

  it('selecao → RECUSADO como token final (401 no_identity)', () => {
    const e = rejection(vector.cases.selecao.token)
    expect(e).toBeInstanceOf(ProductAuthError)
    expect(e.statusCode).toBe(401)
    expect(e.authClass).toBe('no_identity')
    expect(e.kid).toBe(vector.kid)
  })

  it('final_sem_iat → RECUSADO (401 invalid — sem iat a revogação pela senha seria falha aberta, D-EA7)', () => {
    const e = rejection(vector.cases.final_sem_iat.token)
    expect(e.statusCode).toBe(401)
    expect(e.authClass).toBe('invalid')
  })

  it('a chave do setes-api segue valendo ao lado (o token COM role dele também perde o role)', () => {
    const t = jwt.sign({ ...WHO, role: 'admin' }, setesPriv, { algorithm: 'RS256', keyid: 'setes-k1', expiresIn: '1h' })
    const { payload } = verifier.verifyWithIat(t)
    expect(payload).toEqual({ ...WHO, role: '' })
    expect(isAdmin(payload)).toBe(false)
  })

  it.each([
    ['com `scope` (token de seleção com identidade)', { scope: 'select-institution' }],
    ['com `scope` de qualquer valor', { scope: null }],
    ['institutionId fora do inteiro seguro', { institutionId: 2 ** 60 }],
    ['userId fora do inteiro seguro', { userId: 2 ** 60 }],
  ] as const)('gate adversarial (L1/L2): token %s → 401 no_identity (como o setes-api e a auth-api)', (_name, extra) => {
    const t = jwt.sign({ ...WHO, ...extra }, setesPriv, { algorithm: 'RS256', keyid: 'setes-k1', expiresIn: '1h' })
    expect(rejection(t).authClass).toBe('no_identity')
  })

  it('os kids não se cruzam: ASSINADO pela chave do setes-api com o kid da auth-api no cabeçalho → 401 invalid (a chave é a do kid)', () => {
    // gate socrático (M1): assinatura VÁLIDA de outra chave da lista — só falha se o verificador escolhe a chave PELO kid (não "tenta todas")
    const crossed = jwt.sign({ ...WHO }, setesPriv, { algorithm: 'RS256', keyid: vector.kid, expiresIn: '1h' })
    const e = rejection(crossed)
    expect(e.authClass).toBe('invalid')
    expect(e.kid).toBe(vector.kid)
  })
})

describe('productAuth — admin só do perfil VIVO (`access.liveIdentity`), nunca do token cru', () => {
  async function through(token: string, check?: (p: InstitutionPayload, iat: number) => Promise<void | InstitutionPayload>) {
    const mw = productAuth(verifier, check, () => { /* log do 401 fora do teste */ })
    const res: any = { status: jest.fn(function (this: any) { return this }), json: jest.fn() }
    const next = jest.fn()
    const req: any = { headers: { authorization: `Bearer ${token}` }, method: 'GET', baseUrl: '/v1/emitter', path: '/' }
    await mw(req, res, next)
    return { req, next, status: res.status.mock.calls[0]?.[0] }
  }
  /** O banco com a sessão viva: `vw_user_link` responde o perfil pedido. */
  const liveDb = (profile: string) => ({ query: jest.fn(async () => [[{ profile, vendor: 'N' }], []]) }) as any

  it('SEM sessão viva (productAuth sem check): o token com role "super" passa a identidade, mas não é admin nem super', async () => {
    const r = await through(vector.cases.final_com_role_legado.token)
    expect(r.next).toHaveBeenCalledWith()
    expect(r.req.institution).toEqual({ ...WHO, role: '' })
    expect(isAdmin(r.req.institution)).toBe(false)
    expect(isSuper(r.req.institution)).toBe(false)
  })

  it.each([
    ['final_sem_role', 'admin', true, false],
    ['final_sem_role', 'super', true, true],
    ['final_com_role_legado', 'user', false, false],      // o 'super' do token não sobrevive ao perfil vivo 'user'
  ] as const)('%s com perfil vivo %s → isAdmin %s, isSuper %s', async (kase, profile, admin, sup) => {
    const db = liveDb(profile)
    const r = await through(vector.cases[kase].token, (p, iat) => liveIdentity(db, p, iat))
    expect(r.next).toHaveBeenCalledWith()
    expect(r.req.institution).toEqual({ ...WHO, role: profile })
    expect(isAdmin(r.req.institution)).toBe(admin)
    expect(isSuper(r.req.institution)).toBe(sup)
    // a sessão foi lida com a identidade e o iat do TOKEN
    expect(db.query.mock.calls[0][1]).toEqual([WHO.userId, WHO.institutionId, WHO.schemaName, expect.any(String)])
  })

  it('sessão que não vale mais → 401 SESSION_REVOKED, a rota não roda (o token sozinho nunca basta)', async () => {
    const db = { query: jest.fn(async () => [[], []]) } as any
    const r = await through(vector.cases.final_sem_role.token, (p, iat) => liveIdentity(db, p, iat))
    expect(r.status).toBe(401)
    expect(r.next).not.toHaveBeenCalled()
  })
})
