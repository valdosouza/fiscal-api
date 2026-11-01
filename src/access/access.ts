import { Queryable } from '../db/tx'
import { assertSchema } from '../db/schema'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'

/**
 * VEREDITO DE ACESSO DO PRODUTO — a peça ÚNICA (costura A1 da frente auth-api, D-AU3/D-AU6/D-AU8, Valdo 2026-10-31 —
 * `Infra-IA/prompts/prompt_frente_auth_api.md`; parecer do guardião no §3 de lá). "O usuário U pode exercer o verbo V na interface I
 * do estabelecimento X?" deixa de ter QUATRO cópias (setes-api `require-privilege`, núcleo `erp/facts`, guardas da nfse-api, SQL do
 * menu) e passa a ser UMA pilha de VIEWS fundíveis publicada no banco do produto, lida VIVA a cada requisição (sem cache — D-AU8:
 * revogação na hora em todos os processos, por construção):
 *
 *   setes_central.vw_user_link        vínculo VIVO com o perfil (credencial, vínculo e estabelecimento ativos; 'super' só na Setes)
 *   setes_central.vw_interface_catalog interface viva + modo de concessão (delegável do Super — D-PV11)
 *   <schema>.vw_user_reach            interface AO ALCANCE do usuário no estabelecimento (licença, escape do super, delegação)
 *   <schema>.vw_user_access           verbo PERMITIDO — PRESENÇA = PERMISSÃO (D-AU3); construída SOBRE a de alcance
 *
 * Esta biblioteca é o ÚNICO leitor delas (o setes-api a consome pelo subpath `fiscal-api/access`; a nfse-api pelo barril; na A2 vira
 * `auth-api/access` sem mudar a forma). O verbo é citado pelo NOME (`tb_privilege.description` — D-PV53; o número só existe em quem
 * escreve o registro). O motivo do 403 (não contratada × sem privilégio) vem da view de ALCANCE, lida SÓ na negação — a regra de
 * alcance está escrita uma vez, na peça de baixo da mesma pilha.
 *
 * Conhecimento negativo: (a) nunca "verbo exige VISUALIZAR" aqui — a invariante é da ESCRITA da concessão (D-PV57…D-PV60), não do dado;
 * (b) nunca DISTINCT/LIMIT/UNION nas views (deixam de fundir — PADROES §11.3); o LIMIT fica no leitor; (c) nunca cachear o veredito
 * (D-AU8 — se pesar, a decisão volta ao Valdo COM números).
 */

/** Os verbos do catálogo (`tb_privilege.description`) — genéricos, o sentido vem do par interface × verbo (D-PV27/D-PV49). */
export const PRIVILEGE_NAMES = [
  'INSERIR', 'ALTERAR', 'EXCLUIR', 'IMPRIMIR', 'FATURAR', 'VISUALIZAR', 'CANCELAR', 'DESCONTO', 'TRANSMITIR', 'CATALOGAR',
  'CONFIGURAR', 'CONSULTAR',
] as const
export type PrivilegeName = typeof PRIVILEGE_NAMES[number]

export function isPrivilegeName(v: unknown): v is PrivilegeName {
  return typeof v === 'string' && (PRIVILEGE_NAMES as readonly string[]).includes(v)
}

/** Perfil VIVO do vínculo (`vw_user_link.profile`): 'super' só na institution da Setes; qualquer outro `kind` (inclusive 'SYNC') = 'user'. */
export type AccessProfile = 'super' | 'admin' | 'user'

/** Quem pede: a identidade do token (o schema é conferido contra o vínculo vivo — `sessionOf`). */
export interface AccessWho {
  userId:        number
  institutionId: number
  schemaName:    string
}

export interface AccessSession extends AccessWho {
  profile: AccessProfile
  /** O vínculo é com a própria Setes (a fornecedora do produto — D-PV37). */
  vendor:  boolean
}

export type AccessVerdict = 'ok' | 'not-contracted' | 'no-privilege'

/** Nomes das views (o boot de quem publica confere pelo NOME). */
export const ACCESS_VIEWS = {
  userLink:         'vw_user_link',
  interfaceCatalog: 'vw_interface_catalog',
  userReach:        'vw_user_reach',
  userAccess:       'vw_user_access',
} as const

const PROFILES: readonly string[] = ['super', 'admin', 'user']

/**
 * O `iat` do token (segundos de época) como o literal DATETIME UTC que a coluna `password_set_at` guarda. DATETIME × literal não depende do
 * fuso da sessão nem do `timezone` do driver (nunca `UNIX_TIMESTAMP` na view — depende do `time_zone` de quem lê).
 */
