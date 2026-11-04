/**
 * SUPERFÍCIE DE LEITURA da biblioteca — `fiscal-api/reading` (D-NE77 = Q-NE77 (a), gates da parte 2 da NE-1a, Valdo 2026-10-12).
 *
 * Na F2a o setes-api passa a importar o núcleo (D-F33) para LER a voz do fisco pelas views publicadas — e só isso: o efeito no ERP é dele,
 * a escrita da voz é das APIs fiscais (D-F11/D-F15). O barrel completo (`fiscal-api`) carrega também o lado de ESCRITA (descritor da
 * família, `withInvoiceTx`, políticas, emitente/A1); a única barreira seria o GRANT, que só falha em EXECUÇÃO, em produção. Este subpath
 * é a fronteira do contrato publicado como fato de COMPILAÇÃO: o vocabulário e a classificação, a projeção comum e os predicados, a leitura
 * por família (`VOICE_READINGS`) e a referência da nota. O leitor que já mapeia (D-NE66 (b)) ENTROU aqui na F2a (`voice/family-reader.ts`);
 * o SQL cru da view (`voice/view-query.ts`) é interno.
 *
 * Gates da A1 da F2a (Valdo 2026-10-12): a superfície é LISTA EXPLÍCITA (antes `export *`) — ficam FORA o SELECT cru (`familyViewSelect`,
 * `transmissionViewSelect` — a linha crua traz o registro como 'S'/'N'; F2A1-04), o booleano `reconfirmationProven` (D-F118 = Q-F124: prova
 * de UMA candidata sem a barreira da vida — quem decide o cancelamento enxerga só o VEREDITO) e a guarda interna `assertOneInvoiceLife`. Os
 * três seguem no barrel (`fiscal-api`) para as famílias e os testes.
 *
 * CERCA (`ne1a-superficie.test.ts`): a lista daqui = o que os módulos exportam MENOS a lista de fora (export novo num módulo quebra a cerca até
 * alguém decidir se entra); nada do lado de escrita aparece nela; o setes-api só importa `fiscal-api/reading`.
 */
export * from './voice/kinds'
export {
  frozenColumns, COMMON_TRANSMISSION_COLUMNS, mapCommonView, isLiveTransmission, isAuthorized, currentOf, authorityRecordedOf, inLife,
  fiscalStateOf, isFiscalRecord, blocksNewAttempt, localCancelPendingIn,
} from './voice/reading'
export type {
  // D-NE160 (NE-2, gate socrático L6): `VoiceView` (a forma da view de VOZES) SAIU da superfície junto com `voiceView` — não tem produtor nem
  // consumidor no contrato publicado; a forma segue no barrel como tipo da view própria da NFS-e
  InvoiceBranch, TransmissionView, ViewColumn, VoiceFamilyReading, FiscalState, ServiceFiscalState,
} from './voice/reading'
export * from './voice/family-reader'
export {
  CANCEL_EVENT_CODES, SUBSTITUTION_CANCEL_CODE, EX_OFFICIO_CANCEL_CODE, HUMAN_EFFECT_CANCEL_CODES, mapTransmissionView, isHumanEffectCancel,
  isSubstitutionCancel, SERVICE_VOICE_READING, localCancelPending, reconfirmationCandidate, reconfirmationVerdict,
} from './voice/families/service'
export type { ServiceTransmissionView, ReconfirmReason, ReconfirmVerdict } from './voice/families/service'
export * from './voice/families'
export * from './ref/invoice-ref'
