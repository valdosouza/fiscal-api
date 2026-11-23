import { ISSUER_MODELS, IssuerModel } from './issuer-models'
import type { TransmissionEnvironment } from '../voice/kinds'
import type { ReadQueryable } from '../voice/family-reader'

/**
 * LEITURA PUBLICADA DA HABILITAÇÃO por modelo — fiscal-api:FAMILIA.E5.P3.T1 (D-NE170 = Q-NE170 (a), Valdo 2026-10-31; nomes do guardião
 * conceitual, anexo `ficha-familia-e5-p3-pareceres.md`). Quem lê de fora da família lê o AMBIENTE do modelo por aqui: VIVO, nunca cache
 * nem cópia (uma fonte só para o ambiente).
 *
 * DEPOIS DA D-NE257 (Valdo 2026-11-23, fiscal-api:FAMILIA.E5.P5): o número do 55 nasce na TRANSMISSÃO, na nfe-api, e o gerador
 * (`numbering/number-sequence`) tira o ambiente da habilitação TRAVADA, não desta view. A leitura fica publicada (tirar export é versão
 * maior, e a nfe-api confere a view no boot); o motivo de nascença — escolher o eixo das faixas ao gerar o número — deixou de existir.
 *
 * Só a JANELA de leitura da linha da habilitação (`tb_establishment_issuer`): nenhum fato novo, nenhuma regra. A view publica a VIRADA
 * (`cutoverAt`, D-F39) sem filtrar — NULL (réplica do ERP) e "sem linha" (`null` aqui: não habilitado ou apagado) são fatos diferentes, e
 * quem decide o que fazer com cada um é quem chama. Todos os modelos do domínio (`ISSUER_MODELS`); a restrição ao 55/65 é de quem lê.
 *
 * Fica FORA daqui o lado de escrita (`establishment.repository.ts`: `openIssuer`, aluguel, nDPS): este módulo entra na superfície
 * `fiscal-api/reading` e só importa o catálogo dos modelos e tipos. O SELECT cru (`issuerViewSelect`, `issuerViewQuery`) fica no barrel e
 * FORA da superfície (F2A1-04 / D-NE66 (b)).
 *
 * Só SELECT, sem trava: quem DECIDE pelo ambiente (gerar número, reservar inutilização) lê a habilitação travada, no lado de escrita.
 */

/** A view publicada da habilitação (migration 007 do núcleo). */
export const ISSUER_VIEW = 'vw_establishment_issuer'

/** Uma linha viva da habilitação, como a view a publica. */
export interface IssuerView {
  readonly institutionId: number
  readonly model:         IssuerModel
  readonly environment:   TransmissionEnvironment
  /** Desde quando (UTC, 'YYYY-MM-DD HH:MM:SS') a API fiscal emite por esta habilitação; `null` = réplica do ERP (D-F39). */
  readonly cutoverAt:     string | null
}

/** A PK inteira da habilitação — os dois OBRIGATÓRIOS (nunca "todos os modelos"). */
export interface IssuerViewScope {
  readonly institutionId: number
  readonly model:         IssuerModel
}

const IDENT = /^[a-z][a-z0-9_]*$/
const INSTANT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

function assertScope(scope: IssuerViewScope): IssuerViewScope {
  const id = scope?.institutionId
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > 2_147_483_647) {
    throw new Error(`Leitura da habilitação: estabelecimento inválido (${JSON.stringify(id)} — inteiro entre 1 e 2147483647)`)
  }
  if (!ISSUER_MODELS.includes(scope?.model)) throw new Error(`Leitura da habilitação: modelo fora do domínio (${JSON.stringify(scope?.model)} — ${ISSUER_MODELS.join('/')})`)
  return scope
}

/** SELECT pronto da view da habilitação ([db] = banco fiscal; a virada em UTC). */
export function issuerViewSelect(db: string, alias = 'v'): string {
  // `typeof` antes do teste: `RegExp.test(undefined)` testa o TEXTO 'undefined' e passaria
  if (typeof db !== 'string' || !/^[a-z0-9_]+$/.test(db)) throw new Error(`Banco fiscal inválido: ${db}`)
  if (typeof alias !== 'string' || !IDENT.test(alias)) throw new Error(`Alias inválido: ${alias}`)
  return `SELECT ${alias}.tb_institution_id AS institutionId, ${alias}.model AS model, ${alias}.environment AS environment, `
    + `DATE_FORMAT(${alias}.cutover_at, '%Y-%m-%d %H:%i:%s') AS cutoverAt
    FROM \`${db}\`.${ISSUER_VIEW} ${alias}`
}