export function iatAsUtcDatetime(iat: number): string {
  if (!Number.isSafeInteger(iat) || iat <= 0) throw new Error(`iat inválido: ${iat}`)
  return new Date(iat * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * A SESSÃO viva (D-UC9 + D-AU3): o vínculo do usuário com o estabelecimento DO TOKEN, com o schema do token, está vivo (credencial,
 * vínculo e estabelecimento ativos)? Devolve o PERFIL VIVO — quem autentica sobrescreve o `role` do token com ele até a A2 (o token
 * ainda leva `role`, mas ninguém confia nele). `null` = a sessão não vale mais (401 SESSION_REVOKED em quem chama).
 *
 * D-EA7 (Valdo 2026-10-31): na MESMA leitura, o token emitido ANTES de a senha atual ser definida (`iat < password_set_at`) não vale —
 * trocar a senha derruba as sessões anteriores. `iat = T` VALE (o token reemitido na mesma resposta e o 1º login logo depois da criação);
 * limite conhecido: um token emitido no mesmo segundo, antes da troca, sobrevive até o `exp`. `password_set_at` NULL = senha definida antes
 * da regra (sem revogação; o TTL de 24 h fecha). Conhecimento negativo: não trocar para `<` / `<=` "por segurança" — o teste fixa.
 */
export async function sessionOf(q: Queryable, who: AccessWho, iat: number): Promise<AccessSession | null> {
  assertSchema(who.schemaName)
  const [rows] = await q.query(
    `SELECT profile, vendor FROM setes_central.vw_user_link
      WHERE tb_user_id = ? AND tb_institution_id = ? AND schema_name = ?
        AND (password_set_at IS NULL OR password_set_at <= ?) LIMIT 2`,
    [who.userId, who.institutionId, who.schemaName, iatAsUtcDatetime(iat)])
  if (!Array.isArray(rows) || rows.length !== 1) return null          // PK (institution, user): mais de uma linha = view adulterada
  const profile = String(rows[0].profile)
  if (!PROFILES.includes(profile)) return null                         // falha FECHADA: perfil fora do domínio não autentica
  return { ...who, profile: profile as AccessProfile, vendor: rows[0].vendor === 'S' }
}

/**
 * BOOT das APIs fiscais (gate socrático da costura A1): a `setes_central.vw_user_link` (script sql/70) responde, com o GRANT do serviço,
 * pelas colunas que a sessão lê. Sem ela TODA rota autenticada viraria 503 na 1ª requisição — o serviço NÃO sobe (ordem da janela: sql/70 e
 * o GRANT da D-AU12 ANTES do restart). As views POR SCHEMA (migration 075) são conferidas pelo boot do setes-api, que as cria.
 */
export async function assertSessionViewReadable(q: Queryable): Promise<string> {
  try {
    await q.query(`SELECT tb_user_id, tb_institution_id, schema_name, password_set_at, profile, vendor
                     FROM setes_central.vw_user_link LIMIT 0`)   // nome LITERAL: a cerca do GRANT (D-AU12) lê o nome
  } catch (err) {
    const e = err as { code?: unknown; errno?: unknown }
    throw new Error(`setes_central.vw_user_link ilegível (${String(e?.code ?? e?.errno ?? 'erro')}) — aplique o script `
      + 'sql/70_user_access_central_views.sql e o GRANT da D-AU12 (ops/grants.sql) ANTES de subir (costura A1 — D-AU3/D-AU12)')
  }
  return 'ok'
}

/**
 * O [check] do middleware de autenticação (`productAuth` do núcleo; o setes-api tem o adaptador dele): a sessão viva ou 401
 * SESSION_REVOKED; o payload sai com o PERFIL VIVO no `role` (D-UC9 + D-AU3 — rebaixar/promover/inativar vale na hora, em toda rota).
 */
export async function liveIdentity<P extends AccessWho & { role: string }>(q: Queryable, payload: P, iat: number): Promise<P> {
  const session = await sessionOf(q, payload, iat)
  if (!session) {
    throw new HttpError(401, 'O acesso deste usuário a este estabelecimento não vale mais — entre de novo', undefined,
      ErrorCodes.SESSION_REVOKED)
  }
  return { ...payload, role: session.profile }
}

/**
 * A forma CANÔNICA da chave de interface (D-PV42 — a MESMA do `INTERFACE_KEY_PATTERN` do setes-api, a forma das rotas do app).
 * Conhecimento negativo: no MariaDB 10.4 o `utf8mb4_bin` é PAD SPACE — `interface_key IN ('orders ')` casa 'orders'. Chave fora da forma
 * nunca chega ao banco: as quatro leituras julgam IGUAL (antes o veredito dizia 'ok' e o alcance dizia nada — gate adversarial da A1).
 */
const INTERFACE_KEY_FORM = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

function keysOf(keys: readonly string[]): string[] {
  return keys.filter((k, i) => typeof k === 'string' && INTERFACE_KEY_FORM.test(k) && keys.indexOf(k) === i)
}

/**
 * O VEREDITO de UMA ação: o verbo [privilege] em QUALQUER das [keys] (Q-G16 — a ação vale pelo verbo em qualquer interface da lista).
 * Caminho quente: uma leitura de `vw_user_access`. Só na negação, uma leitura de `vw_user_reach` decide o motivo: alcança alguma das
 * interfaces → 'no-privilege' (403 PRIVILEGE_REQUIRED); nenhuma → 'not-contracted' (403 INTERFACE_NOT_ALLOWED).
 */
export async function accessVerdict(
  q: Queryable, who: AccessWho, keys: readonly string[], privilege: PrivilegeName,
): Promise<AccessVerdict> {
  const s = assertSchema(who.schemaName)
  const wanted = keysOf(keys)
  if (wanted.length === 0) return 'not-contracted'
  if (!isPrivilegeName(privilege)) return 'no-privilege'   // verbo fora do vocabulário: ninguém o tem — o motivo é o VERBO, sem ir ao banco
  const [hit] = await q.query(
    `SELECT 1 FROM \`${s}\`.${ACCESS_VIEWS.userAccess}
      WHERE tb_user_id = ? AND tb_institution_id = ? AND interface_key IN (?) AND privilege = ? LIMIT 1`,
    [who.userId, who.institutionId, wanted, privilege])
  if (Array.isArray(hit) && hit.length > 0) return 'ok'
  return (await reachableKeys(q, who, wanted)).length > 0 ? 'no-privilege' : 'not-contracted'
}

/**
 * Das [keys], as que o usuário ALCANÇA no estabelecimento (licença contratada; o super todas; a tela do Super delegável só para o
 * usuário da Setes). É a "licença sozinha" das leituras (Q-N32), do "adquirida" dos painéis (D-PV24/D-PV39) e do motivo do 403.
 */
export async function reachableKeys(q: Queryable, who: AccessWho, keys: readonly string[]): Promise<string[]> {
  const s = assertSchema(who.schemaName)
  const wanted = keysOf(keys)
  if (wanted.length === 0) return []
  const [rows] = await q.query(
    `SELECT interface_key AS k FROM \`${s}\`.${ACCESS_VIEWS.userReach}
      WHERE tb_user_id = ? AND tb_institution_id = ? AND interface_key IN (?)`,
    [who.userId, who.institutionId, wanted])
  const got = (Array.isArray(rows) ? rows : []).map((r: any) => String(r.k))
  return wanted.filter(k => got.includes(k))                 // ordem de quem pediu; só chaves pedidas (nunca o que a view trouxer a mais)
}

/** Das [keys], as em que o usuário exerce o verbo [privilege] (a passada do rodízio escolhe os ramos — D-F46/D-PV40). */
export async function grantedKeys(
  q: Queryable, who: AccessWho, keys: readonly string[], privilege: PrivilegeName,
): Promise<string[]> {
  const s = assertSchema(who.schemaName)
  const wanted = keysOf(keys)
  if (wanted.length === 0 || !isPrivilegeName(privilege)) return []
  const [rows] = await q.query(
    `SELECT interface_key AS k FROM \`${s}\`.${ACCESS_VIEWS.userAccess}
      WHERE tb_user_id = ? AND tb_institution_id = ? AND interface_key IN (?) AND privilege = ?`,
    [who.userId, who.institutionId, wanted, privilege])
  const got = (Array.isArray(rows) ? rows : []).map((r: any) => String(r.k))
  return wanted.filter(k => got.includes(k))
}

export interface AccessRow {
  interfaceId:  number
  interfaceKey: string
  privilege:    PrivilegeName
}

/** TUDO o que o usuário pode no estabelecimento — o menu (VISUALIZAR dá o item, os verbos dão os botões); na A2, `GET /v1/access`. */
export async function accessRows(q: Queryable, who: AccessWho): Promise<AccessRow[]> {
  const s = assertSchema(who.schemaName)
  const [rows] = await q.query(
    `SELECT tb_interface_id AS interfaceId, interface_key AS interfaceKey, privilege
       FROM \`${s}\`.${ACCESS_VIEWS.userAccess}
      WHERE tb_user_id = ? AND tb_institution_id = ?`,
    [who.userId, who.institutionId])
  const out: AccessRow[] = []
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isPrivilegeName(r.privilege)) continue                       // verbo fora do vocabulário (linha nova no catálogo): ninguém o pergunta
    out.push({ interfaceId: Number(r.interfaceId), interfaceKey: String(r.interfaceKey), privilege: r.privilege })
  }
  return out
}
