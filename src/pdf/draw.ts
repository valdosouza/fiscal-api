/**
 * Desenho VETORIAL da base de PDF (D-NE20): barras, matriz e marca d'água. Medidas em pontos (a régua em cm é `cmToPt`). Cada desenho devolve
 * o MÓDULO efetivo — conferir o mínimo da norma é da família (NT Conjunta 2025.001 §6: módulo ≥ 0,02 cm; NT 008: QR ≥ 1,52 cm).
 */
import type { Code128Bars } from './barcode/code128'
import type { QrMatrix } from './barcode/qr'
import { toWinAnsi, STANDARD_FONTS, type StandardFont } from './fonts'
import { ptToCm } from './units'

export interface PdfBox { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
/** Cor do pdfkit: nome/hex, ou CMYK 0–100 (ex.: cinza K35 = [0, 0, 0, 35]). */
export type PdfColor = string | readonly [number, number, number, number]
export interface DrawnModule { readonly modulePt: number; readonly moduleCm: number }

const finite = (n: number): boolean => typeof n === 'number' && Number.isFinite(n)
const assertBox = (b: PdfBox, what: string): void => {
  if (!b || ![b.x, b.y, b.width, b.height].every(finite) || b.width <= 0 || b.height <= 0) throw new RangeError(`base de PDF: caixa ${what} inválida`)
}
const colorOf = (c: PdfColor): string | number[] => (Array.isArray(c) ? [...c] : (c as string))

/**
 * Code-128 numa caixa: a LARGURA da caixa inclui a margem clara (`quietModules` de cada lado — 10 pela NT, a largura mínima de 11,5 cm já a
 * conta); a altura é a das barras.
 */
export function drawBars(doc: PDFKit.PDFDocument, bars: Code128Bars, box: PdfBox,
  opts: { readonly quietModules?: number; readonly color?: PdfColor } = {}): DrawnModule {
  assertBox(box, 'das barras')
  const quiet = opts.quietModules ?? 10
  if (!Number.isInteger(quiet) || quiet < 0) throw new RangeError('base de PDF: margem clara inválida')
  if (!bars || !Array.isArray(bars.widths) || bars.widths.length === 0) throw new RangeError('base de PDF: barras vazias')
  const module = box.width / (bars.modules + 2 * quiet)
  doc.save().fillColor(colorOf(opts.color ?? 'black') as any)
  let x = box.x + quiet * module
  bars.widths.forEach((w, i) => {
    if (i % 2 === 0) doc.rect(x, box.y, w * module, box.height)
    x += w * module
  })
  doc.fill().restore()
  return Object.freeze({ modulePt: module, moduleCm: ptToCm(module) })
}

/** QR (ou outra matriz) num quadrado de lado `size` — só o símbolo; a zona de silêncio em volta é do layout. Módulos contíguos da linha viram um retângulo só. */
export function drawMatrix(doc: PDFKit.PDFDocument, matrix: QrMatrix, box: { readonly x: number; readonly y: number; readonly size: number },
  opts: { readonly color?: PdfColor } = {}): DrawnModule {
  assertBox({ x: box?.x, y: box?.y, width: box?.size, height: box?.size }, 'da matriz')
  if (!matrix || !Number.isInteger(matrix.size) || matrix.size <= 0 || matrix.rows.length !== matrix.size) throw new RangeError('base de PDF: matriz inválida')
  const module = box.size / matrix.size
  doc.save().fillColor(colorOf(opts.color ?? 'black') as any)
  matrix.rows.forEach((row, r) => {
    let c = 0
    while (c < row.length) {
      if (!row[c]) { c++; continue }
      let end = c
      while (end < row.length && row[end]) end++
      doc.rect(box.x + c * module, box.y + r * module, (end - c) * module, module)
      c = end
    }
  })
  doc.fill().restore()
  return Object.freeze({ modulePt: module, moduleCm: ptToCm(module) })
}

export interface WatermarkStyle {
  readonly font: StandardFont
  readonly sizePt: number
  /** Graus (padrão −45: diagonal de baixo-esquerda para cima-direita na página em pé). */
  readonly angleDeg?: number
  readonly color: PdfColor
  /** 0–1 (padrão 1). */
  readonly opacity?: number
}

/**
 * Texto diagonal centrado na folha CORRENTE. O texto passa pelo `toWinAnsi`; a posição de escrita (x/y) da família é preservada — a marca
 * pode ser desenhada antes do conteúdo (`sheetStart`, fica por baixo) ou na passada por folha (por cima). Devolve quantos caracteres viraram `?`.
 */
export function drawWatermark(doc: PDFKit.PDFDocument, text: string, style: WatermarkStyle): { readonly replaced: number } {
  const t = toWinAnsi(text)
  if (t.text.trim() === '') throw new RangeError('base de PDF: marca d\'água vazia')
  if (!(STANDARD_FONTS as readonly string[]).includes(style?.font)) throw new RangeError('base de PDF: fonte da marca d\'água tem de ser fonte-padrão')
  if (!finite(style.sizePt) || style.sizePt <= 0) throw new RangeError('base de PDF: tamanho da marca d\'água inválido')
  const opacity = style.opacity ?? 1
  if (!finite(opacity) || opacity < 0 || opacity > 1) throw new RangeError('base de PDF: opacidade fora de 0–1')
  const { width, height } = doc.page
  const x = doc.x, y = doc.y
  doc.save()
    .rotate(style.angleDeg ?? -45, { origin: [width / 2, height / 2] })
    .font(style.font).fontSize(style.sizePt)
    .fillColor(colorOf(style.color) as any, opacity)
    .text(t.text.replace(/\n/g, ' '), 0, height / 2 - style.sizePt / 2, { width, align: 'center', lineBreak: false })
    .restore()
  doc.x = x; doc.y = y
  return Object.freeze({ replaced: t.replaced })
}
