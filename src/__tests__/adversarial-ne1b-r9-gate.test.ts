/// <reference types="jest" />
// GATE ADVERSARIAL do DELTA 428e282..c99309e da NE-1b (revisor independente, 2026-10-17 — skill `testar-adversarial.md`): ataques às decisões
// D-NE135 (linha única com encadeado ABERTO → recusa), D-NE136 (`continued` com `lineBreak: false` → recusa), D-NE137 (espaços do FIM não contam
// na linha única), ao `assertStandardFontIntact` (gate final F-L2), ao `broken` da D-NE134 (gate final F-L3), ao `end()` com `save()` aberto
// (socrático L3), à guarda por FOLHA do `isolated` (`savedOn`, `GUARD`/`rawOf` — gate final F-L4 / socrático L2) e à recusa sem largura útil
// (gate final F-L5). Os gates anteriores estão em `adversarial-ne1b-gate`, `-delta-gate`, `-r7-gate` e `-final-gate` (não repetidos aqui).
//
// Ataque que RESISTIU fica como teste verde; achado CONFIRMADO fica como `it.failing` com o rótulo "[ACHADO <SEVERIDADE>]" — o corpo afirma o
// comportamento CORRETO (recusa legível da base OU o PDF certo), então quando a correção entrar o `it.failing` passa a FALHAR e vira `it` comum.
import fs from 'fs'
import path from 'path'
import PDFDocument from 'pdfkit'
import { createPdf, writeText, measureText, drawBars, drawWatermark, code128Bars, code128Symbols, cmToPt } from '../pdf'
import { pdfContentOps, pdfTextRuns, pdfPageCount } from './pdf-oracle'

const FIXED = new Date('2026-10-17T03:00:00Z')
const ROLES = { title: 'Times-Bold', content: 'Times-Roman', fixed: 'Courier' } as const
const BARS = code128Bars(code128Symbols('41261040001355500100000000710000000075'))
const BOX = { x: 30, y: 30, width: cmToPt(11.5), height: 12 }
const lines = (n: number, p = 'linha') => Array.from({ length: n }, (_, i) => `${p} ${i + 1}`).join('\n')
const internals = (doc: PDFKit.PDFDocument) => doc as unknown as Record<string | symbol, any>
const fontsOf = (pdf: Buffer) => [...pdf.toString('latin1').matchAll(/\/BaseFont \/(\S+)/g)].map(m => m[1])
const errorOf = (fn: () => unknown): Error | null => { try { fn(); return null } catch (e) { return e as Error } }
const sheetsOf = (doc: PDFKit.PDFDocument): number => internals(doc)._pageBuffer.length
const contentLength = (doc: PDFKit.PDFDocument): number => (doc.page as any).content.uncompressedLength
const PROTO = PDFDocument.prototype as unknown as { save: unknown; restore: unknown }
/** Nenhuma guarda do `isolated` sobrou no documento e a pilha de `save()` está vazia. */
const clean = (doc: PDFKit.PDFDocument) => ({
  ownSave: Object.prototype.hasOwnProperty.call(doc, 'save'), ownRestore: Object.prototype.hasOwnProperty.call(doc, 'restore'),
  protoSave: doc.save === PROTO.save, protoRestore: doc.restore === PROTO.restore, stack: internals(doc)._ctmStack.length,
})
const CLEAN = { ownSave: false, ownRestore: false, protoSave: true, protoRestore: true, stack: 0 }

