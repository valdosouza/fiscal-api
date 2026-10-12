import {
  TransmissionView, ViewColumn, VoiceFamilyReading, assertOneInvoiceLife, authorityRecordedOf, familyViewSelect, frozenColumns, isLiveTransmission,
  localCancelPendingIn, mapCommonView,
} from '../reading'
import { readonlySet } from '../../util/readonly-set'

/**
 * LEITURA da família de SERVIÇO (NFS-e, ramo `service` — modelo SE) — NE-1a (parecer do guardião, `prompt_onda_nfe_sefaz.md` §12.9.2):
 * a política da voz que é SÓ da NFS-e (códigos de evento de cancelamento, efeito humano, reconferência pelo E2404) saiu do vocabulário
 * e do contrato COMUNS para cá; os nomes seguem exportados pela biblioteca (os chamadores não mudam).
 * Na família de serviço o registro pelo fisco É a chave de acesso (a chave vem do fisco): a view 004 da nfse-api publica
 * `authority_recorded = (access_key IS NOT NULL)` — a mesma definição que as regras daqui usam.
 */

/**
 * D-F68 (= Q-F75 (a)) / D-F71 (= Q-F78 (a)), Valdo 2026-10-10: na voz C, o `authority_code` guarda o TIPO do evento de
 * cancelamento do fisco (escrito uma vez; NULL = voz anterior à D-F68, lida como cancelamento comum).
 * 101101 emitente · 105102 SUBSTITUIÇÃO · 105104 deferido em análise fiscal · 305101 de ofício.
 */
export const CANCEL_EVENT_CODES: ReadonlySet<string> = readonlySet(['101101', '105102', '105104', '305101'])
/** D-F64: cancelamento por SUBSTITUIÇÃO — existe uma NFS-e substituta que o ERP não conhece; efeito local NÃO automático. */
export const SUBSTITUTION_CANCEL_CODE = '105102'
/** D-F82 (= Q-F89, Valdo 2026-10-10): cancelamento DE OFÍCIO pelo fisco — sem substituta; o efeito local é do HUMANO. */
export const EX_OFFICIO_CANCEL_CODE = '305101'
/**
 * D-F82: cancelamentos cujo efeito no ERP só nasce de ato HUMANO (substituição: cancelar ou manter a nota — D-F67;
 * de ofício: cancelar a nota). 101101 (o nosso pedido) e 105104 (deferido a pedido do contribuinte) seguem automáticos.
 */
export const HUMAN_EFFECT_CANCEL_CODES: ReadonlySet<string> = readonlySet([SUBSTITUTION_CANCEL_CODE, EX_OFFICIO_CANCEL_CODE])

/** Linha de `vw_invoice_service_transmission`: projeção comum + o DPS da vida e a NFS-e. */
export interface ServiceTransmissionView extends TransmissionView {
  serie:      string | null
  dpsNumber:  number | null
  dpsId:      string | null
  nfseNumber: string | null
  dhProc:     string | null
  /** D-F90: última resposta E2404 (nenhuma NFS-e para o Id do DPS) a uma consulta desta tentativa — a PROVA da D-F29. */
  nfseNotGeneratedAt: string | null
}

/** Colunas PRÓPRIAS da view da NFS-e (a projeção comum vem do contrato comum). */
const SERVICE_COLUMNS: readonly ViewColumn[] = frozenColumns([
  ['serie', 'serie'], ['dps_number', 'dpsNumber'], ['dps_id', 'dpsId'], ['nfse_number', 'nfseNumber'],
  ['dh_proc', 'dhProc', true], ['nfse_not_generated_at', 'nfseNotGeneratedAt', true],
])

export function mapTransmissionView(r: any): ServiceTransmissionView {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  return {
    ...mapCommonView(r),
    serie: r.serie ?? null, dpsNumber: n(r.dpsNumber), dpsId: r.dpsId ?? null, nfseNumber: r.nfseNumber ?? null,
    dhProc: r.dhProc ?? null, nfseNotGeneratedAt: r.nfseNotGeneratedAt ?? null,
  }
}

