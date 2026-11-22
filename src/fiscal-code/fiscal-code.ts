/**
 * CONFIGURAÇÃO FISCAL POR UF — as peças da migration 006 do núcleo (`fiscal-api:FAMILIA.E5.P4.T4`; D-NE218, D-NE221, D-NE223, D-NE224,
 * D-NE226 — `prompt_onda_nfe_sefaz.md` §22.5 a §22.7; ficha `projetos/fiscal-api/GERAL/ficha-familia-e5-p4-pecas-ne4.md` §5 T4).
 *
 *  - LEITURA: `fiscalCodeRequirementsOf` (o que a UF exige), `providerFiscalCredentialOf`/`establishmentFiscalCredentialOf` (a credencial
 *    vigente do dono certo) e `requiredFiscalCredentialsFor` (a composição que o builder da família chama ANTES de montar o XML — falta =
 *    `FiscalCodeMissingError` com UF, tipo, modelo, ambiente e dono; nunca XML incompleto — D-NE218).
 *  - BOOT: `assertRequiredProviderCodesPresent` (D-NE223 — a família que EMITE não sobe sem o código exigido) e
 *    `assertFiscalCodeDomainsEnforced` (os CHECKs binários aplicados pelo motor).
 *  - ESCRITA (a rota da nfse-api — D-NE224 — e o script do Valdo — D-NE226): `saveProviderFiscalCredential`, `endProviderFiscalCredential`;
 *    a listagem `listProviderFiscalCredentials` devolve tudo MENOS o valor.
 *
 * VIGÊNCIA (a mesma regra nas três tabelas): viva (`deleted = 'N'`) de MAIOR `valid_from` ≤ instante, e só se `valid_until` for nulo ou >
 * instante — encerrada = nenhuma; nunca volta à anterior.
 *
 * O VALOR (`code_value`) é TEXTO PURO no banco por decisão (D-NE223 — exceção nomeada à PADROES §11 regra 6). Aqui ele só sai pela leitura
 * da credencial (para o `hashCsrt` da família); NUNCA entra em mensagem de erro, log ou retorno de escrita/listagem (cerca no teste).
 * Sem `if (uf === 'PR')` (D-NE221): o que a UF exige é DADO da tabela de regras.
 *
 * Entrada conferida ANTES do SQL (domínio exato, binário): a coluna é `_ci`, então 'pr' casaria com 'PR' no WHERE — a peça nunca pergunta
 * fora do domínio.
 */
import type { Pool } from 'mysql2/promise'
import type { Queryable } from '../db/tx'
import { assertCheckRefuses, assertLengthRefused, CheckProbe } from '../db/check'

export const FISCAL_CODE_STATES = Object.freeze([
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS',
  'SC', 'SE', 'SP', 'TO',
] as const)
export type FiscalCodeState = typeof FISCAL_CODE_STATES[number]
export const FISCAL_CODE_MODELS = Object.freeze(['55', '65'] as const)
export type FiscalCodeModel = typeof FISCAL_CODE_MODELS[number]
export const FISCAL_CODE_ENVIRONMENTS = Object.freeze(['H', 'P'] as const)
export type FiscalCodeEnvironment = typeof FISCAL_CODE_ENVIRONMENTS[number]
export const FISCAL_CODE_OWNERS = Object.freeze(['provider', 'taxpayer'] as const)
export type FiscalCodeOwner = typeof FISCAL_CODE_OWNERS[number]

const TYPE_FORM = /^[A-Z][A-Z0-9_]*$/
/** O valor de um código: ASCII visível, sem espaço, 1 a 100 (o CSRT tem 16 a 36 bytes alfanuméricos — NT 2018.005). */
const CODE_VALUE_FORM = /^[\x21-\x7E]{1,100}$/

/** O que faltou — sem o valor, nunca. */
export interface MissingFiscalCode {
  readonly state:       string
  readonly type:        string
  readonly model:       string
  readonly environment: string
  readonly owner:       FiscalCodeOwner
}

const describeMissing = (m: MissingFiscalCode): string =>
  `${m.type} (${m.owner === 'provider' ? 'do fornecedor do software' : 'do contribuinte'}) da UF ${m.state}, modelo ${m.model}, ambiente ${m.environment}`

