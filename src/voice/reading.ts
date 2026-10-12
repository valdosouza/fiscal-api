import { AUTHORIZED_KINDS, FINAL_TRANSMISSION_KINDS, TransmissionEnvironment, TransmissionEventKind, TransmissionSource } from './kinds'
import { InvoiceBranch, InvoiceRef, invoiceRefFilter } from '../ref/invoice-ref'

/**
 * CONTRATO DE LEITURA da voz do fisco (D-F33) — exportado pela biblioteca para a API da família
 * (que decide transmitir) E para o setes-api (que decide cancelar localmente e mostra o selo): UMA
 * regra da vigente, UM estado derivado, UMA pendência — nunca duas cópias (guardião §13.1-6).
 * Puro (sem banco): quem lê as VIEWs publicadas (D-F15) mapeia a linha e aplica estas funções.
 *
 * NE-1a (Rodada 1 da NE-1a, Valdo 2026-10-11 — D-NE56/D-NE59; parecer do guardião no `prompt_onda_nfe_sefaz.md` §12.9.2):
 *  - PROJEÇÃO COMUM (`TransmissionView`) = as colunas que TODA família publica na view dela, com os mesmos nomes, tipos e significado;
 *    as colunas próprias da família ficam no tipo dela (NFS-e: `ServiceTransmissionView`, em `families/service.ts`).
 *  - REGISTRO pelo fisco = FATO publicado na view (`authority_recorded` — D-NE56), NUNCA a presença da chave: na NF-e a chave de acesso
 *    é NOSSA e existe desde a reserva da tentativa (D-NE7) — "tem chave" lá não quer dizer que a SEFAZ registrou nada.
 *  - Views POR família (`VoiceFamilyReading`); view comum por UNION é MAQUETE (não funde — PADROES §11 regra 3; colunas NULL por
 *    família; sem dono — D-F35). Quem lê percorre as leituras dos ramos PRESENTES na nota (`VOICE_READINGS`).
 *  - Vocabulário com P/D e estado derivado EXAUSTIVO (kind novo quebra a compilação em vez de virar "em voo" calado).
 */

/** Família = RAMO da nota no `fiscal_api` — a definição mora em `ref/invoice-ref.ts` (parte 2 da NE-1a); re-exportada com o mesmo nome. */
export type { InvoiceBranch }

/** PROJEÇÃO COMUM de uma tentativa (linha da view de tentativas de QUALQUER família). Instantes em UTC. */
export interface TransmissionView {
  institutionId: number
  invoiceId:     number
  terminal:      number
  attempt:       number
  /** Vida da nota (evento E que a abriu — D-N27). */
  lifeEvent:     number
  environment:   TransmissionEnvironment
  /** Chave de acesso do documento — a PROVENIÊNCIA é da família (NFS-e: do fisco; NF-e: nossa, desde a reserva). NUNCA sinal de registro. */
  accessKey:     string | null
  /** D-NE56: o fisco REGISTROU o documento desta tentativa (em qualquer ambiente) — coluna `authority_recorded` ('S'/'N') da view. */
  authorityRecorded: boolean
  lastQueriedAt: string | null
  createdAt:     string | null
  lastEvent:     number | null
  lastKind:      TransmissionEventKind | null
  lastCode:      string | null
  lastMessage:   string | null
  lastSource:    TransmissionSource | null
  lastDh:        string | null
  lastEventAt:   string | null
}

/** Linha da view de VOZES de qualquer família (uma voz). */
export interface VoiceView {
  institutionId: number
  invoiceId:     number
  terminal:      number
  attempt:       number
  lifeEvent:     number
  event:         number
  kind:          TransmissionEventKind
  authorityCode: string | null
  message:       string | null
  dh:            string | null
  source:        TransmissionSource
  userId:        number | null
  createdAt:     string | null
}

/** Coluna publicada: [coluna da view, nome no objeto, instante?] — instante sai como 'YYYY-MM-DD HH:MM:SS' (UTC). */
export type ViewColumn = readonly [column: string, field: string, instant?: boolean]

