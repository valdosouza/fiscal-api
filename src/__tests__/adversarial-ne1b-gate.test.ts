/// <reference types="jest" />
// GATE ADVERSARIAL da NE-1b (revisor independente, 2026-10-17 — skill `testar-adversarial.md`): ataques à base de PDF do núcleo
// (`fiscal-api/pdf`, commit 1072916). Ataque que RESISTIU fica como teste verde; achado CONFIRMADO fica como `it.failing` com o rótulo
// "[ACHADO <SEVERIDADE>]" — quando a correção entrar, o `it.failing` passa a FALHAR (o comportamento mudou) e vira `it` comum.
// Oráculos reusados de `pdf-oracle.ts` (decodificador Code-128 próprio, jsQR, extração de texto); `pageOps` abaixo lê os OPERADORES crus.
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import ts from 'typescript'
import {
  createPdf, registerFontRoles, drawWatermark, drawBars, drawMatrix, code128Bars, code128Symbols, qrMatrix, toWinAnsi, cmToPt, CODE128, writeText,
} from '../pdf'
import { decodeCode128, readQr, pdfTextByStream, pdfPageCount } from './pdf-oracle'

const FIXED = new Date('2026-10-17T03:00:00Z')
const KEY_ALFA = '4126104ABC2DEF000135550010000000071000000075'
const MARK = { font: 'Helvetica' as const, sizePt: 50, color: [0, 0, 0, 35] as const, opacity: 0.4 }

/** Operadores crus de cada stream de conteúdo (uma por folha no pdfkit) — só as que desenham algo. */
function pageOps(pdf: Buffer): string[] {
  const s = pdf.toString('latin1')
  const out: string[] = []
  let i = 0
  while ((i = s.indexOf('stream', i)) !== -1) {
    if (s.slice(i - 3, i) === 'end') { i += 6; continue }
    let start = i + 6
    if (s[start] === '\r') start++
    if (s[start] === '\n') start++
    const end = s.indexOf('endstream', start)
    if (end < 0) break
    const raw = pdf.subarray(start, end)
    let txt: string
    try { txt = zlib.inflateSync(raw).toString('latin1') } catch { txt = raw.toString('latin1') }
    if (/\bBT\b|\bre\b/.test(txt)) out.push(txt)
    i = end + 9
  }
  return out
}
const tfSizes = (ops: string): number[] => [...ops.matchAll(/\/F\d+ ([\d.]+) Tf/g)].map(m => Number(m[1]))
const rects = (ops: string): [number, number, number, number][] =>
  [...ops.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re/g)].map(m => [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])])
/** Números de cor gravados nos operadores `scn`/`sc` (o que o leitor de PDF recebe). */
const colorOperands = (ops: string): string[] => [...ops.matchAll(/^([^\n]*?) scn?$/gm)].flatMap(m => m[1].trim().split(/\s+/))

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}

