import { AUTHORIZED_KINDS, FINAL_TRANSMISSION_KINDS, SUBSTITUTION_CANCEL_CODE, HUMAN_EFFECT_CANCEL_CODES, TransmissionEnvironment, TransmissionEventKind, TransmissionSource } from './kinds'

/**
 * CONTRATO DE LEITURA da voz do fisco (D-F33) — exportado pela biblioteca para a API da família
 * (que decide transmitir) E para o setes-api (que decide cancelar localmente e mostra o selo): UMA
 * regra da vigente, UM estado derivado, UMA pendência — nunca duas cópias (guardião §13.1-6).
 * Puro (sem banco): quem lê as VIEWs publicadas (D-F15) mapeia a linha e aplica estas funções.
 */

/** Linha de `vw_invoice_service_transmission` (tentativa + DPS da vida + última voz). Instantes em UTC. */
export interface TransmissionView {
  institutionId: number
  invoiceId:     number
  terminal:      number
  attempt:       number
  /** Vida da nota (evento E que a abriu — D-N27). */
  lifeEvent:     number
  environment:   TransmissionEnvironment
  serie:         string | null
  dpsNumber:     number | null
  dpsId:         string | null
  accessKey:     string | null
  nfseNumber:    string | null
  dhProc:        string | null
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

/** Linha de `vw_invoice_service_transmission_event` (uma voz). */
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

/** SELECT pronto da view de tentativas (instantes como 'YYYY-MM-DD HH:MM:SS' UTC) — [db] = banco fiscal. */
export function transmissionViewSelect(db: string, alias = 'v'): string {
  if (!/^[a-z0-9_]+$/.test(db)) throw new Error(`Banco fiscal inválido: ${db}`)
  const f = (c: string) => `DATE_FORMAT(${alias}.${c}, '%Y-%m-%d %H:%i:%s')`
  return `SELECT ${alias}.tb_institution_id AS institutionId, ${alias}.tb_invoice_id AS invoiceId, ${alias}.terminal,
         ${alias}.attempt, ${alias}.life_event AS lifeEvent, ${alias}.environment, ${alias}.serie,
         ${alias}.dps_number AS dpsNumber, ${alias}.dps_id AS dpsId, ${alias}.access_key AS accessKey,
         ${alias}.nfse_number AS nfseNumber, ${f('dh_proc')} AS dhProc, ${f('last_queried_at')} AS lastQueriedAt,
         ${f('created_at')} AS createdAt, ${alias}.last_event AS lastEvent, ${alias}.last_kind AS lastKind,
         ${alias}.last_code AS lastCode, ${alias}.last_message AS lastMessage, ${alias}.last_source AS lastSource,
         ${f('last_dh')} AS lastDh, ${f('last_event_at')} AS lastEventAt
    FROM \`${db}\`.vw_invoice_service_transmission ${alias}`
}

export function mapTransmissionView(r: any): TransmissionView {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  return {
    institutionId: Number(r.institutionId), invoiceId: Number(r.invoiceId), terminal: Number(r.terminal ?? 0),
    attempt: Number(r.attempt), lifeEvent: Number(r.lifeEvent), environment: r.environment === 'P' ? 'P' : 'H',
    serie: r.serie ?? null, dpsNumber: n(r.dpsNumber), dpsId: r.dpsId ?? null, accessKey: r.accessKey ?? null,
    nfseNumber: r.nfseNumber ?? null, dhProc: r.dhProc ?? null, lastQueriedAt: r.lastQueriedAt ?? null,
    createdAt: r.createdAt ?? null, lastEvent: n(r.lastEvent), lastKind: r.lastKind ?? null, lastCode: r.lastCode ?? null,
    lastMessage: r.lastMessage ?? null, lastSource: r.lastSource ?? null, lastDh: r.lastDh ?? null, lastEventAt: r.lastEventAt ?? null,
  }
}

type TxLike = Pick<TransmissionView, 'attempt' | 'accessKey' | 'lastKind'>

/** Tentativa VIVA = sem voz (em voo) ou com última voz não final (S/K). */
export function isLiveTransmission(tx: TxLike | null): boolean {
  return !!tx && !FINAL_TRANSMISSION_KINDS.has(tx.lastKind ?? '')
}

/** AUTORIZADA vigente = última voz A ou N (D-N17). */
export function isAuthorized(tx: TxLike | null): boolean {
  return !!tx && AUTHORIZED_KINDS.has(tx.lastKind ?? '')
}

/**
 * A VIGENTE dentro das tentativas de UMA vida (D-N26): a NFS-e existe uma vez por vida e pousa na
 * tentativa que a obteve — "quem DETÉM a chave" (a de maior attempt, se mais de uma); sem chave, a
 * última tentativa. [list] já filtrada pela vida vigente (D-N27), em qualquer ordem.
 */
export function currentOf<T extends TxLike>(list: readonly T[]): T | null {
  if (!list.length) return null
  const sorted = [...list].sort((a, b) => a.attempt - b.attempt)
  const keyed = [...sorted].reverse().find(t => !!t.accessKey)
  return keyed ?? sorted[sorted.length - 1]
}

/** Tentativas de [list] que pertencem à vida [lifeEvent] (vida nula = nota sem evento E: nada vale). */
export function inLife<T extends { lifeEvent: number }>(list: readonly T[], lifeEvent: number | null): T[] {
  return lifeEvent == null ? [] : list.filter(t => t.lifeEvent === lifeEvent)
}

export type ServiceFiscalState = 'none' | 'in_flight' | 'authorized' | 'rejected' | 'failed' | 'cancelled' | 'cancel_in_flight'

export function fiscalStateOf(tx: Pick<TransmissionView, 'lastKind'> | null): ServiceFiscalState {
  if (!tx) return 'none'
  switch (tx.lastKind) {
    case 'A':
    case 'N': return 'authorized'
    case 'R': return 'rejected'
    case 'F': return 'failed'
    case 'C': return 'cancelled'
    case 'K': return 'cancel_in_flight'
    default:  return 'in_flight'
  }
}

/**
 * Pendência DERIVADA do efeito (D-F28): a vigente da vida tem voz C do fisco e a nota, no ERP, ainda
 * NÃO tem o evento C. Nada é gravado para saber disso — é a leitura dos dois fatos.
 */
export function localCancelPending(current: Pick<TransmissionView, 'lastKind' | 'lastCode'> | null, invoiceLastKind: string | null): boolean {
  // D-F68 (= Q-F75 (a)): a SUBSTITUIÇÃO (e105102) não manda o app aplicar o C local — é decisão humana (D-F64/D-F67);
  // D-F82 (= Q-F89): o cancelamento DE OFÍCIO (e305101) também não
  return current?.lastKind === 'C' && invoiceLastKind !== 'C' && !isHumanEffectCancel(current)
}

/** D-F82: a voz vigente é um cancelamento cujo efeito no ERP só nasce de ato HUMANO (105102 ou 305101). */
export function isHumanEffectCancel(current: Pick<TransmissionView, 'lastKind' | 'lastCode'> | null): boolean {
  return current?.lastKind === 'C' && !!current.lastCode && HUMAN_EFFECT_CANCEL_CODES.has(current.lastCode)
}

/** D-F68: a voz vigente é um cancelamento por SUBSTITUIÇÃO (código do evento na voz C — D-F71). */
export function isSubstitutionCancel(current: Pick<TransmissionView, 'lastKind' | 'lastCode'> | null): boolean {
  return current?.lastKind === 'C' && current.lastCode === SUBSTITUTION_CANCEL_CODE
}

type ReconfirmLike = Pick<TransmissionView, 'attempt' | 'lastKind' | 'lastSource' | 'environment' | 'accessKey' | 'dpsId'>

/**
 * Reconfirmação antes do cancelamento LOCAL (Q-ADV1b/Q-ADV2a → D-F29): na VIDA vigente, se nenhuma
 * tentativa detém a chave e alguma fechou com F por CONSULTA em PRODUÇÃO (as tentativas da vida reusam
 * o Id do DPS — D-N3), a candidata é a ÚLTIMA delas. Homologação não prende a nota (Q-CA5b).
 */
export function reconfirmationCandidate<T extends ReconfirmLike>(lifeList: readonly T[]): T | null {
  if (lifeList.some(t => !!t.accessKey)) return null
  const c = lifeList
    .filter(t => t.lastKind === 'F' && t.lastSource === 'Q' && t.environment === 'P' && !!t.dpsId)
    .sort((a, b) => a.attempt - b.attempt)
  return c[c.length - 1] ?? null
}

/**
 * Prova LIDA NO BANCO (D-F29): alguém olhou o fisco DEPOIS da voz F da candidata
 * (`last_queried_at` > instante da voz). A consulta que GEROU o F grava os dois no mesmo instante —
 * por isso estritamente maior: só uma consulta POSTERIOR prova.
 */
export function reconfirmationProven(candidate: Pick<TransmissionView, 'lastQueriedAt' | 'lastEventAt'>): boolean {
  return !!candidate.lastQueriedAt && !!candidate.lastEventAt && candidate.lastQueriedAt > candidate.lastEventAt
}