/** Lista de colunas congelada em PROFUNDIDADE (gate NE-1a, NE1A-06: congelamento raso deixava trocar a coluna do SELECT publicado). */
export function frozenColumns(columns: readonly ViewColumn[]): readonly ViewColumn[] {
  return Object.freeze(columns.map(c => Object.freeze([...c]) as unknown as ViewColumn))
}

/** A projeção comum — UMA lista, que monta o SELECT de toda família (o teste da família a confere contra o DDL da view dela). */
export const COMMON_TRANSMISSION_COLUMNS: readonly ViewColumn[] = frozenColumns([
  ['tb_institution_id', 'institutionId'], ['tb_invoice_id', 'invoiceId'], ['terminal', 'terminal'], ['attempt', 'attempt'],
  ['life_event', 'lifeEvent'], ['environment', 'environment'], ['access_key', 'accessKey'], ['authority_recorded', 'authorityRecorded'],
  ['last_queried_at', 'lastQueriedAt', true], ['created_at', 'createdAt', true], ['last_event', 'lastEvent'], ['last_kind', 'lastKind'],
  ['last_code', 'lastCode'], ['last_message', 'lastMessage'], ['last_source', 'lastSource'], ['last_dh', 'lastDh', true],
  ['last_event_at', 'lastEventAt', true],
])

/**
 * LEITURA PUBLICADA de uma família (NE-1a — parecer do guardião): o nome das views e as colunas DELA, o mapeador da linha e a regra
 * "efeito humano" do cancelamento. Mora no núcleo porque o setes-api só importa o núcleo (D-F33); a família é dona do DDL das views
 * (D-F35). Dado puro — nenhum roteiro aqui.
 */
export interface VoiceFamilyReading<V extends TransmissionView> {
  readonly branch:           InvoiceBranch
  /** A view de tentativas — CONVENÇÃO: `vw_<x>` sobre a tabela `tb_<x>` da família (o "instalada?" da D-NE76 deriva a tabela daqui; o
   *  teste da família confere contra o DDL). */
  readonly transmissionView: string
  readonly voiceView:        string
  readonly ownColumns:       readonly ViewColumn[]
  readonly map:              (row: any) => V
  /** Cancelamento cujo efeito no ERP só nasce de ato HUMANO (NFS-e: substituição e de ofício — D-F82); a NF-e define o dela (NE-2). */
  readonly humanEffectCancel: (current: Pick<TransmissionView, 'lastKind' | 'lastCode'> | null) => boolean
}

const IDENT = /^[a-z][a-z0-9_]*$/
/** Nome de campo do objeto mapeado (camelCase simples). */
const FIELD = /^[a-z][A-Za-z0-9]*$/

/**
 * SELECT pronto da view de tentativas da família ([db] = banco fiscal; instantes em UTC). Gate NE-1a (NE1A-05): TODO identificador
 * é conferido (banco, alias, view, coluna e campo) e a família NÃO pode redeclarar coluna nem campo da projeção comum — senão o SELECT
 * sai com o alias duplicado, o driver monta o objeto na ordem das colunas e a coluna da família substitui o FATO comum calada.
 */
export function familyViewSelect(reading: VoiceFamilyReading<TransmissionView>, db: string, alias = 'v'): string {
  if (!/^[a-z0-9_]+$/.test(db)) throw new Error(`Banco fiscal inválido: ${db}`)
  if (!IDENT.test(alias)) throw new Error(`Alias inválido: ${alias}`)
  if (!/^vw_[a-z0-9_]+$/.test(reading.transmissionView)) throw new Error(`View de tentativas inválida: ${reading.transmissionView}`)
  const columns = [...COMMON_TRANSMISSION_COLUMNS, ...reading.ownColumns]
  const seenColumns: string[] = [], seenFields: string[] = []
  for (const [column, field] of columns) {
    if (typeof column !== 'string' || !IDENT.test(column)) throw new Error(`Coluna inválida na leitura da família: ${JSON.stringify(column)}`)
    if (typeof field !== 'string' || !FIELD.test(field)) throw new Error(`Campo inválido na leitura da família: ${JSON.stringify(field)}`)
    if (seenColumns.includes(column) || seenFields.includes(field)) {
      throw new Error(`A leitura da família redeclara a coluna/campo ${column}/${field} (a projeção comum não se sombreia)`)
    }
    seenColumns.push(column)
    seenFields.push(field)
  }
  const col = ([column, field, instant]: ViewColumn) => instant
    ? `DATE_FORMAT(${alias}.${column}, '%Y-%m-%d %H:%i:%s') AS ${field}`
    : `${alias}.${column} AS ${field}`
  return `SELECT ${columns.map(col).join(', ')}
    FROM \`${db}\`.${reading.transmissionView} ${alias}`
}

