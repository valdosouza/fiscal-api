/// <reference types="jest" />
// GATE ADVERSARIAL do DELTA c99309e..2e16ea6 da NE-1b (revisor independente, 2026-10-18 — skill `testar-adversarial.md`): ataques à Rodada 10
// (D-NE138 — `guardSheetSwitch` no nível de cima e a guarda do `switchToPage` dentro do `isolated`; D-NE140 — `fitFloat32`; D-NE141 — espaços do fim
// U+0020/NBSP na medida e o `advance`; D-NE143 — `continued: false`) e às correções R9-L1/R9-L2 (`useStandardFont`, protótipo da fonte-padrão) e
// do achado 1 do gate anterior (guardas, entrada, saída e limpeza do isolado pela ORIGINAL — `rawOf`). Os gates anteriores estão em
// `adversarial-ne1b-gate`, `-delta-gate`, `-r7-gate`, `-final-gate` e `-r9-gate`; os positivos da rodada em `pdf-rodada10` (não repetidos aqui).
//
// Ataque que RESISTIU fica como teste verde; achado CONFIRMADO fica como `it.failing` com o rótulo "[ACHADO <SEVERIDADE>]" — o corpo afirma o
// comportamento CORRETO, então quando a correção entrar o `it.failing` passa a FALHAR e vira `it` comum.
import fs from 'fs'
import path from 'path'
import { createPdf, writeText, measureText, drawBars, drawWatermark, code128Bars, code128Symbols, cmToPt } from '../pdf'
import { pdfContentOps, pdfTextRuns, pdfPageCount } from './pdf-oracle'

const FIXED = new Date('2026-10-18T03:00:00Z')
const ROLES = { title: 'Times-Bold', content: 'Times-Roman', fixed: 'Courier' } as const
const BARS = code128Bars(code128Symbols('41261040001355500100000000710000000075'))
const BOX = { x: 30, y: 30, width: cmToPt(11.5), height: 12 }
const lines = (n: number, p = 'linha') => Array.from({ length: n }, (_, i) => `${p} ${i + 1}`).join('\n')
const internals = (doc: PDFKit.PDFDocument) => doc as unknown as Record<string | symbol, any>
const fontsOf = (pdf: Buffer) => [...pdf.toString('latin1').matchAll(/\/BaseFont \/(\S+)/g)].map(m => m[1])
const errorOf = (fn: () => unknown): Error | null => { try { fn(); return null } catch (e) { return e as Error } }
const sheetsOf = (doc: PDFKit.PDFDocument): number => internals(doc)._pageBuffer.length
const TOP_REFUSAL = /^base de PDF: há save\(\) aberto — feche com restore\(\) antes de trocar de folha \(switchToPage — D-NE138\)$/
/** A guarda em vigor no `switchToPage` é a do NÍVEL DE CIMA (D-NE138) — pelo comportamento: com `save()` aberto recusa com a mensagem dela (a do isolado é outra). */
const topGuardActive = (doc: PDFKit.PDFDocument): boolean => {
  const here = internals(doc)._pageBuffer.indexOf(doc.page) + internals(doc)._pageBufferStart
  doc.save()
  const message = errorOf(() => doc.switchToPage(here))?.message ?? 'ACEITO'
  doc.restore()
  return TOP_REFUSAL.test(message)
}
/** Nenhuma guarda do `isolated` sobrou: save/restore do protótipo, `switchToPage` = a guarda do nível de cima (D-NE138) e a pilha vazia. */
const clean = (doc: PDFKit.PDFDocument) => ({
  ownSave: Object.prototype.hasOwnProperty.call(doc, 'save'), ownRestore: Object.prototype.hasOwnProperty.call(doc, 'restore'),
  stack: internals(doc)._ctmStack.length, topGuard: topGuardActive(doc),
})
const CLEAN = { ownSave: false, ownRestore: false, stack: 0, topGuard: true }

/** Como o LEITOR vê a folha: `Q` órfão ignorado; recorte vigente por trecho; profundidade final e mínima do q/Q (o oráculo dos gates R7/final/R9). */
function viewer(ops: string): { runs: { text: string; clipped: boolean }[]; final: number; min: number } {
  let clipped = false
  const stack: boolean[] = []
  const runs: { text: string; clipped: boolean }[] = []
  let depth = 0, min = 0
  for (const raw of ops.split('\n')) {
    const l = raw.trim()
    if (l === 'q') { stack.push(clipped); depth++ }
    else if (l === 'Q') { depth--; min = Math.min(min, depth); const popped = stack.pop(); if (popped !== undefined) clipped = popped }
    else if (/^W\*? n$/.test(l)) clipped = true
    else if (/T[Jj]$/.test(l)) runs.push({ text: [...l.matchAll(/<([0-9a-fA-F]+)>/g)].map(h => Buffer.from(h[1], 'hex').toString('latin1')).join(''), clipped })
  }
  return { runs, final: depth, min }
}
const balanceOf = (pdf: Buffer) => pdfContentOps(pdf).map(o => { const v = viewer(o); return { final: v.final, min: v.min } })
const balanced = (pdf: Buffer) => { const b = balanceOf(pdf); return b.length > 0 && b.every(p => p.final === 0 && p.min === 0) }

