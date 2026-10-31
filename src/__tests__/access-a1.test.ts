/// <reference types="jest" />
// Costura A1 da auth-api (D-AU3/D-AU6/D-AU8, Valdo 2026-10-31 — Infra-IA/prompts/prompt_frente_auth_api.md): o veredito de acesso é a
// biblioteca ÚNICA `access` (pilha de views publicada no banco do produto). Aqui a FORMA da leitura (o que pergunta e quando) com um
// dublê do banco; a SEMÂNTICA das views (licença, perfil, delegação, par registrado) é provada AO VIVO em schema descartável pela
// prova do setes-api (`scripts/prove-user-access-views.ts`).
import { HttpError } from '../errors/http-error'
import {
  sessionOf, liveIdentity, accessVerdict, reachableKeys, grantedKeys, accessRows, isPrivilegeName, PRIVILEGE_NAMES,
} from '../access/access'
import * as surface from '../access'

type Call = { sql: string; params: any[] }
function fakeDb(answer: (sql: string, params: any[]) => any[]) {
  const calls: Call[] = []
  const q = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      const t = sql.replace(/\s+/g, ' ').trim()
      calls.push({ sql: t, params })
      return [answer(t, params), []]
    }),
  }
  return { q: q as any, calls }
}

const WHO = { userId: 9, institutionId: 7, schemaName: 'setes_acme' }

