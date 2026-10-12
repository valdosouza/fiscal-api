import { PoolConnection } from 'mysql2/promise'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'
import { Queryable } from '../db/tx'
import { assertSchema } from '../db/schema'
import { DEFAULT_TIME_ZONE, isValidTimeZone } from '../time/zone'
import { InvoiceRef } from '../ref/invoice-ref'

/**
 * FONTE DE FATOS GESTÃO 2027 — base comum (D-F10). ÚNICO lugar do núcleo que lê o ERP
 * (`setes_central` + `setes_<cliente>`, mesma instância MySQL — D-F9). A cerca do critério §12.8-1
 * ("nenhum tb_invoice/tb_order/tb_entity* fora da fonte de fatos") aponta para esta pasta e para a
 * fonte de fatos de cada família.
 *
 * O que vem daqui:
 *  - POLÍTICAS do ERP pelas VIEWs que o setes-api publica (D-F32 — migration 065): interface do RAMO
 *    por pedido (`vw_order_interface`) e VIDA da nota (`vw_invoice_life`) — uma verdade só;
 *  - privilégio por usuário × interface e licença (interface contratada — D-F14), fuso do
 *    estabelecimento (config `time_zone`), cadeia de entidade e `tb_entity_tax`;
 *  - a TRAVA da nota (D-F31): `FOR UPDATE` na linha da `tb_invoice` + leitura travante COMPARTILHADA do
 *    último evento (regra 2 do PADROES §9) — a ÚNICA coisa que uma API fiscal faz no ERP além de ler.
 */

export const PRIVILEGE_CANCELAR = 7
export const PRIVILEGE_TRANSMITIR = 9

const TTL_MS = Number(process.env.ERP_FACTS_CACHE_TTL_MS ?? 60_000)

interface Cached<T> { value: T; expires: number }
const zoneCache = new Map<string, Cached<string>>()
const schemaCache = new Map<number, Cached<string | null>>()
const interfaceIdCache = new Map<string, number>()

export function resetErpFactsCache(): void {
  zoneCache.clear(); schemaCache.clear(); interfaceIdCache.clear()
}

// ---------------------------------------------------------------------------
// Identidade: o schema do token é o da institution?
// ---------------------------------------------------------------------------

/** Defesa em profundidade sobre o JWT: institution ativa e com ESTE schema. */
export async function assertInstitutionSchema(q: Queryable, institutionId: number, schemaName: string): Promise<void> {
  assertSchema(schemaName)
  const hit = schemaCache.get(institutionId)
  let schema: string | null
  if (hit && hit.expires > Date.now()) schema = hit.value
  else {
    const [rows] = await q.query(
      `SELECT schema_name AS schemaName FROM setes_central.tb_institution WHERE id = ? AND deleted = 'N' AND active = 'S'`,
      [institutionId])
    schema = rows[0]?.schemaName ?? null
    schemaCache.set(institutionId, { value: schema, expires: Date.now() + TTL_MS })
  }
  if (schema !== schemaName) {
    throw new HttpError(401, 'Token não corresponde a uma institution ativa com este schema', undefined, ErrorCodes.INSTITUTION_MISMATCH)
  }
}

// ---------------------------------------------------------------------------
// Políticas publicadas pelo ERP (D-F32)
// ---------------------------------------------------------------------------

export type OrderInterfaceKey = 'service-orders' | 'order-returns' | 'orders'

/**
 * Interface do RAMO do pedido da nota (espelho de `resolveOrderInterface`); sem linha = 'orders'. O pedido e a nota têm o MESMO id
 * no ERP (a ordem vincula todo o processo) — por isso recebe a referência da NOTA (NE-1a: terminal por parâmetro, D-NE12).
 */