/** As tentativas de UMA nota na view da família (a referência inteira por parâmetro — o terminal nunca é literal; D-NE12). */
export function familyViewQuery(reading: VoiceFamilyReading<TransmissionView>, db: string, ref: InvoiceRef, alias = 'v'): { sql: string; params: number[] } {
  const f = invoiceRefFilter(ref, alias)
  return { sql: `${familyViewSelect(reading, db, alias)} WHERE ${f.sql} ORDER BY ${alias}.attempt`, params: f.params }
}

/**
 * As tentativas de VÁRIAS notas do MESMO estabelecimento e terminal (lote — o selo da lista de OS na F2a; gate socrático da NE-1a, M3):
 * a chave da nota inteira por parâmetro (simétrico ao `invoiceLives`), nunca um WHERE próprio do leitor com `terminal = 0`. Lista vazia
 * é erro de quem chama (não há SQL para "nenhuma nota").
 */
export function familyViewQueryMany(
  reading: VoiceFamilyReading<TransmissionView>, db: string, scope: Pick<InvoiceRef, 'institutionId' | 'terminal'>, invoiceIds: readonly number[], alias = 'v',
): { sql: string; params: unknown[] } {
  if (!invoiceIds.length) throw new Error('familyViewQueryMany: lista de notas vazia')
  return {
    sql: `${familyViewSelect(reading, db, alias)} WHERE ${alias}.tb_institution_id = ? AND ${alias}.tb_invoice_id IN (?) AND ${alias}.terminal = ?`
      + ` ORDER BY ${alias}.tb_invoice_id, ${alias}.attempt`,
    params: [scope.institutionId, [...invoiceIds], scope.terminal],
  }
}

/**
 * Mapeia a PROJEÇÃO COMUM de uma linha da view. Toda coluna que DECIDE é obrigatória e falha ALTO fora do domínio (gates da NE-1a parte 1):
 * `authority_recorded` ('S'/'N' — view sem a coluna = migration da família não aplicada; nunca vira "não registrado" calado: o cancelamento
 * local trataria nota registrada como pendente), `environment` ('P'/'H' — o padrão 'H' falhava ABERTO no `isFiscalRecord`: nota registrada
 * em produção tratada como homologação, soft-delete e número reaproveitado — M4) e `terminal` (inteiro ≥ 0 — o `?? 0` era o terminal da
 * web escondido no núcleo, D-NE70 = Q-NE70 (a)).
 */
