import { IssuerModel, modelsOf } from '../establishment/issuer-models'
import type { TransmissionEnvironment } from '../voice/kinds'
import type { ReadQueryable } from '../voice/family-reader'

/**
 * FAIXAS RETIRADAS DA NUMERAÇÃO — peça própria do núcleo (NE-2; D-NE161 = Q-NE161 (a), Valdo 2026-10-20, literal: "a nota de mercadoria
 * é controlada por nós, e a nota de serviço é gerada pelo servidor"): a faixa inutilizada é fato da NOSSA numeração, não voz do fisco.
 * Por isso mora em `numbering/`, FORA do catálogo `VOICE_READINGS` (o catálogo é de famílias de TRANSMISSÃO — o emitter e o boot o
 * percorrem; uma faixa ali seria "tentativa" falsa). Está na superfície `fiscal-api/reading` desde a janela da NE-6
 * (fiscal-api:FAMILIA.E5.P3); o SQL cru (`withdrawnRangesSelect`/`withdrawnRangesQuery`) fica só no barrel. O GRANT da view é passo do
 * consumidor (PM-9). Na NFS-e o fato não existe (o número vem do servidor nacional).
 *
 * QUEM LÊ, depois da D-NE257 (Valdo 2026-11-23, fiscal-api:FAMILIA.E5.P5): o número do 55 nasce na TRANSMISSÃO, na nfe-api, do último
 * número guardado no núcleo (`numbering/number-sequence`) — ninguém mais "pula faixa" ao gerar número, e a inutilização só vale até o
 * último número gerado (D-NE263). A leitura segue publicada: a tabela de controle de notas do ERP web copia as inutilizações do banco
 * fiscal (D-NE258, D-NE259) e PODE usá-la — por onde a cópia lê fica para a ficha do setes-api, sem decisão aqui. A série continua do
 * ERP (D-NE11).
 *
 * Fonte: a view `vw_invoice_number_void` (migration 001 da nfe-api — D-F35): faixas PENDENTES e homologadas, sem `authority_recorded`
 * (D-NE161 — "registro" é palavra da voz). Colunas GERADAS do Id da inutilização (uma fonte só).
 * O leitor recebe OBRIGATORIAMENTE os quatro eixos — institution × modelo × série × AMBIENTE (faixa inutilizada em H não retira número
 * de P — D-NE163); qualquer eixo ausente é erro de quem chama (nunca "todas as séries"). Só SELECT, sem trava: a corrida entre gerar
 * número e inutilizar se fecha na linha do último número, no núcleo (`lockNumberSequence`), não aqui.
 * LIMITE CONHECIDO (parecer do guardião, §15.3-4): inutilização pendente não conta como "viva" no DELETE do A1 — falha FECHADO (a faixa
 * fica retirada até o A1 voltar).
 */

/** A view publicada das faixas retiradas (migration 001 da nfe-api). */
export const WITHDRAWN_RANGES_VIEW = 'vw_invoice_number_void'

/** Uma faixa retirada da numeração (pendente ou inutilizada), como a view a publica. */
export interface WithdrawnRange {
  readonly institutionId: number
  /** id do pedido de inutilização (MAX+1 por estabelecimento — identidade da linha, não da faixa). */
  readonly id:            number
  readonly model:         IssuerModel
  readonly serie:         number
  readonly numberFrom:    number
  readonly numberTo:      number
  readonly environment:   TransmissionEnvironment
  readonly createdAt:     string | null
}

/** Os quatro eixos OBRIGATÓRIOS da leitura (D-NE161/D-NE163). */
export interface WithdrawnRangeScope {
  readonly institutionId: number
  readonly model:         IssuerModel
  readonly serie:         number
  readonly environment:   TransmissionEnvironment
}

/** Modelos cuja numeração é NOSSA (ramo de mercadoria — 55/65); a família de serviço não tem faixa (D-NE161). */
export const WITHDRAWN_RANGE_MODELS: readonly IssuerModel[] = modelsOf('merchandise')

const IDENT = /^[a-z][a-z0-9_]*$/
const COLUMNS: readonly (readonly [column: string, field: keyof WithdrawnRange, instant?: boolean])[] = Object.freeze([
  ['tb_institution_id', 'institutionId'], ['id', 'id'], ['model', 'model'], ['serie', 'serie'], ['number_from', 'numberFrom'],
  ['number_to', 'numberTo'], ['environment', 'environment'], ['created_at', 'createdAt', true],
] as const)

function assertScope(scope: WithdrawnRangeScope): WithdrawnRangeScope {
  const intIn = (v: unknown, what: string, min: number, max: number): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`Leitura das faixas retiradas: ${what} inválido (${JSON.stringify(v)} — inteiro entre ${min} e ${max})`)
    return v
  }
  intIn(scope?.institutionId, 'estabelecimento', 1, 2_147_483_647)
  if (!WITHDRAWN_RANGE_MODELS.includes(scope?.model)) throw new Error(`Leitura das faixas retiradas: modelo fora da numeração NOSSA (${JSON.stringify(scope?.model)} — ${WITHDRAWN_RANGE_MODELS.join('/')})`)
  intIn(scope?.serie, 'série', 0, 999)                                   // 3 dígitos no Id da inutilização (D-NE40)
  if (scope?.environment !== 'H' && scope?.environment !== 'P') throw new Error(`Leitura das faixas retiradas: ambiente inválido (${JSON.stringify(scope?.environment)} — H/P; faixa de H não retira número de P)`)
  return scope
}