export async function orderInterface(q: Queryable, schemaName: string, ref: InvoiceRef): Promise<OrderInterfaceKey> {
  const s = assertSchema(schemaName)
  if (!Number.isInteger(ref.invoiceId) || ref.invoiceId <= 0) return 'orders'
  const [rows] = await q.query(
    `SELECT interface_key AS k FROM \`${s}\`.vw_order_interface WHERE tb_institution_id = ? AND tb_order_id = ? AND terminal = ?`,
    [ref.institutionId, ref.invoiceId, ref.terminal])
  const k = rows[0]?.k
  return k === 'service-orders' || k === 'order-returns' ? k : 'orders'
}

export interface InvoiceLife {
  invoiceId:      number
  /** Cabeçalho soft-deletado (nota pendente cancelada — D3); os eventos continuam. */
  invoiceDeleted: boolean
  /** Evento E que abriu a VIDA vigente (D-N27); null = nota sem evento (sincronizada da origem). */
  lifeEvent:      number | null
  lastEvent:      number | null
  /** E emitida · C cancelada · null sem evento. */
  lastKind:       string | null
}

function mapLife(r: any): InvoiceLife {
  return {
    invoiceId: Number(r.invoiceId), invoiceDeleted: String(r.invoiceDeleted) === 'S',
    lifeEvent: r.lifeEvent == null ? null : Number(r.lifeEvent),
    lastEvent: r.lastEvent == null ? null : Number(r.lastEvent), lastKind: r.lastKind ?? null,
  }
}

const LIFE_SELECT = (s: string) => `
  SELECT tb_invoice_id AS invoiceId, invoice_deleted AS invoiceDeleted, life_event AS lifeEvent,
         last_event AS lastEvent, last_kind AS lastKind
    FROM \`${s}\`.vw_invoice_life`

export async function invoiceLife(q: Queryable, schemaName: string, ref: InvoiceRef): Promise<InvoiceLife | null> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query(`${LIFE_SELECT(s)} WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ?`,
    [ref.institutionId, ref.invoiceId, ref.terminal])
  return rows[0] ? mapLife(rows[0]) : null
}

/** Vidas de VÁRIAS notas do MESMO estabelecimento e terminal (lote — a chave da nota inteira por parâmetro, D-NE12). */
export async function invoiceLives(q: Queryable, schemaName: string, scope: Pick<InvoiceRef, 'institutionId' | 'terminal'>, invoiceIds: number[]): Promise<Map<number, InvoiceLife>> {
  const out = new Map<number, InvoiceLife>()
  if (!invoiceIds.length) return out
  const s = assertSchema(schemaName)
  const [rows] = await q.query(`${LIFE_SELECT(s)} WHERE tb_institution_id = ? AND tb_invoice_id IN (?) AND terminal = ?`,
    [scope.institutionId, invoiceIds, scope.terminal])
  for (const r of rows) out.set(Number(r.invoiceId), mapLife(r))
  return out
}

// ---------------------------------------------------------------------------
// Autorização de AÇÃO (regra do ERP aplicada na porta fiscal — D-F13) e licença (D-F14)
// ---------------------------------------------------------------------------

async function interfaceIdOf(q: Queryable, interfaceKey: string): Promise<number | null> {
  const cached = interfaceIdCache.get(interfaceKey)
  if (cached !== undefined) return cached
  const [rows] = await q.query(`SELECT id FROM setes_central.tb_interface WHERE i18n_key = ? AND deleted = 'N' LIMIT 1`, [interfaceKey])
  if (!rows[0]) return null
  const id = Number(rows[0].id)
  interfaceIdCache.set(interfaceKey, id)
  return id
}

/** Usuário regular tem o privilégio na interface? (vínculo ativo — mesma SQL do setes-api) */
export async function userHasPrivilege(q: Queryable, schemaName: string, userId: number, interfaceKey: string, privilegeId: number): Promise<boolean> {
  const s = assertSchema(schemaName)
  const interfaceId = await interfaceIdOf(q, interfaceKey)
  if (interfaceId == null) return false
  const [rows] = await q.query(
    `SELECT 1 FROM \`${s}\`.tb_user_has_privilege
      WHERE tb_user_id = ? AND tb_interface_id = ? AND tb_privilege_id = ? AND active = 'S' AND deleted = 'N' LIMIT 1`,
    [userId, interfaceId, privilegeId])
  return rows.length > 0
}

