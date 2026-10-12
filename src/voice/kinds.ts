/**
 * Vocabulário da VOZ do fisco — fonte ÚNICA (L5 do gate socrático da Onda 3). Sem imports.
 *
 * S enviado · A autorizada · R rejeitada · C cancelada · K cancelamento em voo · F falha explícita ·
 * N pedido de cancelamento NÃO consta no fisco (D-N17 — segue autorizada).
 *
 * CONHECIMENTO NEGATIVO (D-F102 = Q-F108 (a), Valdo 2026-10-11): S ("enviado") NÃO tem produtor hoje e NÃO tem SAÍDA — a D-F51 só
 * fecha tentativa SEM voz, e por DOIS portões: o predicado `isInterruptedInFlight` E a reconferência sob a trava, que recusa tentativa
 * com voz (`recordInterruptedFailure` na nfse-api, `reconcileInterrupted` no setes-api — R21-03). Quem criar produtor de S abre OS DOIS,
 * NA MESMA ENTREGA (idade da voz S ≥ IN_FLIGHT_MINUTES + o veredito conclusivo do fisco da família → F); senão a prova da reconferência
 * (D-F101) fica falsa para sempre e o transmitir em 409. A CERCA (`nfse-api/src/__tests__/voice-kind-fence.ts`, por AST) pega o literal
 * S ao lado de `kind` em QUALQUER grafia e o SQL de escrita na voz, em todo lugar que escreve na voz da NFS-e — NÃO pega produtor
 * SEMÂNTICO (constante nomeada, shorthand, mapa, parâmetro): esse o TIPO do escritor pega — D-F106 (= Q-F112 (b)): o escritor da NFS-e
 * aceita só a lista POSITIVA da família (`ServiceVoiceWriteKind` = A/R/C/K/F/N, na nfse-api e no setes-api); os kinds que a NE-1a trouxer
 * para ESTE tipo comum (P da NF-e — viva, em processamento; D — FINAL, denegada) não entram lá. D-F105 (= Q-F111 (a)): a D-F102 vale SÓ
 * para a família NFS-e — a NF-e PODE produzir S; quem o produzir dá a saída na mesma entrega (consulta pela NOSSA chave — §3.2/D-NE7 do
 * prompt da NF-e; o P sai pela consulta do recibo — D-NE33); no núcleo a cerca só olha SQL na tabela da NFS-e.
 * D-F103 (= Q-F109 (a)): `kind` é CHAR(1) sem CHECK de domínio na migration 001 da nfse-api (colação _ci — o banco aceita "f", que o SQL
 * lê como F e o código como VIVA). Os escritores são TIPADOS — EXCETO a cópia do `migrate:setes` (`nfse-api/scripts/migrate-from-setes-api.ts`:
 * `INSERT IGNORE … SELECT … ev.kind` herda o domínio da ORIGEM, que também não tem CHECK — R21-05). NUNCA gravar voz por fora do código.
 * A migration da F2a ganha o CHECK do domínio em colação binária, conferido no boot (molde da D-F45) — item (7) da nota de implantação;
 * o domínio é a lista da FAMÍLIA (A/R/C/K/F/N — D-F107), não este tipo comum. Quando a máquina vier para cá (NE-1a), a lista de escrita
 * vai no DESCRITOR da família (`VoiceFamily<K>`) e o escritor comum é genérico nela, com o funil em execução (D-F108 — nota no
 * `prompt_onda_nfe_sefaz.md` §12.8): nunca um escritor do núcleo tipado por `TransmissionEventKind`.
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
