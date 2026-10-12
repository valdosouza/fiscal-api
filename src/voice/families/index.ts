import { InvoiceBranch, TransmissionView, VoiceFamilyReading } from '../reading'
import { SERVICE_VOICE_READING } from './service'

/**
 * CATÁLOGO das leituras publicadas, por RAMO da nota (NE-1a — parecer do guardião): quem lê a voz (o setes-api na F2a) percorre as
 * leituras dos ramos PRESENTES na nota (natureza por presença). Quando a NF-e chegar (NE-2), a leitura `merchandise` ENTRA aqui e os
 * leitores agregam — não reformam. Ramo sem leitura = a família ainda não existe.
 */
export const VOICE_READINGS: Readonly<Partial<Record<InvoiceBranch, VoiceFamilyReading<TransmissionView>>>> = Object.freeze({
  service: SERVICE_VOICE_READING,
})