/** Interface no contrato da institution (Q-N32 — leituras fiscais; licença — D-F14). */
export async function institutionHasInterface(q: Queryable, schemaName: string, institutionId: number, interfaceKey: string): Promise<boolean> {
  const s = assertSchema(schemaName)
  const interfaceId = await interfaceIdOf(q, interfaceKey)
  if (interfaceId == null) return false
  const [rows] = await q.query(
    `SELECT 1 FROM \`${s}\`.tb_institution_has_interface
      WHERE tb_institution_id = ? AND tb_interface_id = ? AND (active IS NULL OR active = 'S') AND deleted = 'N' LIMIT 1`,
    [institutionId, interfaceId])
  return rows.length > 0
}

// ---------------------------------------------------------------------------
// Fuso do estabelecimento (Q-TZ1/Q-TZ2) — config `time_zone` da interface establishment
// ---------------------------------------------------------------------------

export async function institutionZone(q: Queryable, schemaName: string, institutionId: number): Promise<string> {
  const key = `${schemaName}|${institutionId}`
  const hit = zoneCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value
  const s = assertSchema(schemaName)
  const [rows] = await q.query(
    `SELECT COALESCE(v.content, c.default_content) AS zone
       FROM setes_central.tb_interface i
       JOIN setes_central.tb_interface_has_config c
         ON c.tb_interface_id = i.id AND c.name = 'time_zone' AND c.deleted = 'N'
       LEFT JOIN \`${s}\`.tb_institution_has_config v
         ON v.tb_interface_id = i.id AND v.name = 'time_zone' AND v.tb_institution_id = ?
        AND v.tb_user_id = 0 AND v.deleted = 'N'
      WHERE i.i18n_key = 'establishment' AND i.deleted = 'N'
      LIMIT 1`,
    [institutionId])
  const raw = rows?.[0]?.zone
  const zone = typeof raw === 'string' && raw !== '' && isValidTimeZone(raw) ? raw : DEFAULT_TIME_ZONE
  zoneCache.set(key, { value: zone, expires: Date.now() + TTL_MS })
  return zone
}

// ---------------------------------------------------------------------------
// Cadeia de entidade (setes_central) e tributação da relação (schema do cliente)
// ---------------------------------------------------------------------------

export interface EntityAddress {
  main:         string | null
  street:       string | null
  nmbr:         string | null
  complement:   string | null
  neighborhood: string | null
  zipCode:      string | null
  cityId:       number | null
  cityName:     string | null
  stateName:    string | null
}

export interface EntityFiscal {
  id:          number
  nameCompany: string | null
  nickTrade:   string | null
  cnpj:        string | null
  im:          string | null
  cpf:         string | null
  addresses:   EntityAddress[]
}