/** O piso float32 do pdfkit (`PDFNumber`) — para provar a correção sugerida do R10-M1 sem tocar no código de produção. */
const floor32 = (n: number): number => {
  const f = Math.fround(n)
  if (f <= n) return f
  const a = new Float32Array([n]); const u = new Uint32Array(a.buffer)
  if (n <= 0) u[0] += 1; else u[0] -= 1
  return a[0]
}
/** O cursor em y = 504,2 (depois do quadro de itens) — valor exato do caso reproduzido (margem 1 cm, Times-Roman 7 pt). */
const AFTER_ITEMS = 504.2

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ACHADOS CONFIRMADOS
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate R10 — [ACHADO MEDIUM] R10-M1: a D-NE140 recusa compensar quando `y + altura da linha` passa do pé EXATO por 1 ulp de float64 — a linha posta em `pé − altura medida` ainda abre folha', () => {
  /**
   * `fitFloat32` só compensa quando `nextY ∈ (pé32, pé]` e trata `nextY > pé` como "não cabe de verdade" — sem folga NENHUMA. Mas `y = pé − h` e
   * `y + lh` são contas em float64: `(pé − lh) + lh` passa do pé por 1 ulp (1,1e-13 pt) em parte das combinações, e a altura medida pelo
   * `heightOfString` (`(y_medida + lh) − y_medida`) sai 1–3 ulps MENOR que `lh` quando a medida é feita com o cursor no meio da folha (o caso real —
   * a família mede depois do conteúdo). Varredura: 74 de 4.242 combinações (margens 0,5–2,54 cm × retrato/paisagem × corpos 5–30 × 3 fontes) com a
   * medida no topo; ~11 % dos corpos com a medida em y = 333,7. Caso comum: A4, margem 0,7 cm, Times-Bold 8,5 pt. Efeito: sem recorte, folha nova
   * com a linha órfã (e o "Folha n/N" errado); COM o recorte da família aberto, a D-NE134 deixa o documento SEM CONSERTO — exatamente o que a
   * Q-NE140 (a) decidiu fechar, e a doc do `measureText` agora PROMETE "um bloco posto exatamente em pé − altura medida cabe" (a orientação de folga
   * de 0,01 pt foi retirada). Caminho pela superfície pública, com valores plausíveis — MEDIUM (não HIGH: determinístico por layout/dado, erro
   * legível, nada corrompido em silêncio quando há recorte). Correção sugerida: folga relativa na conferência "não cabe de verdade" — p.ex.
   * `if (nextY - foot > Math.abs(foot) * 2 ** -40 || nextY <= foot32) return null` (7e-10 pt no A4 — invisível; o 1e-6 pt "a mais" segue indo
   * para a folha seguinte); o laço já sobe o que falta até `pé32`.
   */
  const footCase = async (marginCm: number, role: 'title' | 'content', sizePt: number, measuredAt?: number) => {
    const w = createPdf({ marginCm, title: 'R10M1', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    if (measuredAt !== undefined) d.y = measuredAt                                       // o cursor depois do quadro de itens
    const text = 'linha'
    const m = measureText(d, role, text, { sizePt, width: 300 })
    const y = d.page.maxY() - m.height
    d.save(); d.rect(40, y - 50, 300, 50 + m.height).clip()
    const error = errorOf(() => writeText(d, role, text, { x: 40, y, width: 300, sizePt }))
    d.restore()
    let closed: Error | null = null
    let pdf: Buffer | null = null
    try { pdf = await w.end() } catch (e) { closed = e as Error }
    return { error: error?.message ?? null, closed: closed?.message ?? null, pages: pdf ? pdfPageCount(pdf) : null, text: pdf ? pdfTextRuns(pdfContentOps(pdf)[0]).map(r => r.text) : null }
  }

  it('[CORRIGIDO — ACHADO MEDIUM] R10-M1a — A4, margem 0,7 cm, Times-Bold 8,5 pt (medida no topo): com o recorte aberto no pé exato o documento NÃO fecha', async () => {
    expect(await footCase(0.7, 'title', 8.5)).toEqual({ error: null, closed: null, pages: 1, text: ['linha'] })      // hoje: D-NE134 e o end() recusa
  })

  it('[CORRIGIDO — ACHADO MEDIUM] R10-M1b — o cenário do `pdf-rodada10` (A4, margem 1 cm, Times-Roman 7 pt) com a medida feita com o cursor depois do quadro de itens', async () => {
    expect(await footCase(1, 'content', 7, AFTER_ITEMS)).toEqual({ error: null, closed: null, pages: 1, text: ['linha'] })
  })

  it('[CORRIGIDO — ACHADO MEDIUM] R10-M1c — varredura (margens × retrato/paisagem × corpos 6–12 × 3 fontes, medida no topo e no meio): nenhuma linha posta em `pé − altura medida` abre folha', () => {
    const fails: string[] = []
    for (const marginCm of [0.7, 1, 1.5]) for (const layout of ['portrait', 'landscape'] as const) for (const at of [undefined, 333.7]) {
      for (let s = 6; s <= 12; s += 0.5) for (const role of ['title', 'content', 'fixed']) {
        const d = createPdf({ marginCm, layout, title: 'R10M1c', fontRoles: ROLES }).doc
        if (at !== undefined) d.y = at
        const m = measureText(d, role, 'linha', { sizePt: s, width: 300 })
        writeText(d, role, 'linha', { x: 40, y: d.page.maxY() - m.height, width: 300, sizePt: s })
        if (sheetsOf(d) !== 1) fails.push(`${marginCm}/${layout}/${at ?? 'topo'}/${role}/${s}`)
      }
    }
    expect(fails).toEqual([])                                                               // hoje: algumas dezenas de combinações
  })

  it('a correção sugerida resolve: nos casos que falham, o `y` compensado com folga relativa (≤ 2^-40 × pé) fica na folha e sobe < 1e-4 pt', () => {
    const cases: [number, 'title' | 'content', number, number | undefined][] = [[0.7, 'title', 8.5, undefined], [1, 'content', 7, AFTER_ITEMS]]
    for (const [marginCm, role, sizePt, at] of cases) {
      const d = createPdf({ marginCm, title: 'fix', fontRoles: ROLES }).doc
      if (at !== undefined) d.y = at
      const m = measureText(d, role, 'linha', { sizePt, width: 300 })
      const foot = d.page.maxY()
      const y0 = foot - m.height
      const probe = createPdf({ marginCm, title: 'lh', fontRoles: ROLES }).doc
      probe.font(ROLES[role]).fontSize(sizePt)
      const lh = probe.currentLineHeight(true)
      expect(y0 + lh).toBeGreaterThan(foot)                                                 // o caso do achado: acima do pé exato…
      expect(y0 + lh - foot).toBeLessThanOrEqual(Math.abs(foot) * 2 ** -40)                 // …por ulps de float64
      const foot32 = floor32(foot)
      let y = y0
      for (let i = 0; i < 8 && y + lh > foot32; i++) y -= (y + lh - foot32) + Math.abs(foot32) * 2 ** -52
      expect(y0 - y).toBeLessThan(1e-4)
      writeText(d, role, 'linha', { x: 40, y, width: 300, sizePt })
      expect(sheetsOf(d)).toBe(1)
    }
  })
})

