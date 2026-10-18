/// <reference types="jest" />
// NE-1b: o desenho VETORIAL — o teste grava os retângulos que a base manda ao pdfkit (espiões num documento DA BASE — D-NE127), remonta as
// barras e a matriz e decodifica pelos oráculos (Code-128 pela tabela própria, QR pelo jsQR). E as portas da base: só documento da base
// (D-NE127), desenho opaco mesmo com a opacidade da família (re-gate N1), medida = escrita (D-NE129).
import PDFDocument from 'pdfkit'
import {
  createPdf, drawBars, drawMatrix, drawWatermark, registerFontRoles, writeText, measureText, code128Bars, code128Symbols, qrMatrix, cmToPt,
} from '../pdf'
import { decodeCode128, readQr, pdfContentOps, pdfTextRuns } from './pdf-oracle'

const FIXED = new Date('2026-10-17T03:00:00Z')

/** Documento da base com espiões: grava os retângulos e a sequência de chamadas de estado. */
function recordingDoc() {
  const { doc } = createPdf({ marginCm: 1, title: 'gravação', creationDate: FIXED })
  const rects: [number, number, number, number][] = []
  const calls: string[] = []
  const realRect = doc.rect.bind(doc)
  jest.spyOn(doc, 'rect').mockImplementation(((x: number, y: number, w: number, h: number) => { rects.push([x, y, w, h]); return realRect(x, y, w, h) }) as any)
  for (const name of ['save', 'restore', 'fill'] as const) {
    const real = (doc as any)[name].bind(doc)
    jest.spyOn(doc as any, name).mockImplementation(((...a: unknown[]) => { calls.push(name); return real(...a) }) as any)
  }
  const realFill = doc.fillColor.bind(doc)
  jest.spyOn(doc, 'fillColor').mockImplementation(((c: unknown, o?: number) => { calls.push(`fillColor:${JSON.stringify(c)}:${o}`); return realFill(c as any, o) }) as any)
  return { doc, rects, calls }
}