/** D-F82: a voz vigente é um cancelamento cujo efeito no ERP só nasce de ato HUMANO (105102 ou 305101). */
export function isHumanEffectCancel(current: Pick<TransmissionView, 'lastKind' | 'lastCode'> | null): boolean {
  return current?.lastKind === 'C' && !!current.lastCode && HUMAN_EFFECT_CANCEL_CODES.has(current.lastCode)
}

/** D-F68: a voz vigente é um cancelamento por SUBSTITUIÇÃO (código do evento na voz C — D-F71). */
export function isSubstitutionCancel(current: Pick<TransmissionView, 'lastKind' | 'lastCode'> | null): boolean {
  return current?.lastKind === 'C' && current.lastCode === SUBSTITUTION_CANCEL_CODE
}

/** A leitura PUBLICADA da família de serviço (views da migration da nfse-api — D-F35). */
export const SERVICE_VOICE_READING: VoiceFamilyReading<ServiceTransmissionView> = Object.freeze({
  branch:            'service' as const,
  transmissionView:  'vw_invoice_service_transmission',
  voiceView:         'vw_invoice_service_transmission_event',
  ownColumns:        SERVICE_COLUMNS,
  map:               mapTransmissionView,
  humanEffectCancel: isHumanEffectCancel,
})

/** SELECT pronto da view de tentativas da NFS-e (instantes como 'YYYY-MM-DD HH:MM:SS' UTC) — [db] = banco fiscal. */
export function transmissionViewSelect(db: string, alias = 'v'): string {
  return familyViewSelect(SERVICE_VOICE_READING, db, alias)
}

/**
 * Pendência DERIVADA do efeito (D-F28) na NFS-e: a vigente da vida tem voz C do fisco e a nota, no ERP, ainda NÃO tem o evento C.
 * D-F68 (= Q-F75 (a)): a SUBSTITUIÇÃO (e105102) não manda o app aplicar o C local — é decisão humana (D-F64/D-F67);
 * D-F82 (= Q-F89): o cancelamento DE OFÍCIO (e305101) também não.
 */
export function localCancelPending(current: Pick<TransmissionView, 'lastKind' | 'lastCode'> | null, invoiceLastKind: string | null): boolean {
  return localCancelPendingIn(SERVICE_VOICE_READING, current, invoiceLastKind)
}

type ReconfirmLike = Pick<ServiceTransmissionView, 'attempt' | 'lastKind' | 'lastSource' | 'environment' | 'authorityRecorded' | 'dpsId'>

/**
 * Reconfirmação antes do cancelamento LOCAL (Q-ADV1b/Q-ADV2a → D-F29): na VIDA vigente, se nenhuma
 * tentativa foi REGISTRADA pelo fisco e alguma fechou com F por CONSULTA em PRODUÇÃO (as tentativas da vida reusam
 * o Id do DPS — D-N3), a candidata é a ÚLTIMA delas. Homologação não prende a nota (Q-CA5b).
 * D-NE68 (= Q-NE68 (b), gates da NE-1a parte 1): esta regra é exportada para o setes-api (F2a) — lê o FATO do registro, como
 * `currentOf`/`isFiscalRecord` (antes lia `!!accessKey`: numa linha incoerente o núcleo se contradizia — NE1A-02). Dentro da nfse-api
 * o SQL da família segue decidindo pela chave (lá chave ⇔ registro, pela definição da view 004 — cerca em `ne1a-registro.test.ts`).
 */