/** A consulta de UMA habilitação (institution × modelo — a PK), tudo por parâmetro. */
export function issuerViewQuery(db: string, scope: IssuerViewScope, alias = 'v'): { sql: string; params: (number | string)[] } {
  const s = assertScope(scope)
  return {
    sql: `${issuerViewSelect(db, alias)} WHERE ${alias}.tb_institution_id = ? AND ${alias}.model = ?`,
    params: [s.institutionId, s.model],
  }
}

/** Mapa ESTRITO de uma linha da view: coluna fora do domínio ou fora do escopo pedido falha ALTO (view torta nunca vira dado de quem lê). */
export function mapIssuerView(r: any, scope: IssuerViewScope): IssuerView {
  // número ou texto DECIMAL canônico — '1e3', '0x10', ' 5 ' e '01' não são o que o banco devolve (molde de `mapWithdrawnRange`)
  const v = r?.institutionId
  const institutionId = typeof v === 'number' ? v : (typeof v === 'string' && /^[1-9][0-9]*$/.test(v) ? Number(v) : NaN)
  if (!Number.isInteger(institutionId) || institutionId < 1) throw new Error(`Linha da view da habilitação com estabelecimento inválido (${JSON.stringify(v)})`)
  if (!ISSUER_MODELS.includes(r.model)) throw new Error(`Linha da view da habilitação com modelo fora do domínio (${JSON.stringify(r.model)})`)
  if (r.environment !== 'H' && r.environment !== 'P') throw new Error(`Linha da view da habilitação sem ambiente H/P (${JSON.stringify(r.environment)})`)
  if (r.cutoverAt != null && (typeof r.cutoverAt !== 'string' || !INSTANT.test(r.cutoverAt))) {
    throw new Error(`Linha da view da habilitação com cutover_at inválido (${JSON.stringify(r.cutoverAt)})`)
  }
  const row: IssuerView = { institutionId, model: r.model, environment: r.environment, cutoverAt: r.cutoverAt ?? null }
  if (row.institutionId !== scope.institutionId || row.model !== scope.model) {
    throw new Error(`Linha da view da habilitação fora do escopo pedido (${row.institutionId}/${row.model})`)
  }
  return Object.freeze(row)
}

/** A habilitação VIVA do escopo pedido, mapeada — `null` quando não há (não habilitado ou apagada); mais de uma linha falha ALTO. */
export async function readIssuerView(q: ReadQueryable, db: string, scope: IssuerViewScope): Promise<IssuerView | null> {
  const { sql, params } = issuerViewQuery(db, scope)
  const [rows] = await q.query(sql, params)
  if (!Array.isArray(rows)) throw new Error('Leitura da habilitação: o driver não devolveu linhas')
  if (rows.length > 1) throw new Error(`Leitura da habilitação: ${rows.length} linhas para a PK ${scope.institutionId}/${scope.model} — view torta`)
  return rows.length ? mapIssuerView(rows[0], scope) : null
}

/**
 * Boot de quem lê a habilitação pela view: ela responde ao SELECT publicado com TODAS as colunas. Falta de view, coluna ou GRANT = falha
 * ALTO no boot, nunca 500 na 1ª leitura (molde da D-F113).
 */
export async function assertIssuerViewReadable(q: ReadQueryable, db: string): Promise<void> {
  try {
    await q.query(`${issuerViewSelect(db)} WHERE 1 = 0`)
  } catch (err: any) {
    throw new Error(`A view da habilitação (${db}.${ISSUER_VIEW}) não responde ao SELECT publicado `
      + `(${err?.code ?? err?.errno ?? 'erro'}) — migration 007 do núcleo não aplicada, coluna faltando ou sem GRANT (D-NE170)`)
  }
}