describe('NE-1b — desenho vetorial', () => {
  const KEY = '4126104ABC2DEF000135550010000000071000000075'

  it('drawBars: as barras desenhadas, remontadas em módulos, decodificam a chave; margem clara de 10 módulos dos dois lados; módulo ≥ 0,02 cm na caixa de 11,5 cm', () => {
    const { doc, rects, calls } = recordingDoc()
    const bars = code128Bars(code128Symbols(KEY))
    const box = { x: cmToPt(1), y: cmToPt(5), width: cmToPt(11.5), height: cmToPt(0.8) }
    const drawn = drawBars(doc, bars, box)
    expect(drawn.moduleCm).toBeGreaterThanOrEqual(0.02)
    expect(drawn.modulePt).toBeCloseTo(box.width / (bars.modules + 20), 9)
    expect(calls).toEqual(['save', 'fillColor:"#000000":1', 'fill', 'restore'])   // cor normalizada e OPACA (gates A3/N1), desenho isolado (A1)
    const m = drawn.modulePt
    const sorted = [...rects].sort((a, b) => a[0] - b[0])
    expect(sorted[0][0]).toBeCloseTo(box.x + 10 * m, 6)
    const last = sorted[sorted.length - 1]
    expect(last[0] + last[2]).toBeCloseTo(box.x + box.width - 10 * m, 6)
    expect(sorted.every(r => r[1] === box.y && r[3] === box.height)).toBe(true)
    const widths: number[] = []
    sorted.forEach((r, i) => {
      widths.push(Math.round(r[2] / m))
      if (i < sorted.length - 1) widths.push(Math.round((sorted[i + 1][0] - (r[0] + r[2])) / m))
    })
    expect(decodeCode128(widths).text).toBe(KEY)
  })

  it('drawMatrix: os retângulos (corridas por linha) remontam a matriz exata, que o leitor independente decodifica', () => {
    const { doc, rects } = recordingDoc()
    const url = 'https://www.nfe.fazenda.gov.br/portal/consulta?chave=' + KEY
    const m = qrMatrix(url, { ecLevel: 'M' })
    const box = { x: cmToPt(15), y: cmToPt(2), size: cmToPt(2) }
    const drawn = drawMatrix(doc, m, box)
    expect(drawn.modulePt).toBeCloseTo(box.size / m.size, 9)
    const grid = Array.from({ length: m.size }, () => Array(m.size).fill(false))
    for (const [x, y, w, h] of rects) {
      const r = Math.round((y - box.y) / drawn.modulePt)
      const c0 = Math.round((x - box.x) / drawn.modulePt)
      const n = Math.round(w / drawn.modulePt)
      expect(h).toBeCloseTo(drawn.modulePt, 9)
      for (let c = c0; c < c0 + n; c++) grid[r][c] = true
    }
    expect(grid).toEqual(m.rows.map(r => [...r]))
    expect(readQr({ size: m.size, rows: grid })).toBe(url)
    expect(rects.length).toBeLessThan(m.rows.flat().filter(Boolean).length)          // corridas: menos retângulos que módulos escuros
  })

  it('caixas e entradas inválidas são recusadas antes de desenhar', () => {
    const { doc, rects } = recordingDoc()
    const bars = code128Bars(code128Symbols('1234'))
    for (const box of [{ x: 0, y: 0, width: 0, height: 10 }, { x: NaN, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: -1 }, null as any]) {
      expect(() => drawBars(doc, bars, box)).toThrow(RangeError)
    }
    expect(() => drawBars(doc, bars, { x: 0, y: 0, width: 10, height: 10 }, { quietModules: -1 })).toThrow(RangeError)
    expect(() => drawBars(doc, { widths: [], modules: 0 }, { x: 0, y: 0, width: 10, height: 10 })).toThrow(RangeError)
    expect(() => drawMatrix(doc, qrMatrix('A', { ecLevel: 'L' }), { x: 0, y: 0, size: 0 })).toThrow(RangeError)
    expect(() => drawMatrix(doc, { size: 3, rows: [[true]] }, { x: 0, y: 0, size: 10 })).toThrow(RangeError)
    expect(rects).toEqual([])
  })

  it('cor CMYK chega ao pdfkit como cópia normalizada (o array de quem chama não é retido)', () => {
    const { doc, calls } = recordingDoc()
    const k35 = [0, 0, 0, 35] as const
    drawBars(doc, code128Bars(code128Symbols('1234')), { x: 0, y: 0, width: 100, height: 10 }, { color: k35 })
    expect(calls).toContain('fillColor:[0,0,0,35]:1')
  })

  it('re-gate N1 — barras e QR saem OPACOS mesmo com a opacidade que a família deixou ligada (o desenho afirma a própria opacidade)', async () => {
    const w = createPdf({ marginCm: 1, title: 'N1', creationDate: FIXED })
    w.doc.fillColor('gray', 0.2).rect(10, 10, 50, 50).fill()                         // a família pinta translúcido e não volta
    w.doc.fillColor('black')
    drawBars(w.doc, code128Bars(code128Symbols(KEY)), { x: 20, y: 100, width: cmToPt(11.5), height: cmToPt(0.8) })
    drawMatrix(w.doc, qrMatrix('ABC', { ecLevel: 'L' }), { x: 20, y: 200, size: 60 })
    const ops = pdfContentOps(await w.end())[0]
    // cada bloco q…Q da base afirma a opacidade 1 (ExtGState com ca 1) antes dos retângulos
    const blocks = ops.split('\nq\n').slice(1).filter(b => / re\n/.test(b))
    expect(blocks.length).toBe(2)
    for (const b of blocks) expect(b.indexOf(' gs\n')).toBeLessThan(b.indexOf(' re\n'))
  })

  it('D-NE127 — as seis portas só aceitam documento criado pelo `createPdf` da base (documento do pdfkit cru, objeto qualquer ou nada = recusa)', () => {
    const foreign = new PDFDocument()
    const fakes: unknown[] = [foreign, {}, null, undefined]
    const bars = code128Bars(code128Symbols('1234'))
    for (const d of fakes) {
      const doc = d as PDFKit.PDFDocument
      expect(() => drawBars(doc, bars, { x: 0, y: 0, width: 100, height: 10 })).toThrow(/não foi criado pelo createPdf/)
      expect(() => drawMatrix(doc, qrMatrix('A', { ecLevel: 'L' }), { x: 0, y: 0, size: 10 })).toThrow(/não foi criado pelo createPdf/)
      expect(() => drawWatermark(doc, 'X', { font: 'Helvetica', sizePt: 20, color: 'gray' })).toThrow(/não foi criado pelo createPdf/)
      expect(() => registerFontRoles(doc, { content: 'Times-Roman' })).toThrow(/não foi criado pelo createPdf/)
      expect(() => writeText(doc, 'content', 'x')).toThrow(/não foi criado pelo createPdf/)
      expect(() => measureText(doc, 'content', 'x')).toThrow(/não foi criado pelo createPdf/)
    }
    foreign.end()
  })

  it('D-NE129 — a MEDIDA usa a mesma normalização e bate com a escrita: a altura medida é a altura que o `writeText` ocupou; não mexe no estado da família', async () => {
    const w = createPdf({ marginCm: 1, title: 'medida', creationDate: FIXED, fontRoles: { content: 'Times-Roman', bold: 'Times-Bold' } })
    const text = 'Descrição do produto com acentuação e Ω — '.repeat(12)
    w.doc.font('bold').fontSize(14)
    const before = [(w.doc as any)._font, (w.doc as any)._fontSize, w.doc.x, w.doc.y]
    const m = measureText(w.doc, 'content', text, { sizePt: 8, width: 200 })
    expect([(w.doc as any)._font, (w.doc as any)._fontSize, w.doc.x, w.doc.y]).toEqual(before)
    expect(m.replaced).toBe(12)
    const y0 = 100
    writeText(w.doc, 'content', text, { x: 40, y: y0, sizePt: 8, width: 200 })
    expect(w.doc.y - y0).toBeCloseTo(m.height, 6)
    const single = measureText(w.doc, 'content', 'nº 5 Ω', { sizePt: 10 })
    expect(single.replaced).toBe(1)
    expect(single.width).toBeGreaterThan(0)
    expect(() => measureText(w.doc, 'content', 'x', { continued: true } as any)).toThrow(RangeError)
    expect(() => measureText(w.doc, 'content', 'x', { columns: 2 } as any)).toThrow(RangeError)
    expect(pdfTextRuns(pdfContentOps(await w.end())[0]).some(r => r.text.includes('?'))).toBe(true)
  })
})
