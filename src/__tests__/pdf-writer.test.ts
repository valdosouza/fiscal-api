/// <reference types="jest" />
// NE-1b (D-NE117/D-NE122/D-NE125): a FOLHA DE PROVA — um PDF real de várias folhas montado só com a base: marca d'água por baixo em cada folha
// (sheetStart), Code-128 da chave alfanumérica e QR na 1ª, conteúdo que transborda sozinho para novas folhas, e "FOLHA i/N" escrito na
// passada por folha (o TEXTO é da família — aqui o teste faz o papel dela). Gates da NE-1b (2026-10-17): a 1ª versão conferia só "total ≥ 3"
// e o texto — a marca vazava o estilo para o conteúdo e o PDF saía com 15 folhas ilegíveis; agora o teste confere o LAYOUT (total igual ao da
// mesma folha sem marca), a FONTE, o CORPO e a COR de cada trecho, e lê de volta as barras e o QR do próprio PDF.
import {
  createPdf, writeText, drawWatermark, drawBars, drawMatrix, code128Bars, code128Symbols, qrMatrix, cmToPt,
} from '../pdf'
import { pdfTextByStream, pdfPageCount, pdfContentOps, pdfRects, pdfTextRuns, decodeCode128, readQr } from './pdf-oracle'

const KEY = '4126104ABC2DEF000135550010000000071000000075'
const QR_URL = `https://exemplo.sefaz/consulta?chave=${KEY}`
const FIXED = new Date('2026-10-17T03:00:00Z')
const ROLES = { title: 'Times-Bold', content: 'Times-Roman', fixed: 'Courier' } as const
const BARS_BOX = { x: cmToPt(0.5), y: cmToPt(2.5), width: cmToPt(11.5), height: cmToPt(0.8) }
const QR_BOX = { x: cmToPt(17), y: cmToPt(2.5), size: cmToPt(2) }
const MARK = { font: 'Helvetica' as const, sizePt: 50, color: [0, 0, 0, 35] as const, opacity: 0.4 }

async function proofSheet(lines: number, withMark = true) {
  const opened: number[] = []
  const w = createPdf({
    marginCm: 0.5, title: 'folha de prova NE-1b', creationDate: FIXED, fontRoles: ROLES,
    sheetStart: (doc, sheet) => {
      opened.push(sheet)
      if (withMark) drawWatermark(doc, 'SEM VALOR FISCAL', MARK)
    },
  })
  const { doc } = w
  writeText(doc, 'title', 'DANFE — folha de prova', { x: cmToPt(0.5), y: cmToPt(1.5), sizePt: 12 })
  const bars = drawBars(doc, code128Bars(code128Symbols(KEY)), BARS_BOX)
  const qr = drawMatrix(doc, qrMatrix(QR_URL, { ecLevel: 'M' }), QR_BOX)
  writeText(doc, 'content', '', { x: cmToPt(0.5), y: cmToPt(5), sizePt: 9 })
  for (let i = 1; i <= lines; i++) writeText(doc, 'content', `item ${i} — ação, ícone, nº, ª, °, §, €`)
  const pdf = await w.end((d, { sheet, total }) => {
    writeText(d, 'title', `FOLHA ${sheet}/${total}`, { x: cmToPt(17), y: cmToPt(0.6), sizePt: 10, lineBreak: false })
  })
  return { pdf, opened, bars, qr }
}