describe('NE-1b gate R10 — [ACHADO LOW] R10-L1: texto VAZIO mede 0 e, posto no pé (`pé − 0`), abre folha', () => {
  it.failing('[ACHADO LOW] R10-L1 — bloco opcional vazio empilhado de baixo para cima (`y = pé − altura medida`): folha nova sem nada escrito; com o recorte aberto, a D-NE134 recusa', () => {
    // `measureText('')` = { height: 0 } (o `heightOfString` não emite linha), mas o `writeText('')` passa pelo quebrador de linha, cuja conferência
    // de ENTRADA exige `y + altura da linha ≤ pé` — com `y = pé` abre folha (e com `y ∈ (pé − lh, pé]` também) para não escrever nada. A promessa
    // nova da doc do `measureText` ("posto em pé − altura medida cabe") não vale para o vazio. Campo opcional vazio da NF-e (infCpl/infAdFisco) num
    // bloco ancorado no rodapé — LOW. Correção sugerida: `writeText` de texto vazio (depois do `toWinAnsi`) sem `continued` não chama o pdfkit (é o
    // que ele faz quando cabe: nenhuma linha, `y` parado) — ou a medida do vazio = uma linha.
    const w = createPdf({ marginCm: 1, title: 'R10L1', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    writeText(d, 'content', 'conteudo', { x: 40, y: 100 })
    const m = measureText(d, 'content', '', { width: 300, sizePt: 9 })
    const y = d.page.maxY() - m.height
    d.save(); d.rect(40, y - 20, 300, 20).clip()
    const error = errorOf(() => writeText(d, 'content', '', { x: 40, y, width: 300, sizePt: 9 }))
    d.restore()
    expect({ height: m.height, error: error?.message ?? null, sheets: sheetsOf(d) }).toEqual({ height: 0, error: null, sheets: 1 })   // hoje: D-NE134, 2 folhas
  })
})

describe('NE-1b gate R10 — [ACHADO LOW] R10-L2: wrapper sem a marca (espião do jest) no `switchToPage` esconde a original do `rawOf` — a limpeza do isolado tropeça na guarda da D-NE138', () => {
  /**
   * `jest.spyOn(doc, 'switchToPage')` (ou qualquer wrapper da família) põe por cima da guarda do nível de cima uma função SEM a marca `GUARD`: o
   * `rawOf` para nela e a volta à folha do isolado (`rawSwitch`, só no caminho de erro de uso — folha aberta no `sheetStart`/na passada) passa pela
   * guarda da D-NE138 com o `q` do próprio isolado aberto — RECUSADA. A limpeza aborta no meio: a mensagem vira "há save() aberto" (a família não
   * abriu nenhum), o `q` do isolado fica aberto e o estado NEUTRO (Helvetica 12) vaza para a família. Só em caminho de erro em que o documento já
   * está perdido (o `end()` já marcou fechado / `broken`) e com espião/wrapper — LOW. Correção sugerida: a volta à folha pela função ORIGINAL do
   * pdfkit guardada pela base (na marca do documento, ou `Object.getPrototypeOf(doc).switchToPage`), nunca pela cadeia de wrappers.
   */
  it('[CORRIGIDO — ACHADO LOW] R10-L2a — passada que abre folha com espião no `switchToPage`: a mensagem é a do isolado e a pilha volta a zero', () => {
    const w = createPdf({ marginCm: 1, title: 'R10L2a', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    writeText(d, 'content', 'corpo', { x: 40, y: 100 })
    const spy = jest.spyOn(d, 'switchToPage')
    const e = errorOf(() => w.end(dd => { dd.addPage() }))
    const after = { stack: internals(d)._ctmStack.length, font: internals(d)._font.name }
    spy.mockRestore()
    expect({ message: e?.message, ...after }).toEqual({ message: 'base de PDF: a passada por folha abriu folha nova — o total que ela recebeu ficou errado', stack: 0, font: 'Times-Roman' })
    // hoje: "há save() aberto — … (switchToPage — D-NE138)", pilha 1, fonte Helvetica
  })

  it('[CORRIGIDO — ACHADO LOW] R10-L2b — `sheetStart` que transborda com espião no `switchToPage`: a causa ("o sheetStart abriu folha") é trocada pela recusa da D-NE138', () => {
    const w = createPdf({
      marginCm: 1, title: 'R10L2b', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => { writeText(d, 'title', n === 2 ? lines(200, 'cab') : `CAB ${n}`, { x: 40, y: 20 }); d.y = 60 },
    })
    const spy = jest.spyOn(w.doc, 'switchToPage')
    const e = errorOf(() => w.doc.addPage())
    const stack = internals(w.doc)._ctmStack.length
    spy.mockRestore()
    expect({ message: e?.message, stack }).toEqual({ message: 'base de PDF: o sheetStart abriu folha (o que ele escreve não cabe na folha)', stack: 0 })
  })

  it('sem erro de uso o espião é inofensivo: a passada visita cada folha pelo nível de cima, a guarda do isolado barra a troca e o PDF fecha balanceado', async () => {
    const w = createPdf({ marginCm: 1, title: 'spy', creationDate: FIXED, fontRoles: ROLES, sheetStart: (d, n) => { writeText(d, 'title', `CAB ${n}`, { x: 40, y: 20, lineBreak: false }); d.y = 60 } })
    const d = w.doc
    writeText(d, 'content', lines(150, 'item'), { x: 40, sizePt: 9 })
    const sheets = sheetsOf(d)
    expect(sheets).toBeGreaterThan(1)
    const spy = jest.spyOn(d, 'switchToPage')
    const refusals: string[] = []
    const pdf = await w.end((dd, i) => {
      refusals.push(errorOf(() => dd.switchToPage(0))?.message ?? 'ACEITO')
      writeText(dd, 'title', `FOLHA ${i.sheet}/${i.total}`, { x: 450, y: 20, lineBreak: false, sizePt: 8 })
    })
    const calls = spy.mock.calls.map(c => c[0])
    spy.mockRestore()
    expect(calls).toEqual(Array.from({ length: sheets }, (_, i) => i))
    expect(refusals.every(m => /a passada por folha trocou de folha/.test(m))).toBe(true)
    expect(pdfPageCount(pdf)).toBe(sheets)
    expect(balanced(pdf)).toBe(true)
  })
})

describe('NE-1b gate R10 — [ACHADO LOW] R10-L3: `advance`/`width` de texto com quebra de linha não descrevem a escrita `lineBreak: false` sem `width` (o pdfkit cola as linhas na mesma linha de base)', () => {
  it.failing('[ACHADO LOW] R10-L3 — "AAAAAAAA\\nB " escrito com lineBreak: false e o próximo trecho em x + advance: os trechos se SOBREPÕEM (ou a escrita recusa a quebra, como a linha única da D-NE132)', async () => {
    // Sem `width`, o `lineBreak: false` aceita `\n` e o pdfkit escreve cada "linha" DEPOIS da anterior, na MESMA linha de base (`x += largura`); a
    // medida diz `advance` = a linha mais LARGA e `height` = duas linhas. O caminho que a mensagem da D-NE136 indica ("x pelo advance do
    // measureText") cola o trecho seguinte em cima do "B". Os campos da NF-e não levam quebra (TString), por isso LOW. Ver Q-NE150.
    const w = createPdf({ marginCm: 1, title: 'R10L3', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    const text = 'AAAAAAAA\nB '
    const m = measureText(d, 'content', text, { x: 40, sizePt: 10 })
    const refused = errorOf(() => writeText(d, 'content', text, { x: 40, y: 100, lineBreak: false, sizePt: 10 }))
    if (refused) { expect(refused).toBeInstanceOf(RangeError); await w.end(); return }
    const end = 40 + m.advance
    writeText(d, 'content', 'X', { x: end, y: 100, lineBreak: false, sizePt: 10 })
    const runs = pdfTextRuns(pdfContentOps(await w.end())[0])
    const probe = createPdf({ marginCm: 1, title: 'm', fontRoles: ROLES }).doc
    const advanceOf = (t: string) => measureText(probe, 'content', t, { x: 40, sizePt: 10 }).advance
    const before = runs.filter(r => r.text !== 'X')
    expect(Math.max(...before.map(r => r.x + advanceOf(r.text)))).toBeLessThanOrEqual(end + 1e-6)   // hoje: "B " começa em x + advance
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ATAQUES QUE RESISTIRAM (verdes — ficam como regressão)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate R10 — D-NE138 no nível de cima resistiu', () => {
  const make = () => {
    const w = createPdf({ marginCm: 1, title: 'T1', creationDate: FIXED, fontRoles: ROLES })
    writeText(w.doc, 'content', lines(120, 'item'), { x: 40, sizePt: 9 })
    return w
  }

  it('`switchToPage` com `save()` aberto (outra folha, a MESMA folha, índice inválido): recusado ANTES de trocar; fechado o `save()`, o documento fecha balanceado e o "Folha n/N" fora do recorte', async () => {
    const w = make()
    const d = w.doc
    d.save(); d.rect(40, 600, 200, 100).clip()
    const page = d.page
    for (const n of [0, 1, 7, -1]) expect(errorOf(() => d.switchToPage(n))?.message).toMatch(TOP_REFUSAL)
    expect(d.page).toBe(page)
    d.restore()
    const pdf = await w.end((dd, i) => { writeText(dd, 'title', `FOLHA ${i.sheet}/${i.total}`, { x: 450, y: 20, lineBreak: false, sizePt: 8 }) })
    expect(balanced(pdf)).toBe(true)
    pdfContentOps(pdf).forEach((o, i) => expect(viewer(o).runs.find(r => r.text === `FOLHA ${i + 1}/2`)!.clipped).toBe(false))
  })

  it('as outras portas de folha com `save()` aberto depois de VOLTAR a uma folha (`addPage`/`continueOnNewPage` crus, transbordo do `writeText`): caem na D-NE134 — documento inválido, nunca o "Folha n/N" recortado', () => {
    const opens: ((dd: PDFKit.PDFDocument) => unknown)[] = [
      dd => dd.addPage(), dd => dd.continueOnNewPage(), dd => writeText(dd, 'content', lines(80, 'x'), { x: 40, y: 500, sizePt: 9 }),
    ]
    for (const open of opens) {
      const v = make()
      v.doc.switchToPage(0)
      v.doc.save(); v.doc.rect(40, 600, 200, 100).clip()
      expect(errorOf(() => open(v.doc))?.message).toMatch(/D-NE134/)
      v.doc.restore()
      expect(() => v.end()).toThrow(/ficou inválido e não fecha — há save\(\) aberto atravessando a quebra/)
    }
  })
})

describe('NE-1b gate R10 — guardas por `rawOf` resistiram (achado 1 do gate anterior): aninhamento e erro no meio', () => {
  it('`sheetStart` disparado por TRANSBORDO dentro do `writeText`, com desenhos da base aninhados no `save()` da família e uma medida: cada folha balanceada, o texto que continua volta na fonte/corpo da família, guardas fora', async () => {
    const w = createPdf({
      marginCm: 1, title: 'N1', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => {
        d.save(); d.rotate(1)
        drawWatermark(d, 'SEM VALOR', { font: 'Helvetica', sizePt: 40, color: 'gray', opacity: 0.3 })
        drawBars(d, BARS, BOX)
        const m = measureText(d, 'title', `CAB ${n}`, { x: 300, sizePt: 8 })
        writeText(d, 'title', `CAB ${n}`, { x: 300, y: 50, width: m.width, align: 'right', lineBreak: false, sizePt: 8, underline: true })
        d.save(); d.restore()
        d.restore()
        d.y = 70
      },
    })
    writeText(w.doc, 'content', lines(180, 'item'), { x: 40, sizePt: 9 })
    expect(sheetsOf(w.doc)).toBe(3)
    expect(clean(w.doc)).toEqual(CLEAN)
    const pdf = await w.end()
    expect(balanced(pdf)).toBe(true)
    pdfContentOps(pdf).map(o => pdfTextRuns(o)).forEach((page, i) => {
      expect(page.filter(r => r.text === `CAB ${i + 1}`)).toHaveLength(1)
      const items = page.filter(r => r.text.startsWith('item'))
      expect(items.length).toBeGreaterThan(0)
      expect(new Set(items.map(r => `${r.font}/${r.size}`)).size).toBe(1)                // a mesma fonte e corpo em toda folha
      expect(items[0].size).toBe(9)
    })
    expect(fontsOf(pdf).sort()).toEqual(['Helvetica', 'Times-Bold', 'Times-Roman'])
  })

  it('erro da FAMÍLIA no meio do `sheetStart` (com `save()` dela aberto e desenhos aninhados): sobe sem ser trocado, o `writeText` que transbordou para, guardas fora (a D-NE138 do nível de cima continua valendo) e o documento fecha balanceado', async () => {
    const w = createPdf({
      marginCm: 1, title: 'N2', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => {
        writeText(d, 'title', `CAB ${n}`, { x: 40, y: 20, lineBreak: false })
        if (n === 2) {
          d.save(); d.rotate(2); drawBars(d, BARS, BOX); d.save()
          drawWatermark(d, 'X', { font: 'Helvetica', sizePt: 30, color: 'gray' })
          throw new Error('falha da família')
        }
        d.y = 60
      },
    })
    const d = w.doc
    expect(errorOf(() => writeText(d, 'content', lines(120, 'item'), { x: 40, sizePt: 9 }))?.message).toBe('falha da família')
    expect(clean(d)).toEqual(CLEAN)
    writeText(d, 'content', 'depois do erro', { x: 40, y: 400 })
    const pdf = await w.end()
    expect(pdfPageCount(pdf)).toBe(2)
    expect(balanced(pdf)).toBe(true)
    expect(pdfTextRuns(pdfContentOps(pdf)[1]).map(r => r.text)).toEqual(expect.arrayContaining(['CAB 2', 'X', 'depois do erro']))
  })

  it('erro da BASE aninhado (linha única que não cabe, com o recorte da família aberto): a recusa da base sobe sem ser trocada, a limpeza fecha o `save()` na folha dele', async () => {
    const w = createPdf({
      marginCm: 1, title: 'N3', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => {
        writeText(d, 'title', `CAB ${n}`, { x: 40, y: 20, lineBreak: false })
        if (n === 2) { d.save(); d.rect(30, 30, 100, 20).clip(); writeText(d, 'content', 'texto largo demais para a celula', { x: 30, y: 30, width: 20, lineBreak: false }) }
        d.y = 60
      },
    })
    expect(errorOf(() => w.doc.addPage())?.message).toMatch(/não cabe na largura da linha única/)
    expect(clean(w.doc)).toEqual(CLEAN)
    writeText(w.doc, 'content', 'corpo 2', { x: 40, y: 300 })
    const pdf = await w.end((dd, i) => { writeText(dd, 'title', `FOLHA ${i.sheet}/${i.total}`, { x: 450, y: 20, lineBreak: false, sizePt: 8 }) })
    expect(balanced(pdf)).toBe(true)
    pdfContentOps(pdf).forEach((o, i) => expect(viewer(o).runs.find(r => r.text === `FOLHA ${i + 1}/2`)!.clipped).toBe(false))
  })

  it('a passada com `save()`/`restore()` da família, desenhos e medida aninhados: aceita, balanceada; a guarda do isolado roubada e chamada depois no nível de cima recusa (nunca troca)', async () => {
    let stolen: ((n: number) => unknown) | null = null
    const w = createPdf({ marginCm: 1, title: 'N4', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    writeText(d, 'content', lines(120, 'item'), { x: 40, sizePt: 9 })
    const pdf = await w.end((dd, i) => {
      stolen = dd.switchToPage
      dd.save(); dd.rotate(-3)
      drawBars(dd, BARS, BOX)
      const m = measureText(dd, 'title', `FOLHA ${i.sheet}/${i.total}`, { x: 450, sizePt: 8 })
      writeText(dd, 'title', `FOLHA ${i.sheet}/${i.total}`, { x: 450, y: 20, width: m.width + 1, align: 'right', lineBreak: false, sizePt: 8 })
      dd.restore()
    })
    expect(balanced(pdf)).toBe(true)
    expect(errorOf(() => stolen!.call(d, 0))?.message).toMatch(/a passada por folha trocou de folha/)
  })
})

describe('NE-1b gate R10 — D-NE140 (`fitFloat32`) resistiu fora do R10-M1', () => {
  it('quando age, sobe menos que 1e-4 pt (A4 e Ofício II, retrato e paisagem); o que passa 1e-6 pt do pé segue indo para a folha seguinte', () => {
    const papers: ({ widthCm: number; heightCm: number } | 'A4')[] = ['A4', { widthCm: 21.6, heightCm: 35.5 }]
    for (const paper of papers) for (const layout of ['portrait', 'landscape'] as const) for (const s of [7, 9, 10.5, 24]) {
      const d = createPdf({ marginCm: 1, paper, layout, title: 'F1', fontRoles: ROLES }).doc
      const m = measureText(d, 'content', 'linha', { sizePt: s, width: 300 })
      const y = d.page.maxY() - m.height
      writeText(d, 'content', 'linha', { x: 40, y, width: 300, sizePt: s })
      if (sheetsOf(d) === 1) expect(Math.abs(d.y - (y + m.height))).toBeLessThan(1e-4)
      const v = createPdf({ marginCm: 1, paper, layout, title: 'F1b', fontRoles: ROLES }).doc
      writeText(v, 'content', 'linha', { x: 40, y: y + 1e-6, width: 300, sizePt: s })
      expect(sheetsOf(v)).toBe(2)
    }
  })

  it('não precisa agir onde há folga: `lineGap`/`paragraphGap` no bloco, várias linhas, texto que começa com "\\n" e `height` = a altura medida — sempre UMA folha no pé exato', () => {
    for (const opt of [{ lineGap: 2 }, { paragraphGap: 3 }, {}]) {
      for (const text of ['\nabc', lines(4, 'w')]) {
        const v = createPdf({ marginCm: 1, title: 'F2', fontRoles: ROLES }).doc
        const m = measureText(v, 'content', text, { sizePt: 9, width: 250, ...opt })
        writeText(v, 'content', text, { x: 40, y: v.page.maxY() - m.height, width: 250, sizePt: 9, ...opt })
        expect(sheetsOf(v)).toBe(1)
      }
    }
    const d = createPdf({ marginCm: 1, title: 'F2b', fontRoles: ROLES }).doc
    const m = measureText(d, 'content', 'caixa', { sizePt: 9, width: 200 })
    writeText(d, 'content', 'caixa', { x: 40, y: d.page.maxY() - m.height, width: 200, height: m.height, sizePt: 9 })
    expect(sheetsOf(d)).toBe(1)
  })

  it('`x` sem `y` (o `y` corrente) decide igual ao `y` explícito — também com `y` negativo (corpo 500 num papel em que a linha é maior que a área útil)', () => {
    for (const s of [9, 500]) {
      const paper = { widthCm: 30, heightCm: s === 500 ? 21 : 29.7 }
      const a = createPdf({ marginCm: 0.5, paper, title: 'F3a', fontRoles: ROLES }).doc
      const b = createPdf({ marginCm: 0.5, paper, title: 'F3b', fontRoles: ROLES }).doc
      const m = measureText(a, 'content', 'linha', { sizePt: s, width: 300 })
      const y = a.page.maxY() - m.height - 0.5
      if (s === 500) expect(y).toBeLessThan(0)
      writeText(a, 'content', 'linha', { x: 40, y, width: 300, sizePt: s })
      b.y = y
      writeText(b, 'content', 'linha', { x: 40, width: 300, sizePt: s })
      expect([sheetsOf(a), a.y]).toEqual([sheetsOf(b), b.y])
      expect(sheetsOf(a)).toBe(1)
    }
  })
})

describe('NE-1b gate R10 — D-NE141 e `advance` resistiram (fora do R10-L3)', () => {
  const cell = { x: 300, width: 120, lineBreak: false, sizePt: 10 } as const

  it('NBSP e espaço no FIM (só NBSP, misturados): linha única no mesmo lugar do texto sem eles; NBSP no COMEÇO conta (como o espaço); só NBSP sublinhado/riscado não desenha nada', async () => {
    const w = createPdf({ marginCm: 1, title: 'B1', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    const v = '1.234,56'
    for (const [i, t] of [v, `${v} `, `${v}    `, `${v}   `].entries()) {
      writeText(d, 'content', t, { ...cell, y: 100 + 20 * i, align: 'right' })
      writeText(d, 'content', t, { ...cell, y: 200 + 20 * i, align: 'center' })
    }
    writeText(d, 'content', ` ${v}`, { ...cell, y: 300, align: 'right' })
    writeText(d, 'content', '   ', { ...cell, y: 320, underline: true })
    writeText(d, 'content', '   ', { ...cell, y: 340, strike: true })
    const ops = pdfContentOps(await w.end())[0]
    const runs = pdfTextRuns(ops)
    expect(runs.map(r => r.text)).toEqual([...Array(8).fill(v), ` ${v}`])
    for (const r of runs.filter((_, i) => i < 8 && i % 2 === 0)) expect(r.x).toBeCloseTo(runs[0].x, 6)
    for (const r of runs.filter((_, i) => i < 8 && i % 2 === 1)) expect(r.x).toBeCloseTo(runs[1].x, 6)
    const nb = measureText(createPdf({ marginCm: 1, title: 'm', fontRoles: ROLES }).doc, 'content', ` ${v}`, { sizePt: 10 }).width
    expect(runs[8].x).toBeCloseTo(300 + 120 - nb, 4)
    expect(ops).not.toMatch(/ l\n/)                                                       // nenhum traço (sublinhado/riscado) desenhado
  })

  it('a medida: largura sem os brancos do fim (por linha), `advance` com eles; `width` ≤ `advance` sempre; só NBSP = 0 de largura e > 0 de avanço; o vazio = 0/0', () => {
    const d = createPdf({ marginCm: 1, title: 'B2', fontRoles: ROLES }).doc
    const w = (t: string) => measureText(d, 'content', t, { x: 40, sizePt: 10 })
    expect(w('  ').width).toBe(0)
    expect(w('  ').advance).toBeGreaterThan(0)
    expect(w('')).toEqual(expect.objectContaining({ width: 0, advance: 0 }))
    expect(w('AB  \nABCD').width).toBeCloseTo(w('ABCD').width, 6)
    expect(w('ABCDE   \nAB').width).toBeCloseTo(w('ABCDE').width, 6)
    for (const t of ['A', 'A ', ' A', 'A \nB  ', ' ', 'x\t', 'abc def  ']) expect(w(t).width).toBeLessThanOrEqual(w(t).advance)
    expect(w('x\t').width).toBeCloseTo(w('x').width, 6)                                    // tabulação vira espaço e é aparada
  })
})

describe('NE-1b gate R10 — D-NE143 resistiu', () => {
  it('`continued: false` com encadeado aberto: recusado pela D-NE135 (com e sem `width`); sem `lineBreak: false` FECHA a cadeia normalmente; na escrita sem quebra não abre cadeia', async () => {
    const w = createPdf({ marginCm: 1, title: 'C1', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    writeText(d, 'content', 'Inf.: ', { x: 40, y: 200, width: 300, continued: true })
    expect(errorOf(() => writeText(d, 'content', 'X', { x: 400, y: 300, lineBreak: false, continued: false }))?.message).toMatch(/D-NE135/)
    expect(errorOf(() => writeText(d, 'content', 'X', { x: 400, y: 300, width: 50, lineBreak: false, continued: false }))?.message).toMatch(/D-NE135/)
    writeText(d, 'content', 'fim.', { continued: false })
    expect([internals(d)._wrapper, internals(d)._textOptions]).toEqual([null, null])
    writeText(d, 'content', 'solta', { x: 400, y: 320, lineBreak: false, continued: false })
    expect([internals(d)._wrapper, internals(d)._textOptions, d.x]).toEqual([null, null, 400])
    writeText(d, 'content', 'celula', { x: 400, y: 340, width: 80, lineBreak: false })
    const runs = pdfTextRuns(pdfContentOps(await w.end())[0]).map(r => r.text)
    expect(runs).toEqual(['Inf.: ', 'fim.', 'solta', 'celula'])
  })
})

describe('NE-1b gate R10 — R9-L1/R9-L2 (fonte conferida na troca, protótipo da fonte-padrão) resistiram', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fontkit = require('fontkit') as { create(b: Buffer): object }
  const ocr = () => fontkit.create(fs.readFileSync(path.join(__dirname, '../../node_modules/bwip-js/fonts/OCRB7.ttf')))
  const impostor = (name: string) => Object.create(ocr(), { postscriptName: { value: name } })

  it('fonte EMBUTIDA com nome PostScript de fonte-padrão por TODAS as portas do cache (sem família, por nome registrado, por família): recusada nas 4 portas; nada embutido', async () => {
    const attempts: ((d: PDFKit.PDFDocument) => void)[] = [
      d => { d.font(impostor('Times-Roman')) },
      d => { d.registerFont('marca', impostor('Times-Roman')); d.font('marca') },
      d => { d.font(impostor('Times-Roman'), 'Times-Roman') },
    ]
    for (const attack of attempts) {
      const w = createPdf({ marginCm: 1, title: 'R1', creationDate: FIXED, fontRoles: ROLES })
      const d = w.doc
      attack(d)
      for (const fn of [
        () => writeText(d, 'content', 'abc', { x: 40, y: 40 }),
        () => writeText(d, 'content', 'abc', { x: 40, y: 60, width: 100, lineBreak: false }),
        () => measureText(d, 'content', 'abc'),
        () => drawWatermark(d, 'X', { font: 'Times-Roman', sizePt: 20, color: 'gray' }),
      ]) expect(errorOf(fn)?.message).toMatch(/fonte-padrão "Times-Roman" foi sobreposto/)
      writeText(d, 'fixed', 'segue', { x: 40, y: 80 })
      const pdf = await w.end()
      expect({ fonts: fontsOf(pdf), embedded: /FontFile2/.test(pdf.toString('latin1')) }).toEqual({ fonts: ['Courier'], embedded: false })
    }
  })

  it('o impostor da Helvetica de abertura não entra no cache (o pdfkit devolve a Helvetica-padrão); getter da `width` que sobrepõe a fonte no meio da linha única é pego na troca', async () => {
    const w = createPdf({ marginCm: 1, title: 'R2', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    d.font(impostor('Helvetica'))
    drawWatermark(d, 'COPIA', { font: 'Helvetica', sizePt: 30, color: 'gray' })
    const opts = { x: 40, y: 100, lineBreak: false, get width() { d.registerFont('Times-Roman', 'Symbol'); return 200 } }
    expect(errorOf(() => writeText(d, 'content', 'abc', opts as never))?.message).toMatch(/sobreposto/)
    const pdf = await w.end()
    expect(fontsOf(pdf)).not.toContain('Symbol')
    expect(fontsOf(pdf)).toContain('Helvetica')
  })
})
