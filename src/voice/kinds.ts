/**
 * Vocabulário da VOZ do fisco — fonte ÚNICA (L5 do gate socrático da Onda 3). Sem imports.
 *
 * S enviado · A autorizada · R rejeitada · C cancelada · K cancelamento em voo · F falha explícita ·
 * N pedido de cancelamento NÃO consta no fisco (D-N17 — segue autorizada).
 */
export type TransmissionEventKind = 'S' | 'A' | 'R' | 'C' | 'K' | 'F' | 'N'
/** P resposta direta ao nosso pedido · Q consulta. */
export type TransmissionSource = 'P' | 'Q'
export type TransmissionEnvironment = 'H' | 'P'

/** Tentativa ENCERRADA: o fisco não vai dizer mais nada útil sobre ela sozinho. */
export const FINAL_TRANSMISSION_KINDS: ReadonlySet<string> = new Set<TransmissionEventKind>(['A', 'R', 'C', 'F', 'N'])
/** NFS-e AUTORIZADA e vigente (A, ou N depois de um K — D-N17). */
export const AUTHORIZED_KINDS: ReadonlySet<string> = new Set<TransmissionEventKind>(['A', 'N'])

/**
 * D-F68 (= Q-F75 (a)) / D-F71 (= Q-F78 (a)), Valdo 2026-10-10: na voz C, o `authority_code` guarda o TIPO do evento de
 * cancelamento do fisco (escrito uma vez; NULL = voz anterior à D-F68, lida como cancelamento comum).
 * 101101 emitente · 105102 SUBSTITUIÇÃO · 105104 deferido em análise fiscal · 305101 de ofício.
 */
export const CANCEL_EVENT_CODES: ReadonlySet<string> = new Set(['101101', '105102', '105104', '305101'])
/** D-F64: cancelamento por SUBSTITUIÇÃO — existe uma NFS-e substituta que o ERP não conhece; efeito local NÃO automático. */
export const SUBSTITUTION_CANCEL_CODE = '105102'
/** D-F82 (= Q-F89, Valdo 2026-10-10): cancelamento DE OFÍCIO pelo fisco — sem substituta; o efeito local é do HUMANO. */
export const EX_OFFICIO_CANCEL_CODE = '305101'
/**
 * D-F82: cancelamentos cujo efeito no ERP só nasce de ato HUMANO (substituição: cancelar ou manter a nota — D-F67;
 * de ofício: cancelar a nota). 101101 (o nosso pedido) e 105104 (deferido a pedido do contribuinte) seguem automáticos.
 */
export const HUMAN_EFFECT_CANCEL_CODES: ReadonlySet<string> = new Set([SUBSTITUTION_CANCEL_CODE, EX_OFFICIO_CANCEL_CODE])
