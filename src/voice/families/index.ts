import { InvoiceBranch, TransmissionView, VoiceFamilyReading } from '../reading'
import { SERVICE_VOICE_READING } from './service'

/**
 * CATÁLOGO das leituras publicadas, por RAMO da nota (NE-1a — parecer do guardião): quem lê a voz (o setes-api na F2a) percorre as
 * leituras dos ramos PRESENTES na nota (natureza por presença). Ramo sem leitura = a família ainda não existe (nenhuma tentativa possível).
 * D-NE158 (= Q-NE158 (b), Valdo 2026-10-20 — NE-2): a leitura `merchandise` JÁ EXISTE no núcleo (`./merchandise`, só no barrel) e NÃO entra
 * aqui ainda — entrar no catálogo é ato PUBLICADOR com três consumidores (o emitter conta as vivas por ele; o boot da nfse-api e do
 * setes-api conferem cada view do catálogo — D-F113; a cerca `KNOWN_FAMILIES` do plano de cancelamento no setes-api): acontece na JANELA
 * da NE-6, antes da 1ª tentativa possível, com a 001 da nfe-api aplicada e o GRANT ao `setes_api`. Quando entrar, os leitores agregam —
 * não reformam.
 */
export const VOICE_READINGS: Readonly<Partial<Record<InvoiceBranch, VoiceFamilyReading<TransmissionView>>>> = Object.freeze({
  service: SERVICE_VOICE_READING,
})