/** D-NE218/D-NE223: a UF exige um código e não há credencial ativa e vigente do tipo, modelo e ambiente certos. */
export class FiscalCodeMissingError extends Error {
  readonly code = 'FISCAL_CODE_MISSING'
  constructor(readonly missing: readonly MissingFiscalCode[]) {
    super(`Falta configuração fiscal exigida: ${missing.map(describeMissing).join('; ')}`)
    this.name = 'FiscalCodeMissingError'
  }
}

/** Dois inícios iguais no mesmo escopo (1062 da PK) — a ambiguidade morre na chave. */
export class FiscalCodeConflictError extends Error {
  readonly code = 'FISCAL_CODE_CONFLICT'
  constructor() {
    super('Já existe credencial com o mesmo início de vigência para UF, modelo, ambiente e tipo')
    this.name = 'FiscalCodeConflictError'
  }
}

/** Entrada fora da forma (nunca carrega o valor recebido — só o CAMPO). */
export class FiscalCodeInvalidError extends Error {
  readonly code = 'FISCAL_CODE_INVALID'
  constructor(readonly field: string, why: string) {
    super(`Configuração fiscal inválida: ${field} ${why}`)
    this.name = 'FiscalCodeInvalidError'
  }
}

// ---------------------------------------------------------------------------
// conferência da entrada
// ---------------------------------------------------------------------------

const oneOf = <T extends string>(field: string, v: unknown, domain: readonly T[]): T => {
  if (typeof v !== 'string' || !(domain as readonly string[]).includes(v)) throw new FiscalCodeInvalidError(field, 'fora do domínio')
  return v as T
}
const typeOf = (v: unknown): string => {
  if (typeof v !== 'string' || v.length > 20 || !TYPE_FORM.test(v)) throw new FiscalCodeInvalidError('type', 'fora da forma')
  return v
}
const instant = (field: string, v: unknown): string => {
  if (!(v instanceof Date) || Number.isNaN(v.getTime())) throw new FiscalCodeInvalidError(field, 'não é um instante')
  const iso = v.toISOString()
  if (!/^\d{4}-/.test(iso)) throw new FiscalCodeInvalidError(field, 'fora do intervalo')
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
}
const institution = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new FiscalCodeInvalidError('institutionId', 'não é um id')
  return v
}

/** A linha VIGENTE no instante [at] (UTC `YYYY-MM-DD HH:MM:SS`) entre as vivas — a de maior início ≤ at, se não encerrada. */
function currentAt<R extends { validFrom: string; validUntil: string | null }>(rows: readonly R[], at: string): R | null {
  let best: R | null = null
  for (const r of rows) if (r.validFrom <= at && (best === null || r.validFrom > best.validFrom)) best = r
  if (best === null) return null
  return best.validUntil === null || best.validUntil > at ? best : null
}

const DT = (col: string, as: string) => `DATE_FORMAT(${col}, '%Y-%m-%d %H:%i:%s') AS ${as}`

// ---------------------------------------------------------------------------
// leitura
// ---------------------------------------------------------------------------

export interface FiscalCodeScope {
  readonly state:       string
  readonly model:       string
  readonly environment: string
  readonly at:          Date
}

export interface FiscalCodeRequirement { readonly type: string; readonly owner: FiscalCodeOwner }

/** O que a UF × modelo × ambiente exige no instante (lista vazia = nada a mais — cenário 10). */
export async function fiscalCodeRequirementsOf(q: Queryable, scope: FiscalCodeScope): Promise<FiscalCodeRequirement[]> {
  const state = oneOf('state', scope.state, FISCAL_CODE_STATES)
  const model = oneOf('model', scope.model, FISCAL_CODE_MODELS)
  const environment = oneOf('environment', scope.environment, FISCAL_CODE_ENVIRONMENTS)
  const at = instant('at', scope.at)
  const [rows] = await q.query(
    `SELECT r.tb_fiscal_code_type_id AS type, t.owner AS owner, ${DT('r.valid_from', 'validFrom')}, ${DT('r.valid_until', 'validUntil')}
       FROM tb_fiscal_code_requirement r
       JOIN tb_fiscal_code_type t ON t.id = r.tb_fiscal_code_type_id
      WHERE r.state = ? AND r.model = ? AND r.environment = ? AND r.deleted = 'N' AND t.deleted = 'N' AND r.valid_from <= ?`,
    [state, model, environment, at])
  return requirementsAt(rows as any[], at)
}

