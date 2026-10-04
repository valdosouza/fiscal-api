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
