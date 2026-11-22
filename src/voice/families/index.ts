import { InvoiceBranch, TransmissionView, VoiceFamilyReading } from '../reading'
import { SERVICE_VOICE_READING } from './service'
import { MERCHANDISE_VOICE_READING } from './merchandise'

/**
 * CATÁLOGO das leituras publicadas, por RAMO da nota (NE-1a — parecer do guardião): quem lê a voz (o setes-api na F2a) percorre as
 * leituras dos ramos PRESENTES na nota (natureza por presença). Ramo sem leitura = a família ainda não existe (nenhuma tentativa possível).
 * D-NE158 (= Q-NE158 (b), Valdo 2026-10-20 — NE-2): a leitura `merchandise` nasceu FORA daqui e ENTROU na JANELA da NE-6
 * (fiscal-api:FAMILIA.E5.P3, pacote 5.0.0), antes da 1ª tentativa possível. Entrar no catálogo é ato PUBLICADOR com três consumidores: o
 * emitter conta as vivas por ele (D-NE76: família não instalada no banco — nem view nem tabela — conta 0); o boot de quem confere passa a
 * lista que confere (`assertFamilyViewsReadable` sem valor padrão — D-NE158); a cerca `KNOWN_FAMILIES` do plano de cancelamento no
 * setes-api. O GRANT da view ao `setes_api` e a adoção do pacote são passos de cada consumidor (PM-9/PM-10). Os leitores agregam — não
 * reformam.
 */
export const VOICE_READINGS: Readonly<Partial<Record<InvoiceBranch, VoiceFamilyReading<TransmissionView>>>> = Object.freeze({
  service:     SERVICE_VOICE_READING,
  merchandise: MERCHANDISE_VOICE_READING,
})
