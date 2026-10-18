/// <reference types="jest" />
// GATE ADVERSARIAL do DELTA 3d37aea..756d244 da NE-1b (revisor independente, 2026-10-17 — skill `testar-adversarial.md`): ataques ao re-gate
// D-NE127…D-NE129 da base de PDF (`fiscal-api/pdf`, branch `ne1b`) — a MARCA do documento da base (`base-document.ts`), o `isolated` com q/Q
// conferido, folha conferida e entrada NEUTRA (`state.ts`), o `sheetStart`/passada (`pdf-writer.ts`), a lista FECHADA de opções do `writeText` e a
// porta de MEDIDA `measureText` (`fonts.ts`). Os gates anteriores estão em `adversarial-ne1b-gate.test.ts` e `adversarial-ne1b-delta-gate.test.ts`
// (não repetidos aqui).
//
// Ataque que RESISTIU fica como teste verde; achado CONFIRMADO fica como `it.failing` com o rótulo "[ACHADO <SEVERIDADE>]" — o corpo afirma o
// comportamento CORRETO (recusa legível da base OU o PDF certo), então quando a correção entrar o `it.failing` passa a FALHAR e vira `it` comum.
//
// Oráculo próprio deste gate: `viewer` — intérprete do conteúdo como os LEITORES fazem (pdf.js e MuPDF IGNORAM o `Q` sem `q` correspondente: o que
// foi emitido fora de qualquer `q` vale até o fim da folha). O `pdfTextRuns` do `pdf-oracle.ts` reinicia o estado no `Q` órfão — não serve para ver
// o vazamento por `restore()` a mais.
import PDFDocument from 'pdfkit'
import {
  createPdf, writeText, measureText, registerFontRoles, drawBars, drawMatrix, drawWatermark, code128Bars, code128Symbols, qrMatrix, cmToPt,
} from '../pdf'
import { pdfContentOps, pdfTextRuns, pdfPageCount, decodeCode128, readQr, pdfRects, liveContentOps } from './pdf-oracle'
const D144 = /^base de PDF: o documento ficou inválido e não fecha — o sheetStart (falhou|deixou o y fora da área útil).*D-NE144/   // D-NE144

const FIXED = new Date('2026-10-17T03:00:00Z')
const ROLES = { title: 'Times-Bold', content: 'Times-Roman', fixed: 'Courier' } as const
const KEY = '4126104ABC2DEF000135550010000000071000000075'
const URL_QR = `https://exemplo.gov.br/qr?p=${KEY}`
const barsOf = (t: string) => code128Bars(code128Symbols(t))
const qrOf = (t: string) => qrMatrix(t, { ecLevel: 'M' })
const lines = (n: number, p = 'linha') => Array.from({ length: n }, (_, i) => `${p} ${i + 1}`).join('\n')
const words = (n: number) => Array.from({ length: n }, (_, i) => `palavra${i}`).join(' ')
const internals = (doc: PDFKit.PDFDocument) => doc as unknown as Record<string | symbol, any>
const fontsOf = (pdf: Buffer) => [...pdf.toString('latin1').matchAll(/\/BaseFont \/(\S+)/g)].map(m => m[1])
const errorOf = (fn: () => unknown): Error | null => { try { fn(); return null } catch (e) { return e as Error } }

