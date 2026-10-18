/**
 * Desenho VETORIAL da base de PDF (D-NE20): barras, matriz e marca d'água. Medidas em pontos (a régua em cm é `cmToPt`). Cada desenho devolve
 * o MÓDULO efetivo — conferir o mínimo da norma é da família (NT Conjunta 2025.001 §6: módulo ≥ 0,02 cm; NT 008: QR ≥ 1,52 cm).
 *
 * Gates da NE-1b (2026-10-17): só em documento da base (D-NE127); TODO desenho roda em `isolated` (`./state` — o estado da família volta intacto;
 * o conhecimento negativo do pdfkit está lá) e AFIRMA a própria cor E opacidade (re-gate N1: `fillColor(c)` sem opacidade não emite `gs` — as
 * barras herdavam a opacidade que a família deixou e saíam translúcidas); a marca é UMA linha sem `width` (com `width` o pdfkit usa o quebrador
 * de linha, que quebra e ABRE FOLHA). Toda validação vem ANTES do `save()` (recusa limpa: nenhum `q` aberto).
 */
import type { Code128Bars } from './barcode/code128'
import type { QrMatrix } from './barcode/qr'
import { baseDocument } from './base-document'
import { toWinAnsi, STANDARD_FONTS, type StandardFont } from './fonts'
import { isolated } from './state'
import { MAX_COORDINATE_PT, ptToCm } from './units'

