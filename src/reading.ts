/**
 * SUPERFÍCIE DE LEITURA da biblioteca — `fiscal-api/reading` (D-NE77 = Q-NE77 (a), gates da parte 2 da NE-1a, Valdo 2026-10-12).
 *
 * Na F2a o setes-api passa a importar o núcleo (D-F33) para LER a voz do fisco pelas views publicadas — e só isso: o efeito no ERP é dele,
 * a escrita da voz é das APIs fiscais (D-F11/D-F15). O barrel completo (`fiscal-api`) carrega também o lado de ESCRITA (descritor da
 * família, `withInvoiceTx`, políticas, emitente/A1); a única barreira seria o GRANT, que só falha em EXECUÇÃO, em produção. Este subpath
 * é a fronteira do contrato publicado como fato de COMPILAÇÃO: o vocabulário e a classificação, a projeção comum e os predicados, a leitura
 * por família (`VOICE_READINGS`) e a referência da nota. O leitor que já mapeia (D-NE66 (b)) entra AQUI na F2a.
 *
 * CERCA (`ne1a-superficie.test.ts`): este arquivo só re-exporta destes módulos; nada do lado de escrita aparece nele; o setes-api só
 * importa `fiscal-api/reading`.
 */
export * from './voice/kinds'
export * from './voice/reading'
export * from './voice/families/service'
export * from './voice/families'
export * from './ref/invoice-ref'