/** Só o que o documento fiscal usa da cadeia (nome, CNPJ/IM, CPF, endereços com cidade/UF). */
export async function entityFiscal(q: Queryable, entityId: number): Promise<EntityFiscal | null> {
  const [ent] = await q.query(`SELECT name_company AS nameCompany, nick_trade AS nickTrade FROM setes_central.tb_entity WHERE id = ?`, [entityId])
  if (!ent[0]) return null
  const [company] = await q.query(`SELECT cnpj, im FROM setes_central.tb_company WHERE id = ? AND deleted = 'N'`, [entityId])
  const [person] = await q.query(`SELECT cpf FROM setes_central.tb_person WHERE id = ? AND deleted = 'N'`, [entityId])
  const [addr] = await q.query(
    `SELECT a.main, a.street, a.nmbr, a.complement, a.neighborhood, a.zip_code AS zipCode, a.tb_city_id AS cityId,
            ci.name AS cityName, st.name AS stateName
       FROM setes_central.tb_address a
       LEFT JOIN setes_central.tb_state st ON st.id = a.tb_state_id
       LEFT JOIN setes_central.tb_city  ci ON ci.id = a.tb_city_id
      WHERE a.id = ? AND a.deleted = 'N'
      ORDER BY a.kind`,
    [entityId])
  return {
    id: entityId, nameCompany: ent[0].nameCompany ?? null, nickTrade: ent[0].nickTrade ?? null,
    cnpj: company[0]?.cnpj ?? null, im: company[0]?.im ?? null, cpf: person[0]?.cpf ?? null,
    addresses: (addr as any[]).map(a => ({
      main: a.main ?? null, street: a.street ?? null, nmbr: a.nmbr ?? null, complement: a.complement ?? null,
      neighborhood: a.neighborhood ?? null, zipCode: a.zipCode ?? null, cityId: a.cityId == null ? null : Number(a.cityId),
      cityName: a.cityName ?? null, stateName: a.stateName ?? null,
    })),
  }
}

export interface EntityTax {
  simplesRegime:          string | null
  simplesAssessment:      string | null
  simplesTotalTaxAliquot: number | null
  specialTaxRegime:       string | null
}

export async function entityTax(q: Queryable, schemaName: string, institutionId: number, entityId: number): Promise<EntityTax | null> {
  const s = assertSchema(schemaName)
  const [rows] = await q.query(
    `SELECT simples_regime AS simplesRegime, simples_assessment AS simplesAssessment,
            simples_total_tax_aliquot AS simplesTotalTaxAliquot, special_tax_regime AS specialTaxRegime
       FROM \`${s}\`.tb_entity_tax WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [entityId, institutionId])
  const r = rows[0]
  if (!r) return null
  return {
    simplesRegime: r.simplesRegime ?? null, simplesAssessment: r.simplesAssessment ?? null,
    simplesTotalTaxAliquot: r.simplesTotalTaxAliquot == null ? null : Number(r.simplesTotalTaxAliquot),
    specialTaxRegime: r.specialTaxRegime ?? null,
  }
}

const digitsOf = (v: string | null | undefined) => String(v ?? '').replace(/\D/g, '')

/** Código IBGE (7 dígitos) da cidade; null quando ausente/malformado. */
export async function cityIbge(q: Queryable, cityId: number | null | undefined): Promise<string | null> {
  if (cityId == null) return null
  const [rows] = await q.query(`SELECT ibge FROM setes_central.tb_city WHERE id = ?`, [cityId])
  const ibge = digitsOf(rows[0]?.ibge)
  return ibge.length === 7 ? ibge : null
}

/** CNPJ do estabelecimento (14 dígitos) — conferência do A1 (D-N29b) e pasta do arquivo fiscal. */
export async function establishmentCnpj(q: Queryable, institutionId: number): Promise<string | null> {
  const [rows] = await q.query(`SELECT cnpj FROM setes_central.tb_company WHERE id = ? AND deleted = 'N'`, [institutionId])
  const cnpj = digitsOf(rows[0]?.cnpj)
  return cnpj.length === 14 ? cnpj : null
}

/**
 * D-F39 (lacuna do guardião): o ERP tem habilitação SE PRÓPRIA (o caminho de emissão do setes-api — tabela que a F2a
 * aposenta) para esta institution? Viva OU excluída: o contador tem história (D-N18) — uma habilitação nova na API
 * começando do zero cunharia Ids de DPS que o ERP já usou (cenário R2-2). Só SE: o ERP nunca transmitiu 55/65 (a linha
 * 55 do ERP é a série do faturamento — D-F21). A F2a NÃO apaga a tabela (D-F44: aposenta SEM DROP; D-F110: a migration de nome fixo
 * `f2a_fiscal_passivo` do setes-api — a 069, errata da numeração — a CONGELA por gatilhos: "origem congelada", só o ato N→S passa);
 * a tabela ausente (schema sem a migration 058, cliente que nunca emitiu pelo ERP) = não tem.
 */
export async function erpServiceIssuerExists(q: Queryable, schemaName: string, institutionId: number): Promise<boolean> {
  const s = assertSchema(schemaName)
  try {
    const [rows] = await q.query(
      `SELECT 1 AS x FROM \`${s}\`.tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE' LIMIT 1`, [institutionId])
    return (rows as any[]).length > 0
  } catch (err: any) {
    if (err?.code === 'ER_NO_SUCH_TABLE' || err?.errno === 1146) return false
    throw err
  }
}