export function reconfirmationCandidate<T extends ReconfirmLike>(lifeList: readonly T[]): T | null {
  if (lifeList.some(t => authorityRecordedOf(t))) return null
  // D-F103/D-F107/D-F120: `=== 'F'`/`'Q'`/`'P'` são sensíveis a caixa — e o banco confere o MESMO domínio: CHECK binário de `kind`,
  // `source` e `environment` (migration 005 da nfse-api). Antes da 005 a voz gravada por fora do código ("f", "q") sumia daqui calada.
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
 * D-F101 (= Q-F107 (b), Valdo 2026-10-11 — estende a D-F99): "em voo" = tentativa VIVA, pelo MESMO predicado da barreira do plano de
 * cancelamento e do rodízio (`isLiveTransmission`: sem voz OU última voz não final — S "enviado", K) — a voz S tem instante, mas a
 * apresentação dela pode não ter chegado ao fisco. `lastKind` entra no contrato; AUSENTE conta como viva (falha FECHADO).
 * D-F102 (= Q-F108 (a)): S não tem saída hoje (ver `kinds.ts`) — quem criar produtor de S dá a ela a saída da D-F51.
 * D-F104 (= Q-F110 (a), Valdo 2026-10-11): a prova fica BOOLEANA até a F2a — REVISTA pela D-F109 (abaixo): o booleano é o motivo
 * `provada` da MESMA regra (`proofReason`), uma implementação só.
 */
// R20-02 do gate da Rodada 20: `lastKind` é OBRIGATÓRIO no tipo (o valor pode ser `null` = viva) — projeção que o esquece não compila
// (antes compilava e a prova nunca passava: laço "reconfira" silencioso na F2a); o fallback de execução segue falhando FECHADO
type PresentationLike = Partial<Pick<ServiceTransmissionView, 'lastEventAt' | 'createdAt' | 'dpsId' | 'environment'>> & Pick<ServiceTransmissionView, 'lastKind'>
type ProofCandidate = Pick<ServiceTransmissionView, 'nfseNotGeneratedAt' | 'lastEventAt'> & PresentationLike
/** Instante do banco como o leitor do núcleo o entrega (`DATE_FORMAT` — UTC); só nesse formato a comparação por texto é cronológica. */
const DB_INSTANT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/**
 * D-F109 (= Q-F115 (b), Valdo 2026-10-12 — Rodada 1 da F2a, `prompt_apis_fiscais_isoladas.md` §22.6): o VEREDITO da reconferência com
 * MOTIVO — a pergunta do plano de cancelamento do setes-api (F2a) e do `/reconfirm` da nfse-api, numa regra só:
 *  - `irma-viva`          — há tentativa VIVA na vida (transmissão em andamento — barreira do plano, `isLiveTransmission`); vem ANTES da
 *                           prova (nota (1) da F2a: com tentativa em voo a reconferência carimbaria um E2404 que não prova — laço "reconfira");
 *  - `nao-exigida`        — nada a reconferir (a vida tem registro do fisco, ou nenhuma tentativa fechou com F por consulta em PRODUÇÃO);
 *  - `sem-identidade`     — a candidata ou uma irmã sem Id do DPS/ambiente (falha FECHADO — R18-03/R19-01);
 *  - `instante-invalido`  — instante fora do formato do leitor, ou a candidata sem o instante da voz (R18-06);
 *  - `sem-e2404`          — o fisco ainda não respondeu E2404 a uma pergunta desta candidata (D-F90) — a ação é RECONFERIR;
 *  - `apresentada-depois` — o E2404 que existe é ANTERIOR à última apresentação do Id na vida (D-F97) — reconferir de novo;
 *  - `provada`            — o E2404 é posterior à última apresentação do Id em toda tentativa da mesma identidade (D-F90/D-F97/D-F99/D-F101).
 * A política do ERP (homologação não prende a nota — Q-CA5b; destino da nota) segue no plano do ERP (D-F29).
 */
export type ReconfirmReason =
  'provada' | 'irma-viva' | 'apresentada-depois' | 'sem-e2404' | 'sem-identidade' | 'instante-invalido' | 'nao-exigida'
export interface ReconfirmVerdict<T> {
  readonly reason:    ReconfirmReason
  /** A candidata da reconferência (`reconfirmationCandidate`) — null em `irma-viva` e `nao-exigida`. */
  readonly candidate: T | null
}
/**
 * O que a VIDA precisa trazer para o veredito — a projeção da view (`ServiceTransmissionView`) tem tudo; nenhum campo opcional (R20-02).
 * A nota e a vida vêm em cada linha: o veredito recusa ALTO lista que mistura notas ou vidas (gates da A1 da F2a, F2A1-01 — uma vida H
 * registrada e cancelada localmente misturada à vida nova em P dava `nao-exigida` e liberava o cancelamento local sem reconferir).
 */
type VerdictLike = ReconfirmLike & Pick<ServiceTransmissionView, 'nfseNotGeneratedAt' | 'lastEventAt' | 'createdAt' | 'invoiceId' | 'lifeEvent'>

export function reconfirmationVerdict<T extends VerdictLike>(lifeList: readonly T[]): ReconfirmVerdict<T> {
  // UMA nota, UMA vida (D-NE71 — a mesma guarda do `currentOf`; D-F119: o leitor público já entrega só a vida pedida)
  if (lifeList.length) assertOneInvoiceLife(lifeList, 'reconfirmationVerdict')
  // a barreira ANTES da prova (nota (1) da F2a): tentativa VIVA na vida = transmissão em andamento, em QUALQUER identidade
  if (lifeList.some(t => isLiveTransmission(t))) return Object.freeze({ reason: 'irma-viva', candidate: null })
  const candidate = reconfirmationCandidate(lifeList)
  if (!candidate) return Object.freeze({ reason: 'nao-exigida', candidate: null })
  return Object.freeze({ reason: proofReason(candidate, lifeList), candidate })
}

/**
 * A prova de UMA candidata contra a vida (D-F90/D-F97/D-F99/D-F101) — o booleano histórico é o motivo `provada` desta regra, SEM a barreira
 * da vida (uma tentativa viva de OUTRA identidade não entra na prova). D-F118 (= Q-F124, Valdo 2026-10-12): por isso ele NÃO sai pela
 * superfície `fiscal-api/reading` — quem decide o cancelamento (setes-api, F2a) só enxerga o VEREDITO; o booleano fica no barrel (nfse-api,
 * testes dos gates R18–R21).
 */
export function reconfirmationProven(
  candidate: ProofCandidate,
  /** A VIDA inteira (as tentativas da vida vigente) — obrigatória (gate da Rodada 18, R18-04: o padrão `[candidata]` voltava em
   *  silêncio à regra de antes da D-F97). */
  lifeList: readonly PresentationLike[],
): boolean {
  return proofReason(candidate, lifeList) === 'provada'
}

function proofReason(candidate: ProofCandidate, lifeList: readonly PresentationLike[]): Exclude<ReconfirmReason, 'nao-exigida'> {
  // R18-03: sem a IDENTIDADE da candidata (Id do DPS + ambiente) não há como achar as reapresentações — falha FECHADO
  if (!candidate.dpsId || !candidate.environment) return 'sem-identidade'
  // R18-06: instante fora do formato do leitor (ISO com T/Z, etc.) — a comparação por texto mentiria; falha FECHADO. A candidata sem o
  // instante da voz (o F dela) é projeção incompleta — mesmo motivo
  if (!candidate.lastEventAt) return 'instante-invalido'
  const instants = [candidate.nfseNotGeneratedAt, candidate.lastEventAt, ...lifeList.flatMap(t => [t.createdAt, t.lastEventAt])]
  if (instants.some(at => at != null && !DB_INSTANT.test(at))) return 'instante-invalido'
  let lastPresentation = candidate.lastEventAt
  for (const t of [candidate, ...lifeList]) {
    // R19-01 do gate da Rodada 19: irmã sem a identidade (projeção sem Id do DPS ou ambiente) não pode ser descartada como "outra
    // identidade" — falha FECHADO (a view entrega `dps_id` e `environment` em toda linha da vida)
    if (!t.dpsId || !t.environment) return 'sem-identidade'
    if (t.dpsId !== candidate.dpsId || t.environment !== candidate.environment) continue
    // D-F99/D-F101: VIVA (sem voz, S, K — `isLiveTransmission`; `lastKind` ausente = viva) — a apresentação dela é desconhecida
    if (isLiveTransmission(t)) return 'irma-viva'
    // voz FINAL sem o instante dela (gates da A1, F2A1-02): projeção incompleta, não tentativa viva — `irma-viva` é SÓ `isLiveTransmission`
    if (!t.lastEventAt) return 'instante-invalido'
    for (const at of [t.createdAt, t.lastEventAt]) if (at && at > lastPresentation) lastPresentation = at
  }
  if (!candidate.nfseNotGeneratedAt) return 'sem-e2404'
  return candidate.nfseNotGeneratedAt > lastPresentation ? 'provada' : 'apresentada-depois'
}