interface ViewerRun { readonly text: string; readonly clipped: boolean }
/** Como o LEITOR vê a folha (o oráculo dos gates R7/final): `Q` órfão ignorado; recorte vigente por trecho; profundidade final e mínima do q/Q. */
function viewer(ops: string): { runs: ViewerRun[]; final: number; min: number } {
  let clipped = false
  const stack: boolean[] = []
  const runs: ViewerRun[] = []
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ACHADOS CONFIRMADOS — LOW (nenhum HIGH/CRITICAL)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate R9 — [ACHADO LOW] R9-L1: o `assertStandardFontIntact` confere ANTES de ler as opções/o texto — um getter/toString sobrepõe a fonte DEPOIS da conferência (TOCTOU)', () => {
  /**
   * `writeText`/`measureText` chamam `fontOfRole` (que confere o nome da fonte-padrão) ANTES de `snapshotOptions` e de `String(text)`; o
   * `drawWatermark` confere ANTES do `normalizeColor`, que lê os elementos do CMYK. Código de quem chama que rode nesse intervalo (getter de opção,
   * `toString` do texto, getter de elemento da cor) e faça `doc.registerFont('Times-Roman', 'Symbol')` passa pela conferência: a porta do WinAnsi
   * desenha/mede em Symbol. É a classe do R7-L5 (estado lido antes de terminar a leitura) sobre a defesa F-L2. Mau uso deliberado de API interna do
   * pdfkit (registerFont) por código da família — LOW. Correção sugerida: conferir a fonte DEPOIS de ler opções, texto e estilo (imediatamente antes
   * do `doc.font`), e copiar o CMYK uma vez (`Array.from`) antes de validar.
   */
  it('[CORRIGIDO — ACHADO LOW] R9-L1a — writeText: getter da opção `y` registra Symbol sob "Times-Roman" depois da conferência — o PDF sai em Symbol', async () => {
    const w = createPdf({ marginCm: 1, title: 'R9L1a', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    const opts = { x: 40, get y() { d.registerFont('Times-Roman', 'Symbol'); return 40 } }
    const refused = errorOf(() => writeText(d, 'content', 'abc', opts as never))
    const pdf = await w.end()
    if (refused) { expect(refused).toBeInstanceOf(RangeError); return }                // recusa legível = correção aceita
    expect(fontsOf(pdf)).toEqual(['Times-Roman'])                                       // hoje: ['Symbol']
  })

  it('[CORRIGIDO — ACHADO LOW] R9-L1b — measureText: o `toString` do texto registra Symbol depois da conferência — a largura medida é a da Symbol (0 pt)', () => {
    const control = measureText(createPdf({ marginCm: 1, title: 'c', fontRoles: ROLES }).doc, 'content', 'abc', { sizePt: 10 }).width
    const d = createPdf({ marginCm: 1, title: 'R9L1b', fontRoles: ROLES }).doc
    const text = { toString() { d.registerFont('Times-Roman', 'Symbol'); return 'abc' } }
    let width: number | null = null
    const refused = errorOf(() => { width = measureText(d, 'content', text as never, { sizePt: 10 }).width })
    if (refused) { expect(refused).toBeInstanceOf(RangeError); return }
    expect(width).toBeCloseTo(control, 6)                                               // hoje: 0 (a Symbol não tem "abc" no WinAnsi)
  })

  it('[CORRIGIDO — ACHADO LOW] R9-L1c — drawWatermark: getter de um elemento do CMYK registra Symbol depois da conferência — a marca sai em Symbol', async () => {
    const w = createPdf({ marginCm: 1, title: 'R9L1c', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    let armed = true
    const color: number[] = [0, 0, 0, 0]
    Object.defineProperty(color, 3, { get() { if (armed) { armed = false; d.registerFont('Times-Roman', 'Symbol') } return 35 } })
    const refused = errorOf(() => drawWatermark(d, 'SEM VALOR', { font: 'Times-Roman', sizePt: 40, color: color as never }))
    const pdf = await w.end()
    if (refused) { expect(refused).toBeInstanceOf(RangeError); return }
    expect(fontsOf(pdf)).toEqual(['Times-Roman'])                                       // hoje: ['Symbol']
  })
})

describe('NE-1b gate R9 — [ACHADO LOW] R9-L2: fonte EMBUTIDA cujo nome PostScript é o de uma fonte-padrão passa pela conferência (só o `name` é comparado)', () => {
  /**
   * `assertStandardFontIntact` aceita o cache `_fontFamilies["Times-Roman"]` quando `cached.name === "Times-Roman"` — mas o `name` de uma fonte
   * EMBUTIDA é o nome PostScript do arquivo. `doc.font(<fonte TrueType de nome PostScript "Times-Roman">, "Times-Roman")` antes do 1º uso põe a
   * fonte embutida no cache com o nome certo: a porta do WinAnsi desenha nela, o PDF embute um TrueType (contra a D-NE120 — "sem embutir") e a
   * medida vira a da outra fonte. Caso real: o `Times.ttc` do macOS tem exatamente os nomes PostScript "Times-Roman"/"Times-Bold". Exige
   * `doc.font` cru da família (a cerca da NE-5 o proíbe fora dos papéis) — LOW. Aqui a fonte OCR-B do bwip-js com o nome PostScript trocado.
   * Correção sugerida: conferir também a CLASSE do objeto em cache (fonte-padrão do pdfkit, não `EmbeddedFont` — p.ex. sem `subset`).
   */
  it('[CORRIGIDO — ACHADO LOW] R9-L2 — `doc.font(fonteEmbutida, "Times-Roman")` com nome PostScript "Times-Roman": o writeText desenha numa fonte EMBUTIDA', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fontkit = require('fontkit') as { create(b: Buffer): object }
    const real = fontkit.create(fs.readFileSync(path.join(__dirname, '../../node_modules/bwip-js/fonts/OCRB7.ttf')))
    const impostor = Object.create(real, { postscriptName: { value: 'Times-Roman' } })
    const w = createPdf({ marginCm: 1, title: 'R9L2', creationDate: FIXED, fontRoles: ROLES })
    w.doc.font(impostor, 'Times-Roman')
    const refused = errorOf(() => writeText(w.doc, 'content', 'abc', { x: 40, y: 40 }))
    const pdf = await w.end()
    if (refused) { expect(refused).toBeInstanceOf(RangeError); return }
    expect({ fonts: fontsOf(pdf), embedded: /FontFile2/.test(pdf.toString('latin1')) }).toEqual({ fonts: ['Times-Roman'], embedded: false })
  })
})

describe('NE-1b gate R9 — [ACHADO LOW] R9-L3/R9-L4: a poda da D-NE137 (`/ +$/`) não é a do pdfkit e é quadrática', () => {
  it.failing('[ACHADO LOW] R9-L3 — NBSP (U+00A0, WinAnsi 0xA0 = espaço) no FIM fica e conta: o valor alinhado à direita sai 2,5 pt fora da borda (o pdfkit, que a D-NE137 cita, poda `\\s+$` — inclusive o NBSP)', async () => {
    // O NBSP é representável no WinAnsi (vira o glifo de espaço, mesma largura) — dado de cadastro colado de planilha/HTML traz NBSP no fim.
    // A base poda só U+0020: a célula de linha única fica desalinhada da mesma célula escrita pelo caminho de várias linhas (onde o `_fragment` do
    // pdfkit poda o NBSP) e um valor que caberia sem ele é RECUSADO por "não cabe". Correção sugerida: podar `[  ]+$` (os brancos do WinAnsi
    // depois do `toWinAnsi` — tab já virou espaço).
    const w = createPdf({ marginCm: 1, title: 'R9L3', creationDate: FIXED, fontRoles: ROLES })
    const cell = { x: 300, width: 120, align: 'right' as const, lineBreak: false, sizePt: 10 }
    writeText(w.doc, 'content', '1.234,56', { ...cell, y: 100 })
    writeText(w.doc, 'content', '1.234,56 ', { ...cell, y: 120 })
    const runs = pdfTextRuns(pdfContentOps(await w.end())[0])
    expect(runs[1].x).toBeCloseTo(runs[0].x, 4)                                         // hoje: 2,5 pt à esquerda
  })

  it('[CORRIGIDO — ACHADO LOW] R9-L4 — a poda `/ +$/` é QUADRÁTICA em texto com uma corrida longa de espaços NO MEIO: 40.000 espaços custam segundos de CPU antes da recusa por largura', () => {
    // Retrocesso clássico do `\s+$`: a regex tenta casar a partir de CADA espaço, consome até o "b" e falha — O(n²). Medido: 10 mil → 0,26 s,
    // 20 mil → 1 s, 40 mil → 3,9 s. Os campos da NF-e são limitados pelo XSD (o infCpl tem 5.000 caracteres → ~0,06 s), por isso LOW. Correção
    // sugerida: podar com um laço do fim para o começo (linear) — e só DEPOIS de conferir que a largura cabe, se quiser cortar mais cedo.
    const d = createPdf({ marginCm: 1, title: 'R9L4', fontRoles: ROLES }).doc
    const text = `a${' '.repeat(40000)}b`
    const t0 = Date.now()
    expect(() => writeText(d, 'content', text, { x: 40, y: 100, width: 100, lineBreak: false, sizePt: 1 })).toThrow(/não cabe/)
    expect(Date.now() - t0).toBeLessThan(500)                                           // hoje: 2 a 4 s
  })
})

describe('NE-1b gate R9 — [ACHADO LOW] R9-L5: a guarda por folha (`savedOn`) do isolado de FORA guarda o `save()` de entrada de cada isolado de DENTRO e nunca o tira', () => {
  /**
   * Um desenho da base dentro do `sheetStart` (marca, barras, QR) roda num `isolated` ANINHADO: o `doc.save()` de entrada dele passa pela guarda
   * de `save` do isolado de fora (empilha a folha corrente no `savedOn` de fora), mas a limpeza dele fecha pelo `restore` CRU (`rawOf`) — a entrada
   * fica para sempre no `savedOn` de fora. Enquanto tudo acontece numa folha só, é inofensivo; se o `sheetStart` desenha noutra folha (switchToPage
   * e volta — o contrato só proíbe TERMINAR noutra), a entrada velha (a) faz a guarda acusar "restore() noutra folha" para um par save/restore que
   * é da MESMA folha e (b) faz a limpeza mandar o `Q` do `save()` aberto para a folha ERRADA — o PDF que ainda fecha sai com q/Q desbalanceado nas
   * duas folhas (o que a limpeza promete evitar). Regressão do delta (antes não havia `savedOn`). Exótico (classe do F-L4) — LOW. Correção sugerida:
   * o `save()` de entrada do isolado e o `restore()` final pelo CRU (`rawOf`) — ou o isolado de dentro tirar do `savedOn` de fora o que pôs.
   */
  const header = (d: PDFKit.PDFDocument, n: number) => writeText(d, 'title', `CAB ${n}`, { x: 40, y: 20, lineBreak: false })

  it('[CORRIGIDO — ACHADO LOW] R9-L5a — save() na folha 2, barras desenhadas na folha 1 e volta, restore() na folha 2: acusado como "noutra folha" e o `Q` da limpeza cai na folha 1', async () => {
    const w = createPdf({
      marginCm: 1, title: 'R9L5a', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => {
        header(d, n)
        if (n === 2) { d.save(); d.switchToPage(0); drawBars(d, BARS, BOX); d.switchToPage(1); d.restore() }
        d.y = 60
      },
    })
    const error = errorOf(() => w.doc.addPage())
    writeText(w.doc, 'content', 'corpo da folha 2', { x: 40, y: 100 })
    const after = clean(w.doc)
    const balance = balanceOf(await w.end())
    expect(after).toEqual(CLEAN)
    if (error) expect(error.message).toMatch(/^base de PDF: o sheetStart/)
    expect(balance).toEqual([{ final: 0, min: 0 }, { final: 0, min: 0 }])               // hoje: folha 1 com `Q` órfão, folha 2 com `q` aberto
  })

  it('[CORRIGIDO — ACHADO LOW] R9-L5b — save() na folha 2 deixado aberto depois de barras na folha 1: o erro de uso sobe, mas a limpeza fecha o `save()` na folha 1', async () => {
    const w = createPdf({
      marginCm: 1, title: 'R9L5b', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => {
        header(d, n)
        if (n === 2) { d.save(); d.switchToPage(0); drawBars(d, BARS, BOX); d.switchToPage(1) }
        d.y = 60
      },
    })
    expect(errorOf(() => w.doc.addPage())?.message).toMatch(/^base de PDF: o sheetStart deixou save\(\) sem restore\(\)/)
    writeText(w.doc, 'content', 'corpo da folha 2', { x: 40, y: 100 })
    expect(clean(w.doc)).toEqual(CLEAN)
    expect(balanceOf(await w.end())).toEqual([{ final: 0, min: 0 }, { final: 0, min: 0 }])   // hoje: [-1, -1] e [+1, 0]
  })
})

describe('NE-1b gate R9 — [ACHADO LOW] R9-L6: fora do isolado, `save()` numa folha e `restore()` noutra (switchToPage) zeram a pilha — o `end()` aceita e o "Folha n/N" sai RECORTADO', () => {
  it.failing('[ACHADO LOW] R9-L6 — o recorte aberto na folha 1 e fechado na folha 2 deixa q/Q desbalanceado nas duas e a passada da folha 1 dentro do recorte (invisível)', async () => {
    // A D-NE134 pega o `save()` atravessando o `addPage`; o socrático L3 pega o `save()` aberto no `end()` — os dois contam a PILHA do JS. Voltar
    // a uma folha anterior (bufferPages — p.ex. preencher os totais da folha 1 depois que os itens transbordaram) e trocar de folha entre o `save()`
    // e o `restore()` deixa a pilha em zero e o PDF quebrado: o R7-L4 por outra porta. Erro de uso da família no nível de cima — LOW. Correção
    // sugerida (ver Q-NE138): `switchToPage` com `save()` da família aberto = erro de uso (a mesma regra da D-NE134).
    const w = createPdf({ marginCm: 1, title: 'R9L6', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    writeText(d, 'content', lines(120, 'item'), { x: 40, sizePt: 9 })
    expect(sheetsOf(d)).toBe(2)
    const misuse = errorOf(() => { d.switchToPage(0); d.save(); d.rect(28, 600, 300, 100).clip(); d.switchToPage(1); d.restore() })
    if (misuse) { expect(misuse.message).toMatch(/^base de PDF/); return }
    let pdf: Buffer | null = null
    let refused: Error | null = null
    try { pdf = await w.end((dd, i) => { writeText(dd, 'title', `FOLHA ${i.sheet}/${i.total}`, { x: 450, y: 20, lineBreak: false, sizePt: 8 }) }) }
    catch (e) { refused = e as Error }
    if (refused) { expect(refused.message).toMatch(/^base de PDF/); return }
    const seen = pdfContentOps(pdf!).map(viewer)
    expect(seen.map(p => ({ final: p.final, min: p.min }))).toEqual([{ final: 0, min: 0 }, { final: 0, min: 0 }])   // hoje: [+1, 0] e [-1, -1]
    expect(seen[0].runs.find(r => r.text === 'FOLHA 1/2')!.clipped).toBe(false)                                    // hoje: recortado
  })
})

describe('NE-1b gate R9 — [ACHADO LOW, fora do delta] R9-L7: o CMYK é lido elemento a elemento VÁRIAS vezes (valida um valor, grava outro)', () => {
  it('[CORRIGIDO — ACHADO LOW] R9-L7 — drawBars com um elemento do CMYK que muda entre a validação e o uso: grava "0 0 0 10000" (fora de 0–1) cru no PDF — o A3 de volta pela classe do R7-L5', async () => {
    // O `drawBars`/`drawWatermark` copiam opções/estilo UMA vez (R7-L5), mas a cor é um ARRAY que o `normalizeColor` lê 5 vezes por elemento
    // (4 no `every`, 1 no `map`). Getter deliberado — LOW. Correção sugerida: `Array.from(c)` uma vez antes de validar.
    const w = createPdf({ marginCm: 1, title: 'R9L7', creationDate: FIXED, fontRoles: ROLES })
    let reads = 0
    const color: number[] = [0, 0, 0, 0]
    Object.defineProperty(color, 3, { get() { reads++; return reads <= 4 ? 35 : 1e6 } })
    const refused = errorOf(() => drawBars(w.doc, BARS, BOX, { color: color as never }))
    const pdf = await w.end()
    if (refused) { expect(refused).toBeInstanceOf(RangeError); return }
    const operands = pdfContentOps(pdf)[0].split('\n').filter(l => / scn$/.test(l)).flatMap(l => l.split(' ').slice(0, -1).map(Number))
    expect(operands.every(v => v >= 0 && v <= 1)).toBe(true)                            // hoje: 10000
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ATAQUES QUE RESISTIRAM (verdes — ficam como regressão)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate R9 — D-NE135/D-NE136 resistiram: nenhuma cadeia aberta escapa e a recusa não deixa rastro', () => {
  const CELL = { x: 400, y: 300, width: 100, align: 'right' as const, lineBreak: false, sizePt: 9 }
  const openers: Record<string, (d: PDFKit.PDFDocument) => void> = {
    'continued com width': d => { writeText(d, 'content', 'Inf. compl.: ', { x: 40, y: 200, width: 300, continued: true }) },
    'continued sem width (largura que sobra na folha)': d => { writeText(d, 'content', 'Inf. compl.: ', { x: 40, y: 200, continued: true }) },
    'continued com texto VAZIO': d => { writeText(d, 'content', '', { x: 40, y: 200, width: 300, continued: true }) },
    'continued do fixed depois do content (cadeia de dois papéis)': d => {
      writeText(d, 'content', 'Inf.: ', { x: 40, y: 200, width: 300, continued: true }); writeText(d, 'fixed', 'ABC ', { continued: true })
    },
    'cadeia aberta pelo pdfkit cru (fora da porta)': d => { d.font('Times-Roman'); d.text('Inf. compl.: ', 40, 200, { width: 300, continued: true }) },
  }
  /** Monta o documento; `attack` tenta as escritas recusadas no meio da cadeia — o PDF tem de sair IGUAL ao de controle (sem a tentativa). */
  const build = async (open: (d: PDFKit.PDFDocument) => void, attack: boolean) => {
    const w = createPdf({ marginCm: 1, title: 'C', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    open(d)
    const errors: string[] = []
    if (attack) {
      const keys = ['_font', '_fontSize', '_fillColor', '_wrapper', '_textOptions', '_lineGap', 'x', 'y'] as const
      const before = keys.map(k => internals(d)[k])
      const len = contentLength(d)
      for (const opts of [CELL, { ...CELL, width: undefined }, { x: 400, y: 300, lineBreak: false }, { lineBreak: false }, { ...CELL, underline: true }]) {
        errors.push(errorOf(() => writeText(d, 'content', 'VALOR 1,00', opts as never))?.message ?? 'ACEITO')
      }
      for (const opts of [{ ...CELL, continued: true }, { ...CELL, continued: false }, { y: 300, lineBreak: false, continued: true }]) {
        errors.push(errorOf(() => writeText(d, 'content', 'X', opts as never))?.message ?? 'ACEITO')
      }
      expect(keys.map(k => internals(d)[k])).toEqual(before)
      keys.forEach((k, i) => { if (typeof before[i] === 'object' && before[i] !== null) expect(internals(d)[k]).toBe(before[i]) })   // os MESMOS objetos
      expect(contentLength(d)).toBe(len)
    }
    writeText(d, 'content', 'fim do texto encadeado.')                                    // a família FECHA a cadeia…
    writeText(d, 'content', 'VALOR 1,00', CELL)                                           // …e só então a célula
    const sheets = sheetsOf(d)
    return { pdf: await w.end(), errors, sheets }
  }

  for (const [name, open] of Object.entries(openers)) {
    it(`${name}: a linha única (com/sem largura, sublinhada) é recusada pela D-NE135, \`continued\` com lineBreak:false pela D-NE136 — estado e conteúdo intactos, PDF byte a byte igual ao de controle`, async () => {
      const attacked = await build(open, true)
      const control = await build(open, false)
      expect(attacked.errors).toHaveLength(8)
      expect(attacked.errors.slice(0, 5).every(m => /D-NE135/.test(m))).toBe(true)
      expect(attacked.errors.slice(5).every(m => /D-NE136/.test(m))).toBe(true)
      expect(attacked.pdf.equals(control.pdf)).toBe(true)
      expect(attacked.sheets).toBe(1)
      const runs = pdfTextRuns(pdfContentOps(attacked.pdf)[0])
      expect(runs.filter(r => r.text === 'VALOR 1,00')).toHaveLength(1)
      const cellRun = runs.find(r => r.text === 'VALOR 1,00')!
      const vw = measureText(createPdf({ marginCm: 1, title: 'm', fontRoles: ROLES }).doc, 'content', 'VALOR 1,00', { sizePt: 9 }).width
      expect(cellRun.x).toBeCloseTo(400 + 100 - vw, 4)
    })
  }

  it('o caminho que a D-NE136 indica funciona: `continued` COM width junta rótulo e número na MESMA linha, um depois do outro', async () => {
    const w = createPdf({ marginCm: 1, title: 'C2', creationDate: FIXED, fontRoles: ROLES })
    writeText(w.doc, 'title', 'CNPJ: ', { x: 40, y: 100, width: 300, continued: true })
    writeText(w.doc, 'content', '12.345.678/0001-90')
    const runs = pdfTextRuns(pdfContentOps(await w.end())[0])
    const label = measureText(createPdf({ marginCm: 1, title: 'm', fontRoles: ROLES }).doc, 'title', 'CNPJ: ').width
    expect(runs.map(r => r.text)).toEqual(['CNPJ: ', '12.345.678/0001-90'])
    expect(runs[1].yPdf).toBeCloseTo(runs[0].yPdf, 6)
    expect(runs[1].x).toBeCloseTo(runs[0].x + label, 3)
  })

  it('a cadeia ABERTA no sheetStart (deixada aberta) não vaza para a família, e a da família fica escondida durante o sheetStart (linha única lá dentro aceita, no lugar)', async () => {
    const w = createPdf({
      marginCm: 1, title: 'C3', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => {
        writeText(d, 'title', `CAB ${n}`, { x: 300, y: 20, width: 120, align: 'right', lineBreak: false })
        writeText(d, 'content', 'aberta no cabeçalho ', { x: 40, y: 40, width: 200, continued: true })   // deixada ABERTA
        d.y = 60
      },
    })
    const d = w.doc
    writeText(d, 'content', 'Inf.: ', { x: 40, y: 700, width: 300, continued: true })
    writeText(d, 'fixed', lines(40, 'w').replace(/\n/g, ' '), { continued: true })          // transborda no meio da cadeia
    writeText(d, 'content', ' FIM.')
    expect(internals(d)._wrapper).toBeNull()
    expect(() => writeText(d, 'content', 'célula', { x: 400, y: 300, width: 100, lineBreak: false })).not.toThrow()
    const pdf = await w.end()
    for (const o of pdfContentOps(pdf)) expect(pdfTextRuns(o).filter(r => r.text.startsWith('CAB'))).toHaveLength(1)
  })
})

describe('NE-1b gate R9 — D-NE137 resistiu (espaços do fim)', () => {
  const cell = { x: 300, width: 120, lineBreak: false, sizePt: 10 } as const

  it('tabulação (vira espaço), mistura tab+espaço e muitos espaços no FIM: mesma posição do texto sem eles, em right e center; o texto desenhado não leva os espaços', async () => {
    const w = createPdf({ marginCm: 1, title: 'S1', creationDate: FIXED, fontRoles: ROLES })
    const v = '1.234,56'
    const variants = [v, `${v}\t\t`, `${v} \t \t `, `${v}${' '.repeat(500)}`]
    variants.forEach((t, i) => writeText(w.doc, 'content', t, { ...cell, y: 100 + 20 * i, align: 'right' }))
    variants.forEach((t, i) => writeText(w.doc, 'content', t, { ...cell, y: 200 + 20 * i, align: 'center' }))
    const runs = pdfTextRuns(pdfContentOps(await w.end())[0])
    expect(runs.map(r => r.text)).toEqual(Array(8).fill(v))
    for (const r of runs.slice(0, 4)) expect(r.x).toBeCloseTo(runs[0].x, 6)
    for (const r of runs.slice(4)) expect(r.x).toBeCloseTo(runs[4].x, 6)
  })

  it('cabe só SEM os espaços: aceito (julgado pelo texto podado) e encostado à direita; espaços do COMEÇO contam (como no pdfkit); "abc  \\n" segue recusado', async () => {
    const w = createPdf({ marginCm: 1, title: 'S2', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    const vw = measureText(d, 'content', 'VALOR', { sizePt: 10 }).width
    const lw = measureText(d, 'content', '  VALOR', { sizePt: 10 }).width
    writeText(d, 'content', `VALOR${' '.repeat(40)}`, { ...cell, width: vw, y: 100, align: 'right' })
    writeText(d, 'content', '  VALOR', { ...cell, y: 120, align: 'right' })
    expect(() => writeText(d, 'content', 'abc  \n', { ...cell, y: 140 })).toThrow(/não leva quebra de linha/)
    expect(() => writeText(d, 'content', `  VALOR${' '.repeat(9)}`, { ...cell, width: lw - 1e-3, y: 160 })).toThrow(/não cabe/)
    const runs = pdfTextRuns(pdfContentOps(await w.end())[0])
    expect(runs.map(r => r.text)).toEqual(['VALOR', '  VALOR'])
    expect(runs[0].x).toBeCloseTo(300, 4)
    expect(runs[1].x).toBeCloseTo(300 + 120 - lw, 4)
  })

  it('sublinhado e riscado com espaços no fim: o traço cobre só o texto podado (dentro da célula); só espaços sublinhados não desenham nada (semântica da D-NE137 — Q-NE139)', async () => {
    const w = createPdf({ marginCm: 1, title: 'S3', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    const vw = measureText(d, 'content', 'TOTAL', { sizePt: 10 }).width
    writeText(d, 'content', 'TOTAL     ', { ...cell, y: 100, align: 'left', underline: true })
    writeText(d, 'content', 'TOTAL     ', { ...cell, y: 120, align: 'right', strike: true })
    writeText(d, 'content', '          ', { ...cell, y: 140, align: 'left', underline: true })
    const ops = pdfContentOps(await w.end())[0]
    const segs = [...ops.matchAll(/(-?[\d.]+) (-?[\d.]+) m\n(-?[\d.]+) (-?[\d.]+) l/g)].map(m => [Number(m[1]), Number(m[3])])
    expect(segs).toHaveLength(2)
    expect(segs[0][0]).toBeCloseTo(300, 3)
    expect(segs[0][1] - segs[0][0]).toBeCloseTo(vw, 3)
    expect(segs[1][1]).toBeCloseTo(420, 3)
    expect(segs[1][1] - segs[1][0]).toBeCloseTo(vw, 3)
  })
})

describe('NE-1b gate R9 — `assertStandardFontIntact` resistiu (fora do TOCTOU R9-L1 e do impostor R9-L2)', () => {
  it('`doc.font("Symbol", "Times-Roman")` antes do 1º uso: writeText, measureText e a marca em Times-Roman são recusados com mensagem da base; o papel de OUTRA fonte segue escrevendo', async () => {
    const w = createPdf({ marginCm: 1, title: 'F1', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    d.font('Symbol', 'Times-Roman')
    for (const fn of [
      () => writeText(d, 'content', 'abc', { x: 40, y: 40 }),
      () => writeText(d, 'content', 'abc', { x: 40, y: 40, width: 100, lineBreak: false }),
      () => measureText(d, 'content', 'abc'),
      () => drawWatermark(d, 'X', { font: 'Times-Roman', sizePt: 20, color: 'gray' }),
    ]) expect(errorOf(fn)?.message).toMatch(/fonte-padrão "Times-Roman" foi sobreposto/)
    writeText(d, 'fixed', 'segue em Courier', { x: 40, y: 80 })
    expect(fontsOf(await w.end())).toEqual(['Courier'])
  })

  it('depois que a fonte-padrão já está no cache, `doc.font("Symbol", "Times-Roman")` não a troca (o pdfkit devolve o cache) — a porta segue escrevendo em Times-Roman', async () => {
    const w = createPdf({ marginCm: 1, title: 'F2', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    writeText(d, 'content', 'antes', { x: 40, y: 40 })
    d.font('Symbol', 'Times-Roman')
    writeText(d, 'content', 'depois', { x: 40, y: 60 })
    expect(measureText(d, 'content', 'abc').width).toBeGreaterThan(0)
    expect(fontsOf(await w.end())).toEqual(['Times-Roman'])
  })

  it('`registerFont("Helvetica", "Symbol")`: a marca em Helvetica é recusada (conservador — o cache da construção ainda é Helvetica); o estado NEUTRO do sheetStart segue Helvetica; nada sai em Symbol', async () => {
    let neutralFont = ''
    const w = createPdf({
      marginCm: 1, title: 'F3', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => { neutralFont = internals(d)._font.name; writeText(d, 'title', `CAB ${n}`, { x: 40, y: 20, lineBreak: false }); d.y = 60 },
    })
    const d = w.doc
    d.registerFont('Helvetica', 'Symbol')
    expect(errorOf(() => drawWatermark(d, 'X', { font: 'Helvetica', sizePt: 20, color: 'gray' }))?.message).toMatch(/sobreposto/)
    d.addPage()
    expect(neutralFont).toBe('Helvetica')
    expect(fontsOf(await w.end())).toEqual(['Times-Bold'])
  })
})

describe('NE-1b gate R9 — `broken` (D-NE134) e o `end()` com `save()` aberto resistiram', () => {
  it('`doc.addPage()` cru com `save()` aberto: erro de uso; o `end()` recusa SEMPRE (2 vezes) dizendo a causa, nunca "já foi fechado"; as guardas não sobram', () => {
    const w = createPdf({ marginCm: 1, title: 'B1', fontRoles: ROLES, sheetStart: (d, n) => { writeText(d, 'title', `CAB ${n}`, { x: 40, y: 20, lineBreak: false }); d.y = 60 } })
    const d = w.doc
    d.save()
    expect(errorOf(() => d.addPage())?.message).toMatch(/D-NE134/)
    d.restore()
    for (let i = 0; i < 2; i++) expect(() => w.end()).toThrow(/ficou inválido e não fecha — há save\(\) aberto atravessando a quebra/)
    expect(clean(d)).toEqual(CLEAN)
  })

  it('`end()` com `save()`+recorte aberto: recusa SEM fechar; a família dá `restore()` e fecha — PDF balanceado e o "FOLHA n/N" fora do recorte', async () => {
    const w = createPdf({ marginCm: 1, title: 'B2', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    writeText(d, 'content', lines(110, 'item'), { x: 40, sizePt: 9 })
    d.save(); d.rect(28, 300, 300, 100).clip()
    writeText(d, 'content', 'recortado', { x: 30, y: 310, sizePt: 9 })
    const pass = (dd: PDFKit.PDFDocument, i: { sheet: number; total: number }) => { writeText(dd, 'title', `FOLHA ${i.sheet}/${i.total}`, { x: 450, y: 20, lineBreak: false, sizePt: 8 }) }
    expect(() => w.end(pass)).toThrow(/save\(\) aberto no fim do conteúdo/)
    d.restore()
    const pdf = await w.end(pass)
    expect(pdfPageCount(pdf)).toBe(2)
    const seen = pdfContentOps(pdf).map(viewer)
    expect(seen.map(p => ({ final: p.final, min: p.min }))).toEqual([{ final: 0, min: 0 }, { final: 0, min: 0 }])
    seen.forEach((p, i) => expect(p.runs.find(r => r.text === `FOLHA ${i + 1}/2`)!.clipped).toBe(false))
  })

  it('sem falso positivo: recortes da família abertos e FECHADOS na mesma folha (células de linha única no pé, bloco medido com folga de 0,01 pt) e só depois o transbordo — fecha', async () => {
    const w = createPdf({ marginCm: 1, title: 'B3', creationDate: FIXED, fontRoles: ROLES, sheetStart: (d, n) => { writeText(d, 'title', `CAB ${n}`, { x: 40, y: 20, lineBreak: false }); d.y = 60 } })
    const d = w.doc
    d.save(); d.rect(28, d.page.maxY() - 20, 500, 20).clip()
    writeText(d, 'content', 'célula no pé', { x: 30, y: d.page.maxY() - 1, width: 200, align: 'right', lineBreak: false, sizePt: 30 })
    d.restore()
    // o canhoto GIRADO da D-NE130 (save → rotate → linha única → restore), com o `y` girado bem além do pé: nunca abre folha
    d.save(); d.rotate(-90, { origin: [20, 800] })
    writeText(d, 'title', 'RECEBEMOS DE SETES OS PRODUTOS CONSTANTES DA NOTA', { x: 20, y: 900, width: 700, align: 'center', lineBreak: false, sizePt: 7 })
    d.restore()
    const block = lines(5, 'item')
    const h = measureText(d, 'content', block, { width: 290, sizePt: 9 }).height
    const y = d.page.maxY() - h - 0.01
    d.save(); d.rect(28, y, 300, h).clip()
    writeText(d, 'content', block, { x: 30, y, width: 290, sizePt: 9 })
    d.restore()
    expect(sheetsOf(d)).toBe(1)
    writeText(d, 'content', lines(5, 'transborda'), { x: 30, width: 290, sizePt: 9 })
    expect(sheetsOf(d)).toBe(2)
    expect(balanceOf(await w.end())).toEqual([{ final: 0, min: 0 }, { final: 0, min: 0 }])
  })
})

describe('NE-1b gate R9 — guarda por folha do `isolated` resistiu (fora do R9-L5)', () => {
  const header = (d: PDFKit.PDFDocument, n: number) => writeText(d, 'title', `CAB ${n}`, { x: 40, y: 20, lineBreak: false })

  it('sheetStart deixa `save()` aberto em TRÊS folhas (sem desenho aninhado) e volta à sua: erro de uso legível; cada `Q` da limpeza cai na folha do seu `q` — tudo balanceado; guardas fora', async () => {
    const w = createPdf({
      marginCm: 1, title: 'I1', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => {
        header(d, n)
        if (n === 3) { d.save(); d.rotate(3); d.switchToPage(0); d.save(); d.rotate(5); d.switchToPage(1); d.save(); d.rotate(7); d.switchToPage(2) }
        d.y = 60
      },
    })
    w.doc.addPage()
    expect(errorOf(() => w.doc.addPage())?.message).toMatch(/^base de PDF: o sheetStart deixou save\(\) sem restore\(\)/)
    expect(clean(w.doc)).toEqual(CLEAN)
    expect(balanceOf(await w.end())).toEqual([{ final: 0, min: 0 }, { final: 0, min: 0 }, { final: 0, min: 0 }])
  })

  it('`save()` nesta folha e `restore()` noutra: barrado NA HORA (antes do `Q`), o `save()` fecha na folha certa; as duas balanceadas', async () => {
    const w = createPdf({
      marginCm: 1, title: 'I2', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => { header(d, n); if (n === 2) { d.save(); d.fillColor('red', 0.3); d.switchToPage(0); d.restore() } d.y = 60 },
    })
    expect(errorOf(() => w.doc.addPage())?.message).toMatch(/^base de PDF: o sheetStart deu restore\(\) noutra folha/)
    expect(clean(w.doc)).toEqual(CLEAN)
    expect(balanceOf(await w.end())).toEqual([{ final: 0, min: 0 }, { final: 0, min: 0 }])
  })

  it('desenhos da base ANINHADOS entre o `save()` e o `restore()` da família NA MESMA folha (marca, barras, sublinhado): aceito, sem erro, balanceado — a entrada velha do R9-L5 é inofensiva numa folha só', async () => {
    const w = createPdf({
      marginCm: 1, title: 'I3', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => {
        d.save(); d.rotate(2)
        drawWatermark(d, 'COPIA', { font: 'Helvetica', sizePt: 40, color: 'gray', opacity: 0.3 })
        drawBars(d, BARS, BOX)
        writeText(d, 'title', `CAB ${n}`, { x: 300, y: 50, width: 120, align: 'right', lineBreak: false, underline: true })
        d.save(); d.restore()
        d.restore()
        d.y = 70
      },
    })
    writeText(w.doc, 'content', lines(150, 'item'), { x: 40, sizePt: 9 })
    expect(sheetsOf(w.doc)).toBeGreaterThan(1)
    expect(clean(w.doc)).toEqual(CLEAN)
    const balance = balanceOf(await w.end())
    expect(balance).toEqual(balance.map(() => ({ final: 0, min: 0 })))
  })
})

describe('NE-1b gate R9 — F-L5 (sem largura útil) resistiu', () => {
  const build = async (attack: (d: PDFKit.PDFDocument) => string[]) => {
    const w = createPdf({ marginCm: 1, title: 'L', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    writeText(d, 'content', 'antes', { x: 40, y: 40 })
    const errors = attack(d)
    writeText(d, 'content', 'depois', { x: 40, y: 80 })
    return { pdf: await w.end(), errors }
  }

  it('além da margem direita por 1e-6 pt (writeText com x, `continued` sem cadeia, com `height`, só com `y` usando o x corrente, sem nenhum dos dois; measureText): recusado, PDF igual ao de controle', async () => {
    const attacked = await build(d => {
      const beyond = d.page.width - d.page.margins.right + 1e-6
      const out: string[] = []
      const push = (fn: () => unknown) => out.push(errorOf(fn)?.message ?? 'ACEITO')
      push(() => writeText(d, 'content', 'abc\ndef', { x: beyond, y: 300 }))
      push(() => writeText(d, 'content', 'abc', { x: beyond, y: 300, continued: true }))
      push(() => writeText(d, 'content', 'abc', { x: beyond, y: 300, lineBreak: true, height: 40 }))
      push(() => measureText(d, 'content', 'abc', { x: beyond }))
      d.x = beyond
      push(() => writeText(d, 'content', 'abc', { y: 300 }))
      push(() => writeText(d, 'content', 'abc'))
      d.x = 40
      return out
    })
    const control = await build(() => [])
    expect(attacked.errors).toHaveLength(6)
    for (const m of attacked.errors) expect(m).toMatch(/não há largura útil a partir de x/)
    expect(attacked.pdf.equals(control.pdf)).toBe(true)
  })

  it('na margem direita (resíduo de ponto flutuante dos dois lados): a escrita sem largura é RECUSADA ou anda uma linha por linha — nunca empilha; quando aceita, a medida = o avanço', () => {
    // a conferência da base e a largura do pdfkit são a MESMA conta (`page.width − x − margem`): largura 0 → recusa; resíduo positivo → coluna estreita
    for (const delta of [-1e-6, -1e-12, -1e-14, 0, 1e-14, 1e-12]) {
      const d = createPdf({ marginCm: 1, title: 'L1b', fontRoles: ROLES }).doc
      const x = d.page.width - d.page.margins.right + delta
      const refusedWrite = errorOf(() => writeText(d, 'content', 'abc\ndef', { x, y: 300, sizePt: 9 }))
      const advance = d.y - 300
      const refusedMeasure = errorOf(() => measureText(d, 'content', 'abc\ndef', { x, sizePt: 9 }))
      expect([delta, !!refusedWrite]).toEqual([delta, !!refusedMeasure])
      if (refusedWrite) { expect(refusedWrite.message).toMatch(/não há largura útil/); continue }
      expect(advance).toBeGreaterThan(5 * 9)                                               // 6 caracteres, um por linha
      expect(measureText(d, 'content', 'abc\ndef', { x, sizePt: 9 }).height).toBeCloseTo(advance, 6)
    }
  })

  it('a 0,001 pt da margem: aceito (coluna estreita — um caractere por linha, termina); linha única SEM largura além da margem: aceita, uma linha, o x volta', async () => {
    const w = createPdf({ marginCm: 1, title: 'L2', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    const edge = d.page.width - d.page.margins.right
    writeText(d, 'content', 'abc', { x: edge - 0.001, y: 100, sizePt: 9 })
    expect(d.y).toBeGreaterThan(100 + 2 * 9)                                             // três linhas
    writeText(d, 'content', 'fora', { x: edge + 5, y: 300, lineBreak: false })
    expect(d.x).toBe(edge + 5)
    const runs = pdfTextRuns(pdfContentOps(await w.end())[0])
    expect(runs.map(r => r.text)).toEqual(['a', 'b', 'c', 'fora'])
  })
})