describe('accessVerdict — caminho quente numa leitura; o motivo do 403 só na negação', () => {
  it('permitido: UMA leitura de vw_user_access pelo schema do token, verbo pelo NOME, chaves pela lista', async () => {
    const { q, calls } = fakeDb(t => /vw_user_access/.test(t) ? [{ 1: 1 }] : [])
    expect(await accessVerdict(q, WHO, ['orders', 'service-orders'], 'CANCELAR')).toBe('ok')
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toMatch(/FROM `setes_acme`\.vw_user_access WHERE tb_user_id = \? AND tb_institution_id = \? AND interface_key IN \(\?\) AND privilege = \? LIMIT 1$/)
    expect(calls[0].params).toEqual([9, 7, ['orders', 'service-orders'], 'CANCELAR'])
  })

  it('negado com a interface ao alcance → no-privilege (2ª leitura: vw_user_reach)', async () => {
    const { q, calls } = fakeDb(t => /vw_user_reach/.test(t) ? [{ k: 'orders' }] : [])
    expect(await accessVerdict(q, WHO, ['orders'], 'FATURAR')).toBe('no-privilege')
    expect(calls.map(c => /vw_user_(\w+)/.exec(c.sql)![1])).toEqual(['access', 'reach'])
  })

  it('negado sem alcance → not-contracted', async () => {
    const { q } = fakeDb(() => [])
    expect(await accessVerdict(q, WHO, ['orders'], 'FATURAR')).toBe('not-contracted')
  })

  it('a view devolvendo chave NÃO pedida não vira alcance (só as chaves pedidas contam)', async () => {
    const { q } = fakeDb(t => /vw_user_reach/.test(t) ? [{ k: 'customers' }] : [])
    expect(await accessVerdict(q, WHO, ['orders'], 'FATURAR')).toBe('not-contracted')
  })

  it('sem chave ou com verbo fora do vocabulário: nega SEM ir ao banco (falha fechada)', async () => {
    const { q, calls } = fakeDb(() => [{ 1: 1 }])
    expect(await accessVerdict(q, WHO, [], 'VISUALIZAR')).toBe('not-contracted')
    expect(await accessVerdict(q, WHO, ['', ''], 'VISUALIZAR')).toBe('not-contracted')
    expect(await accessVerdict(q, WHO, ['orders'], 'visualizar' as any)).toBe('not-contracted')
    expect(calls).toHaveLength(0)
  })

  it('schema inválido no token: lança antes de qualquer SQL', async () => {
    const { q, calls } = fakeDb(() => [])
    await expect(accessVerdict(q, { ...WHO, schemaName: 'setes_x`; DROP' }, ['orders'], 'FATURAR')).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('SEM cache (D-AU8): duas perguntas iguais = duas leituras — a revogação vale na hora', async () => {
    let allowed = true
    const { q, calls } = fakeDb(t => /vw_user_access/.test(t) && allowed ? [{ 1: 1 }] : [])
    expect(await accessVerdict(q, WHO, ['orders'], 'FATURAR')).toBe('ok')
    allowed = false
    expect(await accessVerdict(q, WHO, ['orders'], 'FATURAR')).toBe('not-contracted')
    expect(calls.filter(c => /vw_user_access/.test(c.sql))).toHaveLength(2)
  })
})

describe('reachableKeys / grantedKeys / accessRows', () => {
  it('alcance devolve na ordem pedida, sem repetir e só o que foi pedido', async () => {
    const { q, calls } = fakeDb(() => [{ k: 'order-returns' }, { k: 'orders' }, { k: 'customers' }])
    expect(await reachableKeys(q, WHO, ['orders', 'service-orders', 'order-returns', 'orders'])).toEqual(['orders', 'order-returns'])
    expect(calls[0].params).toEqual([9, 7, ['orders', 'service-orders', 'order-returns']])
  })

  it('verbo concedido por ramo (passada do rodízio)', async () => {
    const { q, calls } = fakeDb(() => [{ k: 'service-orders' }])
    expect(await grantedKeys(q, WHO, ['orders', 'service-orders'], 'CONSULTAR')).toEqual(['service-orders'])
    expect(calls[0].sql).toMatch(/vw_user_access .*privilege = \?$/)
  })

  it('accessRows (o menu): tudo do usuário no estabelecimento, verbo fora do vocabulário fica fora', async () => {
    const { q } = fakeDb(() => [
      { interfaceId: 3, interfaceKey: 'orders', privilege: 'VISUALIZAR' },
      { interfaceId: 3, interfaceKey: 'orders', privilege: 'NOVO_VERBO' },
    ])
    expect(await accessRows(q, WHO)).toEqual([{ interfaceId: 3, interfaceKey: 'orders', privilege: 'VISUALIZAR' }])
  })
})

describe('sessionOf / liveIdentity — D-UC9: a sessão vale enquanto o vínculo vive', () => {
  it('vínculo vivo: perfil e "a Setes" da view; pergunta pelo schema do token', async () => {
    const { q, calls } = fakeDb(() => [{ profile: 'admin', vendor: 'N' }])
    expect(await sessionOf(q, WHO)).toEqual({ ...WHO, profile: 'admin', vendor: false })
    expect(calls[0].sql).toMatch(/FROM setes_central\.vw_user_link WHERE tb_user_id = \? AND tb_institution_id = \? AND schema_name = \?/)
    expect(calls[0].params).toEqual([9, 7, 'setes_acme'])
  })

  it('sem linha, com DUAS linhas ou perfil fora do domínio → null (falha fechada)', async () => {
    for (const rows of [[], [{ profile: 'admin', vendor: 'N' }, { profile: 'user', vendor: 'N' }], [{ profile: 'Admin', vendor: 'N' }]]) {
      expect(await sessionOf(fakeDb(() => rows).q, WHO)).toBeNull()
    }
  })

  it('liveIdentity: o role do token é TROCADO pelo perfil vivo (rebaixar vale na hora)', async () => {
    const { q } = fakeDb(() => [{ profile: 'user', vendor: 'N' }])
    expect(await liveIdentity(q, { ...WHO, role: 'admin' })).toEqual({ ...WHO, role: 'user' })
  })

  it('liveIdentity sem sessão → 401 SESSION_REVOKED', async () => {
    const err = await liveIdentity(fakeDb(() => []).q, { ...WHO, role: 'admin' }).catch(e => e)
    expect(err).toBeInstanceOf(HttpError)
    expect([err.statusCode, err.code]).toEqual([401, 'SESSION_REVOKED'])
  })
})

describe('vocabulário e superfície', () => {
  it('os verbos são os do catálogo, pelo NOME (D-PV53) — caixa exata', () => {
    expect(PRIVILEGE_NAMES).toEqual(['INSERIR', 'ALTERAR', 'EXCLUIR', 'IMPRIMIR', 'FATURAR', 'VISUALIZAR', 'CANCELAR', 'DESCONTO',
      'TRANSMITIR', 'CATALOGAR', 'CONFIGURAR', 'CONSULTAR'])
    expect(isPrivilegeName('TRANSMITIR')).toBe(true)
    expect(isPrivilegeName('transmitir')).toBe(false)
  })

  it('o subpath `fiscal-api/access` expõe só o leitor do veredito (nada de escrita)', () => {
    expect(Object.keys(surface).sort()).toEqual([
      'ACCESS_VIEWS', 'PRIVILEGE_NAMES', 'accessRows', 'accessVerdict', 'grantedKeys', 'isPrivilegeName', 'liveIdentity',
      'reachableKeys', 'sessionOf',
    ])
  })
})
