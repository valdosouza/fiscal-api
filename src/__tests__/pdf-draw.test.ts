/// <reference types="jest" />
// NE-1b: o desenho VETORIAL — o teste grava os retângulos que a base manda ao pdfkit, remonta as barras e a matriz e decodifica pelos
// oráculos (Code-128 pela tabela própria, QR pelo jsQR).
import { drawBars, drawMatrix } from '../pdf/draw'
import { code128Bars, code128Symbols } from '../pdf/barcode/code128'
import { qrMatrix } from '../pdf/barcode/qr'
import { cmToPt } from '../pdf/units'
import { decodeCode128, readQr } from './pdf-oracle'

function recordingDoc() {
  const rects: [number, number, number, number][] = []
  const calls: string[] = []
  const doc: any = {
    save() { calls.push('save'); return doc }, restore() { calls.push('restore'); return doc },
    fillColor(c: unknown) { calls.push(`fillColor:${JSON.stringify(c)}`); return doc },
    rect(x: number, y: number, w: number, h: number) { rects.push([x, y, w, h]); return doc },
    fill() { calls.push('fill'); return doc },
  }
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
    expect(calls).toEqual(['save', 'fillColor:"#000000"', 'fill', 'restore'])       // cor normalizada (gate A3) e desenho isolado (gate A1)
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

  it('cor CMYK chega ao pdfkit como cópia (o array de quem chama não é retido)', () => {
    const { doc, calls } = recordingDoc()
    const k35 = [0, 0, 0, 35] as const
    drawBars(doc, code128Bars(code128Symbols('1234')), { x: 0, y: 0, width: 100, height: 10 }, { color: k35 })
    expect(calls).toContain('fillColor:[0,0,0,35]')
  })
})