/** Menor número de símbolos de DADOS com os conjuntos A e C (programação dinâmica) — a régua do "minimizar o comprimento" da NT. */
function optimalAC(t: string): number {
  const isD = (c: string) => c >= '0' && c <= '9'
  const n = t.length
  const best: [number, number][] = Array.from({ length: n + 1 }, () => [Infinity, Infinity])
  best[n] = [0, 0]
  for (let i = n - 1; i >= 0; i--) {
    for (let k = 0; k < 2; k++) {
      const a = Math.min(1 + best[i + 1][0], 1 + best[i][1])
      const pair = i + 1 < n && isD(t[i]) && isD(t[i + 1]) ? 1 + best[i + 2][1] : Infinity
      const c = Math.min(pair, 1 + best[i][0])
      best[i] = [Math.min(best[i][0], a), Math.min(best[i][1], c)]
    }
  }
  return Math.min(best[0][0], best[0][1])
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ACHADOS CONFIRMADOS
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate adversarial — A1 [HIGH] a marca d\'água vaza o ESTADO DE TEXTO do pdfkit para o conteúdo da família', () => {
  // `drawWatermark` faz save()/restore() — que só guardam a matriz (q/Q) — e troca `doc.font`/`fontSize`/`fillColor` (estado JS do pdfkit) sem
  // devolver. No `sheetStart` (que roda também nas folhas que o pdfkit abre SOZINHO no transbordo), o texto da família que continua depois da
  // quebra sai com a fonte, o tamanho, a COR e a OPACIDADE da marca (o LineWrapper do pdfkit reaplica `doc._fillColor` depois da quebra).

  it('[CORRIGIDO — ACHADO HIGH] A1a — transbordo automático: 120 linhas em Times 9 pt viram Helvetica 50 pt cinza K35 a 40 % da folha 2 em diante (4 folhas em vez de 2)', async () => {
    const w = createPdf({ marginCm: 0.5, title: 'A1a', creationDate: FIXED, sheetStart: d => { drawWatermark(d, 'SEM VALOR FISCAL', MARK) } })
    registerFontRoles(w.doc, { content: 'Times-Roman' })
    w.doc.font('content').fontSize(9).fillColor('black')
    w.doc.text(Array.from({ length: 120 }, (_, i) => `item ${i + 1}`).join('\n'))
    const pages = pageOps(await w.end())
    expect({
      folhas: pages.length,
      // o 1º Tf de cada folha é o da marca (50 pt); todo o resto é texto da família e tem de ser 9 pt
      tamanhosDaFamilia: [...new Set(pages.flatMap(p => tfSizes(p).slice(1)))],
      // o cinza K35 só pode aparecer DENTRO da marca (uma vez por folha)
      cinzaForaDaMarca: pages.map(p => (p.match(/0 0 0 0\.35 scn/g) ?? []).length - 1),
    }).toEqual({ folhas: 2, tamanhosDaFamilia: [9], cinzaForaDaMarca: [0, 0] })
  })

  it('[CORRIGIDO — ACHADO HIGH] A1b — folha aberta pela FAMÍLIA (addPage): o texto seguinte sai na fonte/tamanho da marca, não no que a família escolheu', async () => {
    const w = createPdf({ marginCm: 0.5, title: 'A1b', creationDate: FIXED, sheetStart: d => { drawWatermark(d, 'SEM VALOR FISCAL', MARK) } })
    registerFontRoles(w.doc, { content: 'Times-Roman' })
    w.doc.font('content').fontSize(9).text('folha 1')
    w.doc.addPage()
    w.doc.text('folha 2')
    const pages = pageOps(await w.end())
    expect(pages.map(p => tfSizes(p).slice(1))).toEqual([[9], [9]])
  })

  it('[CORRIGIDO — ACHADO HIGH] A1c — a FOLHA DE PROVA do pdf-writer.test.ts tem 15 folhas, não 3: 14 delas com os itens em Helvetica 50 (o teste só confere total ≥ 3)', async () => {
    // cópia fiel do `proofSheet(160)` de pdf-writer.test.ts
    const w = createPdf({
      marginCm: 0.5, title: 'folha de prova NE-1b', creationDate: FIXED,
      sheetStart: doc => { drawWatermark(doc, 'SEM VALOR FISCAL', { font: 'Helvetica', sizePt: 50, color: [0, 0, 0, 35] }) },
    })
    const { doc } = w
    registerFontRoles(doc, { title: 'Times-Bold', content: 'Times-Roman', fixed: 'Courier' })
    doc.font('title').fontSize(12).text('DANFE — folha de prova', cmToPt(0.5), cmToPt(1.5))
    drawBars(doc, code128Bars(code128Symbols(KEY_ALFA)), { x: cmToPt(0.5), y: cmToPt(2.5), width: cmToPt(11.5), height: cmToPt(0.8) })
    drawMatrix(doc, qrMatrix(`https://exemplo.sefaz/consulta?chave=${KEY_ALFA}`, { ecLevel: 'M' }), { x: cmToPt(17), y: cmToPt(2.5), size: cmToPt(2) })
    doc.font('content').fontSize(9).text('', cmToPt(0.5), cmToPt(5))
    for (let i = 1; i <= 160; i++) doc.text(`item ${i} — ação, ícone, nº, ª, °, §, €`)
    const pdf = await w.end((d, { sheet, total }) => { d.font('title').fontSize(10).text(`FOLHA ${sheet}/${total}`, cmToPt(17), cmToPt(0.6), { lineBreak: false }) })
    expect(pdfPageCount(pdf)).toBe(3)
  })

  it('[CORRIGIDO — ACHADO HIGH] A1d — texto encadeado (`continued`) que transborda: a marca REUSA o LineWrapper vivo da família e quebra a cadeia (6 folhas em vez de 2)', async () => {
    const w = createPdf({ marginCm: 0.5, title: 'A1d', creationDate: FIXED, sheetStart: d => { drawWatermark(d, 'SEM VALOR FISCAL', MARK) } })
    const { doc } = w
    doc.font('Times-Roman').fontSize(9).text('Informações complementares: ', 20, 700, { continued: true, width: 500 })
    doc.font('Times-Bold').text(Array.from({ length: 200 }, (_, i) => `palavra${i}`).join(' '), { continued: true })
    doc.font('Times-Roman').text(' FIM.')
    expect(pdfPageCount(await w.end())).toBe(2)
  })
})