/** SELECT pronto da view das faixas retiradas ([db] = banco fiscal; instantes em UTC). */
export function withdrawnRangesSelect(db: string, alias = 'v'): string {
  if (!/^[a-z0-9_]+$/.test(db)) throw new Error(`Banco fiscal inválido: ${db}`)
  if (!IDENT.test(alias)) throw new Error(`Alias inválido: ${alias}`)
  const col = ([column, field, instant]: typeof COLUMNS[number]) => instant
    ? `DATE_FORMAT(${alias}.${column}, '%Y-%m-%d %H:%i:%s') AS ${field}`
    : `${alias}.${column} AS ${field}`
  return `SELECT ${COLUMNS.map(col).join(', ')}
    FROM \`${db}\`.${WITHDRAWN_RANGES_VIEW} ${alias}`
}

/** A consulta das faixas retiradas de UM eixo (institution × modelo × série × ambiente), em ordem de número inicial — tudo por parâmetro. */
export function withdrawnRangesQuery(db: string, scope: WithdrawnRangeScope, alias = 'v'): { sql: string; params: (number | string)[] } {
  const s = assertScope(scope)
  return {
    // ordem pelas colunas do ÍNDICE da faixa (`uk_invoice_number_void_range`: …, number_from, number_to) — entre as RETIRADAS do eixo o par é único,
    // então a ordem é total sem o `id` (gate socrático L7: `ORDER BY number_from, id` forçava filesort)
    sql: `${withdrawnRangesSelect(db, alias)} WHERE ${alias}.tb_institution_id = ? AND ${alias}.model = ? AND ${alias}.serie = ? AND ${alias}.environment = ? ORDER BY ${alias}.number_from, ${alias}.number_to`,
    params: [s.institutionId, s.model, s.serie, s.environment],
  }
}

/** Mapa ESTRITO de uma linha da view: coluna que decide fora do domínio ou fora do eixo pedido falha ALTO (view torta nunca vira dado de quem lê). */
export function mapWithdrawnRange(r: any, scope: WithdrawnRangeScope): WithdrawnRange {
  // ESTRITO (gate adversarial da NE-2, INPUT_LENIENCY): número ou texto DECIMAL canônico — '1e3', '0x10', ' 5 ' e '01' não são o que o banco devolve
  const int = (v: unknown, what: string): number => {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^(?:0|[1-9][0-9]*)$/.test(v) ? Number(v) : NaN)
    if (!Number.isInteger(n) || n < 0) throw new Error(`Linha da view das faixas retiradas com ${what} inválido (${JSON.stringify(v)})`)
    return n
  }
  if (r.createdAt != null && typeof r.createdAt !== 'string') throw new Error(`Linha da view das faixas retiradas com created_at inválido (${JSON.stringify(r.createdAt)})`)
  const row: WithdrawnRange = {
    institutionId: int(r.institutionId, 'estabelecimento'), id: int(r.id, 'id'), model: r.model, serie: int(r.serie, 'série'),
    numberFrom: int(r.numberFrom, 'número inicial'), numberTo: int(r.numberTo, 'número final'), environment: r.environment,
    createdAt: r.createdAt ?? null,
  }
  if (!WITHDRAWN_RANGE_MODELS.includes(row.model)) throw new Error(`Linha da view das faixas retiradas com modelo fora do domínio (${JSON.stringify(r.model)})`)
  if (row.environment !== 'H' && row.environment !== 'P') throw new Error(`Linha da view das faixas retiradas sem ambiente H/P (${JSON.stringify(r.environment)})`)
  if (row.numberFrom < 1 || row.numberTo < row.numberFrom) throw new Error(`Linha da view das faixas retiradas com faixa torta (${row.numberFrom}..${row.numberTo})`)
  if (row.institutionId !== scope.institutionId || row.model !== scope.model || row.serie !== scope.serie || row.environment !== scope.environment) {
    throw new Error(`Linha da view das faixas retiradas fora do eixo pedido (${row.institutionId}/${row.model}/${row.serie}/${row.environment})`)
  }
  return Object.freeze(row)
}

/** As faixas RETIRADAS do eixo pedido, mapeadas, em ordem de número inicial. */
export async function readWithdrawnRanges(q: ReadQueryable, db: string, scope: WithdrawnRangeScope): Promise<WithdrawnRange[]> {
  const { sql, params } = withdrawnRangesQuery(db, scope)
  const [rows] = await q.query(sql, params)
  if (!Array.isArray(rows)) throw new Error('Leitura das faixas retiradas: o driver não devolveu linhas')
  return rows.map(r => mapWithdrawnRange(r, scope))
}

/**
 * Boot de quem lê as faixas (a nfe-api desde a NE-2 — a dona da view; o setes-api quando copiar as faixas, D-NE259): a view responde ao
 * SELECT publicado com TODAS as colunas. Falta de view, coluna ou GRANT = falha ALTO no boot, nunca 500 na 1ª leitura (molde da D-F113).
 */
export async function assertWithdrawnRangesViewReadable(q: ReadQueryable, db: string): Promise<void> {
  try {
    await q.query(`${withdrawnRangesSelect(db)} WHERE 1 = 0`)
  } catch (err: any) {
    throw new Error(`A view das faixas retiradas da numeração (${db}.${WITHDRAWN_RANGES_VIEW}) não responde ao SELECT publicado `
      + `(${err?.code ?? err?.errno ?? 'erro'}) — migration 001 da nfe-api não aplicada, coluna faltando ou sem GRANT (D-NE161)`)
  }
}
