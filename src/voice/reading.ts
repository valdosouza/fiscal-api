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
  /** D-F90: última resposta E2404 (nenhuma NFS-e para o Id do DPS) a uma consulta desta tentativa — a PROVA da D-F29. */
  nfseNotGeneratedAt: string | null
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
         ${f('nfse_not_generated_at')} AS nfseNotGeneratedAt, ${f('created_at')} AS createdAt, ${alias}.last_event AS lastEvent, ${alias}.last_kind AS lastKind,
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
    nfseNotGeneratedAt: r.nfseNotGeneratedAt ?? null, createdAt: r.createdAt ?? null, lastEvent: n(r.lastEvent), lastKind: r.lastKind ?? null, lastCode: r.lastCode ?? null,
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
 * Prova LIDA NO BANCO (D-F29; D-F90 = Q-F96 (c), Valdo 2026-10-11 — SUPERA em parte a D-F29): o fisco respondeu
 * EXPLICITAMENTE E2404 ("nenhuma NFS-e para este Id de DPS") a uma pergunta feita DEPOIS da voz F da candidata
 * (`nfse_not_generated_at` > instante da voz). NUNCA o `last_queried_at` — esse é só o carimbo do rodízio ("nós
 * olhamos"), gravado também quando a consulta falhou de forma persistente (502 ambíguo): a prova ficava forjável.
 * Mesmo relógio dos dois lados (o NOSSO — PADROES §11 regra 9). Estritamente maior: a consulta que GEROU o F não prova.
 * CONHECIMENTO NEGATIVO (D-F92 = Q-F98 (a), Valdo 2026-10-11): a prova NÃO tem prazo de validade — qualquer E2404 POSTERIOR à
 * última apresentação do Id vale, inclusive o da revisita automática de 24 h (D-F52) semanas antes do cancelamento; 24 h depois da
 * última apresentação o "não gerada" é conclusivo. Não inventar janela; reabrir só se a prova ao vivo M4 mostrar NFS-e gerada TARDE.
 * D-F97 (= Q-F103 (b), Valdo 2026-10-11): as tentativas da MESMA vida reapresentam o MESMO Id do DPS (D-N3/D-F30) — a premissa "o DPS
 * foi enviado uma vez" era falsa. O E2404 tem de ser POSTERIOR à ÚLTIMA apresentação do Id em QUALQUER tentativa da vida no mesmo
 * ambiente (o instante da reserva ou da última voz de cada uma, o maior); passe a VIDA em `lifeList` (sem ela, só a candidata conta).
 * D-F99 (= Q-F105 (b), Valdo 2026-10-11): tentativa da MESMA identidade SEM VOZ (em voo — só há o instante da RESERVA; o POST dela pode
 * chegar ao fisco DEPOIS do E2404) → não prova, falha FECHADO. A prova volta quando a tentativa ganhar voz (aí a apresentação é conhecida).
 */
type PresentationLike = Partial<Pick<TransmissionView, 'lastEventAt' | 'createdAt' | 'dpsId' | 'environment'>>
/** Instante do banco como o leitor do núcleo o entrega (`DATE_FORMAT` — UTC); só nesse formato a comparação por texto é cronológica. */
const DB_INSTANT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
export function reconfirmationProven(
  candidate: Pick<TransmissionView, 'nfseNotGeneratedAt' | 'lastEventAt'> & PresentationLike,
  /** A VIDA inteira (as tentativas da vida vigente) — obrigatória (gate da Rodada 18, R18-04: o padrão `[candidata]` voltava em
   *  silêncio à regra de antes da D-F97). */
  lifeList: readonly PresentationLike[],
): boolean {
  if (!candidate.nfseNotGeneratedAt || !candidate.lastEventAt) return false
  // R18-03: sem a IDENTIDADE da candidata (Id do DPS + ambiente) não há como achar as reapresentações — falha FECHADO
  if (!candidate.dpsId || !candidate.environment) return false
  // R18-06: instante fora do formato do leitor (ISO com T/Z, etc.) — a comparação por texto mentiria; falha FECHADO
  const instants = [candidate.nfseNotGeneratedAt, candidate.lastEventAt, ...lifeList.flatMap(t => [t.createdAt, t.lastEventAt])]
  if (instants.some(at => at != null && !DB_INSTANT.test(at))) return false
  let lastPresentation = candidate.lastEventAt
  for (const t of [candidate, ...lifeList]) {
    // R19-01 do gate da Rodada 19: irmã sem a identidade (projeção sem Id do DPS ou ambiente) não pode ser descartada como "outra
    // identidade" — falha FECHADO (a view entrega `dps_id` e `environment` em toda linha da vida)
    if (!t.dpsId || !t.environment) return false
    if (t.dpsId !== candidate.dpsId || t.environment !== candidate.environment) continue
    if (!t.lastEventAt) return false                                   // D-F99: em voo — a apresentação dela é desconhecida
    for (const at of [t.createdAt, t.lastEventAt]) if (at && at > lastPresentation) lastPresentation = at
  }
  return candidate.nfseNotGeneratedAt > lastPresentation
}
