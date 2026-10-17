/// <reference types="jest" />
// NE-1b (D-NE117/D-NE122): a FOLHA DE PROVA — um PDF real de várias folhas montado só com a base: marca d'água por baixo em cada folha
// (sheetStart), Code-128 da chave alfanumérica e QR na 1ª, conteúdo que transborda sozinho para novas folhas, e "FOLHA i/N" escrito na
// passada por folha (o TEXTO é da família — aqui o teste faz o papel dela).
import { createPdf, registerFontRoles, drawWatermark, drawBars, drawMatrix, code128Bars, code128Symbols, qrMatrix, cmToPt } from '../pdf'
import { pdfTextByStream, pdfPageCount } from './pdf-oracle'

const KEY = '4126104ABC2DEF000135550010000000071000000075'
const FIXED = new Date('2026-10-17T03:00:00Z')

async function proofSheet(lines: number) {
  const opened: number[] = []
  const w = createPdf({
    marginCm: 0.5, title: 'folha de prova NE-1b', creationDate: FIXED,
    sheetStart: (doc, sheet) => {
      opened.push(sheet)
      drawWatermark(doc, 'SEM VALOR FISCAL', { font: 'Helvetica', sizePt: 50, color: [0, 0, 0, 35] })
    },
  })
  const { doc } = w
  registerFontRoles(doc, { title: 'Times-Bold', content: 'Times-Roman', fixed: 'Courier' })
  doc.font('title').fontSize(12).text('DANFE — folha de prova', cmToPt(0.5), cmToPt(1.5))
  const bars = drawBars(doc, code128Bars(code128Symbols(KEY)), { x: cmToPt(0.5), y: cmToPt(2.5), width: cmToPt(11.5), height: cmToPt(0.8) })
  const qr = drawMatrix(doc, qrMatrix(`https://exemplo.sefaz/consulta?chave=${KEY}`, { ecLevel: 'M' }), { x: cmToPt(17), y: cmToPt(2.5), size: cmToPt(2) })
  doc.font('content').fontSize(9).text('', cmToPt(0.5), cmToPt(5))
  for (let i = 1; i <= lines; i++) doc.text(`item ${i} — ação, ícone, nº, ª, °, §, €`)
  const pdf = await w.end((d, { sheet, total }) => {
    d.font('title').fontSize(10).text(`FOLHA ${sheet}/${total}`, cmToPt(17), cmToPt(0.6), { lineBreak: false })
  })
  return { pdf, opened, bars, qr }
}

describe('NE-1b — folha de prova e passada por folha', () => {
  it('o conteúdo transborda sozinho; cada folha aberta recebe a marca d\'água POR BAIXO e, no fim, "FOLHA i/N" com o total certo', async () => {
    const { pdf, opened, bars, qr } = await proofSheet(160)
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    const total = pdfPageCount(pdf)
    expect(total).toBeGreaterThanOrEqual(3)
    expect(opened).toEqual(Array.from({ length: total }, (_, i) => i + 1))
    const pages = pdfTextByStream(pdf)
    expect(pages).toHaveLength(total)
    pages.forEach((lines, i) => {
      expect(lines[0]).toBe('SEM VALOR FISCAL')                                    // por baixo: 1ª coisa escrita na folha
      expect(lines[lines.length - 1]).toBe(`FOLHA ${i + 1}/${total}`)             // por cima: a passada, com o total
    })
    expect(pages[0]).toContain('DANFE — folha de prova')
    expect(pages.flat().filter(l => l.startsWith('item ')).length).toBe(160)
    expect(pages[0]).toContain('item 1 — ação, ícone, nº, ª, °, §, €')
    expect(bars.moduleCm).toBeGreaterThanOrEqual(0.02)
    expect(qr.moduleCm).toBeGreaterThan(0)
    expect(qr.moduleCm).toBeLessThan(2)
  })

  it('folha única: a passada recebe total 1 (é o que a família de página única afirma)', async () => {
    const totals: number[] = []
    const w = createPdf({ marginCm: 0.2, title: 'uma folha', creationDate: FIXED })
    w.doc.text('só uma')
    await w.end((_d, info) => totals.push(info.total))
    expect(totals).toEqual([1])
  })

  it('a marca d\'água não move a posição de escrita da família', () => {
    const w = createPdf({ marginCm: 1, title: 'posição', creationDate: FIXED })
    const before = [w.doc.x, w.doc.y]
    drawWatermark(w.doc, 'CANCELADA', { font: 'Helvetica', sizePt: 60, color: 'gray', opacity: 0.4 })
    expect([w.doc.x, w.doc.y]).toEqual(before)
  })

  it('a passada que abre folha nova falha alto (o total que ela recebeu teria ficado errado)', async () => {
    const w = createPdf({ marginCm: 1, title: 'passada errada', creationDate: FIXED })
    expect(() => w.end(d => { d.addPage() })).toThrow(/abriu folha nova/)
  })

  it('o documento fecha uma vez só', async () => {
    const w = createPdf({ marginCm: 1, title: 'uma vez', creationDate: FIXED })
    await w.end()
    expect(() => w.end()).toThrow(/já foi fechado/)
  })

  it('papel em cm e paisagem; margens e título validados', async () => {
    const w = createPdf({ paper: { widthCm: 23, heightCm: 33 }, layout: 'landscape', marginCm: { top: 0.2, right: 0.8, bottom: 0.2, left: 0.8 }, title: 'ofício II', creationDate: FIXED })
    expect(w.doc.page.width).toBeCloseTo(cmToPt(33), 3)
    expect(w.doc.page.height).toBeCloseTo(cmToPt(23), 3)
    expect(w.doc.page.margins.left).toBeCloseTo(cmToPt(0.8), 6)
    await w.end()
    expect(() => createPdf({ marginCm: -1, title: 'x' })).toThrow(RangeError)
    expect(() => createPdf({ marginCm: NaN, title: 'x' })).toThrow(RangeError)
    expect(() => createPdf({ marginCm: 1, title: '  ' })).toThrow(RangeError)
    expect(() => createPdf({ marginCm: 1, title: 'x', paper: { widthCm: -2, heightCm: 10 } })).toThrow(RangeError)
  })

  it('com a mesma data, o mesmo conteúdo dá o MESMO PDF (arquivo reproduzível)', async () => {
    const a = (await proofSheet(5)).pdf
    const b = (await proofSheet(5)).pdf
    expect(a.equals(b)).toBe(true)
  })

  it('marca d\'água recusa texto vazio, fonte fora das padrão, tamanho e opacidade inválidos — e conta o que virou "?"', () => {
    const { doc } = createPdf({ marginCm: 1, title: 'marca', creationDate: FIXED })
    const style = { font: 'Helvetica' as const, sizePt: 50, color: 'gray' }
    expect(() => drawWatermark(doc, '   ', style)).toThrow(RangeError)
    expect(() => drawWatermark(doc, 'X', { ...style, font: 'Symbol' as any })).toThrow(RangeError)
    expect(() => drawWatermark(doc, 'X', { ...style, sizePt: 0 })).toThrow(RangeError)
    expect(() => drawWatermark(doc, 'X', { ...style, opacity: 2 })).toThrow(RangeError)
    expect(drawWatermark(doc, 'CANCELADA ✓', style).replaced).toBe(1)
  })
})