describe('NE-1b gate adversarial — A2 [MEDIUM] a marca d\'água não é linha única: quebra linha e ABRE FOLHA', () => {
  // `lineBreak: false` não desliga a quebra quando há `width` (o pdfkit usa o LineWrapper). Texto/tamanho que não cabe na largura da folha
  // vira várias linhas; passando do fim da folha, o pdfkit abre folha nova.

  it('[CORRIGIDO — ACHADO MEDIUM] A2a — chamada direta: "SEM VALOR FISCAL" a 140 pt numa A4 em pé ACRESCENTA uma folha e muda a folha corrente da família', async () => {
    const w = createPdf({ marginCm: 0.5, title: 'A2a', creationDate: FIXED })
    const before = w.doc.page
    drawWatermark(w.doc, 'SEM VALOR FISCAL', { font: 'Helvetica', sizePt: 140, color: 'gray', opacity: 0.3 })
    expect({ folhas: w.doc.bufferedPageRange().count, mesmaFolha: w.doc.page === before }).toEqual({ folhas: 1, mesmaFolha: true })
    await w.end()
  })

  it('[CORRIGIDO — ACHADO MEDIUM] A2b — no sheetStart, a 150 pt: cada folha da marca abre outra — recursão até estourar a pilha (~500 folhas, "Maximum call stack")', () => {
    let outcome: string
    try {
      const w = createPdf({ marginCm: 0.5, title: 'A2b', creationDate: FIXED, sheetStart: d => { drawWatermark(d, 'SEM VALOR FISCAL', { font: 'Helvetica', sizePt: 150, color: 'gray' }) } })
      outcome = `ok:${w.doc.bufferedPageRange().count}`
    } catch (e) {
      outcome = /base de PDF/.test((e as Error).message) ? 'recusa-legivel' : `estouro:${(e as Error).message}`
    }
    expect(['ok:1', 'recusa-legivel']).toContain(outcome)
  })
})

describe('NE-1b gate adversarial — A3 [MEDIUM] cor não validada: o pdfkit ignora em silêncio ou grava operando inválido', () => {
  const bars = () => code128Bars(code128Symbols('41261007742094000113550010000000071000000075'))

  it('[CORRIGIDO — ACHADO MEDIUM] A3a — nome de cor inválido ("preto", "blak") é IGNORADO: as barras saem na cor corrente (branca → código de barras invisível)', async () => {
    const w = createPdf({ marginCm: 1, title: 'A3a', creationDate: FIXED })
    w.doc.fillColor('white')
    let refused = false
    try { drawBars(w.doc, bars(), { x: 20, y: 20, width: cmToPt(11.5), height: cmToPt(0.8) }, { color: 'preto' }) } catch (e) { refused = e instanceof RangeError }
    const pdf = await w.end()
    if (refused) { expect(rects(pageOps(pdf)[0] ?? '')).toEqual([]); return }     // recusa LIMPA: nada desenhado
    const ops = pageOps(pdf)[0]
    const firstRect = ops.indexOf(' re\n')
    const block = ops.slice(ops.lastIndexOf('q\n', firstRect), firstRect)
    // ou a base recusa a cor, ou o bloco das barras define a própria cor de preenchimento
    expect(/scn?\n/.test(block)).toBe(true)
  })

  it('[CORRIGIDO — ACHADO MEDIUM] A3b — marca d\'água com cor inválida PERDE A OPACIDADE (sai opaca, na cor corrente) — o pdfkit só aplica a opacidade quando a cor vale', async () => {
    const w = createPdf({ marginCm: 1, title: 'A3b', creationDate: FIXED })
    let refused = false
    try { drawWatermark(w.doc, 'CANCELADA', { font: 'Helvetica', sizePt: 50, color: 'cinza', opacity: 0.2 }) } catch (e) { refused = e instanceof RangeError }
    const ops = pageOps(await w.end())[0]
    expect(refused || / gs\n/.test(ops)).toBe(true)
  })

  it('[CORRIGIDO — ACHADO MEDIUM] A3c — CMYK fora de 0–100 / NaN / fração pequena vai cru ao PDF: "NaN", "5" e "9.99e-10" (expoente não é número de PDF)', async () => {
    for (const color of [[0, 0, 0, NaN], [0, 0, 0, 500], [0, 0, 0, 1e-7]] as const) {
      const w = createPdf({ marginCm: 1, title: 'A3c', creationDate: FIXED })
      let refused = false
      try { drawBars(w.doc, bars(), { x: 20, y: 20, width: 300, height: 20 }, { color }) } catch (e) { refused = e instanceof RangeError }
      if (refused) continue
      const operands = colorOperands(pageOps(await w.end())[0])
      // número de PDF: sem expoente, sem NaN; componente de cor em 0–1
      expect([color[3], operands.every(o => /^-?\d*\.?\d+$/.test(o) && Number(o) >= 0 && Number(o) <= 1)]).toEqual([color[3], true])
    }
  })
})