function requirementsAt(rows: readonly any[], at: string): FiscalCodeRequirement[] {
  const byType = new Map<string, { validFrom: string; validUntil: string | null; owner: FiscalCodeOwner }[]>()
  for (const r of rows) {
    const type = String(r.type)
    const owner = oneOf('owner', String(r.owner), FISCAL_CODE_OWNERS)
    byType.set(type, [...(byType.get(type) ?? []), { validFrom: String(r.validFrom), validUntil: r.validUntil === null ? null : String(r.validUntil), owner }])
  }
  const out: FiscalCodeRequirement[] = []
  for (const [type, list] of [...byType.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const cur = currentAt(list, at)
    if (cur) out.push(Object.freeze({ type, owner: cur.owner }))
  }
  return out
}

export interface FiscalCredential {
  readonly codeId:    string
  /** O código em claro — só para o cálculo da família (ex.: `hashCsrt`); nunca log, nunca resposta. */
  readonly codeValue: string
  readonly validFrom: string
}

function credentialAt(rows: readonly any[], at: string): FiscalCredential | null {
  const cur = currentAt(rows.map(r => ({
    codeId: String(r.codeId), codeValue: String(r.codeValue), validFrom: String(r.validFrom), validUntil: r.validUntil === null ? null : String(r.validUntil),
  })), at)
  return cur ? Object.freeze({ codeId: cur.codeId, codeValue: cur.codeValue, validFrom: cur.validFrom }) : null
}

/** A credencial VIGENTE do FORNECEDOR (compartilhada por todos os clientes — cenário 3), ou null. */
export async function providerFiscalCredentialOf(
  q: Queryable, scope: FiscalCodeScope & { readonly type: string },
): Promise<FiscalCredential | null> {
  const state = oneOf('state', scope.state, FISCAL_CODE_STATES)
  const model = oneOf('model', scope.model, FISCAL_CODE_MODELS)
  const environment = oneOf('environment', scope.environment, FISCAL_CODE_ENVIRONMENTS)
  const type = typeOf(scope.type)
  const at = instant('at', scope.at)
  const [rows] = await q.query(
    `SELECT code_id AS codeId, code_value AS codeValue, ${DT('valid_from', 'validFrom')}, ${DT('valid_until', 'validUntil')}
       FROM tb_provider_fiscal_credential
      WHERE state = ? AND model = ? AND environment = ? AND tb_fiscal_code_type_id = ? AND owner = 'provider' AND deleted = 'N'
        AND valid_from <= ?`,
    [state, model, environment, type, at])
  return credentialAt(rows as any[], at)
}

/** A credencial VIGENTE do CONTRIBUINTE (só a do estabelecimento — nunca a de outro: cenário 6), ou null. */
export async function establishmentFiscalCredentialOf(
  q: Queryable, scope: { readonly institutionId: number; readonly model: string; readonly environment: string; readonly type: string; readonly at: Date },
): Promise<FiscalCredential | null> {
  const institutionId = institution(scope.institutionId)
  const model = oneOf('model', scope.model, FISCAL_CODE_MODELS)
  const environment = oneOf('environment', scope.environment, FISCAL_CODE_ENVIRONMENTS)
  const type = typeOf(scope.type)
  const at = instant('at', scope.at)
  const [rows] = await q.query(
    `SELECT code_id AS codeId, code_value AS codeValue, ${DT('valid_from', 'validFrom')}, ${DT('valid_until', 'validUntil')}
       FROM tb_establishment_fiscal_credential
      WHERE tb_institution_id = ? AND model = ? AND environment = ? AND tb_fiscal_code_type_id = ? AND owner = 'taxpayer' AND deleted = 'N'
        AND valid_from <= ?`,
    [institutionId, model, environment, type, at])
  return credentialAt(rows as any[], at)
}

export interface RequiredFiscalCredential extends FiscalCredential {
  readonly type:  string
  readonly owner: FiscalCodeOwner
}

/**
 * A composição que o builder da família chama ANTES do XML (D-NE218): o que a UF do emitente × modelo × ambiente exige, cada código do dono
 * certo (fornecedor → a credencial compartilhada; contribuinte → a do estabelecimento). Falta qualquer um = `FiscalCodeMissingError` com
 * TODAS as faltas. Nada exigido = lista vazia.
 */
export async function requiredFiscalCredentialsFor(
  q: Queryable, scope: FiscalCodeScope & { readonly institutionId: number },
): Promise<RequiredFiscalCredential[]> {
  const institutionId = institution(scope.institutionId)
  const out: RequiredFiscalCredential[] = []
  const missing: MissingFiscalCode[] = []
  for (const req of await fiscalCodeRequirementsOf(q, scope)) {
    const cred = req.owner === 'provider'
      ? await providerFiscalCredentialOf(q, { ...scope, type: req.type })
      : await establishmentFiscalCredentialOf(q, { institutionId, model: scope.model, environment: scope.environment, type: req.type, at: scope.at })
    if (cred) out.push(Object.freeze({ ...cred, type: req.type, owner: req.owner }))
    else missing.push(Object.freeze({ state: scope.state, type: req.type, model: scope.model, environment: scope.environment, owner: req.owner }))
  }
  if (missing.length) throw new FiscalCodeMissingError(missing)
  return out
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

/**
 * D-NE223 (o boot recusa): para cada (modelo × ambiente) com ao menos uma habilitação VIVA em `tb_establishment_issuer` (a linha — o boot
 * não decifra o A1), toda regra viva e vigente de tipo com dono `provider` tem de ter a credencial vigente do fornecedor; senão RECUSA com
 * todas as faltas numa mensagem (UF, tipo, modelo, ambiente). Regras de dono `taxpayer` dependem do estabelecimento: ficam para a recusa
 * da nota. Efeito dito na ficha: a habilitação não tem UF (D-F10), então um 55/H vivo exige o CSRT de H do PR mesmo sem cliente no PR — o
 * código é da Setes e serve a todos. Quem chama é a família que EMITE (a nfe-api); a nfse-api, que hospeda a rota de cadastro, não.
 */
export async function assertRequiredProviderCodesPresent(q: Queryable, at: Date = new Date()): Promise<void> {
  const atSql = instant('at', at)
  const [issuers] = await q.query(
    `SELECT DISTINCT model, environment FROM tb_establishment_issuer
      WHERE deleted = 'N' AND model COLLATE utf8mb4_bin IN ('55', '65') AND environment COLLATE utf8mb4_bin IN ('H', 'P')`)
  const missing: MissingFiscalCode[] = []
  const pairs = (issuers as any[]).map(r => [String(r.model), String(r.environment)] as const)
    .sort(([a, b], [c, d]) => (a + b < c + d ? -1 : a + b > c + d ? 1 : 0))
  for (const [model, environment] of pairs) {
    const [rows] = await q.query(
      `SELECT r.state AS state, r.tb_fiscal_code_type_id AS type, t.owner AS owner, ${DT('r.valid_from', 'validFrom')}, ${DT('r.valid_until', 'validUntil')}
         FROM tb_fiscal_code_requirement r
         JOIN tb_fiscal_code_type t ON t.id = r.tb_fiscal_code_type_id
        WHERE r.model = ? AND r.environment = ? AND r.deleted = 'N' AND t.deleted = 'N' AND r.valid_from <= ?`,
      [model, environment, atSql])
    const states = [...new Set((rows as any[]).map(r => String(r.state)))].sort()
    for (const state of states) {
      for (const req of requirementsAt((rows as any[]).filter(r => String(r.state) === state), atSql)) {
        if (req.owner !== 'provider') continue
        if (!await providerFiscalCredentialOf(q, { state, model, environment, type: req.type, at })) {
          missing.push(Object.freeze({ state, type: req.type, model, environment, owner: req.owner }))
        }
      }
    }
  }
  if (missing.length) throw new FiscalCodeMissingError(missing)
}

const STATE_OK = 'PR', TYPE_OK = 'CSRT'
const reqProbe = (value: string, constraint: string, row: { state?: string; model?: string; environment?: string; type?: string }, n: number): CheckProbe => ({
  value, constraint,
  sql: `INSERT INTO tb_fiscal_code_requirement (state, model, environment, tb_fiscal_code_type_id, valid_from, source, deleted)
        VALUES (?, ?, ?, ?, ?, 'sonda do boot', 'N')`,
  params: [row.state ?? STATE_OK, row.model ?? '55', row.environment ?? 'H', row.type ?? TYPE_OK, `1990-01-0${n} 00:00:00`],
})
const credProbe = (value: string, constraint: string, row: { state?: string; model?: string; environment?: string; type?: string; owner?: string }, n: number): CheckProbe => ({
  value, constraint,
  sql: `INSERT INTO tb_provider_fiscal_credential (state, model, environment, tb_fiscal_code_type_id, owner, valid_from, code_id, code_value, deleted)
        VALUES (?, ?, ?, ?, ?, ?, '01', 'sonda', 'N')`,
  params: [row.state ?? STATE_OK, row.model ?? '55', row.environment ?? 'H', row.type ?? TYPE_OK, row.owner ?? 'provider', `1990-01-0${n} 00:00:00`],
})
const estProbe = (value: string, constraint: string, row: { model?: string; environment?: string; type?: string; owner?: string }, n: number): CheckProbe => ({
  value, constraint,
  sql: `INSERT INTO tb_establishment_fiscal_credential (tb_institution_id, model, environment, tb_fiscal_code_type_id, owner, valid_from, code_id, code_value, deleted)
        VALUES (0, ?, ?, ?, ?, ?, '1', 'sonda', 'N')`,
  params: [row.model ?? '65', row.environment ?? 'H', row.type ?? 'CSC', row.owner ?? 'taxpayer', `1990-01-0${n} 00:00:00`],
})
const typeProbe = (value: string, constraint: string, id: string, owner: string): CheckProbe => ({
  value, constraint,
  sql: `INSERT INTO tb_fiscal_code_type (id, owner, code_id_pattern, description, deleted) VALUES (?, ?, '^x$', 'sonda do boot', 'N')`,
  params: [id, owner],
})

/**
 * D-F45/D-NE84/D-F120 aplicados à 006: cada domínio fechado é recusado PELO MOTOR, pelo CHECK de nome certo — um valor fora do domínio E a
 * minúscula de um válido (o `_ci` aceitaria a minúscula). Sondas numa transação SEMPRE desfeita, sem FK (a sonda mira o CHECK, não a FK); e
 * a sessão é ESTRITA no `code_value` (101 posições recusadas — D-NE172).
 */
export async function assertFiscalCodeDomainsEnforced(pool: Pick<Pool, 'getConnection'>): Promise<void> {
  const noFk = { withoutForeignKeys: true }
  await assertCheckRefuses(pool, 'o catálogo dos códigos fiscais', [
    typeProbe('csrt', 'ck_fiscal_code_type_id_bin', 'csrt', 'provider'),
    typeProbe('1X', 'ck_fiscal_code_type_id_bin', '1X', 'provider'),
    typeProbe('Provider', 'ck_fiscal_code_type_owner_bin', 'ZZSONDA1', 'Provider'),
    typeProbe('x', 'ck_fiscal_code_type_owner_bin', 'ZZSONDA2', 'x'),
  ], noFk)
  await assertCheckRefuses(pool, 'as regras fiscais por UF', [
    reqProbe('pr', 'ck_fiscal_code_requirement_state_bin', { state: 'pr' }, 1),
    reqProbe('ZZ', 'ck_fiscal_code_requirement_state_bin', { state: 'ZZ' }, 2),
    reqProbe('SE', 'ck_fiscal_code_requirement_model_bin', { model: 'SE' }, 3),
    reqProbe('5', 'ck_fiscal_code_requirement_model_bin', { model: '5' }, 4),
    reqProbe('h', 'ck_fiscal_code_requirement_environment_bin', { environment: 'h' }, 5),
    reqProbe('X', 'ck_fiscal_code_requirement_environment_bin', { environment: 'X' }, 6),
    reqProbe('csrt', 'ck_fiscal_code_requirement_type_bin', { type: 'csrt' }, 7),
  ], noFk)
  await assertCheckRefuses(pool, 'as credenciais do fornecedor', [
    credProbe('Provider', 'ck_provider_fiscal_credential_owner_bin', { owner: 'Provider' }, 1),
    credProbe('taxpayer', 'ck_provider_fiscal_credential_owner_bin', { owner: 'taxpayer' }, 2),
    credProbe('pr', 'ck_provider_fiscal_credential_state_bin', { state: 'pr' }, 3),
    credProbe('SE', 'ck_provider_fiscal_credential_model_bin', { model: 'SE' }, 4),
    credProbe('h', 'ck_provider_fiscal_credential_environment_bin', { environment: 'h' }, 5),
    credProbe('csrt', 'ck_provider_fiscal_credential_type_bin', { type: 'csrt' }, 6),
  ], noFk)
  await assertCheckRefuses(pool, 'as credenciais do contribuinte', [
    estProbe('Taxpayer', 'ck_establishment_fiscal_credential_owner_bin', { owner: 'Taxpayer' }, 1),
    estProbe('provider', 'ck_establishment_fiscal_credential_owner_bin', { owner: 'provider' }, 2),
    estProbe('SE', 'ck_establishment_fiscal_credential_model_bin', { model: 'SE' }, 3),
    estProbe('h', 'ck_establishment_fiscal_credential_environment_bin', { environment: 'h' }, 4),
    estProbe('csc', 'ck_establishment_fiscal_credential_type_bin', { type: 'csc' }, 5),
  ], noFk)
  await assertLengthRefused(pool, 'o código da credencial', [{
    value: 'A'.repeat(101), column: 'tb_provider_fiscal_credential.code_value',
    sql: `INSERT INTO tb_provider_fiscal_credential (state, model, environment, tb_fiscal_code_type_id, owner, valid_from, code_id, code_value, deleted)
          VALUES ('PR', '55', 'H', 'CSRT', 'provider', '1990-01-09 00:00:00', '01', ?, 'N')`,
    params: ['A'.repeat(101)],
  }], noFk)
}

// ---------------------------------------------------------------------------
// escrita e listagem (rota da nfse-api — D-NE224; script do Valdo — D-NE226)
// ---------------------------------------------------------------------------

export interface ProviderFiscalCredentialInput {
  readonly state:       string
  readonly model:       string
  readonly environment: string
  readonly type:        string
  readonly codeId:      string
  readonly codeValue:   string
  readonly validFrom:   Date
  readonly validUntil?: Date | null
  readonly userId?:     number | null
}

/** O que a escrita e a listagem devolvem — TUDO menos o valor. */
export interface ProviderFiscalCredentialRow {
  readonly state:       string
  readonly model:       string
  readonly environment: string
  readonly type:        string
  readonly codeId:      string
  readonly validFrom:   string
  readonly validUntil:  string | null
  readonly userId:      number | null
}

const isDuplicate = (err: any): boolean => err?.errno === 1062 || String(err?.code ?? '') === 'ER_DUP_ENTRY'

/** Grava uma credencial do FORNECEDOR pela PK (o tipo tem de ser do dono `provider`; o `code_id` na forma do tipo). Nunca devolve o valor. */
export async function saveProviderFiscalCredential(q: Queryable, input: ProviderFiscalCredentialInput): Promise<ProviderFiscalCredentialRow> {
  const state = oneOf('state', input.state, FISCAL_CODE_STATES)
  const model = oneOf('model', input.model, FISCAL_CODE_MODELS)
  const environment = oneOf('environment', input.environment, FISCAL_CODE_ENVIRONMENTS)
  const type = typeOf(input.type)
  const validFrom = instant('validFrom', input.validFrom)
  const validUntil = input.validUntil === undefined || input.validUntil === null ? null : instant('validUntil', input.validUntil)
  if (validUntil !== null && validUntil <= validFrom) throw new FiscalCodeInvalidError('validUntil', 'não é depois do início')
  const userId = input.userId === undefined || input.userId === null ? null : input.userId
  if (userId !== null && (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0)) throw new FiscalCodeInvalidError('userId', 'não é um id')
  if (typeof input.codeValue !== 'string' || !CODE_VALUE_FORM.test(input.codeValue)) {
    throw new FiscalCodeInvalidError('codeValue', 'fora da forma (1 a 100 caracteres ASCII visíveis, sem espaço)')
  }
  const [types] = await q.query(
    `SELECT id, owner, code_id_pattern AS pattern FROM tb_fiscal_code_type WHERE id = ? AND deleted = 'N'`, [type])
  const t = (types as any[]).find(r => String(r.id) === type)
  if (!t) throw new FiscalCodeInvalidError('type', 'não existe no catálogo')
  if (String(t.owner) !== 'provider') throw new FiscalCodeInvalidError('type', 'não é de dono fornecedor')
  if (typeof input.codeId !== 'string' || !new RegExp(String(t.pattern)).test(input.codeId)) {
    throw new FiscalCodeInvalidError('codeId', `fora da forma do tipo ${type}`)
  }
  try {
    await q.query(
      `INSERT INTO tb_provider_fiscal_credential
         (state, model, environment, tb_fiscal_code_type_id, owner, valid_from, valid_until, code_id, code_value, tb_user_id, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, 'provider', ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'N')`,
      [state, model, environment, type, validFrom, validUntil, input.codeId, input.codeValue, userId])
  } catch (err) {
    if (isDuplicate(err)) throw new FiscalCodeConflictError()
    throw err
  }
  return Object.freeze({ state, model, environment, type, codeId: input.codeId, validFrom, validUntil, userId })
}

/** Encerra (`valid_until` = at) a credencial viva e não encerrada identificada pela PK. Devolve se encerrou. */
export async function endProviderFiscalCredential(
  q: Queryable, key: { readonly state: string; readonly model: string; readonly environment: string; readonly type: string; readonly validFrom: Date },
  at: Date = new Date(),
): Promise<boolean> {
  const state = oneOf('state', key.state, FISCAL_CODE_STATES)
  const model = oneOf('model', key.model, FISCAL_CODE_MODELS)
  const environment = oneOf('environment', key.environment, FISCAL_CODE_ENVIRONMENTS)
  const type = typeOf(key.type)
  const validFrom = instant('validFrom', key.validFrom)
  const atSql = instant('at', at)
  if (atSql <= validFrom) throw new FiscalCodeInvalidError('at', 'não é depois do início')
  const [res] = await q.query(
    `UPDATE tb_provider_fiscal_credential SET valid_until = ?, updated_at = UTC_TIMESTAMP()
      WHERE state = ? AND model = ? AND environment = ? AND tb_fiscal_code_type_id = ? AND valid_from = ? AND deleted = 'N'
        AND (valid_until IS NULL OR valid_until > ?)`,
    [atSql, state, model, environment, type, validFrom, atSql])
  return Number((res as any)?.affectedRows ?? 0) > 0
}

/** As credenciais vivas do fornecedor — SEM o valor (a leitura da rota — D-NE224). */
export async function listProviderFiscalCredentials(q: Queryable): Promise<ProviderFiscalCredentialRow[]> {
  const [rows] = await q.query(
    `SELECT state, model, environment, tb_fiscal_code_type_id AS type, code_id AS codeId, ${DT('valid_from', 'validFrom')},
            ${DT('valid_until', 'validUntil')}, tb_user_id AS userId
       FROM tb_provider_fiscal_credential WHERE deleted = 'N'
      ORDER BY state, model, environment, tb_fiscal_code_type_id, valid_from`)
  return (rows as any[]).map(r => Object.freeze({
    state: String(r.state), model: String(r.model), environment: String(r.environment), type: String(r.type), codeId: String(r.codeId),
    validFrom: String(r.validFrom), validUntil: r.validUntil === null ? null : String(r.validUntil),
    userId: r.userId === null || r.userId === undefined ? null : Number(r.userId),
  }))
}