export function mapCommonView(r: any): TransmissionView {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  if (r.authorityRecorded !== 'S' && r.authorityRecorded !== 'N') {
    throw new Error(`View de tentativas sem authority_recorded ('S'/'N') — migration da família não aplicada? (recebido: ${JSON.stringify(r.authorityRecorded)})`)
  }
  if (r.environment !== 'P' && r.environment !== 'H') {
    throw new Error(`Linha da view sem environment ('P'/'H') — projeção torta? (recebido: ${JSON.stringify(r.environment)})`)
  }
  const terminal = r.terminal === null || r.terminal === undefined || r.terminal === '' ? NaN : Number(r.terminal)
  if (!Number.isInteger(terminal) || terminal < 0) {
    throw new Error(`Linha da view sem terminal (inteiro ≥ 0) — projeção torta? (recebido: ${JSON.stringify(r.terminal)})`)
  }
  // D-NE61 (= Q-NE61 (a), Valdo 2026-10-12 — Q-NE67 rejeitada): INVARIANTE DA FAMÍLIA — toda voz D (denegada; o número queimou, D-E7)
  // é publicada REGISTRADA. A barreira de nova tentativa segue SÓ pelo fato (D-NE56); uma linha D sem registro é família inconsistente e
  // falha ALTO aqui — nunca libera retransmitir o número queimado. A família NF-e confere o invariante na NE-2 (teste da view dela).
  if (r.lastKind === 'D' && r.authorityRecorded !== 'S') {
    throw new Error('Linha da view com voz D (denegada) SEM registro — a família publica a denegada sempre registrada (D-NE61)')
  }
  return {
    institutionId: Number(r.institutionId), invoiceId: Number(r.invoiceId), terminal,
    attempt: Number(r.attempt), lifeEvent: Number(r.lifeEvent), environment: r.environment,
    accessKey: r.accessKey ?? null, authorityRecorded: r.authorityRecorded === 'S',
    lastQueriedAt: r.lastQueriedAt ?? null, createdAt: r.createdAt ?? null, lastEvent: n(r.lastEvent), lastKind: r.lastKind ?? null,
    lastCode: r.lastCode ?? null, lastMessage: r.lastMessage ?? null, lastSource: r.lastSource ?? null, lastDh: r.lastDh ?? null,
    lastEventAt: r.lastEventAt ?? null,
  }
}

/** Só a última voz decide; a tentativa costuma vir inteira (attempt/accessKey passam, não pesam). */
type KindLike = Pick<TransmissionView, 'lastKind'> & { attempt?: number; accessKey?: string | null }

/** Tentativa VIVA = sem voz (em voo) ou com última voz não final (S/K/P). */
export function isLiveTransmission(tx: KindLike | null): boolean {
  return !!tx && !FINAL_TRANSMISSION_KINDS.has(tx.lastKind ?? '')
}

/** AUTORIZADA vigente = última voz A ou N (D-N17). */
export function isAuthorized(tx: KindLike | null): boolean {
  return !!tx && AUTHORIZED_KINDS.has(tx.lastKind ?? '')
}

/**
 * A VIGENTE dentro das tentativas de UMA vida (D-N26): o documento existe uma vez por vida e pousa na tentativa que o fisco
 * REGISTROU (a de maior attempt, se mais de uma); sem registro, a última tentativa. [list] já filtrada pela vida vigente (D-N27), em
 * qualquer ordem. D-NE56 (NE-1a): era "quem DETÉM a chave" — na NFS-e é o mesmo fato (a chave vem do fisco); na NF-e não (a chave é nossa).
 */
export function currentOf<T extends Pick<TransmissionView, 'attempt' | 'authorityRecorded'>>(list: readonly T[]): T | null {
  if (!list.length) return null
  assertOneInvoiceLife(list)
  const sorted = [...list].sort((a, b) => a.attempt - b.attempt)
  const recorded = [...sorted].reverse().find(t => authorityRecordedOf(t))
  return recorded ?? sorted[sorted.length - 1]
}

/**
 * O fato do registro como BOOLEANO — falha ALTO fora do domínio (D-NE66 = Q-NE66 (a), gate adversarial NE1A-01): a linha CRUA da view
 * (flag 'S'/'N' do SELECT público, `any` do driver) passada direto a um predicado virava "não registrado" calada — NFS-e registrada em
 * produção tratada como pendente. O caminho certo é o `reading.map`; o predicado recusa o que não passou por ele.
 */
export function authorityRecordedOf(tx: Pick<TransmissionView, 'authorityRecorded'>): boolean {
  const v = (tx as { authorityRecorded?: unknown }).authorityRecorded
  if (typeof v !== 'boolean') {
    throw new Error(`authorityRecorded fora do domínio boolean (${JSON.stringify(v)}) — linha da view não passou pelo mapa da família?`)
  }
  return v
}

/**
 * D-NE71 (= Q-NE71 (a), gate adversarial): a vigente é de UMA nota e UMA vida — lista que mistura estabelecimento, nota, terminal ou vida
 * (nos campos que as linhas trazem) é erro de quem chama e falha alto, nunca uma "vigente" de outra nota. A família não está na linha
 * (projeção comum) — quem mistura famílias é a composição que percorre `VOICE_READINGS`, uma de cada vez.
 */