describe('NE-1b gate adversarial — A4 [MEDIUM] o WinAnsi só vale para quem LEMBRA de chamar `toWinAnsi`', () => {
  // fonts.ts prometia: "Texto fora do WinAnsi … NÃO chega ao pdfkit". No caminho `doc.text` com um papel de fonte chegava: o pdfkit codifica
  // U+03A9 como "3a9" (3 dígitos hex) e DESALINHA o resto da linha — o texto sai corrompido em silêncio. D-NE126 (Valdo 2026-10-17 — Q-NE126 (b)):
  // a GARANTIA é de construção — `writeText` é a porta de texto da família e sempre passa pelo `toWinAnsi`; `doc.text` direto fica FORA da
  // garantia (a cerca que o proíbe na família nasce com o DANFE, NE-5).
  it('[CORRIGIDO — ACHADO MEDIUM] A4 — "AΩB 10μm ok" escrito pela porta da base (`writeText`) sai "A?B 10?m ok" no PDF, com 2 trocas contadas', async () => {
    const w = createPdf({ marginCm: 1, title: 'A4', creationDate: FIXED, fontRoles: { content: 'Times-Roman' } })
    const input = 'AΩB 10μm ok'
    expect(writeText(w.doc, 'content', input, { sizePt: 9, lineBreak: false })).toEqual({ replaced: 2 })
    const lines = pdfTextByStream(await w.end()).flat()
    expect(lines).toContain(toWinAnsi(input).text)
    expect(toWinAnsi(input).text).toBe('A?B 10?m ok')
  })
})

