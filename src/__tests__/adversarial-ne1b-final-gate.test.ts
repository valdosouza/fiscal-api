/// <reference types="jest" />
// GATE ADVERSARIAL do DELTA FINAL 756d244..428e282 da NE-1b (revisor independente, 2026-10-17 — skill `testar-adversarial.md`): ataques à guarda
// do `restore()` a mais (`state.ts`), ao desenho pela fonte do registro DA BASE (`fonts.ts`), ao estado neutro = folha nova e à passada entrando
// nas margens, ao `measureText` com `x`, à marca só como propriedade própria (`base-document.ts`), ao `sheetStart` que abre folha deixando o
// documento inválido, às opções lidas uma vez e às decisões D-NE131 (um papel, uma fonte), D-NE132 (`lineBreak: false` COM `width` = LINHA ÚNICA
// alinhada pela base), D-NE133 (o `x` volta para onde a linha única começou) e D-NE134 (`save()` da família aberto na abertura de folha).
// Os gates anteriores estão em `adversarial-ne1b-gate`, `-delta-gate` e `-r7-gate` (não repetidos aqui).
//
// Ataque que RESISTIU fica como teste verde; achado CONFIRMADO fica como `it.failing` com o rótulo "[ACHADO <SEVERIDADE>]" — o corpo afirma o
// comportamento CORRETO (recusa legível da base OU o PDF certo), então quando a correção entrar o `it.failing` passa a FALHAR e vira `it` comum.
import PDFDocument from 'pdfkit'
import {
  createPdf, writeText, measureText, registerFontRoles, drawBars, drawMatrix, drawWatermark, code128Bars, code128Symbols, qrMatrix, cmToPt,
} from '../pdf'
import { pdfContentOps, pdfTextRuns, pdfPageCount, decodeCode128, readQr, pdfRects } from './pdf-oracle'

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
const sheetsOf = (doc: PDFKit.PDFDocument): number => internals(doc)._pageBuffer.length
const ownRestore = (doc: PDFKit.PDFDocument): boolean => Object.prototype.hasOwnProperty.call(doc, 'restore')
const PROTO_RESTORE = (PDFDocument.prototype as unknown as { restore: unknown }).restore
const contentLength = (doc: PDFKit.PDFDocument): number => (doc.page as any).content.uncompressedLength

interface ViewerState { readonly color: string; readonly ca: number; readonly rotated: boolean; readonly clipped: boolean }
interface ViewerRun extends ViewerState { readonly text: string }
/** Como o LEITOR vê a folha (o mesmo oráculo do gate R7): `Q` órfão é ignorado (pdf.js / MuPDF); giro, recorte, cor e `ca` vigentes. */
function viewer(ops: string): { runs: ViewerRun[]; final: number; min: number } {
  let st: ViewerState = { color: '', ca: 1, rotated: false, clipped: false }
  const stack: ViewerState[] = []
  const runs: ViewerRun[] = []
  let depth = 0, min = 0
  for (const raw of ops.split('\n')) {
    const l = raw.trim()
    if (l === 'q') { stack.push(st); depth++ }
    else if (l === 'Q') { depth--; min = Math.min(min, depth); const popped = stack.pop(); if (popped) st = popped }
    else if (/ (scn|sc|rg|k)$/.test(l)) st = { ...st, color: l.replace(/ (scn|sc|rg|k)$/, '') }
    else if (/ gs %ca=/.test(l)) { const ca = l.split('%ca=')[1]; if (ca !== '-') st = { ...st, ca: Number(ca) } }
    else if (/ cm$/.test(l)) { const p = l.split(/\s+/).map(Number); if (p[1] !== 0 || p[2] !== 0) st = { ...st, rotated: true } }
    else if (/^W\*? n$/.test(l)) st = { ...st, clipped: true }
    else if (/T[Jj]$/.test(l)) {
      const text = [...l.matchAll(/<([0-9a-fA-F]+)>/g)].map(h => Buffer.from(h[1], 'hex').toString('latin1')).join('')
      runs.push({ text, ...st })
    }
  }
  return { runs, final: depth, min }
}

/** As barras remontadas dos retângulos da folha (altura exata `height`, largura ≤ 4 módulos) e decodificadas pelo oráculo independente. */
function barsTextOf(ops: string, box: { x: number; width: number; height: number }, bars: { modules: number }): string {
  const module = box.width / (bars.modules + 20)
  const rects = pdfRects(ops).filter(([x, , w, h]) => Math.abs(h - box.height) < 1e-3 && x >= box.x - 1e-6 && w <= 4 * module + 1e-6)
    .sort((p, q) => p[0] - q[0])
  const widths: number[] = []
  rects.forEach(([x, , w], i) => {
    if (i > 0) widths.push(Math.round((x - (rects[i - 1][0] + rects[i - 1][2])) / module))
    widths.push(Math.round(w / module))
  })
  return decodeCode128(widths).text
}