function assertOneInvoiceLife(list: readonly object[]): void {
  for (const key of ['institutionId', 'invoiceId', 'terminal', 'lifeEvent'] as const) {
    const first = (list[0] as Record<string, unknown>)[key]
    for (const t of list) {
      if ((t as Record<string, unknown>)[key] !== first) throw new Error(`currentOf: lista mistura ${key} (${String(first)} × ${String((t as Record<string, unknown>)[key])})`)
    }
  }
}

/** Tentativas de [list] que pertencem à vida [lifeEvent] (vida nula = nota sem evento E: nada vale). */
export function inLife<T extends { lifeEvent: number }>(list: readonly T[], lifeEvent: number | null): T[] {
  return lifeEvent == null ? [] : list.filter(t => t.lifeEvent === lifeEvent)
}

/** Estado DERIVADO da última voz — do vocabulário COMUM (P em processamento e D denegada são da NF-e; a NFS-e nunca os produz). */
export type FiscalState = 'none' | 'in_flight' | 'processing' | 'authorized' | 'denied' | 'rejected' | 'failed' | 'cancelled' | 'cancel_in_flight'
/** Nome anterior à NE-1a (o estado é do vocabulário comum); a NFS-e só produz os 7 do contrato dela. */
export type ServiceFiscalState = FiscalState

/** Estado derivado — `switch` EXAUSTIVO: kind novo no vocabulário sem `case` aqui não compila (o `default` era "em voo" calado). */
export function fiscalStateOf(tx: KindLike | null): FiscalState {
  if (!tx) return 'none'
  const kind = tx.lastKind
  if (kind === null || kind === undefined) return 'in_flight'          // reserva sem voz
  switch (kind) {
    case 'S': return 'in_flight'
    case 'P': return 'processing'
    case 'A':
    case 'N': return 'authorized'
    case 'D': return 'denied'
    case 'R': return 'rejected'
    case 'F': return 'failed'
    case 'C': return 'cancelled'
    case 'K': return 'cancel_in_flight'
    default: {
      // kind fora do vocabulário só chega gravado por fora do código (D-F103) — em execução falha FECHADO como viva
      const unknownKind: never = kind
      void unknownKind
      return 'in_flight'
    }
  }
}

/** Registro FISCAL (Q-CA5): o fisco registrou E em PRODUÇÃO — homologação não tem valor jurídico. Fato da view (D-NE56). */
export function isFiscalRecord(tx: Pick<TransmissionView, 'authorityRecorded' | 'environment'> | null): boolean {
  return !!tx && authorityRecordedOf(tx) && tx.environment === 'P'
}

/**
 * Barreira de NOVA tentativa (NE-1a): a vigente está VIVA ou o fisco REGISTROU o documento — a NF-e DENEGADA (D: final e não
 * autorizada) também barra (D-E7: não se retransmite; o número queimou) PORQUE a família a publica sempre registrada (D-NE61 — o mapa
 * recusa D sem registro); nenhuma 2ª regra pela letra (Q-NE67 rejeitada). A NFS-e segue com a ordem dos 409 dela (os mesmos códigos).
 */
export function blocksNewAttempt(tx: Pick<TransmissionView, 'lastKind' | 'authorityRecorded'> | null): boolean {
  if (!tx) return false
  const recorded = authorityRecordedOf(tx)          // o fato é conferido SEMPRE (também quando a viva decidiria sozinha)
  return isLiveTransmission(tx) || recorded
}

/**
 * Pendência DERIVADA do efeito (D-F28) na leitura de UMA família: a vigente da vida tem voz C do fisco e a nota, no ERP, ainda NÃO tem
 * o evento C — salvo cancelamento de efeito HUMANO da família. Nada é gravado para saber disso — é a leitura dos dois fatos.
 */
export function localCancelPendingIn(
  reading: Pick<VoiceFamilyReading<TransmissionView>, 'humanEffectCancel'>,
  current: Pick<TransmissionView, 'lastKind' | 'lastCode'> | null,
  invoiceLastKind: string | null,
): boolean {
  return current?.lastKind === 'C' && invoiceLastKind !== 'C' && !reading.humanEffectCancel(current)
}
