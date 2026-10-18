/// <reference types="jest" />
// NE-1b — Rodada 11 da nfe-api (Valdo 2026-10-18: "Q-NE144 a Q-NE147 segue recomendação"): o comportamento POSITIVO de cada decisão, no PDF real
// (os ataques ficam nos arquivos `adversarial-ne1b-*`).
import { createPdf, writeText, measureText } from '../pdf'
import { pdfContentOps, pdfPageCount, pdfTextRuns, liveContentOps, qDepth } from './pdf-oracle'

const FIXED = new Date('2026-10-17T03:00:00Z')
const ROLES = { title: 'Times-Bold', content: 'Times-Roman' } as const
const lines = (n: number, w = 'linha'): string => Array.from({ length: n }, (_, i) => `${w} ${i + 1}`).join('\n')
const errorOf = (fn: () => unknown): Error | null => { try { fn(); return null } catch (e) { return e as Error } }
const INVALID = /^base de PDF: o documento ficou inválido e não fecha — o sheetStart (falhou|deixou o y fora da área útil).*D-NE144.*\(monte de novo\)$/

describe('D-NE144 — toda falha do sheetStart deixa o documento INVÁLIDO; o end() recusa dizendo a causa (texto da base, nunca a mensagem de quem falhou)', () => {
  const failing: Record<string, (d: PDFKit.PDFDocument) => void> = {
    'erro da própria família': () => { throw new Error('dado-da-familia-que-nao-pode-ecoar') },
    'erro de uso da base (D-NE138)': d => { d.switchToPage(0) },
    'save() sem restore()': d => { d.save() },
    'y fora da área útil': d => { d.y = d.page.height },
  }
  for (const [name, bad] of Object.entries(failing)) {
    it(`${name}: no TRANSBORDO o erro sobe pelo writeText do conteúdo — mesmo engolido, o documento não fecha; a causa não ecoa a mensagem de quem falhou`, () => {
      const w = createPdf({
        marginCm: 1, title: 'D-NE144', creationDate: FIXED, fontRoles: ROLES,
        sheetStart: (d, n) => { writeText(d, 'title', `CAB ${n}`, { x: 40, y: 20, lineBreak: false }); if (n === 2) bad(d); else d.y = 60 },
      })
      const swallowed = errorOf(() => writeText(w.doc, 'content', lines(120, 'item'), { x: 40, sizePt: 9 }))
      expect(swallowed).not.toBeNull()
      expect(liveContentOps(w.doc).map(qDepth)).toEqual([{ final: 0, min: 0 }, { final: 0, min: 0 }])    // a limpeza segue balanceando
      const refused = errorOf(() => w.end())
      expect(refused?.message).toMatch(INVALID)
      expect(refused?.message).not.toContain('dado-da-familia')
      expect(errorOf(() => w.end())?.message).toMatch(INVALID)                                           // sempre — nunca "já foi fechado"
    })
  }

  it('também no addPage EXPLÍCITO da família; sem falha, o mesmo sheetStart fecha normalmente', async () => {
    const bad = createPdf({ marginCm: 1, title: 'x', fontRoles: ROLES, sheetStart: (_d, n) => { if (n === 2) throw new Error('falhou') } })
    expect(errorOf(() => bad.doc.addPage())?.message).toBe('falhou')
    expect(errorOf(() => bad.end())?.message).toMatch(INVALID)
    const good = createPdf({ marginCm: 1, title: 'ok', creationDate: FIXED, fontRoles: ROLES, sheetStart: (d, n) => { writeText(d, 'title', `CAB ${n}`, { x: 40, y: 20, lineBreak: false }) } })
    good.doc.addPage()
    expect(pdfPageCount(await good.end())).toBe(2)
  })
})

describe('D-NE145 — `advance` é o avanço da ÚLTIMA linha (onde o próximo trecho entra)', () => {
  it('texto de 2 linhas: `advance` = a última com os espaços do fim; `width` = a mais larga sem eles', () => {
    const d = createPdf({ marginCm: 1, title: 'D-NE145', fontRoles: ROLES }).doc
    const long = measureText(d, 'content', 'uma linha bem mais comprida', { sizePt: 9 })
    const last = measureText(d, 'content', 'curta ', { sizePt: 9 })
    const both = measureText(d, 'content', 'uma linha bem mais comprida\ncurta ', { sizePt: 9 })
    expect(both.width).toBeCloseTo(long.width, 6)
    expect(both.advance).toBeCloseTo(last.advance, 6)
    expect(both.advance).toBeLessThan(both.width)
  })
})

describe('D-NE146 — toda escrita `lineBreak: false` recusa quebra de linha (com ou sem `width`)', () => {
  it('sem `width` e com `width`: recusado antes de escrever; uma linha passa', async () => {
    const w = createPdf({ marginCm: 1, title: 'D-NE146', creationDate: FIXED, fontRoles: ROLES })
    for (const opts of [{ x: 40, y: 100, lineBreak: false }, { x: 40, y: 100, width: 300, lineBreak: false }]) {
      expect(errorOf(() => writeText(w.doc, 'content', 'AAAA\nB', opts))?.message).toMatch(/não leva quebra de linha \(D-NE146\)/)
      expect(errorOf(() => writeText(w.doc, 'content', 'AAAA\r\nB', opts))?.message).toMatch(/D-NE146/)   // \r\n também (vira \n)
    }
    writeText(w.doc, 'content', 'AAAA B', { x: 40, y: 100, lineBreak: false })
    expect(pdfTextRuns(pdfContentOps(await w.end())[0]).map(r => r.text)).toEqual(['AAAA B'])
  })
})