export interface PdfBox { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
/**
 * Cor da base: hex (`#rgb`/`#rrggbb`), um dos nomes `black`/`white`/`gray`/`grey`, ou CMYK 0–100 (ex.: cinza K35 = [0, 0, 0, 35]; vermelho
 * sólido M100/Y100 = [0, 100, 100, 0]). Qualquer outra coisa é recusada — o pdfkit IGNORA cor inválida em silêncio (o desenho sairia na cor
 * corrente, até branca) e grava CMYK fora da faixa cru no PDF.
 */
export type PdfColor = string | readonly [number, number, number, number]
export interface DrawnModule { readonly modulePt: number; readonly moduleCm: number }

const NAMED: Readonly<Record<string, string>> = Object.freeze({ black: '#000000', white: '#ffffff', gray: '#808080', grey: '#808080' })
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const CMYK_INDEXES = [0, 1, 2, 3] as const

/** A cor como o pdfkit vai recebê-la (hex ou CMYK arredondado a centésimos — nunca expoente no PDF). */
export function normalizeColor(c: PdfColor): string | number[] {
  if (typeof c === 'string') {
    const hex = Object.prototype.hasOwnProperty.call(NAMED, c) ? NAMED[c] : c
    if (HEX.test(hex)) return hex
  } else if (Array.isArray(c) && c.length === 4
    // por ÍNDICE (re-gate D10: o `every` pula buraco — `[0, , 0, 35]` passava e gravava 3 operandos)
    && CMYK_INDEXES.every(i => typeof c[i] === 'number' && Number.isFinite(c[i]) && c[i] >= 0 && c[i] <= 100)) {
    return CMYK_INDEXES.map(i => Math.round(c[i] * 100) / 100 + 0)
  }
  throw new RangeError('base de PDF: cor inválida (hex, black/white/gray ou CMYK 0–100)')
}

const coordinate = (n: number): boolean => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORDINATE_PT
const assertBox = (b: PdfBox, what: string): void => {
  if (!b || ![b.x, b.y, b.width, b.height].every(coordinate) || b.width <= 0 || b.height <= 0) throw new RangeError(`base de PDF: caixa ${what} inválida`)
}

/**
 * Code-128 numa caixa: a LARGURA da caixa inclui a margem clara (`quietModules` de cada lado — 10 pela NT, a largura mínima de 11,5 cm já a
 * conta); a altura é a das barras. Não deixe caminho aberto antes (o preenchimento é do caminho corrente do PDF).
 */
export function drawBars(doc: PDFKit.PDFDocument, bars: Code128Bars, box: PdfBox,
  opts: { readonly quietModules?: number; readonly color?: PdfColor } = {}): DrawnModule {
  baseDocument(doc)
  assertBox(box, 'das barras')
  const quiet = opts.quietModules ?? 10
  if (!Number.isInteger(quiet) || quiet < 0 || quiet > 100) throw new RangeError('base de PDF: margem clara inválida')
  const widths = bars?.widths
  if (!Array.isArray(widths) || widths.length === 0 || widths.length % 2 === 0 || !widths.every(w => Number.isInteger(w) && w >= 1 && w <= 4)) {
    throw new RangeError('base de PDF: barras inválidas (larguras de 1 a 4 módulos, começando e terminando em barra)')
  }
  if (bars.modules !== widths.reduce((a, b) => a + b, 0)) throw new RangeError('base de PDF: barras inválidas (módulos ≠ soma das larguras)')
  const color = normalizeColor(opts.color ?? 'black')
  const module = box.width / (bars.modules + 2 * quiet)
  return isolated(doc, () => {
    doc.fillColor(color as any, 1)
    let x = box.x + quiet * module
    widths.forEach((w, i) => {
      if (i % 2 === 0) doc.rect(x, box.y, w * module, box.height)
      x += w * module
    })
    doc.fill()
    return Object.freeze({ modulePt: module, moduleCm: ptToCm(module) })
  }, { who: 'drawBars' })
}

/** QR (ou outra matriz) num quadrado de lado `size` — só o símbolo; a zona de silêncio em volta é do layout. Módulos contíguos da linha viram um retângulo só. */
export function drawMatrix(doc: PDFKit.PDFDocument, matrix: QrMatrix, box: { readonly x: number; readonly y: number; readonly size: number },
  opts: { readonly color?: PdfColor } = {}): DrawnModule {
  baseDocument(doc)
  assertBox({ x: box?.x, y: box?.y, width: box?.size, height: box?.size }, 'da matriz')
  const size = matrix?.size
  const rows = matrix?.rows
  if (!Number.isInteger(size) || size <= 0 || !Array.isArray(rows) || rows.length !== size
    || !rows.every(r => Array.isArray(r) && r.length === size && r.every(v => typeof v === 'boolean'))) {
    throw new RangeError('base de PDF: matriz inválida (size × size de booleanos)')
  }
  const color = normalizeColor(opts.color ?? 'black')
  const module = box.size / size
  return isolated(doc, () => {
    doc.fillColor(color as any, 1)
    rows.forEach((row, r) => {
      let c = 0
      while (c < row.length) {
        if (!row[c]) { c++; continue }
        let end = c
        while (end < row.length && row[end]) end++
        doc.rect(box.x + c * module, box.y + r * module, (end - c) * module, module)
        c = end
      }
    })
    doc.fill()
    return Object.freeze({ modulePt: module, moduleCm: ptToCm(module) })
  }, { who: 'drawMatrix' })
}

export interface WatermarkStyle {
  readonly font: StandardFont
  readonly sizePt: number
  /** Graus (padrão −45: diagonal de baixo-esquerda para cima-direita na página em pé); reduzido módulo 360. */
  readonly angleDeg?: number
  readonly color: PdfColor
  /** 0–1 (padrão 1). */
  readonly opacity?: number
}

/**
 * Texto diagonal centrado na folha CORRENTE, em UMA linha (nunca quebra nem abre folha — o que passar da folha some fora dela). O texto passa
 * pelo `toWinAnsi` (quebra de linha vira espaço); o estado da família (fonte, corpo, cor, posição, texto encadeado) volta intacto — a marca
 * pode ser desenhada antes do conteúdo (`sheetStart`, fica por baixo) ou na passada por folha (por cima). Devolve quantos caracteres viraram `?`.
 */
export function drawWatermark(doc: PDFKit.PDFDocument, text: string, style: WatermarkStyle): { readonly replaced: number } {
  baseDocument(doc)
  const t = toWinAnsi(text)
  const line = t.text.replace(/\n/g, ' ')
  if (line.trim() === '') throw new RangeError('base de PDF: marca d\'água vazia')
  if (!(STANDARD_FONTS as readonly string[]).includes(style?.font)) throw new RangeError('base de PDF: fonte da marca d\'água tem de ser fonte-padrão')
  if (typeof style.sizePt !== 'number' || !Number.isFinite(style.sizePt) || style.sizePt <= 0 || style.sizePt > 1000) {
    throw new RangeError('base de PDF: tamanho da marca d\'água inválido')
  }
  const rawAngle = style.angleDeg ?? -45
  if (typeof rawAngle !== 'number' || !Number.isFinite(rawAngle)) throw new RangeError('base de PDF: ângulo da marca d\'água inválido')
  const angle = rawAngle % 360                                     // re-gate D11: ângulo finito gigante virava Infinity em radianos
  const opacity = style.opacity ?? 1
  if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new RangeError('base de PDF: opacidade fora de 0–1')
  const color = normalizeColor(style.color)
  const { width, height } = doc.page
  isolated(doc, () => {
    doc.rotate(angle, { origin: [width / 2, height / 2] }).font(style.font).fontSize(style.sizePt).fillColor(color as any, opacity)
    const w = doc.widthOfString(line)
    doc.text(line, width / 2 - w / 2, height / 2 - doc.currentLineHeight() / 2, { lineBreak: false })
  }, { who: 'drawWatermark' })
  return Object.freeze({ replaced: t.replaced })
}
