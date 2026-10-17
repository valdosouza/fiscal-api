/**
 * SUPERFÍCIE da base de PDF — `fiscal-api/pdf` (NE-1b — D-NE20/D-NE32/D-NE117…D-NE123, Valdo 2026-10-17).
 *
 * O vocabulário de DESENHO comum aos documentos auxiliares: régua em cm, papéis de fonte (fontes-padrão WinAnsi), escritor com passada por
 * folha, barras (Code-128 híbrido C/A da NT Conjunta 2025.001), matriz (QR) e marca d'água. Cega ao fisco: não sabe de nota, voz, estado,
 * "Folha n/N" nem de quadro de nenhuma norma — DANFE e DANFSe são COMPOSIÇÕES da família (parecer do guardião, prompt da NF-e §14.4).
 *
 * Fora do índice principal e do `reading`: quem não desenha PDF (o setes-api) não carrega pdfkit nem a lib de símbolos (cerca
 * `pdf-cerca.test.ts`). O pdfkit é `peerDependency` opcional — a família que usa esta superfície traz o dela.
 */
export * from './pdf/units'
export * from './pdf/fonts'
export * from './pdf/pdf-writer'
export * from './pdf/draw'
export * from './pdf/barcode/code128'
export * from './pdf/barcode/qr'