describe('D-NE147 — texto VAZIO sem `continued` não chama o pdfkit (a medida 0 vale)', () => {
  it('vazio no pé exato (y = pé − 0): nenhuma folha nova, nada escrito; o x/y ficam como informados', async () => {
    const w = createPdf({ marginCm: 1, title: 'D-NE147', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    expect(measureText(d, 'content', '', { width: 300 }).height).toBe(0)
    writeText(d, 'content', 'antes', { x: 40, y: 100 })
    d.save(); d.rect(40, 600, 300, d.page.maxY() - 600).clip()
    writeText(d, 'content', '', { x: 41, y: d.page.maxY(), width: 300 })
    d.restore()
    expect({ sheets: d.bufferedPageRange().count, x: d.x, y: d.y }).toEqual({ sheets: 1, x: 41, y: d.page.maxY() })
    expect(pdfTextRuns(pdfContentOps(await w.end())[0]).map(r => r.text)).toEqual(['antes'])
  })

  it('com a cadeia ABERTA o vazio FECHA a cadeia (D-NE152 — pela base); `continued: true` vazio abre cadeia', async () => {
    const w = createPdf({ marginCm: 1, title: 'D-NE147 cadeia', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc as unknown as PDFKit.PDFDocument & { _wrapper: unknown }
    writeText(d, 'content', 'Obs: ', { x: 40, y: 100, width: 300, continued: true })
    expect(d._wrapper).toBeTruthy()
    writeText(d, 'content', '')
    expect(d._wrapper).toBeNull()
    writeText(d, 'content', '', { x: 40, y: 200, width: 300, continued: true })
    expect(d._wrapper).toBeTruthy()
    writeText(d, 'content', 'fim')
    expect(pdfTextRuns(pdfContentOps(await w.end())[0]).map(r => r.text)).toEqual(expect.arrayContaining(['Obs: ', 'fim']))
  })
})

describe('D-NE152 — o vazio que fecha a cadeia aberta deixa x/y onde o fechamento com TEXTO deixaria (a base fecha, sem chamar o pdfkit)', () => {
  type Close = { role: 'title' | 'content'; sizePt?: number; lineGap?: number; paragraphGap?: number }
  const chainOpts: Record<string, number>[] = [{}, { lineGap: 2 }, { paragraphGap: 5 }, { lineGap: 1.5, paragraphGap: 3 }]
  const closes: Close[] = [{ role: 'content' }, { role: 'title', sizePt: 12 }, { role: 'content', sizePt: 7, lineGap: 4 }, { role: 'title', paragraphGap: 2 }]
  const after = (closeText: string, chain: Record<string, number>, close: Close): { x: number; y: number; open: unknown } => {
    const d = createPdf({ marginCm: 1, title: 'D-NE152', fontRoles: ROLES }).doc as PDFKit.PDFDocument & { _wrapper: unknown }
    writeText(d, 'content', 'INF. COMPL.: ', { x: 40, y: 100, width: 300, continued: true, sizePt: 9, ...chain })
    const { role, ...opts } = close
    writeText(d, role, closeText, opts)
    return { x: d.x, y: d.y, open: d._wrapper }
  }
  for (const chain of chainOpts) {
    for (const close of closes) {
      it(`cadeia ${JSON.stringify(chain)} fechada por ${JSON.stringify(close)}: vazio = texto`, () => {
        const withEmpty = after('', chain, close)
        const withText = after('X', chain, close)
        expect(withEmpty.open).toBeNull()
        expect(withEmpty.x).toBe(withText.x)
        expect(withEmpty.y).toBeCloseTo(withText.y, 9)
      })
    }
  }

  it('o próximo bloco só com x cai na linha de baixo, como depois do fechamento com texto; no pé, nenhuma folha nova', async () => {
    const w = createPdf({ marginCm: 1, title: 'D-NE152 bloco', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    writeText(d, 'content', 'INF. COMPL.: ', { x: 40, y: 100, width: 300, continued: true })
    writeText(d, 'content', '')
    writeText(d, 'content', 'RESERVADO AO FISCO', { x: 40 })
    const m = measureText(d, 'content', 'Obs: ', { sizePt: 7, width: 300 })
    writeText(d, 'content', 'Obs: ', { x: 40, y: d.page.maxY() - m.height, width: 300, sizePt: 7, continued: true })
    writeText(d, 'title', '', { sizePt: 12 })
    expect(d.bufferedPageRange().count).toBe(1)
    const runs = pdfTextRuns(pdfContentOps(await w.end())[0])
    expect(runs.map(r => r.text)).toEqual(['INF. COMPL.: ', 'RESERVADO AO FISCO', 'Obs: '])
    expect(runs[1].yPdf).toBeLessThan(runs[0].yPdf - 1)
  })
})