interface ViewerState { readonly color: string; readonly ca: number; readonly rotated: boolean; readonly clipped: boolean }
interface ViewerRun extends ViewerState { readonly text: string }
/** Como o LEITOR vê a folha: `Q` órfão é ignorado (pdf.js / MuPDF); `cm` com giro, recorte (`W n`), cor e `ca` vigentes em cada trecho e retângulo. */
function viewer(ops: string): { runs: ViewerRun[]; rects: ViewerState[]; final: number; min: number } {
  let st: ViewerState = { color: '', ca: 1, rotated: false, clipped: false }
  const stack: ViewerState[] = []
  const runs: ViewerRun[] = []
  const rects: ViewerState[] = []
  let depth = 0, min = 0
  for (const raw of ops.split('\n')) {
    const l = raw.trim()
    if (l === 'q') { stack.push(st); depth++ }
    else if (l === 'Q') { depth--; min = Math.min(min, depth); const popped = stack.pop(); if (popped) st = popped }
    else if (/ (scn|sc|rg|k)$/.test(l)) st = { ...st, color: l.replace(/ (scn|sc|rg|k)$/, '') }
    else if (/ gs %ca=/.test(l)) { const ca = l.split('%ca=')[1]; if (ca !== '-') st = { ...st, ca: Number(ca) } }
    else if (/ cm$/.test(l)) { const p = l.split(/\s+/).map(Number); if (p[1] !== 0 || p[2] !== 0) st = { ...st, rotated: true } }
    else if (/^W\*? n$/.test(l)) st = { ...st, clipped: true }
    else if (/ re$/.test(l)) rects.push(st)
    else if (/T[Jj]$/.test(l)) {
      const text = [...l.matchAll(/<([0-9a-fA-F]+)>/g)].map(h => Buffer.from(h[1], 'hex').toString('latin1')).join('')
      runs.push({ text, ...st })
    }
  }
  return { runs, rects, final: depth, min }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ACHADOS CONFIRMADOS — MEDIUM
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate R7 — [ACHADO MEDIUM] R7-M1: o `isolated` só confere a pilha ACIMA do esperado — `restore()` a mais passa calado', () => {
  /**
   * O `isolated` guarda `depth = _ctmStack.length` depois do próprio `save()` e só acusa `_ctmStack.length > depth` (save sem restore — re-gate
   * D3). O espelho — o código isolado fecha o `q` DO ISOLAMENTO com um `restore()` a mais — não é conferido: tudo o que ele emite depois fica FORA
   * de qualquer `q` e vale até o fim da folha; o `doc.restore()` final do `isolated` vira `Q` órfão (que os leitores ignoram) e o `_ctm` do pdfkit
   * cai na identidade. Correção sugerida: guardar a ENTRADA que o próprio `save()` empilhou (`_ctmStack[depth - 1]`, um array novo a cada save) e
   * acusar erro de uso se a pilha ficou ABAIXO de `depth` ou se a entrada não é mais a mesma (`restore(); save()` equilibra a contagem).
   */
  async function family(sheetStart: (d: PDFKit.PDFDocument, n: number) => void) {
    const w = createPdf({ marginCm: 1, title: 'M1', creationDate: FIXED, fontRoles: ROLES, sheetStart })
    let error: Error | null = null
    try {
      writeText(w.doc, 'content', 'corpo da folha 1', { x: 40, y: 100, sizePt: 9 })
      drawBars(w.doc, barsOf(KEY), { x: cmToPt(1), y: 200, width: cmToPt(11.5), height: cmToPt(1) })
      w.doc.addPage()
      writeText(w.doc, 'content', 'corpo da folha 2', { x: 40, y: 100, sizePt: 9 })
    } catch (e) { error = e as Error }
    let pdf: Buffer | null = null
    let closeError: Error | null = null
    try { pdf = await w.end((d, i) => { writeText(d, 'title', `FOLHA ${i.sheet}/${i.total}`, { x: 450, y: 20, lineBreak: false, sizePt: 8 }) }) }
    catch (e) { closeError = e as Error }
    // D-NE144: a falha do sheetStart deixa o documento inválido — o equilíbrio é conferido no conteúdo VIVO das folhas
    return { error, closeError, pages: (pdf ? pdfContentOps(pdf) : liveContentOps(w.doc)).map(viewer) }
  }
  const header = (d: PDFKit.PDFDocument, n: number) => writeText(d, 'title', `CABEÇALHO ${n}`, { x: 40, y: 20, lineBreak: false, sizePt: 10 })
  const assertIntact = (r: Awaited<ReturnType<typeof family>>) => {
    if (r.error) { expect(r.error.message).toMatch(/^base de PDF: o sheetStart/); return }      // recusa legível = correção aceita
    for (const p of r.pages) {
      expect({ final: p.final, min: p.min }).toEqual({ final: 0, min: 0 })
      for (const run of p.runs.filter(x => x.text.startsWith('corpo') || x.text.startsWith('FOLHA'))) {
        expect({ ca: run.ca, rotated: run.rotated }).toEqual({ ca: 1, rotated: false })
      }
      expect(p.rects.every(x => !x.rotated)).toBe(true)
    }
  }

  // CORRIGIDO (2026-10-17): o `isolated` guarda a ENTRADA do próprio `save()` e acusa erro de uso se a pilha ficou abaixo dela ou se a entrada
  // mudou; reabre o que falta para o PDF seguir balanceado. (Antes: sem erro, `Q` órfão, corpo vermelho a 30 % girado 90° em toda folha.)
  /** Com a correção: o erro de uso sobe NA HORA (antes do `Q` extra) e nada vaza — toda folha balanceada, corpo/FOLHA opacos e sem giro. */
  const assertRefusedAndClean = (r: Awaited<ReturnType<typeof family>>) => {
    expect(r.error?.message).toMatch(/^base de PDF: o sheetStart deu restore\(\) a mais/)
    expect(r.closeError?.message).toMatch(D144)
    for (const p of r.pages) {
      expect({ final: p.final, min: p.min }).toEqual({ final: 0, min: 0 })
      for (const run of p.runs.filter(x => x.text.startsWith('corpo') || x.text.startsWith('FOLHA'))) {
        expect({ ca: run.ca, rotated: run.rotated }).toEqual({ ca: 1, rotated: false })
      }
      expect(p.rects.every(x => !x.rotated)).toBe(true)
    }
  }

  it('[CORRIGIDO — ACHADO MEDIUM] R7-M1a — sheetStart com `restore()` a mais (depois de um save/restore legítimo) é barrado NA HORA, antes do `Q` extra: erro de uso legível e NADA vaza (antes: corpo vermelho a 30 % girado 90°, `Q` órfão em toda folha)', async () => {
    assertRefusedAndClean(await family((d, n) => {
      header(d, n)
      if (n > 1) {
        d.save(); d.restore(); d.restore()                                     // o 2º restore fecharia o q DO ISOLAMENTO
        d.fillColor('red', 0.3).rotate(90, { origin: [300, 400] })
      }
      d.y = 60
    }))
    // na 1ª folha (o sheetStart roda dentro do createPdf) a recusa sobe do próprio createPdf
    expect(() => createPdf({ marginCm: 1, title: 'M1a1', fontRoles: ROLES, sheetStart: d => { d.restore() } }))
      .toThrow(/^base de PDF: o sheetStart deu restore\(\) a mais/)
  })

  it('[CORRIGIDO — ACHADO MEDIUM] R7-M1b — `restore(); …; save()` (que equilibraria a contagem com OUTRA entrada) é barrado no 1º `restore()`: erro de uso legível, nada vaza', async () => {
    assertRefusedAndClean(await family((d, n) => {
      header(d, n)
      if (n > 1) {
        d.restore()
        d.fillColor('red', 0.3).rotate(90, { origin: [300, 400] })
        d.save()
      }
      d.y = 60
    }))
  })

  it('[CORRIGIDO — ACHADO MEDIUM] R7-M1c — a PASSADA por folha com `restore()` a mais = erro de uso legível (nunca `Q` órfão calado)', async () => {
    const w = createPdf({ marginCm: 1, title: 'M1c', creationDate: FIXED, fontRoles: ROLES })
    w.doc.addPage()
    let error: Error | null = null
    let pdf: Buffer | null = null
    try {
      pdf = await w.end((d, i) => {
        d.restore()
        d.fillColor('red', 0.3)
        writeText(d, 'title', `FOLHA ${i.sheet}/${i.total}`, { x: 450, y: 20, lineBreak: false, sizePt: 8 })
      })
    } catch (e) { error = e as Error }
    if (error) { expect(error.message).toMatch(/^base de PDF: a passada por folha/); return }
    for (const p of pdfContentOps(pdf!).map(viewer)) expect({ final: p.final, min: p.min }).toEqual({ final: 0, min: 0 })
  })
})