// ---------------------------------------------------------------------------
// A TRAVA da nota (D-F27/D-F31) — serializa transmitir (API fiscal) × cancelar local (setes-api)
// ---------------------------------------------------------------------------

export interface LockedInvoice {
  /** Cabeçalho vivo (deleted='N')? Nota pendente cancelada localmente fica soft-deletada (D3). */
  alive:     boolean
  /** VIDA vigente (evento E mais recente — D-N27); null = nota sem evento (sincronizada da origem). */
  lifeEvent: number | null
  lastEvent: number | null
  lastKind:  string | null
}

/**
 * `FOR UPDATE` na linha da nota (viva OU soft-deletada — a linha é o ponto de serialização dos dois
 * serviços) + VIDA e último evento lidos da MESMA view de política do ERP (`vw_invoice_life` — D-F32: uma
 * regra só, gate socrático L-9) por leitura travante COMPARTILHADA (fresca: não depende do snapshot do
 * REPEATABLE READ). Primeira coisa que a transação faz no ERP. null = a linha não existe.
 * D-F126 (= Q-F136 (a), Valdo 2026-10-12 — gates da A2 da F2a, F2A2-ADV-02 provado no MariaDB 10.4.20): a leitura travante da view só é
 * fresca nas tabelas do JOIN — os NOT EXISTS de dentro dela ("último evento") leem o RETRATO do REPEATABLE READ. Retrato aberto ANTES
 * desta trava + re-faturamento no intervalo = VÁRIAS linhas (vida × último, novas e velhas). Aqui a trava é o 1º comando (withInvoiceTx),
 * mas a regra não depende disso: mais de uma linha = 409 RESOURCE_BUSY (PADROES_BANCO §11 regra 13) — nunca "a primeira".
 */
export async function lockInvoice(conn: PoolConnection, schemaName: string, ref: InvoiceRef): Promise<LockedInvoice | null> {
  const s = assertSchema(schemaName)
  const [rows] = await conn.query<any[]>(
    `SELECT deleted FROM \`${s}\`.tb_invoice WHERE id = ? AND tb_institution_id = ? AND terminal = ? FOR UPDATE`,
    [ref.invoiceId, ref.institutionId, ref.terminal])
  if (!rows[0]) return null
  const [life] = await conn.query<any[]>(
    `SELECT life_event AS lifeEvent, last_event AS lastEvent, last_kind AS lastKind FROM \`${s}\`.vw_invoice_life
      WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ? LOCK IN SHARE MODE`,
    [ref.institutionId, ref.invoiceId, ref.terminal])
  if (life.length > 1) {
    throw new HttpError(409, `A nota ${ref.invoiceId} mudou durante a operação — tente novamente`, undefined, ErrorCodes.RESOURCE_BUSY)
  }
  const l = life[0]
  return {
    alive: String(rows[0].deleted) !== 'S',
    lifeEvent: l?.lifeEvent == null ? null : Number(l.lifeEvent),
    lastEvent: l?.lastEvent == null ? null : Number(l.lastEvent),
    lastKind: l?.lastKind ?? null,
  }
}
