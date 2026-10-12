import { Queryable } from '../db/tx'
import type { InvoiceRef } from '../ref/invoice-ref'
import { InvoiceTx, assertInvoiceTx } from '../erp/invoice-tx'
import { TransmissionEventKind } from './kinds'
import type { VoiceEventInput, VoiceEventRow } from './event-table'

/**
 * POLÍTICA sobre o escritor da voz — peças do núcleo da parte 2 da NE-1a (D-NE13/D-NE58; §12.9.7, passo 5). Recebem as PORTAS da família
 * (o escritor tipado pela lista dela e o leitor de idempotência) e guardam a REGRA; QUANDO chamar é roteiro da família. Vieram da nfse-api
 * sem mudar de comportamento. Receber a porta (e não o descritor) mantém a costura de sempre da família (os testes dela simulam o
 * repositório) — e o TIPO prova a lista: o escritor de uma família sem K (ou sem N) não cabe em `VoiceWriter<'K'>` (parâmetro
 * contravariante — `strictFunctionTypes`), então reservar/liberar numa família que não declarou K/N não compila; o funil da família
 * confere de novo em execução. Toda política confere o `InvoiceTx` na ENTRADA, antes de qualquer leitura (gate NE1A2-05: com um
 * `InvoiceTx` vazado, a leitura de idempotência saía pela conexão já devolvida ao pool e respondia "já estava" calada).
 */
export type VoiceWriter<K extends TransmissionEventKind> =
  (itx: InvoiceTx, attempt: number, userId: number | null, e: VoiceEventInput<K>) => Promise<number>
export type VoiceSaid =
  (q: Queryable, ref: InvoiceRef, attempt: number, kind: TransmissionEventKind, dh: string | null) => Promise<boolean>

/**
 * Idempotência da VOZ DO FISCO: a fala (kind, dh) entra UMA vez por tentativa — a mesma resposta lida de novo (consulta, rodízio,
 * retentativa) não duplica (a chave única `(…, kind, dh)` da tabela é a rede; esta é a regra). Devolve o nº do evento, ou null = já estava.
 * Conferido e escrito sob a MESMA trava (o `InvoiceTx`).
 */
export async function recordVoiceOnce<K extends TransmissionEventKind>(
  voice: { insertTransmissionEvent: VoiceWriter<K>; hasTransmissionEvent: VoiceSaid },
  itx: InvoiceTx, attempt: number, userId: number | null, e: VoiceEventInput<K>,
): Promise<number | null> {
  assertInvoiceTx(itx)                                                             // NE1A2-05
  if (await voice.hasTransmissionEvent(itx.conn, itx.ref, attempt, e.kind, e.dh ?? null)) return null
  return voice.insertTransmissionEvent(itx, attempt, userId, e)
}

export const CANCEL_REQUEST_IN_FLIGHT = 'Pedido de cancelamento ao fisco em andamento'

/**
 * RESERVA do pedido de cancelamento (K — D-N17), sob a trava da nota e ANTES da chamada ao fisco: quem chega depois vê K (cancelamento em
 * voo) — sem ela, dois "Cancelar" simultâneos mandavam dois pedidos (gate adversarial M). K e o N de liberação são fatos NOSSOS, não voz do
 * fisco: dh NULL — a chave única (kind, dh) é a idempotência da VOZ do fisco; K → N → K no mesmo segundo colidia nela (500 — adversarial
 * ao vivo, retrabalho).
 */
export async function reserveCancelRequest(write: VoiceWriter<'K'>, itx: InvoiceTx, attempt: number, userId: number | null): Promise<number> {
  assertInvoiceTx(itx)
  return write(itx, attempt, userId, { kind: 'K', source: 'P', dh: null, message: CANCEL_REQUEST_IN_FLIGHT })
}

/**
 * O pedido NÃO vigora (recusado pelo fisco, credencial, ou nem enviado): N devolve a nota a autorizada (D-N17) — SÓ se a última voz da
 * tentativa ainda é o K da reserva ([current] = a tentativa lida pela família sob a MESMA trava — D-NE83: a DESTA tentativa; a de outra
 * falha alto, nunca libera). Fato nosso, dh NULL (ver o K).
 * O AMBÍGUO não libera: o fisco pode ter cancelado — o K fica e a consulta reconcilia (C, ou N depois da carência — roteiro da família).
 */
export async function releaseCancelRequest(
  write: VoiceWriter<'N'>, itx: InvoiceTx, attempt: number, userId: number | null, message: string,
  current: { readonly attempt: number; readonly lastKind: TransmissionEventKind | null } | null,
): Promise<boolean> {
  assertInvoiceTx(itx)
  if (current && current.attempt !== attempt) {
    throw new Error(`releaseCancelRequest: a tentativa lida (${String(current.attempt)}) não é a liberada (${attempt}) — nada gravado (D-NE83)`)
  }
  if (!current || current.lastKind !== 'K') return false
  await write(itx, attempt, userId, { kind: 'N', source: 'P', dh: null, message: message.slice(0, 255) })
  return true
}

export type VoiceFindByKind =
  (q: Queryable, ref: InvoiceRef, attempt: number, kind: TransmissionEventKind, forUpdate?: boolean) => Promise<VoiceEventRow | null>

/**
 * Idempotência POR KIND: a fala deste kind entra UMA vez por tentativa, QUALQUER dh (HIGH-3a: um C por tentativa — o fisco pode devolver o
 * mesmo cancelamento com instantes diferentes em consultas diferentes). Já existindo, devolve a que está (nada escrito).
 */
export async function recordKindOnce<K extends TransmissionEventKind>(
  voice: { insertTransmissionEvent: VoiceWriter<K>; findTransmissionEventByKind: VoiceFindByKind },
  itx: InvoiceTx, attempt: number, userId: number | null, e: VoiceEventInput<K>,
): Promise<{ event: number; inserted: true } | { event: number; inserted: false; existing: VoiceEventRow }> {
  assertInvoiceTx(itx)                                                             // NE1A2-05
  const existing = await voice.findTransmissionEventByKind(itx.conn, itx.ref, attempt, e.kind)   // sob a trava da nota
  if (existing) return { event: existing.event, inserted: false, existing }
  return { event: await voice.insertTransmissionEvent(itx, attempt, userId, e), inserted: true }
}