/** O QR remontado dos retângulos da folha (os de altura de UM módulo a partir da caixa) e lido pelo jsQR. */
function qrTextOf(ops: string, box: { x: number; y: number; size: number }, size: number): string | null {
  const qm = box.size / size
  const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => false))
  for (const [x, y, w, h] of pdfRects(ops).filter(([x, y, , h]) => x >= box.x - 1e-6 && y >= box.y - 1e-6 && Math.abs(h - qm) < 1e-3)) {
    const r = Math.round((y - box.y) / qm), c0 = Math.round((x - box.x) / qm), n = Math.round(w / qm)
    for (let c = c0; c < c0 + n; c++) grid[r][c] = true
  }
  return readQr({ size, rows: grid })
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ACHADOS CONFIRMADOS — MEDIUM
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate final — [ACHADO MEDIUM] F-M1: a LINHA ÚNICA (D-NE132) com um encadeado da família ABERTO é quebrada pela largura do encadeado e ABRE FOLHA', () => {
  /**
   * A linha única mede e recusa contra a `width` da CÉLULA, mas escreve com `doc.text(t, x0 + dx, y, { lineBreak: false })` SEM isolar o encadeado:
   * o `_initOptions` do pdfkit 0.20.2 copia para as opções TODA chave ausente do `_textOptions` pendente (a `width`, o `align`…) e o `_text` usa o
   * `_wrapper` pendente — o valor da célula vira o FIM do encadeado, quebrado na largura DELE (o "1.234.567,89" sai partido em "1.234.56" / "7,89",
   * outro número na leitura), deslocado pelo `continuedX` e, perto do pé, ABRE FOLHA — o sintoma do R7-M2 que a D-NE132 fechou, reaberto pelo
   * estado. A base PRESERVA o encadeado da família através das outras portas (D-NE128: marca, barras, medida) — a linha única é a única porta que
   * o consome. Correção sugerida: escrever a linha única com `_wrapper`/`_textOptions` fora (como o `isolated` faz) e devolvê-los depois — ou recusar
   * a linha única com encadeado aberto (RangeError legível).
   */
  const VALUE = 'VALOR 1.234.567,89'
  const cell = { x: 400, width: 120, align: 'right' as const, lineBreak: false, sizePt: 8 }

  it('[CORRIGIDO — ACHADO MEDIUM] F-M1a — no meio da folha: o valor da célula sai em UMA linha, inteiro, alinhado à direita da célula (hoje: 3 linhas, número partido)', async () => {
    const w = createPdf({ marginCm: 1, title: 'FM1a', creationDate: FIXED, fontRoles: ROLES })
    writeText(w.doc, 'content', 'Obs: ', { x: 40, y: 700, width: 30, continued: true, sizePt: 9 })     // encadeado ABERTO
    const vw = measureText(w.doc, 'content', VALUE, { sizePt: 8 }).width
    const refused = errorOf(() => writeText(w.doc, 'content', VALUE, { ...cell, y: 300 }))
    const pdf = await w.end()
    expect(vw).toBeGreaterThan(0)
    expect(refused?.message).toMatch(/texto encadeado aberto.*D-NE135/)                  // fechado pela D-NE135 (gate socrático do delta, achado 2)
    expect(pdfTextRuns(pdfContentOps(pdf)[0]).filter(r => r.text !== 'Obs: ').map(r => r.text)).toEqual([])
  })

  it('[CORRIGIDO — ACHADO MEDIUM] F-M1b — perto do pé: a linha única NUNCA abre folha (hoje: 2 folhas, o resto do valor na folha nova)', async () => {
    const w = createPdf({ marginCm: 1, title: 'FM1b', creationDate: FIXED, fontRoles: ROLES })
    writeText(w.doc, 'content', 'Obs: ', { x: 40, y: 100, width: 30, continued: true, sizePt: 9 })
    const refused = errorOf(() => writeText(w.doc, 'content', VALUE, { ...cell, y: 800 }))
    const sheets = sheetsOf(w.doc)
    const pdf = await w.end()
    expect(refused?.message).toMatch(/texto encadeado aberto.*D-NE135/)
    expect({ sheets, pages: pdfPageCount(pdf) }).toEqual({ sheets: 1, pages: 1 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ACHADOS CONFIRMADOS — LOW
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate final — achados LOW', () => {
  it('[CORRIGIDO — ACHADO LOW] F-L1 — `{ lineBreak: false, continued: true }` SEM largura é ACEITO, mas a D-NE133 joga o `continued` fora: o texto seguinte cai POR CIMA (o rótulo "CNPJ: " e o número no mesmo x)', async () => {
    // (antes do delta o `x` avançava e o número seguia o rótulo; a D-NE132 recusa `continued` na linha única COM largura — sem largura, aceita e
    // anula). Correção sugerida: recusar `continued` com `lineBreak: false` também sem `width`.
    const w = createPdf({ marginCm: 1, title: 'FL1', creationDate: FIXED, fontRoles: ROLES })
    const refused = errorOf(() => {
      writeText(w.doc, 'title', 'CNPJ: ', { x: 40, y: 100, lineBreak: false, continued: true })
      writeText(w.doc, 'content', '12.345.678/0001-90')
    })
    const pdf = await w.end()
    expect(refused?.message).toMatch(/"continued" não combina com lineBreak: false.*D-NE136/)
    expect(pdfContentOps(pdf).flatMap(ops => pdfTextRuns(ops))).toEqual([])            // a recusa vem antes de qualquer texto (nem folha abriu)
  })

  it('[CORRIGIDO — ACHADO LOW] F-L2 — `doc.registerFont("Times-Roman", "Symbol")` (o NOME da fonte-padrão, não o do papel) ainda põe a Symbol na porta do WinAnsi: o `doc.font(fonte)` do pdfkit consulta o `_registeredFonts` pelo nome antes da fonte-padrão', async () => {
    // O re-gate S1/R7-L1 trocou `doc.font(papel)` por `doc.font(fonte do registro da base)` — mas o pdfkit 0.20.2 resolve QUALQUER string pelo
    // `_registeredFonts` primeiro (e guarda o resultado no `_fontFamilies` pelo mesmo nome). Medida 0 e PDF com /BaseFont /Symbol. Correção
    // sugerida: abrir a fonte-padrão por um caminho que não passe pelo registro do pdfkit (ou recusar quando `_registeredFonts[fonte]` existe).
    const w = createPdf({ marginCm: 1, title: 'FL2', creationDate: FIXED, fontRoles: ROLES })
    w.doc.registerFont('Times-Roman', 'Symbol')
    const m = errorOf(() => measureText(w.doc, 'content', 'abc'))
    const refused = errorOf(() => writeText(w.doc, 'content', 'abc', { x: 40, y: 40 }))
    const pdf = await w.end()
    for (const e of [m, refused]) expect(e?.message).toMatch(/fonte-padrão "Times-Roman" foi sobreposto/)
    expect(fontsOf(pdf)).not.toContain('Symbol')
  })

  it('[CORRIGIDO — ACHADO LOW] F-L3 — o erro da D-NE134 deixa uma folha ÓRFÃ (sem o sheetStart dela) e o documento AINDA FECHA: folha 2 sem cabeçalho, q/Q desbalanceado e o "FOLHA 1/2" dentro do recorte (o R7-L4 de volta para quem engole o erro)', async () => {
    // O comentário do `broken` ("só o sheetStart que abre folha deixa uma folha ÓRFÃ no buffer") não vale: a D-NE134 lança DEPOIS do `opened++`
    // e ANTES do `sheetStart`. Correção sugerida: marcar o documento inválido (`broken`) também na D-NE134 — o `end()` recusa com a causa.
    let starts = 0
    const w = createPdf({
      marginCm: 1, title: 'FL3', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => { starts++; writeText(d, 'title', `CAB ${n}`, { x: 40, y: 20, lineBreak: false }); d.y = 60 },
    })
    const d = w.doc
    d.save(); d.rect(28, 300, 300, 500).clip()
    const e134 = errorOf(() => writeText(d, 'content', lines(80, 'item'), { x: 30, y: 300, width: 290, sizePt: 9 }))
    expect(e134?.message).toMatch(/D-NE134/)
    d.restore()
    let closed: Error | null = null
    try { await w.end((dd, i) => { writeText(dd, 'title', `FOLHA ${i.sheet}/${i.total}`, { x: 450, y: 20, lineBreak: false, sizePt: 8 }) }) }
    catch (e) { closed = e as Error }
    expect({ starts, refusedToClose: closed !== null }).toEqual({ starts: 1, refusedToClose: true })   // hoje: fecha (2 folhas, 1 cabeçalho)
  })

  it('[CORRIGIDO — ACHADO LOW] F-L4 — a guarda do `restore()` conta a pilha do JS, não a da FOLHA: um `save()` NOUTRA folha + `restore()` nesta (voltando à folha) fecha o `q` do isolamento sem erro — o resto do sheetStart (vermelho a 30 %, girado) vaza para o conteúdo', async () => {
    // Exótico (o sheetStart não tem por que trocar de folha — o contrato já proíbe TERMINAR noutra), mas é a classe do R7-M1 por outro caminho e
    // passa calada: a pilha volta com a MESMA entrada (a do isolamento), a folha é a mesma, nenhuma conferência dispara. Correção sugerida: a
    // guarda recusar `save()`/`restore()` com a folha corrente diferente da do isolamento (ou o `switchToPage` dentro do isolamento).
    const w = createPdf({
      marginCm: 1, title: 'FL4', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => {
        if (n === 2) {
          d.switchToPage(0); d.save(); d.switchToPage(1)
          d.restore()                                                                      // o `Q` cai na folha 2 e fecha o `q` DO ISOLAMENTO
          d.fillColor('red', 0.3).rotate(90, { origin: [300, 400] })
        }
        d.y = 60
      },
    })
    const error = errorOf(() => w.doc.addPage())
    writeText(w.doc, 'content', 'corpo da folha 2', { x: 40, y: 100, sizePt: 9 })
    const pages = pdfContentOps(await w.end()).map(viewer)
    expect(error?.message).toMatch(/^base de PDF: o sheetStart trocou de folha \(switchToPage\).*D-NE138/)                                  // D-NE138
    const body = pages[pages.length - 1].runs.find(r => r.text.startsWith('corpo'))!
    expect({ ca: body.ca, rotated: body.rotated }).toEqual({ ca: 1, rotated: false })   // (o equilíbrio q/Q por folha: teste do R9 "restore() noutra")
  })

  it('[CORRIGIDO — ACHADO LOW] F-L5 — `measureText` com `x` além da margem direita (sem `width`): a medida diz N linhas, o `writeText` não avança o `y` e EMPILHA as linhas no mesmo lugar', async () => {
    // A promessa nova (re-gate S4: "sem `width`, com a largura que sobra a partir de `x`") quebra quando não sobra largura: o pdfkit calcula
    // `width = max(0, …)` = 0, o `_text` trata 0 como "sem largura" e escreve cada linha SEM avançar o `y` (uma por cima da outra); a medida passa
    // pelo `heightOfString`, que soma uma altura por linha. Correção sugerida: recusar medida/escrita sem `width` quando não sobra largura a partir
    // de `x` (RangeError legível) — no DANFE, onde o `x` pode vir de um sistema GIRADO (D-NE130), o erro silencioso é linhas sobrepostas.
    const w = createPdf({ marginCm: 1, title: 'FL5', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    const x = d.page.width - d.page.margins.right + 1
    const refusedMeasure = errorOf(() => measureText(d, 'content', 'abc\ndef', { x, sizePt: 9 }))
    const m = refusedMeasure ? null : measureText(d, 'content', 'abc\ndef', { x, sizePt: 9 })
    const refusedWrite = errorOf(() => writeText(d, 'content', 'abc\ndef', { x, y: 40, sizePt: 9 }))
    const advance = d.y - 40
    await w.end()
    for (const e of [refusedMeasure, refusedWrite]) expect(e?.message).toMatch(/não há largura útil a partir de x/)
    expect({ m, advanced: advance > 0 }).toEqual({ m: null, advanced: false })            // nada medido, nada escrito
  })

  it('[CORRIGIDO — D-NE140] F-L6 (a escrita compensa o arredondamento float32 do pdfkit) — texto de UMA linha (com quebra de linha permitida) posto EXATAMENTE no pé pela medida (`y = maxY − altura`): o pdfkit abre folha ANTES de escrever — com o recorte da família aberto, a D-NE134 recusa um bloco que a medida disse que cabe', async () => {
    // Pré-existente no pdfkit 0.20.2, exposto pela D-NE134: o `LineWrapper` arredonda o `maxY` PARA BAIXO em float32 (`PDFNumber`) e a conferência
    // de ENTRADA (`nextY = y + altura da linha`) fica em float64 — `nextY > maxY` por ~2,5e-5 pt e o `nextSection` abre folha. As conferências entre
    // linhas arredondam os dois lados (o bloco de 6 linhas no mesmo limite cabe — teste verde abaixo). Sem o recorte: folha nova com a linha órfã e o
    // desenho seguinte da família (por coordenada) caindo nela. Correção sugerida: LIMITE CONHECIDO documentado no `measureText` (cabe se
    // `y + altura < maxY − 1e-4`) ou a porta compensar a conferência de entrada.
    const w = createPdf({ marginCm: 1, title: 'FL6', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    const h = measureText(d, 'content', 'último item', { width: 290, sizePt: 9 }).height
    const y = d.page.maxY() - h
    d.save(); d.rect(28, y, 300, h).clip()
    const error = errorOf(() => writeText(d, 'content', 'último item', { x: 30, y, width: 290, sizePt: 9 }))
    d.restore()
    const sheets = sheetsOf(d)
    await w.end()
    expect({ error: error?.message ?? null, sheets }).toEqual({ error: null, sheets: 1 })   // hoje: D-NE134 (e, sem o recorte, 2 folhas)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ATAQUES QUE RESISTIRAM (verdes — ficam como regressão)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate final — a guarda do `restore()` a mais (R7-M1) resistiu', () => {
  const BARS_BOX = { x: cmToPt(1), y: 30, width: cmToPt(11.5), height: 21.5 }
  const QR_BOX = { x: 470, y: 22, size: cmToPt(2.5) }
  const header = (d: PDFKit.PDFDocument, n: number) => {
    drawWatermark(d, 'SEM VALOR FISCAL', { font: 'Helvetica', sizePt: 50, color: [0, 0, 0, 35], opacity: 0.4 })   // isolado DENTRO do isolado
    drawBars(d, barsOf(KEY), BARS_BOX)
    drawMatrix(d, qrOf(URL_QR), QR_BOX)
    const m = measureText(d, 'title', `CHAVE ${n}`, { sizePt: 8 })                                          // isolado sem gráfico
    writeText(d, 'title', `CHAVE ${n}`, { x: 300, y: 60, width: m.width, align: 'right', lineBreak: false, sizePt: 8, underline: true })
    writeText(d, 'content', `folha ${n}`, { x: 300, y: 72, width: 120, align: 'center', lineBreak: false, sizePt: 8, strike: true })
    d.y = 100
  }
  const body = (d: PDFKit.PDFDocument) => {
    writeText(d, 'content', 'Inf. compl.: ', { x: 40, y: 700, width: 300, continued: true, sizePt: 9 })
    writeText(d, 'fixed', words(500), { continued: true, sizePt: 9 })
    writeText(d, 'content', ' FIM.')
  }

  it('aninhamento: transbordo → sheetStart → marca/barras/QR/medida/linha única (isolados dentro do isolado) — toda folha balanceada como o leitor vê, barras e QR lidos de volta em TODA folha, encadeado inteiro e o `restore` do documento volta a ser o do protótipo', async () => {
    const w = createPdf({ marginCm: 1, title: 'G1', creationDate: FIXED, fontRoles: ROLES, sheetStart: header })
    body(w.doc)
    expect(ownRestore(w.doc)).toBe(false)
    const pdf = await w.end((d, i) => { writeText(d, 'title', `Folha ${i.sheet}/${i.total}`, { x: 480, width: 80, align: 'right', lineBreak: false, sizePt: 7, y: 815 }) })
    expect(ownRestore(w.doc)).toBe(false)
    expect(w.doc.restore).toBe(PROTO_RESTORE)
    const ops = pdfContentOps(pdf)
    expect(ops.length).toBeGreaterThanOrEqual(3)
    const qr = qrOf(URL_QR)
    ops.forEach((o, i) => {
      const seen = viewer(o)
      expect({ i, final: seen.final, min: seen.min }).toEqual({ i, final: 0, min: 0 })
      expect(barsTextOf(o, BARS_BOX, barsOf(KEY))).toBe(KEY)
      expect(qrTextOf(o, QR_BOX, qr.size)).toBe(URL_QR)
      expect(seen.runs.filter(r => r.text.startsWith('palavra')).every(r => r.ca === 1 && !r.rotated && !r.clipped)).toBe(true)
      expect(seen.runs.some(r => r.text === `Folha ${i + 1}/${ops.length}`)).toBe(true)
    })
    expect(pdfTextRuns(ops[ops.length - 1]).map(r => r.text).join('')).toContain('FIM.')
  })

  it('isolado REENTRANTE: depois da marca/barras/QR/medida/linha única DENTRO do sheetStart, a guarda em vigor é a DO sheetStart — o `restore()` a mais é barrado com a mensagem dele, antes do `Q`, e nada vaza', async () => {
    const w = createPdf({
      marginCm: 1, title: 'G2', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => { header(d, n); if (n === 2) { d.restore(); d.fillColor('red', 0.3).rotate(90, { origin: [300, 400] }) } },
    })
    const error = errorOf(() => body(w.doc))
    expect(error?.message).toMatch(/^base de PDF: o sheetStart deu restore\(\) a mais/)
    expect(ownRestore(w.doc)).toBe(false)
    writeText(w.doc, 'content', 'depois do erro', { x: 40, y: 400, sizePt: 9 })            // o documento segue usável (o sheetStart não abriu folha)
    const seen = pdfContentOps(await w.end()).map(viewer)
    for (const p of seen) {
      expect({ final: p.final, min: p.min }).toEqual({ final: 0, min: 0 })
      expect(p.runs.filter(r => r.text.startsWith('palavra') || r.text.startsWith('depois')).every(r => r.ca === 1 && !r.rotated)).toBe(true)
    }
  })

  it('depois de CADA erro (restore a mais, erro próprio do sheetStart, D-NE134, recusa da passada, recusa de entrada) o `restore` do documento é o do protótipo e a pilha está vazia', async () => {
    const scenarios: Record<string, () => Promise<PDFKit.PDFDocument>> = {
      'restore a mais no transbordo': async () => {
        const w = createPdf({ marginCm: 1, title: 'a', fontRoles: ROLES, sheetStart: (d, n) => { if (n === 2) d.restore() } })
        expect(errorOf(() => writeText(w.doc, 'content', words(3000), { sizePt: 9 }))?.message).toMatch(/o sheetStart deu restore\(\) a mais/)
        await w.end(); return w.doc
      },
      'erro próprio do sheetStart no meio do desenho': async () => {
        const w = createPdf({ marginCm: 1, title: 'b', fontRoles: ROLES, sheetStart: (d, n) => { if (n === 2) { d.save(); d.rotate(9); throw new Error('meu') } } })
        expect(errorOf(() => writeText(w.doc, 'content', words(3000), { sizePt: 9 }))?.message).toBe('meu')
        await w.end(); return w.doc
      },
      'D-NE134': async () => {
        const w = createPdf({ marginCm: 1, title: 'c', fontRoles: ROLES })
        w.doc.save()
        expect(errorOf(() => writeText(w.doc, 'content', words(3000), { sizePt: 9 }))?.message).toMatch(/D-NE134/)
        w.doc.restore(); return w.doc
      },
      'passada com restore a mais': async () => {
        const w = createPdf({ marginCm: 1, title: 'd', fontRoles: ROLES })
        expect(errorOf(() => w.end(d => { d.restore() }))?.message).toMatch(/^base de PDF: a passada por folha deu restore\(\) a mais/)
        return w.doc
      },
      'recusa de entrada (barras, linha única que não cabe)': async () => {
        const w = createPdf({ marginCm: 1, title: 'e', fontRoles: ROLES })
        expect(errorOf(() => drawBars(w.doc, { widths: [1, 1], modules: 2 } as never, BARS_BOX))).toBeInstanceOf(RangeError)
        expect(errorOf(() => writeText(w.doc, 'content', words(9), { x: 40, y: 40, width: 10, lineBreak: false }))).toBeInstanceOf(RangeError)
        await w.end(); return w.doc
      },
    }
    for (const [name, run] of Object.entries(scenarios)) {
      const doc = await run()
      expect([name, ownRestore(doc), doc.restore === PROTO_RESTORE, internals(doc)._ctmStack.length]).toEqual([name, false, true, 0])
    }
  })

  it('espião do jest no `restore` do documento: a guarda envolve o espião (que vê os `restore()` do isolamento), o devolve no fim e ainda barra o `restore()` a mais; `mockRestore` volta ao protótipo', async () => {
    const w = createPdf({
      marginCm: 1, title: 'G4', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => { d.save(); d.rotate(5); d.restore(); if (n === 3) d.restore(); d.y = 60 },
    })
    const spy = jest.spyOn(w.doc, 'restore')
    drawBars(w.doc, barsOf(KEY), BARS_BOX)
    w.doc.addPage()
    expect(w.doc.restore).toBe(spy)
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3)                             // drawBars + sheetStart (o dele e o do isolamento)
    expect(() => w.doc.addPage()).toThrow(/^base de PDF: o sheetStart deu restore\(\) a mais/)
    expect(w.doc.restore).toBe(spy)
    spy.mockRestore()
    expect([ownRestore(w.doc), w.doc.restore === PROTO_RESTORE]).toEqual([false, true])
    const seen = pdfContentOps(await w.end()).map(viewer)
    expect(seen.map(p => ({ final: p.final, min: p.min }))).toEqual(seen.map(() => ({ final: 0, min: 0 })))
  })
})

describe('NE-1b gate final — a LINHA ÚNICA (D-NE132/D-NE133) resistiu nos limites', () => {
  it('largura no limite: a medida exata e 5e-7 abaixo cabem (tolerância 1e-6, uma linha, encostada à direita); 1e-5 abaixo é recusado SEM rastro (nem conteúdo, nem estado)', async () => {
    const w = createPdf({ marginCm: 1, title: 'L1', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    const t = 'R$ 1.234.567,89'
    const mw = measureText(d, 'content', t, { sizePt: 8 }).width
    writeText(d, 'content', t, { x: 300, y: 100, width: mw, align: 'right', lineBreak: false, sizePt: 8 })
    writeText(d, 'content', t, { x: 300, y: 120, width: mw - 5e-7, align: 'right', lineBreak: false, sizePt: 8 })
    d.fillColor('#123456').fontSize(13)
    const keys = ['_font', '_fontSize', '_fillColor', '_wrapper', '_textOptions', 'x', 'y'] as const
    const before = keys.map(k => internals(d)[k])
    const len = contentLength(d)
    expect(() => writeText(d, 'content', t, { x: 300, y: 140, width: mw - 1e-5, align: 'right', lineBreak: false, sizePt: 8 })).toThrow(/não cabe na largura/)
    expect(keys.map(k => internals(d)[k])).toEqual(before)
    expect(contentLength(d)).toBe(len)
    expect(sheetsOf(d)).toBe(1)
    const runs = pdfTextRuns(pdfContentOps(await w.end())[0])
    expect(runs.map(r => r.text)).toEqual([t, t])
    expect(runs[0].x).toBeCloseTo(300, 4)
  })

  it('texto vazio, só espaços, `justify` (= esquerda), sublinhado e riscado DENTRO da célula; o `x` volta e o `y` não anda', async () => {
    const w = createPdf({ marginCm: 1, title: 'L2', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    const cell = { x: 200, width: 150, lineBreak: false, sizePt: 10 } as const
    writeText(d, 'content', '', { ...cell, y: 100, align: 'right' })
    expect([d.x, d.y]).toEqual([200, 100])
    writeText(d, 'content', '     ', { ...cell, y: 120, align: 'center' })
    writeText(d, 'content', 'a b c', { ...cell, y: 140, align: 'justify' })
    writeText(d, 'content', 'SUBLINHADO', { ...cell, y: 160, align: 'right', underline: true })
    writeText(d, 'content', 'RISCADO', { ...cell, y: 180, align: 'center', strike: true })
    expect([d.x, d.y]).toEqual([200, 180])
    const ops = pdfContentOps(await w.end())[0]
    const runs = pdfTextRuns(ops)
    // D-NE137 (Valdo 2026-10-17): na linha única os espaços do FIM não contam — só espaços = vazio, nada desenhado (como o texto vazio)
    expect(runs.map(r => r.text)).toEqual(['a b c', 'SUBLINHADO', 'RISCADO'])
    expect(runs[0].x).toBeCloseTo(200, 4)                                              // justify numa linha só = à esquerda
    const segs = [...ops.matchAll(/(-?[\d.]+) (-?[\d.]+) m\n(-?[\d.]+) (-?[\d.]+) l/g)].map(m => [Number(m[1]), Number(m[3])])
    expect(segs).toHaveLength(2)
    for (const [a, b] of segs) { expect(a).toBeGreaterThanOrEqual(200 - 1e-6); expect(b).toBeLessThanOrEqual(350 + 1e-6) }
  })

  it('no pé da folha, abaixo dela, dentro do sheetStart e na passada (o "Folha n/N" à direita no rodapé): nunca abre folha, nem sheetStart extra', async () => {
    let starts = 0
    const w = createPdf({
      marginCm: 1, title: 'L3', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => {
        starts++
        writeText(d, 'title', `CABEÇALHO DA FOLHA ${n}`, { x: 300, y: 20, width: 260, align: 'right', lineBreak: false, sizePt: 9 })
        writeText(d, 'content', 'rodapé fixo', { x: 40, y: d.page.height - 12, width: 200, align: 'center', lineBreak: false, sizePt: 30 })
        d.y = 60
      },
    })
    const d = w.doc
    writeText(d, 'content', 'no pé', { x: 40, y: d.page.maxY() - 1, width: 100, align: 'right', lineBreak: false, sizePt: 30 })
    writeText(d, 'content', 'abaixo da folha', { x: 40, y: d.page.height + 50, width: 200, lineBreak: false })
    d.addPage()
    expect(sheetsOf(d)).toBe(2)
    const pdf = await w.end((dd, i) => {
      writeText(dd, 'title', `Folha ${i.sheet} de ${i.total}`, { x: 480, y: dd.page.height - 15, width: 85, align: 'right', lineBreak: false, sizePt: 7 })
    })
    expect({ pages: pdfPageCount(pdf), starts }).toEqual({ pages: 2, starts: 2 })
    expect(pdfContentOps(pdf).map(o => pdfTextRuns(o).filter(r => r.text.startsWith('Folha')).map(r => r.text))).toEqual([['Folha 1 de 2'], ['Folha 2 de 2']])
  })
})

describe('NE-1b gate final — a D-NE134 não dá falso positivo', () => {
  it('nenhuma porta da base deixa `save()` aberto: marca, barras, QR, medida, linha única sublinhada/riscada e o encadeado — depois, o conteúdo transborda sem erro', async () => {
    const w = createPdf({ marginCm: 1, title: 'N1', creationDate: FIXED, fontRoles: ROLES, sheetStart: d => { drawWatermark(d, 'X', { font: 'Times-Roman', sizePt: 20, color: 'gray' }); d.y = 60 } })
    const d = w.doc
    drawWatermark(d, 'SEM VALOR', { font: 'Helvetica', sizePt: 60, color: 'gray', opacity: 0.3 })
    drawBars(d, barsOf(KEY), { x: 30, y: 30, width: cmToPt(11.5), height: 20 })
    drawMatrix(d, qrOf(URL_QR), { x: 450, y: 30, size: 70 })
    measureText(d, 'content', words(400), { width: 200 })
    writeText(d, 'content', 'valor', { x: 300, y: 120, width: 80, align: 'right', lineBreak: false, underline: true })
    writeText(d, 'content', 'valor', { x: 300, y: 140, width: 80, align: 'center', lineBreak: false, strike: true })
    expect(internals(d)._ctmStack).toHaveLength(0)
    writeText(d, 'content', 'Inf: ', { x: 40, y: 200, width: 300, continued: true })
    expect(() => writeText(d, 'content', words(900))).not.toThrow()
    expect(sheetsOf(d)).toBeGreaterThan(1)
    await w.end()
  })

  it('a família fecha o `save()` no LIMITE exato: o bloco recortado de várias linhas (e um com "\\n" final) termina exatamente no pé (medido), o `restore()` vem antes do texto que transborda — sem erro', async () => {
    const w = createPdf({ marginCm: 1, title: 'N2', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    for (const block of [lines(6, 'item'), 'a\nb\n']) {
      const h = measureText(d, 'content', block, { width: 290, sizePt: 9 }).height
      const y = d.page.maxY() - h
      d.save(); d.rect(28, y, 300, h).clip()
      expect(() => writeText(d, 'content', block, { x: 30, y, width: 290, sizePt: 9 })).not.toThrow()
      d.restore()
      expect(sheetsOf(d)).toBe(1)
    }
    expect(() => writeText(d, 'content', lines(5, 'transborda'), { x: 30, width: 290, sizePt: 9 })).not.toThrow()
    expect(sheetsOf(d)).toBe(2)
    const seen = pdfContentOps(await w.end()).map(viewer)
    expect(seen.map(p => ({ final: p.final, min: p.min }))).toEqual([{ final: 0, min: 0 }, { final: 0, min: 0 }])
  })
})

describe('NE-1b gate final — D-NE131 (um papel, uma fonte) resistiu', () => {
  it('papel do `fontRoles` repetido num lote MISTO com a mesma fonte passa; com outra fonte o lote INTEIRO é recusado (nem o papel novo entra); o sheetStart pode re-registrar o mesmo papel em toda folha', async () => {
    const w = createPdf({
      marginCm: 1, title: 'F1', creationDate: FIXED, fontRoles: { content: 'Times-Roman' },
      sheetStart: (d, n) => { registerFontRoles(d, { content: 'Times-Roman', title: 'Times-Bold' }); writeText(d, 'title', `CAB ${n}`, { x: 40, y: 20, lineBreak: false }); d.y = 60 },
    })
    const d = w.doc
    registerFontRoles(d, { content: 'Times-Roman', fixed: 'Courier' })
    expect(() => registerFontRoles(d, { novo: 'Helvetica', fixed: 'Courier-Bold' } as never)).toThrow(/já é Courier/)
    expect(() => writeText(d, 'novo', 'x')).toThrow(/não registrado/)
    expect(() => registerFontRoles(d, { title: 'Times-Roman' })).toThrow(/já é Times-Bold/)
    writeText(d, 'fixed', lines(120), { x: 40, sizePt: 9 })
    const pdf = await w.end()
    expect(fontsOf(pdf).sort()).toEqual(['Courier', 'Times-Bold'])
  })
})

describe('NE-1b gate final — reprodutibilidade com TUDO do delta', () => {
  it('a MESMA data dá os MESMOS bytes (guarda aninhada, linha única à direita/centro sublinhada/riscada, x de volta, medida com x, passada nas margens, marca/barras/QR em toda folha); outra data muda os bytes', async () => {
    const build = async (date: Date) => {
      const w = createPdf({
        marginCm: { top: 1, right: 1, bottom: 1.5, left: 1 }, title: 'R', creationDate: date, fontRoles: ROLES,
        sheetStart: (d, n) => {
          drawWatermark(d, 'SEM VALOR FISCAL', { font: 'Helvetica', sizePt: 50, color: [0, 0, 0, 35], opacity: 0.4 })
          drawBars(d, barsOf(KEY), { x: cmToPt(1), y: 30, width: cmToPt(11.5), height: 21.5 })
          drawMatrix(d, qrOf(URL_QR), { x: 470, y: 22, size: cmToPt(2.5) })
          writeText(d, 'title', `CAB ${n}`, { x: 300, y: 60, width: 120, align: 'center', lineBreak: false, underline: true })
          d.y = 100
        },
      })
      const d = w.doc
      const m = measureText(d, 'content', words(40), { x: 300 })
      writeText(d, 'content', `altura ${m.height.toFixed(3)}`, { x: 40, y: 110, width: 200, align: 'right', lineBreak: false, strike: true })
      writeText(d, 'content', 'rótulo', { y: 125, lineBreak: false })
      writeText(d, 'content', words(40), { x: 300, y: 140 })
      expect(d.y - 140).toBeCloseTo(m.height, 6)                                         // a medida com `x` = o avanço da escrita (re-gate S4)
      writeText(d, 'content', 'Inf. compl.: ', { x: 40, y: 600, width: 300, continued: true })
      writeText(d, 'fixed', words(400), { continued: true })
      writeText(d, 'content', ' FIM.')
      return w.end((dd, i) => { writeText(dd, 'title', `Folha ${i.sheet}/${i.total}`, { y: 20, width: 80, align: 'right', lineBreak: false, sizePt: 8 }) })
    }
    const [a, b, c] = [await build(FIXED), await build(FIXED), await build(new Date('2026-10-18T03:00:00Z'))]
    expect(a.equals(b)).toBe(true)
    expect(a.equals(c)).toBe(false)
    const ops = pdfContentOps(a)
    expect(ops.length).toBeGreaterThan(1)
    expect(Math.round(pdfTextRuns(ops[0]).find(r => r.text === 'rótulo')!.x)).toBe(40)  // D-NE133: só `y` depois da linha única = o x de onde ela começou
    const qr = qrOf(URL_QR)
    for (const o of ops) {
      expect(barsTextOf(o, { x: cmToPt(1), width: cmToPt(11.5), height: 21.5 }, barsOf(KEY))).toBe(KEY)
      expect(qrTextOf(o, { x: 470, y: 22, size: cmToPt(2.5) }, qr.size)).toBe(URL_QR)
      // a passada entra na margem esquerda (re-gate S3): o "Folha" só com `y` fica na célula [1 cm, 1 cm + 80], encostado à direita
      const folha = pdfTextRuns(o).filter(r => r.text.startsWith('Folha'))
      expect(folha).toHaveLength(1)
      expect(folha[0].x).toBeGreaterThan(cmToPt(1) + 40)
      expect(folha[0].x).toBeLessThan(cmToPt(1) + 80)
    }
  })
})
