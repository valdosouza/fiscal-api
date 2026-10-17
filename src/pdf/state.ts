/**
 * Isolamento do estado do pdfkit (gates da NE-1b, 2026-10-17 — HIGH provado pelos dois revisores; D-NE125).
 *
 * CONHECIMENTO NEGATIVO: no pdfkit 0.20.2 o `save()`/`restore()` guarda só a MATRIZ (q/Q no PDF + `_ctmStack`). Fonte, corpo, cor, posição e o
 * texto ENCADEADO (`continued`) da família vivem no objeto JS (`_font`, `_fontSize`, `_fillColor`, `_strokeColor`, `_wrapper`, `_textOptions`,
 * `x`, `y`) e o quebrador de linha REAPLICA `_fillColor` depois de abrir folha. Código que mexe nisso sem devolver faz o texto da família
 * continuar no estilo dele (a marca d'água no `sheetStart` deixava os itens das folhas seguintes em Helvetica 50 cinza translúcido).
 * Estes nomes são INTERNOS do pdfkit — a versão é exata no package.json (D-NE124) e trocá-la exige os testes A1/A2 do gate.
 *
 * Interno da base (não sai pela superfície `fiscal-api/pdf`).
 */
const TEXT_STATE = ['_font', '_fontSize', '_fontSource', '_fontFamily', '_fillColor', '_strokeColor', '_wrapper', '_textOptions', 'x', 'y'] as const
export type KeptState = 'y'

/**
 * Roda `draw` com o estado da família guardado: o texto encadeado dela fica FORA (o desenho não continua a frase da família), o estado
 * gráfico do PDF volta pelo q/Q e o estado JS volta campo a campo — menos o que estiver em `keep` (o `sheetStart` deixa o `y` como o começo
 * do conteúdo da folha — D-NE125).
 */
export function isolated<T>(doc: PDFKit.PDFDocument, draw: () => T, keep: readonly KeptState[] = []): T {
  const d = doc as unknown as Record<string, unknown>
  const saved = TEXT_STATE.map(k => d[k])
  d._wrapper = null
  d._textOptions = null
  doc.save()
  try {
    return draw()
  } finally {
    doc.restore()
    TEXT_STATE.forEach((k, i) => { if (!(keep as readonly string[]).includes(k)) d[k] = saved[i] })
  }
}