describe('NE-1b gate adversarial — achados LOW', () => {
  it('[CORRIGIDO — ACHADO LOW] A5 — passada por folha ASSÍNCRONA (o tipo `=> void` aceita `async`) perde o "FOLHA n/N" em silêncio: o desenho cai depois do end()', async () => {
    const w = createPdf({ marginCm: 1, title: 'A5', creationDate: FIXED })
    w.doc.addPage()
    let outcome: string
    try {
      const pdf = await w.end((async (d: PDFKit.PDFDocument, { sheet, total }: { sheet: number; total: number }) => {
        await null
        d.text(`FOLHA ${sheet}/${total}`, 50, 50, { lineBreak: false })
      }) as any)
      outcome = pdfTextByStream(pdf).flat().filter(l => l.startsWith('FOLHA ')).length === 2 ? 'desenhou' : 'perdeu-calado'
    } catch { outcome = 'recusou' }
    expect(outcome).not.toBe('perdeu-calado')
  })

  it('[CORRIGIDO — ACHADO LOW] A6 — `doc.flushPages()` (API pública do pdfkit) faz a passada ver só o resto: "1/1" na 6ª folha, nada nas 5 primeiras — total errado em silêncio', async () => {
    const seen: string[] = []
    let outcome: string
    try {
      const w = createPdf({ marginCm: 1, title: 'A6', creationDate: FIXED })
      for (let i = 0; i < 4; i++) w.doc.addPage()
      w.doc.flushPages()
      w.doc.addPage()
      await w.end((_d, info) => { seen.push(`${info.sheet}/${info.total}`) })
      outcome = seen.join(',')
    } catch { outcome = 'recusou' }
    expect(['recusou', '1/6,2/6,3/6,4/6,5/6,6/6']).toContain(outcome)
  })

  it('[CORRIGIDO — ACHADO LOW] A7 — `creationDate` inválida passa no createPdf (o título é validado lá) e só explode no end() com "Invalid time value"', () => {
    expect(() => createPdf({ marginCm: 1, title: 'A7', creationDate: new Date('não é data') })).toThrow(RangeError)
  })

  it('[CORRIGIDO — ACHADO LOW] A8 — ângulo NaN e caixa finita ≥ 1e21 passam na validação: o pdfkit lança Error genérico DEPOIS do save() — `q` aberto e pilha de matriz desbalanceada', () => {
    const outcomes: string[] = []
    const probe = (name: string, f: (doc: PDFKit.PDFDocument) => void) => {
      const { doc } = createPdf({ marginCm: 1, title: 'A8', creationDate: FIXED })
      const depth = (doc as any)._ctmStack.length
      try { f(doc); outcomes.push(`${name}:aceitou`) } catch (e) {
        outcomes.push(`${name}:${e instanceof RangeError && (doc as any)._ctmStack.length === depth ? 'recusa-limpa' : 'erro-sujo'}`)
      }
    }
    probe('angulo', doc => { drawWatermark(doc, 'X', { font: 'Helvetica', sizePt: 20, color: 'gray', angleDeg: NaN }) })
    probe('barras', doc => { drawBars(doc, code128Bars(code128Symbols('1234')), { x: 1e21, y: 0, width: 100, height: 10 }) })
    probe('matriz', doc => { drawMatrix(doc, qrMatrix('A', { ecLevel: 'L' }), { x: 0, y: 1e21, size: 10 }) })
    expect(outcomes).toEqual(['angulo:recusa-limpa', 'barras:recusa-limpa', 'matriz:recusa-limpa'])
  })

  it('[CORRIGIDO — ACHADO LOW] A9 — papel de fonte com nome do Object.prototype ("toString", "constructor") é aceito e o 1º texto quebra com TypeError obscuro', () => {
    for (const role of ['toString', 'constructor']) {
      const { doc } = createPdf({ marginCm: 1, title: 'A9', creationDate: FIXED })
      let outcome: string
      try {
        registerFontRoles(doc, { [role]: 'Times-Roman' } as any)
        doc.font(role).text('abc')
        outcome = 'funcionou'
      } catch (e) { outcome = e instanceof RangeError ? 'recusou-no-registro' : `quebrou:${(e as Error).message}` }
      expect([role, ['funcionou', 'recusou-no-registro'].includes(outcome)]).toEqual([role, true])
    }
  })

  it('[CORRIGIDO — ACHADO LOW] A10 — `code128Bars` aceita símbolos FORJADOS: Start B, DV declarado errado (ignorado), CODE B/Stop/Start no meio, dados vazios', () => {
    const forged: Record<string, { start: number; data: number[]; check: number }> = {
      startB: { start: 104, data: [33, 34], check: (104 + 33 + 68) % 103 },
      dvErrado: { start: 105, data: [12, 34], check: 99 },
      codeB: { start: 105, data: [100, 33], check: 0 },
      stopNoMeio: { start: 105, data: [106, 12], check: 0 },
      startNoMeio: { start: 105, data: [103, 12], check: 0 },
      vazio: { start: 105, data: [], check: 105 % 103 },
    }
    const accepted = Object.entries(forged).filter(([, s]) => { try { code128Bars(s); return true } catch { return false } }).map(([k]) => k)
    expect(accepted).toEqual([])
  })

  it('[CORRIGIDO — ACHADO LOW] A11 — o desenho confia na FORMA: linhas maiores que `size` desenham fora da caixa, linhas não-array não desenham nada (e devolvem sucesso), `modules` incoerente com `widths` estica as barras', () => {
    const { doc } = createPdf({ marginCm: 1, title: 'A11', creationDate: FIXED })
    const box = { x: 0, y: 0, size: 10 }
    const accepted: string[] = []
    const tryDraw = (name: string, f: () => unknown) => { try { f(); accepted.push(name) } catch { /* recusou */ } }
    tryDraw('linhas-longas', () => drawMatrix(doc, { size: 2, rows: [[true, true, true, true], [true, true, true, true]] }, box))
    tryDraw('linhas-nao-array', () => drawMatrix(doc, { size: 2, rows: [{} as any, {} as any] }, box))
    tryDraw('modules-incoerente', () => drawBars(doc, { widths: [1, 1, 1], modules: 1 }, { x: 0, y: 0, width: 100, height: 10 }))
    expect(accepted).toEqual([])
  })

  it('[CORRIGIDO — ACHADO LOW] A12 — `qrMatrix` lê `ecLevel` DUAS vezes (valida uma, usa outra): um getter injeta opção na string da lib ("L includetext" passa)', () => {
    let reads = 0
    const opts = { get ecLevel() { reads++; return (reads === 1 ? 'M' : 'L includetext') as any } }
    let outcome: string
    try { qrMatrix('https://exemplo/abc', opts); outcome = `aceitou:${reads}` } catch { outcome = `recusou:${reads}` }
    expect(['aceitou:1', 'recusou:1']).toContain(outcome)
  })

  it('[CORRIGIDO — ACHADO LOW] A12b — recusa por tamanho chega com a mensagem da LIB (Error "bwipp.…"), não com o RangeError da base', () => {
    const errs: unknown[] = []
    try { qrMatrix('a'.repeat(2954), { ecLevel: 'L' }) } catch (e) { errs.push(e) }
    try { code128Bars(code128Symbols('1'.repeat(1000))) } catch (e) { errs.push(e) }
    expect(errs.map(e => e instanceof RangeError && !/bwipp/.test((e as Error).message))).toEqual([true, true])
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ATAQUES QUE RESISTIRAM (verdes — ficam como regressão)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate adversarial — Code-128 resistiu', () => {
  it('EXAUSTIVO: as 4.096 formas de CNPJ (letra × dígito em cada uma das 12 posições) — leitor lê a chave, DV da lib = o nosso, comprimento ÓTIMO (A/C), cabe nas 539 posições', () => {
    let maxPositions = 0
    for (let mask = 0; mask < 4096; mask++) {
      let cnpj = ''
      for (let b = 0; b < 12; b++) cnpj += (mask >> b) & 1 ? 'KXZAQ'[b % 5] : String((b * 7 + mask) % 10)
      const key = `412610${cnpj}${'55001000000007100000007'}5`.slice(0, 44).padEnd(44, '3')
      const s = code128Symbols(key)
      const bars = code128Bars(s)
      const decoded = decodeCode128(bars.widths)
      if (decoded.text !== key || decoded.values.join() !== [s.start, ...s.data, s.check, 106].join() || s.data.length !== optimalAC(key)) {
        throw new Error(`falhou em ${key}: ${decoded.text} ${s.data.length}/${optimalAC(key)}`)
      }
      expect(s.start).toBe(CODE128.START_C)
      maxPositions = Math.max(maxPositions, bars.modules + 20)
    }
    expect(maxPositions).toBeLessThanOrEqual(539)
    expect(11.5 / maxPositions).toBeGreaterThanOrEqual(0.02)
  })

  it('cada posição do CNPJ × cada letra A–Z (312 chaves): ida e volta pelo leitor', () => {
    for (let p = 6; p < 18; p++) {
      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        const key = `${'41261007742094000113550010000000071000000075'.slice(0, p)}${letter}${'41261007742094000113550010000000071000000075'.slice(p + 1)}`
        expect(decodeCode128(code128Bars(code128Symbols(key)).widths).text).toBe(key)
      }
    }
  })

  it('20.000 textos [0-9A-Z] de 1 a 20: nunca mais símbolos que o ótimo A/C (as orientações da NT minimizam de fato)', () => {
    const rnd = seeded(103)
    const AN = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    for (let k = 0; k < 20000; k++) {
      const len = 1 + Math.floor(rnd() * 20)
      const t = Array.from({ length: len }, () => (rnd() < 0.7 ? String(Math.floor(rnd() * 10)) : AN[10 + Math.floor(rnd() * 26)])).join('')
      if (code128Symbols(t).data.length !== optimalAC(t)) throw new Error(`não ótimo: ${t}`)
    }
  })

  it('bordas curtas: 1 caractere, 2/3 dígitos, letra-dígito alternados — ida e volta', () => {
    for (const t of ['0', '9', 'A', 'Z', '00', '000', '0000', 'AA', '0A', 'A0', '1A1A1A1A1A1A1A1A', 'A1A1A1A1A1A1A1A', '12345', 'A12345', 'A123456', '1234567A']) {
      expect([t, decodeCode128(code128Bars(code128Symbols(t)).widths).text]).toEqual([t, t])
    }
  })

  it('parecidos com dígito/letra e não-texto são recusados (sem `i` nem `u` na regex — o [0-9A-Z] é literal)', () => {
    const bad: unknown[] = ['１２３４', '٤١٢٦', '۴۱', 'K', 'İ', 'ß', 'ﬁ', 'Å', '1234\n', '\n1234', '1234\u0000', '12‍34', '12﻿34', 'Ⅻ', '¹²',
      new String('1234'), ['1', '2'], { toString: () => '1234' }, 1234, Symbol.iterator]
    for (const t of bad) expect(() => code128Symbols(t as any)).toThrow(RangeError)
  })

  it('PONTA A PONTA no pdfkit REAL: os retângulos gravados no PDF, remontados em módulos, decodificam a chave alfanumérica (margem clara de 10 módulos)', async () => {
    const w = createPdf({ marginCm: 1, title: 'barras', creationDate: FIXED })
    const box = { x: cmToPt(1), y: cmToPt(3), width: cmToPt(11.5), height: cmToPt(0.8) }
    const drawn = drawBars(w.doc, code128Bars(code128Symbols(KEY_ALFA)), box)
    const r = rects(pageOps(await w.end())[0]).sort((a, b) => a[0] - b[0])
    const m = drawn.modulePt
    expect(r[0][0]).toBeCloseTo(box.x + 10 * m, 4)
    expect(r[r.length - 1][0] + r[r.length - 1][2]).toBeCloseTo(box.x + box.width - 10 * m, 4)
    const widths: number[] = []
    r.forEach((q, i) => {
      widths.push(Math.round(q[2] / m))
      if (i < r.length - 1) widths.push(Math.round((r[i + 1][0] - (q[0] + q[2])) / m))
    })
    expect(decodeCode128(widths).text).toBe(KEY_ALFA)
    expect(drawn.moduleCm).toBeGreaterThanOrEqual(0.02)
  })
})

describe('NE-1b gate adversarial — QR resistiu', () => {
  it('PONTA A PONTA no pdfkit REAL: a matriz remontada dos retângulos do PDF é lida pelo jsQR igual à URL', async () => {
    const url = `https://www.fazenda.pr.gov.br/nfce/qrcode?p=${KEY_ALFA}|2|1|1|ABCDEF0123456789`
    const m = qrMatrix(url, { ecLevel: 'M' })
    const w = createPdf({ marginCm: 1, title: 'qr', creationDate: FIXED })
    const box = { x: cmToPt(2), y: cmToPt(2), size: cmToPt(3) }
    const drawn = drawMatrix(w.doc, m, box)
    const grid = Array.from({ length: m.size }, () => Array<boolean>(m.size).fill(false))
    for (const [x, y, wd] of rects(pageOps(await w.end())[0])) {
      const row = Math.round((y - box.y) / drawn.modulePt)
      const c0 = Math.round((x - box.x) / drawn.modulePt)
      for (let c = c0; c < c0 + Math.round(wd / drawn.modulePt); c++) grid[row][c] = true
    }
    expect(readQr({ size: m.size, rows: grid })).toBe(url)
  })

  it('no limite EXATO de capacidade (L 2953 / H 1273 bytes) a matriz ainda é lida de volta inteira', () => {
    for (const [ecLevel, n] of [['L', 2953], ['H', 1273]] as const) {
      const t = 'a'.repeat(n)
      const m = qrMatrix(t, { ecLevel })
      expect(m.size).toBe(177)
      expect(readQr(m, 2)).toBe(t)
    }
  })

  it('o "^" é literal (a lib não está com `parse` ligado): "^065^066" volta "^065^066", não "AB"', () => {
    for (const t of ['^065^066', 'a^FNC1b', '^NUL', 'x  y', ' ']) expect(readQr(qrMatrix(t, { ecLevel: 'M' }), 4)).toBe(t)
  })

  it('controle ASCII, DEL e não-texto são recusados', () => {
    for (const t of ['\x7f', 'a\x00b', 'a\tb', 'a\rb', new String('abc'), 42]) expect(() => qrMatrix(t as any, { ecLevel: 'M' })).toThrow(RangeError)
    for (const ec of ['m', ' M', 'M ', '', null]) expect(() => qrMatrix('abc', { ecLevel: ec as any })).toThrow(RangeError)
  })
})

describe('NE-1b gate adversarial — WinAnsi resistiu', () => {
  it('surrogates soltos, BOM, U+FFFD, combinante sem base, separadores Unicode, NEL/VT/FF viram "?" contados; NFC compõe o Ångström', () => {
    expect(toWinAnsi('\uD800x\uDC00﻿�́a  \u0085\u000B\u000C')).toEqual({ text: '?x????a?????', replaced: 10 })
    expect(toWinAnsi('Å Å')).toEqual({ text: 'Å Å', replaced: 0 })
    expect(toWinAnsi('ﬁ ½ ２ 😀😀')).toEqual({ text: '? ½ ? ??', replaced: 4 })
  })

  it('texto grande (2 MB) é linear — sem custo quadrático', () => {
    const t0 = Date.now()
    const r = toWinAnsi('ação €→'.repeat(300_000))
    expect(r.replaced).toBe(300_000)
    expect(Date.now() - t0).toBeLessThan(5000)
  })
})

describe('NE-1b gate adversarial — escritor resistiu', () => {
  it('200 folhas: sheetStart 200 vezes em ordem, a passada vê 1…200 com total 200 e o "FOLHA i/200" fica POR CIMA em cada folha; x/y da família preservados', async () => {
    const opened: number[] = []
    const w = createPdf({ marginCm: 0.5, title: '200 folhas', creationDate: FIXED, sheetStart: (d, n) => { opened.push(n); drawWatermark(d, 'SEM VALOR FISCAL', MARK) } })
    for (let i = 1; i < 200; i++) w.doc.addPage()
    w.doc.text('', 123, 456)
    const familyXY = [w.doc.x, w.doc.y]
    const xy: number[][] = []
    const pdf = await w.end((d, { sheet, total }) => {
      xy.push([d.x, d.y])
      d.font('Times-Bold').fontSize(8).text(`FOLHA ${sheet}/${total}`, 400, 20, { lineBreak: false })
    })
    // re-gate S3 (2026-10-17): a passada entra SEMPRE na posição de uma folha nova (margens) — não no x/y que sobrou do conteúdo; a posição da
    // família volta intacta depois de cada folha (a passada é isolada — D-NE128)
    const { left, top } = w.doc.page.margins
    expect(new Set(xy.map(p => p.join()))).toEqual(new Set([`${left},${top}`]))
    expect([w.doc.x, w.doc.y]).toEqual(familyXY)
    expect(opened).toEqual(Array.from({ length: 200 }, (_, i) => i + 1))
    const pages = pdfTextByStream(pdf)
    expect(pages).toHaveLength(200)
    pages.forEach((lines, i) => expect([lines[0], lines[lines.length - 1]]).toEqual(['SEM VALOR FISCAL', `FOLHA ${i + 1}/200`]))
  })

  it('reentrância: end() dentro da passada é recusado; passada ou sheetStart que lançam propagam o erro (nunca PDF calado)', async () => {
    const w = createPdf({ marginCm: 1, title: 'reentra', creationDate: FIXED })
    expect(() => w.end(() => { w.end() })).toThrow(/já foi fechado/)
    const w2 = createPdf({ marginCm: 1, title: 'lança', creationDate: FIXED })
    expect(() => w2.end(() => { throw new Error('boom') })).toThrow('boom')
    expect(() => createPdf({ marginCm: 1, title: 'x', sheetStart: () => { throw new Error('início') } })).toThrow('início')
  })

  it('a passada que escreve perto do PÉ da folha (transbordaria) falha alto em vez de abrir folha e errar o total', () => {
    const w = createPdf({ marginCm: 1, title: 'pé', creationDate: FIXED })
    expect(() => w.end((d, { sheet, total }) => { d.text(`Folha ${sheet}/${total}`, 30, d.page.height - 5, { width: 200 }) })).toThrow(/abriu folha nova/)
  })

  it('margens, papel e título absurdos são recusados no createPdf (RangeError)', () => {
    const bad: any[] = [
      { marginCm: Infinity, title: 'x' }, { marginCm: -0.0001, title: 'x' }, { marginCm: '1', title: 'x' }, { marginCm: null, title: 'x' },
      { marginCm: { top: 1, right: 1, bottom: 1 }, title: 'x' }, { marginCm: 1, title: '' }, { marginCm: 1, title: 42 },
      { marginCm: 1, title: 'x', paper: 'a4' }, { marginCm: 1, title: 'x', paper: { widthCm: NaN, heightCm: 10 } },
    ]
    for (const opts of bad) expect(() => createPdf(opts)).toThrow(RangeError)
  })
})

describe('NE-1b gate adversarial — cercas resistiram (varredura INDEPENDENTE, mais larga que a do pdf-cerca)', () => {
  // A cerca do pdf-cerca.test.ts compara o especificador EXATO ('bwip-js'/'pdfkit') e só vê StringLiteral: subpath ('bwip-js/node',
  // 'pdfkit/js/pdfkit') e template literal (require(`bwip-js`)) passariam. Esta varredura olha TODO literal de texto do código (string e
  // template) e casa também os subpaths — hoje nada escapa.
  const SRC = path.resolve(__dirname, '..')
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? (d.name === '__tests__' ? [] : walk(path.join(dir, d.name))) : /\.(c|m)?[tj]s$/.test(d.name) && !/\.test\./.test(d.name) ? [path.join(dir, d.name)] : [])
  const literals = (file: string): string[] => {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const out: string[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n)) out.push(n.text)
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return out
  }
  const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, '/')

  it('nenhum literal fora de `pdf/` nomeia `pdfkit` ou `bwip-js` (nem subpath); `bwip-js` só em `pdf/barcode/lib.ts`', () => {
    const hits = walk(SRC).flatMap(f => literals(f).filter(l => /^(pdfkit|bwip-js)(\/|$)/.test(l)).map(l => `${rel(f)} → ${l}`))
    expect(hits.filter(h => !h.startsWith('pdf/') && !h.startsWith('pdf.ts'))).toEqual([])
    expect(hits.filter(h => /→ bwip-js/.test(h)).map(h => h.split(' → ')[0])).toEqual(['pdf/barcode/lib.ts'])
  })
})
