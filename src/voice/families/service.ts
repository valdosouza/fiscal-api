import { FINAL_TRANSMISSION_KINDS } from '../kinds'
import {
  TransmissionView, ViewColumn, VoiceFamilyReading, authorityRecordedOf, familyViewSelect, frozenColumns, localCancelPendingIn, mapCommonView,
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
  // D-F103 (= Q-F109 (a)): `=== 'F'` é sensível a caixa e o banco não confere o domínio de `kind` (colação _ci) — os escritores são
  // tipados; voz gravada por fora do código ("f") some daqui. O CHECK binário entra na migration da F2a.
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
 * D-F104 (= Q-F110 (a), Valdo 2026-10-11): a prova fica BOOLEANA até a F2a; o veredito com MOTIVO (barreira e prova numa chamada só —
 * molde `verdictOf`, D-IB47) se decide na rodada da F2a, com o caso real (itens (5)/(6) da nota de implantação, §21.14).
 */
// R20-02 do gate da Rodada 20: `lastKind` é OBRIGATÓRIO no tipo (o valor pode ser `null` = viva) — projeção que o esquece não compila
// (antes compilava e a prova nunca passava: laço "reconfira" silencioso na F2a); o fallback de execução segue falhando FECHADO
type PresentationLike = Partial<Pick<ServiceTransmissionView, 'lastEventAt' | 'createdAt' | 'dpsId' | 'environment'>> & Pick<ServiceTransmissionView, 'lastKind'>
/** Instante do banco como o leitor do núcleo o entrega (`DATE_FORMAT` — UTC); só nesse formato a comparação por texto é cronológica. */
const DB_INSTANT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
export function reconfirmationProven(
  candidate: Pick<ServiceTransmissionView, 'nfseNotGeneratedAt' | 'lastEventAt'> & PresentationLike,
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
    // D-F99/D-F101: em voo (sem voz) ou VIVA (S/K — `isLiveTransmission`) — a apresentação dela é desconhecida; `lastKind` ausente = viva
    if (!t.lastEventAt || !FINAL_TRANSMISSION_KINDS.has(t.lastKind ?? '')) return false
    for (const at of [t.createdAt, t.lastEventAt]) if (at && at > lastPresentation) lastPresentation = at
  }
  return candidate.nfseNotGeneratedAt > lastPresentation
}