describe('NE-1b — folha de prova e passada por folha', () => {
  it('a marca d\'água NÃO muda o layout: mesmo total da folha sem marca; cada folha aberta recebe a marca POR BAIXO e, no fim, "FOLHA i/N" por cima', async () => {
    const { pdf, opened } = await proofSheet(160)
    const control = await proofSheet(160, false)
    const total = pdfPageCount(pdf)
    expect(total).toBe(pdfPageCount(control.pdf))
    expect(total).toBe(3)
    expect(opened).toEqual([1, 2, 3])
    const pages = pdfTextByStream(pdf)
    expect(pages).toHaveLength(total)
    pages.forEach((lines, i) => {
      expect(lines[0]).toBe('SEM VALOR FISCAL')                                    // por baixo: 1ª coisa escrita na folha
      expect(lines[lines.length - 1]).toBe(`FOLHA ${i + 1}/${total}`)             // por cima: a passada, com o total
    })
    expect(pages[0]).toContain('DANFE — folha de prova')
    expect(pages.flat().filter(l => l.startsWith('item ')).length).toBe(160)
    expect(pages[0]).toContain('item 1 — ação, ícone, nº, ª, °, §, €')
  })

  it('FONTE, CORPO e COR de cada trecho: a marca é o único trecho a 50 pt, cinza e translúcido; todo item sai em 9 pt, opaco, na cor da família — em TODAS as folhas', async () => {
    const pages = pdfContentOps((await proofSheet(160)).pdf)
    expect(pages).toHaveLength(3)
    const items = pages.flatMap(ops => pdfTextRuns(ops).filter(r => r.text.startsWith('item ')))
    expect(items).toHaveLength(160)
    expect([...new Set(items.map(r => `${r.size}|${r.color}|${r.translucent}`))]).toEqual(['9||false'])
    expect(new Set(items.map(r => r.font)).size).toBe(1)
    for (const ops of pages) {
      const runs = pdfTextRuns(ops)
      const marks = runs.filter(r => r.text === 'SEM VALOR FISCAL')
      expect(marks.map(r => `${r.size}|${r.color}|${r.translucent}`)).toEqual(['50|0 0 0 0.35|true'])
      expect(runs.filter(r => r.size === 50 || r.translucent || r.color === '0 0 0 0.35')).toEqual(marks)
    }
  })

  it('as barras e o QR são lidos de volta do PRÓPRIO PDF (retângulos gravados na folha 1): a chave alfanumérica e a URL, exatas', async () => {
    const { pdf, bars, qr } = await proofSheet(5)
    const r = pdfRects(pdfContentOps(pdf)[0])
    const barRects = r.filter(q => Math.abs(q[1] - BARS_BOX.y) < 1e-3 && Math.abs(q[3] - BARS_BOX.height) < 1e-3).sort((a, b) => a[0] - b[0])
    const m = bars.modulePt
    const widths: number[] = []
    barRects.forEach((q, i) => {
      widths.push(Math.round(q[2] / m))
      if (i < barRects.length - 1) widths.push(Math.round((barRects[i + 1][0] - (q[0] + q[2])) / m))
    })
    expect(decodeCode128(widths).text).toBe(KEY)
    expect(bars.moduleCm).toBeGreaterThanOrEqual(0.02)
    const size = Math.round(QR_BOX.size / qr.modulePt)
    const grid = Array.from({ length: size }, () => Array<boolean>(size).fill(false))
    for (const [x, y, wd] of r.filter(q => q[0] >= QR_BOX.x - 1e-3 && q[1] >= QR_BOX.y - 1e-3 && q[1] < QR_BOX.y + QR_BOX.size)) {
      const row = Math.round((y - QR_BOX.y) / qr.modulePt)
      const c0 = Math.round((x - QR_BOX.x) / qr.modulePt)
      for (let c = c0; c < c0 + Math.round(wd / qr.modulePt); c++) grid[row][c] = true
    }
    expect(readQr({ size, rows: grid })).toBe(QR_URL)
  })

  it('D-NE125 — contrato do sheetStart: papéis de fonte já na 1ª folha; o estilo que ELE mexe não vaza; o `y` em que ele para é o começo do conteúdo; o `x` volta', async () => {
    const reserve = cmToPt(6)
    const w = createPdf({
      marginCm: 1, title: 'cabeçalho repetido', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (doc, sheet) => {
        writeText(doc, 'title', `CABEÇALHO ${sheet}`, { x: 300, y: cmToPt(1), sizePt: 30 })   // papel 'title' já existe na folha 1
        doc.fillColor('red').fontSize(40)
        doc.y = reserve
      },
    })
    writeText(w.doc, 'content', Array.from({ length: 140 }, (_, i) => `linha ${i + 1}`).join('\n'), { sizePt: 9 })
    const pdf = await w.end()
    const pages = pdfContentOps(pdf)
    expect(pages.length).toBeGreaterThanOrEqual(2)
    const height = 841.89
    for (const [i, ops] of pages.entries()) {
      const runs = pdfTextRuns(ops)
      expect(runs[0].text).toBe(`CABEÇALHO ${i + 1}`)
      const lines = runs.filter(r => r.text.startsWith('linha '))
      expect(lines.length).toBeGreaterThan(0)
      expect([...new Set(lines.map(r => `${r.size}|${r.color}`))]).toEqual(['9|'])                 // nem o vermelho nem o 40 do sheetStart
      expect(Math.min(...lines.map(r => height - r.yPdf))).toBeGreaterThanOrEqual(reserve)       // começa abaixo do espaço reservado
      expect(Math.min(...lines.map(r => r.x))).toBeCloseTo(cmToPt(1), 3)                         // x da margem, não o 300 do cabeçalho
    }
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

  it('erro de USO lança na hora (contrato do escritor): a passada que abre folha nova; fechar duas vezes; sheetStart/passada assíncronos; folhas já despejadas', async () => {
    const a = createPdf({ marginCm: 1, title: 'passada errada', creationDate: FIXED })
    expect(() => a.end(d => { d.addPage() })).toThrow(/abriu folha nova/)
    const b = createPdf({ marginCm: 1, title: 'uma vez', creationDate: FIXED })
    await b.end()
    expect(() => b.end()).toThrow(/já foi fechado/)
    expect(() => createPdf({ marginCm: 1, title: 'assíncrono', sheetStart: (async () => { /* nada */ }) as any })).toThrow(/síncrono/)
    const c = createPdf({ marginCm: 1, title: 'passada assíncrona', creationDate: FIXED })
    expect(() => c.end((async () => { /* nada */ }) as any)).toThrow(/síncrona/)
    const d = createPdf({ marginCm: 1, title: 'despejadas', creationDate: FIXED })
    d.doc.addPage(); d.doc.flushPages(); d.doc.addPage()
    expect(() => d.end()).toThrow(/despejadas/)
  })

  it('papel em cm e paisagem; margens, título e data validados', async () => {
    const w = createPdf({ paper: { widthCm: 23, heightCm: 33 }, layout: 'landscape', marginCm: { top: 0.2, right: 0.8, bottom: 0.2, left: 0.8 }, title: 'ofício II', creationDate: FIXED })
    expect(w.doc.page.width).toBeCloseTo(cmToPt(33), 3)
    expect(w.doc.page.height).toBeCloseTo(cmToPt(23), 3)
    expect(w.doc.page.margins.left).toBeCloseTo(cmToPt(0.8), 6)
    await w.end()
    expect(() => createPdf({ marginCm: -1, title: 'x' })).toThrow(RangeError)
    expect(() => createPdf({ marginCm: NaN, title: 'x' })).toThrow(RangeError)
    expect(() => createPdf({ marginCm: 1, title: '  ' })).toThrow(RangeError)
    expect(() => createPdf({ marginCm: 1, title: 'x', paper: { widthCm: -2, heightCm: 10 } })).toThrow(RangeError)
    expect(() => createPdf({ marginCm: 1, title: 'x', creationDate: new Date('inválida') })).toThrow(RangeError)
  })

  it('com a mesma data, o mesmo conteúdo dá o MESMO PDF (arquivo reproduzível)', async () => {
    const a = (await proofSheet(5)).pdf
    const b = (await proofSheet(5)).pdf
    expect(a.equals(b)).toBe(true)
  })

  it('marca d\'água recusa texto vazio, fonte fora das padrão, tamanho, ângulo, cor e opacidade inválidos — e conta o que virou "?"', () => {
    const { doc } = createPdf({ marginCm: 1, title: 'marca', creationDate: FIXED })
    const style = { font: 'Helvetica' as const, sizePt: 50, color: 'gray' }
    expect(() => drawWatermark(doc, '   ', style)).toThrow(RangeError)
    expect(() => drawWatermark(doc, 'X', { ...style, font: 'Symbol' as any })).toThrow(RangeError)
    expect(() => drawWatermark(doc, 'X', { ...style, sizePt: 0 })).toThrow(RangeError)
    expect(() => drawWatermark(doc, 'X', { ...style, angleDeg: NaN })).toThrow(RangeError)
    expect(() => drawWatermark(doc, 'X', { ...style, color: 'cinza' })).toThrow(RangeError)
    expect(() => drawWatermark(doc, 'X', { ...style, opacity: 2 })).toThrow(RangeError)
    expect(drawWatermark(doc, 'CANCELADA ✓', style).replaced).toBe(1)
  })

  it('marca d\'água enorme é UMA linha: não quebra nem abre folha (o que passa da folha fica fora dela)', async () => {
    const w = createPdf({ marginCm: 0.5, title: 'enorme', creationDate: FIXED, sheetStart: d => { drawWatermark(d, 'SEM VALOR FISCAL', { font: 'Helvetica', sizePt: 400, color: 'gray' }) } })
    const page = w.doc.page
    drawWatermark(w.doc, 'CANCELADA', { font: 'Helvetica', sizePt: 300, color: 'gray' })
    expect([w.doc.bufferedPageRange().count, w.doc.page === page]).toEqual([1, true])
    expect(pdfPageCount(await w.end())).toBe(1)
  })
})
