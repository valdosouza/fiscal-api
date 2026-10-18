/// <reference types="jest" />
// NE-1b — Rodada 10 da nfe-api (Valdo 2026-10-17: "Q-NE138 a Q-NE143 segue recomendação"): o comportamento POSITIVO de cada decisão, provado no
// PDF real (os ataques ficam nos arquivos `adversarial-ne1b-*`).
import { createPdf, writeText, measureText } from '../pdf'
import { pdfContentOps, pdfPageCount, pdfTextRuns } from './pdf-oracle'

const FIXED = new Date('2026-10-17T03:00:00Z')
const ROLES = { title: 'Times-Bold', content: 'Times-Roman' } as const
const lines = (n: number, w = 'linha'): string => Array.from({ length: n }, (_, i) => `${w} ${i + 1}`).join('\n')
const qBalance = (ops: string): { final: number; min: number } => {
  let depth = 0
  let min = 0
  for (const raw of ops.split('\n')) {
    const l = raw.trim()
    if (l === 'q') depth++
    else if (l === 'Q') { depth--; min = Math.min(min, depth) }
  }
  return { final: depth, min }
}
const errorOf = (fn: () => unknown): Error | null => { try { fn(); return null } catch (e) { return e as Error } }

describe('D-NE138 — trocar de folha com save() aberto é erro de uso; dentro do sheetStart e da passada a folha é a deles', () => {
  it('no nível de cima: voltar à folha 1 SEM save() aberto (os totais depois do transbordo) é livre; COM save() aberto é recusado antes de trocar', async () => {
    const w = createPdf({ marginCm: 1, title: 'D-NE138', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    writeText(d, 'content', lines(120, 'item'), { x: 40, sizePt: 9 })
    expect(d.bufferedPageRange().count).toBe(2)
    d.save(); d.rect(40, 40, 100, 20).clip()
    expect(errorOf(() => d.switchToPage(0))?.message).toMatch(/^base de PDF: há save\(\) aberto — feche com restore\(\) antes de trocar de folha.*D-NE138/)
    expect(d.bufferedPageRange().count).toBe(2)
    d.restore()
    d.switchToPage(0)                                                                       // sem save() aberto: livre
    writeText(d, 'title', 'TOTAL 1.234,56', { x: 400, y: 40, width: 150, align: 'right', lineBreak: false })
    d.switchToPage(1)
    const pdf = await w.end((dd, i) => { writeText(dd, 'title', `FOLHA ${i.sheet}/${i.total}`, { x: 450, y: 20, lineBreak: false, sizePt: 8 }) })
    const pages = pdfContentOps(pdf)
    expect(pdfPageCount(pdf)).toBe(2)
    expect(pages.map(qBalance)).toEqual([{ final: 0, min: 0 }, { final: 0, min: 0 }])
    expect(pdfTextRuns(pages[0]).map(r => r.text)).toEqual(expect.arrayContaining(['TOTAL 1.234,56', 'FOLHA 1/2']))
  })

  it('dentro do sheetStart: switchToPage é barrado NA HORA, com a mensagem dele; o documento segue e FECHA balanceado', async () => {
    const w = createPdf({
      marginCm: 1, title: 'D-NE138 isolado', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => { writeText(d, 'title', `CAB ${n}`, { x: 40, y: 20, lineBreak: false }); if (n === 2) d.switchToPage(0); d.y = 60 },
    })
    const e = errorOf(() => w.doc.addPage())
    expect(e?.message).toMatch(/^base de PDF: o sheetStart trocou de folha \(switchToPage\).*D-NE138/)
    writeText(w.doc, 'content', 'corpo da folha 2', { x: 40, y: 100 })
    const pdf = await w.end((dd, i) => { writeText(dd, 'title', `FOLHA ${i.sheet}/${i.total}`, { x: 450, y: 20, lineBreak: false, sizePt: 8 }) })
    expect(pdfPageCount(pdf)).toBe(2)
    expect(pdfContentOps(pdf).map(qBalance)).toEqual([{ final: 0, min: 0 }, { final: 0, min: 0 }])
  })

  it('dentro da passada: switchToPage é barrado NA HORA, com a mensagem dela', async () => {
    const w = createPdf({ marginCm: 1, title: 'D-NE138 passada', creationDate: FIXED, fontRoles: ROLES })
    writeText(w.doc, 'content', lines(120, 'item'), { x: 40, sizePt: 9 })
    let passError: Error | null = null
    try { await w.end(dd => { dd.switchToPage(0) }) } catch (err) { passError = err as Error }
    expect(passError?.message).toMatch(/^base de PDF: a passada por folha trocou de folha \(switchToPage\).*D-NE138/)
  })
})

describe('D-NE140 — o bloco posto EXATAMENTE onde a medida diz que cabe não abre folha', () => {
  it('VARREDURA (gates R10-M1/socrático M1): 3 fontes × corpos 5–12 × cursor da medida no topo/meio/baixo × 2 margens — 1 linha no pé exato (y = pé − altura medida), com o recorte da família aberto: sempre na folha e o documento FECHA', async () => {
    const roles = { title: 'Times-Bold', content: 'Times-Roman', fixed: 'Courier' } as const
    const failures: string[] = []
    for (const marginCm of [0.7, 1]) {
      for (const role of ['title', 'content', 'fixed'] as const) {
        for (let sizePt = 5; sizePt <= 12; sizePt += 0.5) {
          for (const cursor of [0, 333.7, 504.2]) {
            const w = createPdf({ marginCm, title: 'D-NE140', creationDate: FIXED, fontRoles: roles })
            const d = w.doc
            if (cursor) d.y = cursor                                                  // a medida feita onde o conteúdo parou (o y entra na conta)
            const m = measureText(d, role, 'ultima linha do quadro', { sizePt, width: 300 })
            const y = d.page.maxY() - m.height
            d.save(); d.rect(40, y - 50, 300, 50 + m.height).clip()
            writeText(d, role, 'ultima linha do quadro', { x: 40, y, width: 300, sizePt })
            d.restore()
            const sheets = d.bufferedPageRange().count
            const closed = await w.end().then(pdf => pdfPageCount(pdf), (e: Error) => e.message)
            if (sheets !== 1 || closed !== 1) failures.push(`${marginCm}/${role}/${sizePt}/${cursor}: ${sheets} folhas, ${closed}`)
          }
        }
      }
    }
    expect(failures).toEqual([])
  })

  it('com `height` = a altura medida da 1ª linha, a linha é escrita (conhecimento negativo: com `height` o pdfkit não perde a linha — a D-NE140 não age)', async () => {
    const w = createPdf({ marginCm: 1, title: 'D-NE140 height', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    for (const [i, y] of [100.1, 333.37, 517.03, 700.71].entries()) {
      const m = measureText(d, 'content', `caixa ${i}`, { sizePt: 9, width: 200 })
      writeText(d, 'content', `caixa ${i}`, { x: 40, y, width: 200, height: m.height, sizePt: 9 })
    }
    const pdf = await w.end()
    expect(pdfTextRuns(pdfContentOps(pdf)[0]).map(r => r.text)).toEqual(['caixa 0', 'caixa 1', 'caixa 2', 'caixa 3'])
  })

  it('o que NÃO cabe de verdade continua com o pdfkit: 1 pt abaixo do pé exato, a linha vai para a folha seguinte', () => {
    const w = createPdf({ marginCm: 1, title: 'D-NE140 nao cabe', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    const m = measureText(d, 'content', 'nao cabe', { sizePt: 9, width: 300 })
    writeText(d, 'content', 'nao cabe', { x: 40, y: d.page.maxY() - m.height + 1, width: 300, sizePt: 9 })
    expect(d.bufferedPageRange().count).toBe(2)
  })
})

describe('D-NE141 — os espaços do fim (U+0020 e NBSP) fora na medida e na linha única; `advance` para juntar trechos', () => {
  it('a largura medida é a que a linha única desenha (com espaços e NBSP no fim); `advance` conta os espaços', async () => {
    const w = createPdf({ marginCm: 1, title: 'D-NE141', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    const bare = measureText(d, 'content', 'VALOR 1.234,56', { sizePt: 9 })
    for (const tail of ['   ', ' ', '   ']) {
      const m = measureText(d, 'content', `VALOR 1.234,56${tail}`, { sizePt: 9 })
      expect(m.width).toBeCloseTo(bare.width, 6)
      expect(m.advance).toBeGreaterThan(bare.advance)
    }
    expect(measureText(d, 'content', ' ', { sizePt: 9 })).toEqual(expect.objectContaining({ width: 0 }))
    expect(measureText(d, 'content', ' ', { sizePt: 9 }).advance).toBeGreaterThan(0)
    writeText(d, 'content', 'VALOR 1.234,56  ', { x: 300, y: 100, width: 120, align: 'right', lineBreak: false, sizePt: 9 })
    const runs = pdfTextRuns(pdfContentOps(await w.end())[0])
    expect(runs.map(r => r.text)).toEqual(['VALOR 1.234,56'])
    expect(runs[0].x).toBeCloseTo(300 + 120 - bare.width, 4)
  })

  it('o caminho da D-NE136 pelo `advance`: rótulo e número na mesma linha, com o espaço entre eles', async () => {
    const w = createPdf({ marginCm: 1, title: 'D-NE141 advance', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    const label = measureText(d, 'title', 'CNPJ: ', { x: 40, sizePt: 9 })
    writeText(d, 'title', 'CNPJ: ', { x: 40, y: 100, lineBreak: false, sizePt: 9 })
    writeText(d, 'content', '12.345.678/0001-90', { x: 40 + label.advance, y: 100, lineBreak: false, sizePt: 9 })
    const runs = pdfTextRuns(pdfContentOps(await w.end())[0])
    expect(runs.map(r => r.text)).toEqual(['CNPJ: ', '12.345.678/0001-90'])
    expect(runs[1].x - runs[0].x).toBeCloseTo(label.advance, 4)
    expect(label.advance).toBeGreaterThan(label.width)
  })
})

describe('D-NE143 — `continued: false` (o padrão) passa com lineBreak: false; só `true` é recusado', () => {
  it('aceito na linha única e na escrita sem quebra; o x volta (D-NE133); `true` segue recusado pela D-NE136', async () => {
    const w = createPdf({ marginCm: 1, title: 'D-NE143', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    writeText(d, 'content', 'A', { x: 300, y: 100, width: 50, lineBreak: false, continued: false })
    writeText(d, 'content', 'B', { x: 300, y: 120, lineBreak: false, continued: false })
    expect(d.x).toBe(300)
    expect(errorOf(() => writeText(d, 'content', 'C', { x: 300, y: 140, lineBreak: false, continued: true }))?.message).toMatch(/D-NE136/)
    expect(pdfTextRuns(pdfContentOps(await w.end())[0]).map(r => r.text)).toEqual(['A', 'B'])
  })
})