describe('NE-1b gate R7 — [ACHADO MEDIUM] R7-M2: `lineBreak: false` com `width` (a CÉLULA alinhada do DANFE) QUEBRA a linha e ABRE FOLHA', () => {
  /**
   * A lista fechada aceita `lineBreak`, `width` e `align` juntos, sem ressalva. No pdfkit 0.20.2 o `_text` usa o quebrador de linha sempre que há
   * `width` — o `lineBreak: false` só desliga a largura PADRÃO. Alinhar à direita/centro EXIGE `width` (sem ela o `_fragment` não alinha), então o
   * idioma natural da célula de valor do DANFE (`{ width: célula, align: 'right', lineBreak: false }`) quebra o valor longo em várias linhas por cima
   * das células de baixo e, perto do pé, ABRE FOLHA no meio do layout (o resto do valor e todo desenho seguinte vão para a folha nova). Depende do
   * DADO: some nos testes com valor curto e aparece em produção. É o sintoma do re-gate D2 (MEDIUM) por outra combinação — a mais comum.
   * Correção sugerida: com `lineBreak: false` a base escreve UMA linha (alinhamento calculado pela medida, sem `width` no pdfkit) — ou recusa a
   * combinação (RangeError) e manda a família usar `height` + `ellipsis`.
   */
  const VALUE = 'VALOR TOTAL DOS PRODUTOS 1.234.567,89'
  const cell = { x: 400, width: 80, align: 'right' as const, lineBreak: false, sizePt: 8 }

  it('[CORRIGIDO — ACHADO MEDIUM] R7-M2a — no meio da folha: o valor sai em 3 linhas (uma por cima da célula de baixo), não em 1', async () => {
    const w = createPdf({ marginCm: 1, title: 'M2a', creationDate: FIXED, fontRoles: ROLES })
    const refused = errorOf(() => writeText(w.doc, 'content', VALUE, { ...cell, y: 100 }))
    const pdf = await w.end()
    if (refused) { expect(refused).toBeInstanceOf(RangeError); return }
    expect(pdfTextRuns(pdfContentOps(pdf)[0]).map(r => r.text)).toEqual([VALUE])
  })

  it('[CORRIGIDO — ACHADO MEDIUM] R7-M2b — perto do pé: ABRE FOLHA (2 folhas para uma célula; o desenho seguinte da família cai na folha nova)', async () => {
    const w = createPdf({ marginCm: 1, title: 'M2b', creationDate: FIXED, fontRoles: ROLES })
    const refused = errorOf(() => writeText(w.doc, 'content', VALUE, { ...cell, y: 800 }))
    const pageAfterCell = internals(w.doc)._pageBuffer.indexOf(w.doc.page)
    const pdf = await w.end()
    if (refused) { expect(refused).toBeInstanceOf(RangeError); return }
    expect({ pages: pdfPageCount(pdf), pageAfterCell }).toEqual({ pages: 1, pageAfterCell: 0 })
  })

  it('[CORRIGIDO — ACHADO MEDIUM] R7-M2c — na passada por folha (o "Folha n/N" alinhado à direita no pé): o documento NÃO fecha — "a passada abriu folha nova"', async () => {
    const w = createPdf({ marginCm: 1, title: 'M2c', creationDate: FIXED, fontRoles: ROLES })
    let error: Error | null = null
    try {
      await w.end((d, i) => {
        writeText(d, 'content', `Folha ${i.sheet} de ${i.total} - documento auxiliar`, { ...cell, x: 500, width: 60, y: 805 })
      })
    } catch (e) { error = e as Error }
    expect(error === null || error instanceof RangeError).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ACHADOS CONFIRMADOS — LOW
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate R7 — achados LOW', () => {
  it('[CORRIGIDO — ACHADO LOW] R7-L1a — `doc.registerFont("content", "Symbol")` direto não muda nada: a medida e o `writeText` usam a fonte do registro DA BASE (Times-Roman)', async () => {
    const w = createPdf({ marginCm: 1, title: 'L1a', creationDate: FIXED, fontRoles: ROLES })
    w.doc.registerFont('content', 'Symbol')
    const m = measureText(w.doc, 'content', 'abc')
    const refused = errorOf(() => writeText(w.doc, 'content', 'abc', { x: 40, y: 40 }))
    const pdf = await w.end()
    expect(m.width).toBeGreaterThan(0)                                       // (antes: 0 — a medida da Symbol)
    if (refused) return
    expect(fontsOf(pdf)).toEqual(['Times-Roman'])
  })

  it('[CORRIGIDO — ACHADO LOW] R7-L1b — religar um papel depois de usado: ou é recusado, ou o desenho e a medida seguem a fonte NOVA do registro da base (nunca o registro dizendo uma e o PDF saindo noutra)', async () => {
    const w = createPdf({ marginCm: 1, title: 'L1b', creationDate: FIXED, fontRoles: { content: 'Times-Roman' } })
    writeText(w.doc, 'content', 'antes', { x: 40, y: 40 })
    const refused = errorOf(() => registerFontRoles(w.doc, { content: 'Courier' }))
    if (refused) { expect(refused).toBeInstanceOf(RangeError); await w.end(); return }
    const m = measureText(w.doc, 'content', 'iiii', { sizePt: 10 })
    writeText(w.doc, 'content', 'depois', { x: 40, y: 80 })
    const pdf = await w.end()
    expect(m.width).toBeCloseTo(24, 3)                                       // Courier 10 pt: 4 × 6
    expect(fontsOf(pdf)).toContain('Courier')
  })

  // TRATADO (2026-10-17): `wordSpacing` e `characterSpacing` SAÍRAM da lista fechada — defeitos do pdfkit 0.20.2 (o `wordSpacing` apaga quebras
  // de linha e não entra na largura medida; o `characterSpacing` conta duas vezes no sublinhado); o DANFE não precisa de nenhum dos dois
  it('[TRATADO — ACHADO LOW] R7-L2a — `wordSpacing` (apagava as quebras de linha no pdfkit) é RECUSADO pela porta, antes de desenhar', async () => {
    const w = createPdf({ marginCm: 1, title: 'L2a', creationDate: FIXED, fontRoles: ROLES })
    const refused = errorOf(() => writeText(w.doc, 'content', 'Item A\n\nItem B', { x: 40, y: 100, wordSpacing: 1 } as any))
    expect(refused).toBeInstanceOf(RangeError)
    expect(refused!.message).toMatch(/"wordSpacing" fora da porta/)
    expect(pdfPageCount(await w.end())).toBe(1)
  })

  it('[TRATADO — ACHADO LOW] R7-L2b — `measureText` com `wordSpacing` (a largura não o contava) é RECUSADA', () => {
    const w = createPdf({ marginCm: 1, title: 'L2b', creationDate: FIXED, fontRoles: ROLES })
    expect(() => measureText(w.doc, 'content', 'Valor total da nota fiscal', { wordSpacing: 10 } as any)).toThrow(RangeError)
  })

  it('[TRATADO — ACHADO LOW] R7-L2c — `characterSpacing` (contado duas vezes no sublinhado) é RECUSADO na escrita e na medida', () => {
    const w = createPdf({ marginCm: 1, title: 'L2c', creationDate: FIXED, fontRoles: ROLES })
    const t = 'Valor total da nota fiscal'
    expect(() => measureText(w.doc, 'content', t, { characterSpacing: 2 } as any)).toThrow(RangeError)
    expect(() => writeText(w.doc, 'content', t, { x: 40, y: 100, underline: true, characterSpacing: 2 } as any)).toThrow(RangeError)
  })

  it('[CORRIGIDO — ACHADO LOW] R7-L3a — sheetStart que ABRE folha: o erro de uso sobe e o `end()` diz a causa REAL (documento inválido — o sheetStart abriu folha), não o flushPages', async () => {
    const w = createPdf({ marginCm: 1, title: 'L3a', creationDate: FIXED, fontRoles: ROLES, sheetStart: (d, n) => { if (n === 2) d.addPage() } })
    expect(() => w.doc.addPage()).toThrow('o sheetStart abriu folha')
    let message = ''
    try { await w.end() } catch (e) { message = (e as Error).message }
    expect(message).not.toMatch(/flushPages/)
  })

  it('[CORRIGIDO — ACHADO LOW] R7-L3b — sheetStart que faz `save()` NOUTRA folha e lança: o erro sobe (certo), mas o PDF que ainda fecha fica com `q` pendente na folha 1 e `Q` órfão na folha 2 (o "corrigido para continuar balanceado" não vale entre folhas)', async () => {
    const w = createPdf({
      marginCm: 1, title: 'L3b', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => { if (n === 2) { d.switchToPage(0); d.save(); d.rotate(45); throw new Error('meu erro') } },
    })
    expect(() => w.doc.addPage()).toThrow(/^base de PDF: o sheetStart trocou de folha \(switchToPage\).*D-NE138/)                        // D-NE138: a troca é barrada antes do save() noutra folha
    const pages = liveContentOps(w.doc)
    expect(pages.map(viewer).map(p => ({ final: p.final, min: p.min }))).toEqual([{ final: 0, min: 0 }, { final: 0, min: 0 }])
    expect(() => w.end()).toThrow(D144)
  })

  it('[CORRIGIDO — ACHADO LOW] R7-L4 — a entrada NEUTRA não cobre recorte nem matriz: um `save()`+`clip()` da família que ATRAVESSA a quebra de folha deixa o "FOLHA 1/2" da passada RECORTADO (invisível) e q/Q desbalanceado nas duas folhas, sem erro', async () => {
    const w = createPdf({ marginCm: 1, title: 'L4', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    let error: Error | null = null
    try {
      d.save(); d.rect(28, 300, 300, 500).clip()                             // a caixa dos itens, recortada…
      writeText(d, 'content', lines(80, 'item'), { x: 30, y: 300, width: 290, sizePt: 9 })   // …que transborda para a folha 2
      d.restore()
    } catch (e) { error = e as Error }
    // D-NE134 (Valdo 2026-10-17): erro de uso legível na abertura da folha — e o documento fica INVÁLIDO (a folha nova ficou sem o sheetStart;
    // gate final F-L3): o `end()` recusa dizendo a causa, nunca fecha um PDF com folha sem cabeçalho
    if (error) {
      expect(error.message).toMatch(/^base de PDF: há save\(\) aberto atravessando a quebra de folha/)
      expect(() => w.end()).toThrow(/documento ficou inválido.*save\(\) aberto atravessando a quebra/)
      return
    }
    const pages = pdfContentOps(await w.end((dd, i) => { writeText(dd, 'title', `FOLHA ${i.sheet}/${i.total}`, { x: 450, y: 20, lineBreak: false, sizePt: 8 }) }))
    const seen = pages.map(viewer)
    expect(seen[0].runs.find(r => r.text.startsWith('FOLHA'))!.clipped).toBe(false)
    expect(seen.map(p => ({ final: p.final, min: p.min }))).toEqual([{ final: 0, min: 0 }, { final: 0, min: 0 }])
  })

  it('[CORRIGIDO — ACHADO LOW] R7-L5 — `measureText` lê `sizePt` QUATRO vezes (valida a 1ª, usa a 4ª — a classe do A12): um getter dá corpo −50 e altura NEGATIVA; a marca d\'água lê `font` duas vezes e grava Symbol', async () => {
    const w = createPdf({ marginCm: 1, title: 'L5', creationDate: FIXED, fontRoles: ROLES })
    let reads = 0
    const flip = { get sizePt() { return reads++ === 0 ? 9 : -50 } } as unknown as { sizePt: number }
    let m: { height: number } | Error
    try { m = measureText(w.doc, 'content', 'abc', flip) } catch (e) { m = e as Error }
    let k = 0
    const style = { get font() { return (k++ === 0 ? 'Helvetica' : 'Symbol') as 'Helvetica' }, sizePt: 40, color: 'gray' }
    const wm = errorOf(() => drawWatermark(w.doc, 'COPIA', style))
    const pdf = await w.end()
    expect(reads).toBeLessThanOrEqual(1)
    if (!(m instanceof Error)) expect(m.height).toBeGreaterThan(0)
    if (!wm) expect(fontsOf(pdf)).not.toContain('Symbol')
  })

  it('[CORRIGIDO — ACHADO LOW] R7-L6 — a faixa ±1000 dos espaçamentos aceita valor que leva o texto para FORA da folha em silêncio: `lineGap: -1000` dá altura medida NEGATIVA (−18.746 pt para 60 palavras em 200 pt) e as linhas são escritas acima do topo', async () => {
    const w = createPdf({ marginCm: 1, title: 'L6', creationDate: FIXED, fontRoles: ROLES })
    const refused = errorOf(() => measureText(w.doc, 'content', words(60), { width: 200, lineGap: -1000 }))
    if (refused) { expect(refused).toBeInstanceOf(RangeError); await w.end(); return }
    expect(measureText(w.doc, 'content', words(60), { width: 200, lineGap: -1000 }).height).toBeGreaterThanOrEqual(0)
  })

  it('[CORRIGIDO — ACHADO LOW] R7-L7 — "só `y` usa o `x` corrente" (re-gate D2), mas depois de um `lineBreak: false` o x corrente é o FIM do texto anterior (o pdfkit avança `x` sem quebrador): a coluna de rótulos escrita só com `y` vira ESCADA (40 → 71 → 86 pt)', async () => {
    const w = createPdf({ marginCm: 1, title: 'L7', creationDate: FIXED, fontRoles: ROLES })
    writeText(w.doc, 'content', 'CNPJ:', { x: 40, y: 100, lineBreak: false })
    writeText(w.doc, 'content', 'IE:', { y: 115, lineBreak: false })
    writeText(w.doc, 'content', 'UF:', { y: 130, lineBreak: false })
    const xs = pdfTextRuns(pdfContentOps(await w.end())[0]).map(r => Math.round(r.x))
    expect(xs).toEqual([40, 40, 40])
  })

  it('[CORRIGIDO — ACHADO LOW] R7-L8 — `sheetStart` que não é função passa no createPdf e estoura TypeError genérico ("start is not a function") no 1º addPage, não a recusa da base', () => {
    const e = errorOf(() => createPdf({ marginCm: 1, title: 'L8', sheetStart: 'cabecalho' as unknown as () => void }))
    expect(e).toBeInstanceOf(RangeError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ATAQUES QUE RESISTIRAM (verdes — ficam como regressão)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate R7 — a marca D-NE127 resistiu', () => {
  it('documento do pdfkit cru, objeto qualquer, primitivo e função são recusados por TODAS as portas; documento de OUTRO createPdf não herda os papéis', async () => {
    const raw = new PDFDocument({ autoFirstPage: true })
    const ports: [string, (d: any) => unknown][] = [
      ['writeText', d => writeText(d, 'content', 'x')], ['measureText', d => measureText(d, 'content', 'x')],
      ['registerFontRoles', d => registerFontRoles(d, { content: 'Times-Roman' })],
      ['drawBars', d => drawBars(d, barsOf('1234'), { x: 10, y: 10, width: 100, height: 10 })],
      ['drawMatrix', d => drawMatrix(d, qrOf('x'), { x: 10, y: 10, size: 50 })],
      ['drawWatermark', d => drawWatermark(d, 'X', { font: 'Helvetica', sizePt: 10, color: 'gray' })],
    ]
    for (const target of [raw, {}, Object.create(null), 42, 'doc', () => 1, null, undefined]) {
      for (const [name, port] of ports) expect([name, errorOf(() => port(target))?.message]).toEqual([name, expect.stringMatching(/D-NE127/)])
    }
    const a = createPdf({ marginCm: 1, title: 'A', creationDate: FIXED, fontRoles: ROLES })
    const b = createPdf({ marginCm: 1, title: 'B', creationDate: FIXED })
    expect(() => writeText(b.doc, 'content', 'x')).toThrow(/não registrado na base/)
    expect(() => measureText(b.doc, 'content', 'x')).toThrow(/não registrado na base/)
    await a.end(); await b.end()
  })

  it('a marca não se troca, não se apaga e o estado é congelado; o Proxy de um documento da base escreve no MESMO documento; a cópia do símbolo por reflexão para um pdfkit cru nunca desenha', async () => {
    const w = createPdf({ marginCm: 1, title: 'P', creationDate: FIXED, fontRoles: ROLES })
    const sym = Object.getOwnPropertySymbols(w.doc).find(s => String(s).includes('fiscal-api'))!
    expect(Object.isFrozen(internals(w.doc)[sym])).toBe(true)
    expect(() => Object.defineProperty(w.doc, sym, { value: { roles: {} } })).toThrow(TypeError)
    expect(Reflect.deleteProperty(w.doc, sym)).toBe(false)
    writeText(new Proxy(w.doc, {}), 'content', 'pelo proxy', { x: 40, y: 40, lineBreak: false })
    const raw = new PDFDocument({ autoFirstPage: true })
    Object.defineProperty(raw, sym, { value: internals(w.doc)[sym] })
    // LIMITE CONHECIDO (base-document.ts — a marca protege contra ENGANO, não contra fraude): a cópia do símbolo por reflexão passa pela porta e
    // escreve no documento DELA (a fonte vem do registro da base desde o gate S1/R7-L1) — nunca no documento da base
    errorOf(() => writeText(raw, 'content', 'roubado', { x: 40, y: 40 }))
    raw.end()
    expect(pdfTextRuns(pdfContentOps(await w.end())[0]).map(r => r.text)).toEqual(['pelo proxy'])
  })
})

describe('NE-1b gate R7 — measureText × writeText resistiu (D-NE129)', () => {
  // (2026-10-17: `lineGap: 0`, `characterSpacing` e `wordSpacing` saíram da lista fechada — gate R7-L2/L6 — e das combinações; agora são recusados)
  it('ALTURA medida = avanço do writeText em 132 combinações (\\n, linhas vazias, só \\n, vazio, CRLF, tabulação, espaços, palavra gigante × largura minúscula, justify, right, center, paragraphGap, indent, lineGap 5, corpo)', async () => {
    const texts = ['abc def ghi', 'linha 1\nlinha 2', 'linha 1\n', 'a\n\nb', '\n', '', 'a \nb', 'a\r\nb', words(60), 'X'.repeat(200), 'a\tb\t\tc', 'a    b     c']
    const optsSet: Record<string, unknown>[] = [
      {}, { width: 100 }, { width: 100, align: 'justify' }, { width: 100, align: 'right' }, { width: 100, align: 'center' },
      { width: 100, paragraphGap: 7 }, { width: 100, indent: 20 }, { width: 100, lineGap: 5 },
      { width: 3 }, { width: 100, sizePt: 7 }, { width: 100, paragraphGap: 7, indent: 10, lineGap: 3 },
    ]
    const w = createPdf({ marginCm: 1, title: 'M', creationDate: FIXED, fontRoles: ROLES, paper: { widthCm: 21, heightCm: 500 } })
    const d = w.doc
    const diffs: string[] = []
    for (const t of texts) for (const o of optsSet) {
      d.x = 40; d.y = 40
      const m = measureText(d, 'content', t, o)
      writeText(d, 'content', t, { x: 40, y: 40, ...o })
      if (Math.abs((d.y - 40) - m.height) > 1e-6) diffs.push(`${JSON.stringify(t).slice(0, 20)} ${JSON.stringify(o)}: ${m.height} × ${d.y - 40}`)
    }
    expect(diffs).toEqual([])
    expect(internals(d)._pageBuffer).toHaveLength(1)
    await w.end()
  })

  it('a medida não desenha, não abre folha e devolve o estado da família INTEIRO (inclusive o encadeado vivo e o espaçamento corrente)', async () => {
    const w = createPdf({ marginCm: 1, title: 'M2', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    writeText(d, 'content', 'Inicio: ', { x: 40, y: 100, width: 200, continued: true, sizePt: 9 })
    d.lineGap(3).fillColor('#333333', 0.5)
    const keys = ['_font', '_fontSize', '_lineGap', '_fillColor', '_wrapper', '_textOptions', 'x', 'y', 'page'] as const
    const before = keys.map(k => internals(d)[k])
    const ops0 = (d.page as any).content.uncompressedLength
    const m = measureText(d, 'fixed', lines(500), { width: 50, sizePt: 30 })
    expect(m.height).toBeGreaterThan(cmToPt(29.7))                           // mais alta que a folha — e nenhuma folha aberta
    expect(keys.map(k => internals(d)[k])).toEqual(before)
    expect((d.page as any).content.uncompressedLength).toBe(ops0)
    writeText(d, 'content', 'fim.', {})
    expect(pdfTextRuns(pdfContentOps(await w.end())[0]).map(r => r.text).join('')).toContain('Inicio: fim.')
  })
})

describe('NE-1b gate R7 — erros de uso no MEIO de um encadeado que transborda resistiram', () => {
  const cases: Record<string, (d: PDFKit.PDFDocument) => unknown> = {
    'y fora da área útil': d => { d.y = d.page.height },
    'save() sem restore()': d => { d.save(); d.fillColor('red', 0.3) },
    'terminou noutra folha': d => { d.switchToPage(0) },
    'getter `then` que lança': () => ({ get then() { throw new Error('getter then') } }),
    'promessa rejeitada': () => Promise.reject(new Error('assíncrono')),
  }
  for (const [name, bad] of Object.entries(cases)) {
    it(`${name}: o erro sobe na hora, 2 folhas com q/Q balanceado, o conteúdo da folha 2 opaco e sem giro, e o documento INVÁLIDO (D-NE144)`, async () => {
      const w = createPdf({
        marginCm: 1, title: name, creationDate: FIXED, fontRoles: ROLES,
        sheetStart: (d, n) => {
          writeText(d, 'title', `CAB ${n}`, { x: 40, y: 20, lineBreak: false }); d.y = 60
          return (n === 2 ? bad(d) : undefined) as void
        },
      })
      const error = errorOf(() => {
        writeText(w.doc, 'content', 'Inicio: ', { x: 40, y: 700, width: 200, continued: true, sizePt: 9 })
        writeText(w.doc, 'content', words(300), { continued: true })
        writeText(w.doc, 'content', ' FIM.')
      })
      expect(error?.message).toMatch(/^base de PDF: o sheetStart|^getter then$/)
      const seen = liveContentOps(w.doc).map(viewer)
      expect(seen.map(p => ({ final: p.final, min: p.min }))).toEqual([{ final: 0, min: 0 }, { final: 0, min: 0 }])
      expect(seen[1].runs.filter(r => r.text.startsWith('palavra')).every(r => r.ca === 1 && !r.rotated)).toBe(true)
      expect(() => w.end()).toThrow(D144)
    })
  }
})

describe('NE-1b gate R7 — valores-limite da lista fechada terminam (sem laço infinito do quebrador de linha)', () => {
  // (2026-10-17: espaçamentos NEGATIVOS, `lineGap: 0`, `characterSpacing` e `wordSpacing` saíram da faixa/lista — gate R7-L2/L6 — e passaram para
  // a lista de RECUSA abaixo)
  it('largura 1e-9/0,5/14.400, recuo até 1000 (maior que a largura), espaçamentos até 1000, justify com largura minúscula, encadeado com recuo — writeText e measureText terminam em tempo curto; largura 0/NaN, espaçamento negativo e opção retirada são recusados', async () => {
    const text = 'palavra '.repeat(40) + 'X'.repeat(80) + '\n\nfim de texto'
    const sets: Record<string, unknown>[] = [
      { width: 1e-9 }, { width: 0.5 }, { width: 14400 }, { width: 200, indent: 1000 }, { width: 1e-9, indent: 1000 },
      { width: 200, lineGap: 1000 }, { width: 200, paragraphGap: 1000 }, { width: 1e-9, align: 'justify' }, { indent: 1000 },
    ]
    const t0 = Date.now()
    for (const o of sets) {
      const w = createPdf({ marginCm: 1, title: 'F', creationDate: FIXED, fontRoles: ROLES })
      measureText(w.doc, 'content', text, o)
      writeText(w.doc, 'content', text, { x: 40, y: 40, ...o })
      writeText(w.doc, 'content', text, { x: 40, y: 40, ...o, continued: true })
      writeText(w.doc, 'content', 'fim')
      expect(pdfPageCount(await w.end())).toBeLessThan(60)
    }
    expect(Date.now() - t0).toBeLessThan(15000)
    const w = createPdf({ marginCm: 1, title: 'F0', creationDate: FIXED, fontRoles: ROLES })
    for (const bad of [{ width: 0 }, { width: NaN }, { width: 14401 }, { lineGap: 1001 }, { indent: -Infinity }, { align: 'JUSTIFY' }, { columns: 2 },
      { indent: -1000 }, { paragraphGap: -1000 }, { lineGap: 0 }, { lineGap: -1000 }, { characterSpacing: 1000 }, { wordSpacing: 1 }]) {
      expect(() => writeText(w.doc, 'content', 'x', bad as never)).toThrow(RangeError)
    }
    await w.end()
  })
})

describe('NE-1b gate R7 — "só y" no pé da folha e reprodutibilidade resistiram', () => {
  it('writeText só com `y` no PÉ da folha e `lineBreak: false`: escreve ali, no x corrente, sem abrir folha (e sem sheetStart extra)', async () => {
    let starts = 0
    const w = createPdf({ marginCm: 1, title: 'Pe', creationDate: FIXED, fontRoles: ROLES, sheetStart: () => { starts++ } })
    w.doc.x = 123
    writeText(w.doc, 'content', 'rodapé', { y: w.doc.page.maxY() - 2, lineBreak: false, sizePt: 7 })
    const pdf = await w.end()
    expect({ pages: pdfPageCount(pdf), starts }).toEqual({ pages: 1, starts: 1 })
    expect(Math.round(pdfTextRuns(pdfContentOps(pdf)[0])[0].x)).toBe(123)
  })

  it('a MESMA data dá os MESMOS bytes com TUDO do delta junto (medida, sublinhado, riscado, justify, encadeado, espaçamentos, marca, barras, QR, cabeçalho, passada); as barras e o QR saem lidos de volta', async () => {
    const build = async (date: Date) => {
      const w = createPdf({
        marginCm: 1, title: 'R', creationDate: date, fontRoles: ROLES,
        sheetStart: (d, n) => {
          drawWatermark(d, 'SEM VALOR FISCAL', { font: 'Helvetica', sizePt: 50, color: [0, 0, 0, 35], opacity: 0.4 })
          writeText(d, 'title', `CAB ${n}`, { x: 40, y: 20, lineBreak: false }); d.y = 60
        },
      })
      const d = w.doc
      drawBars(d, barsOf(KEY), { x: cmToPt(1), y: 600, width: cmToPt(11.5), height: cmToPt(1) })
      drawMatrix(d, qrOf(URL_QR), { x: 400, y: 600, size: cmToPt(3) })
      const m = measureText(d, 'content', words(80), { width: 300, align: 'justify', lineGap: 2 })
      writeText(d, 'content', `altura medida ${m.height.toFixed(3)}`, { x: 40, y: 80, underline: true })
      writeText(d, 'content', words(80), { x: 40, y: 100, width: 300, align: 'justify', lineGap: 2, strike: true })
      writeText(d, 'content', 'Inf. compl.: ', { width: 300, continued: true })
      writeText(d, 'fixed', words(400), { continued: true })
      writeText(d, 'content', ' FIM.')
      return w.end((dd, i) => { writeText(dd, 'title', `FOLHA ${i.sheet}/${i.total}`, { x: 450, y: 20, lineBreak: false, sizePt: 8 }) })
    }
    const [a, b, c] = [await build(FIXED), await build(FIXED), await build(new Date('2026-10-18T03:00:00Z'))]
    expect(a.equals(b)).toBe(true)
    expect(a.equals(c)).toBe(false)
    expect(pdfPageCount(a)).toBeGreaterThan(1)
    // barras da folha 1 remontadas dos retângulos: módulo = largura / (módulos + 20)
    const bars = barsOf(KEY)
    const module = cmToPt(11.5) / (bars.modules + 20)
    const rects = pdfRects(pdfContentOps(a)[0]).filter(([, , w, h]) => Math.abs(h - cmToPt(1)) < 0.01 && w <= 4 * module + 1e-6)
      .sort((p, q) => p[0] - q[0])
    const widths: number[] = []
    rects.forEach(([x, , w], i) => {
      if (i > 0) widths.push(Math.round((x - (rects[i - 1][0] + rects[i - 1][2])) / module))
      widths.push(Math.round(w / module))
    })
    expect(decodeCode128(widths).text).toBe(KEY)
    // QR da folha 1 remontado dos retângulos (os do símbolo: x ≥ 400, altura de UM módulo)
    const qr = qrOf(URL_QR)
    const qm = cmToPt(3) / qr.size
    const grid = Array.from({ length: qr.size }, () => Array.from({ length: qr.size }, () => false))
    for (const [x, y, w, h] of pdfRects(pdfContentOps(a)[0]).filter(([x, , , h]) => x >= 400 - 1e-6 && Math.abs(h - qm) < 1e-3)) {
      const r = Math.round((y - 600) / qm), c0 = Math.round((x - 400) / qm), n = Math.round(w / qm)
      for (let c = c0; c < c0 + n; c++) grid[r][c] = true
    }
    expect(readQr({ size: qr.size, rows: grid })).toBe(URL_QR)
  })
})
