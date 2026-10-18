/// <reference types="jest" />
// GATE ADVERSARIAL do DELTA 2e16ea6..15f3373 da NE-1b (revisor independente, 2026-10-18 — skill `testar-adversarial.md`): ataques à leva do gate
// R10 (a180971 — R10-M1: folga RELATIVA 2^-40 × pé no `fitFloat32`; R10-L2: a volta à folha do isolado pelo `switchToPage` do PROTÓTIPO) e à
// Rodada 11 (15f3373 — D-NE144 toda falha do `sheetStart` invalida o documento; D-NE145 `advance` = a ÚLTIMA linha; D-NE146 `lineBreak: false`
// recusa quebra de linha; D-NE147 o vazio sem `continued` e sem cadeia não chama o pdfkit) e à honestidade do oráculo `liveContentOps`.
// Os gates anteriores estão em `adversarial-ne1b-gate`, `-delta-gate`, `-r7-gate`, `-final-gate`, `-r9-gate` e `-r10-gate`; os positivos da
// rodada em `pdf-rodada11` (não repetidos aqui).
//
// Ataque que RESISTIU fica como teste verde; achado CONFIRMADO fica como `it.failing` com o rótulo "[ACHADO <SEVERIDADE>]" — o corpo afirma o
// comportamento CORRETO, então quando a correção entrar o `it.failing` passa a FALHAR e vira `it` comum.
import {
  createPdf, writeText, measureText, drawBars, drawMatrix, drawWatermark, code128Bars, code128Symbols, qrMatrix, cmToPt,
} from '../pdf'
import { pdfContentOps, pdfTextRuns, pdfPageCount, liveContentOps, qDepth } from './pdf-oracle'

const FIXED = new Date('2026-10-18T03:00:00Z')
const ROLES = { title: 'Times-Bold', content: 'Times-Roman', fixed: 'Courier' } as const
const BARS = code128Bars(code128Symbols('41261040001355500100000000710000000075'))
const QR = qrMatrix('https://www.fazenda.pr.gov.br/nfce/qrcode?p=41261040001355500100000000710000000075|2|1|1|ABCDEF', { ecLevel: 'M' })
const lines = (n: number, p = 'linha') => Array.from({ length: n }, (_, i) => `${p} ${i + 1}`).join('\n')
const internals = (doc: PDFKit.PDFDocument) => doc as unknown as Record<string | symbol, any>
const sheetsOf = (doc: PDFKit.PDFDocument): number => internals(doc)._pageBuffer.length
const errorOf = (fn: () => unknown): Error | null => { try { fn(); return null } catch (e) { return e as Error } }
/** O que foi lançado, SEM supor que é `Error` (o `throw 'x'`/`throw null` da família). */
const thrown = (fn: () => unknown): { threw: boolean; value?: unknown } => { try { fn(); return { threw: false } } catch (value) { return { threw: true, value } } }
const D144 = /^base de PDF: o documento ficou inválido e não fecha — o sheetStart (falhou|deixou o y fora da área útil).*D-NE144.*\(monte de novo\)$/
const BALANCED = { final: 0, min: 0 }
/** Altura de UMA linha da fonte no corpo, como o pdfkit a calcula (`currentLineHeight(true)`) — sem passar pela medida (que erra ulps). */
const lineHeight = (font: string, sizePt: number): number => {
  const probe = createPdf({ marginCm: 1, title: 'lh', fontRoles: ROLES }).doc
  return probe.font(font).fontSize(sizePt).currentLineHeight(true)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ACHADOS CONFIRMADOS
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate R11 — [ACHADO LOW] R11-L1: o vazio que FECHA a cadeia aberta (D-NE147 "vai ao pdfkit") não avança o `y` como o fechamento com texto — e, de papel maior no pé, abre folha vazia', () => {
  /**
   * No pdfkit 0.20.2 o trecho `continued: true` devolve o `y` ao TOPO da linha encadeada (`continueY`); quem fecha a cadeia escreve na mesma linha
   * e o `_line` avança o `y`. Fechar com `''` não emite linha: o `y` fica no TOPO da linha de "INF. COMPL.: " e o próximo `writeText` sem `y`
   * escreve POR CIMA dela (provado no PDF: mesmo x, mesma linha de base). Caminho público com dado plausível (rótulo encadeado + campo opcional
   * vazio — infCpl/infAdFisco); sobreposição SILENCIOSA, mas só quando a família segue sem `y` explícito (o DANFE posiciona por caixa) — LOW.
   * Correção sugerida (pede decisão — Q-NE152): o vazio que fecha a cadeia deixa o `y` onde o fechamento com texto deixaria (uma linha abaixo da
   * linha encadeada) sem chamar o pdfkit. ESTE corpo afirma a recomendação (a); se o Valdo escolher (b) recusar ou (c) limite, reescrever.
   */
  it('[CORRIGIDO — D-NE152] R11-L1a — "INF. COMPL.: " encadeado + campo opcional VAZIO + próximo bloco só com x: o próximo bloco cai na linha de baixo (hoje: por cima do rótulo)', async () => {
    const w = createPdf({ marginCm: 1, title: 'R11L1a', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    writeText(d, 'content', 'INF. COMPL.: ', { x: 40, y: 100, width: 300, continued: true })
    writeText(d, 'content', '')                                                                  // infCpl ausente
    writeText(d, 'content', 'RESERVADO AO FISCO', { x: 40 })
    const [label, next] = pdfTextRuns(pdfContentOps(await w.end())[0])
    expect(label.text).toBe('INF. COMPL.: ')
    expect(next.text).toBe('RESERVADO AO FISCO')
    expect(next.yPdf).toBeLessThan(label.yPdf - 1)                                                // hoje: a MESMA linha de base (733,694)
  })

  it('referência: fechando a cadeia com TEXTO, o próximo bloco só com x cai na linha de baixo (é a paridade que o vazio não tem)', async () => {
    const w = createPdf({ marginCm: 1, title: 'R11L1ref', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    writeText(d, 'content', 'INF. COMPL.: ', { x: 40, y: 100, width: 300, continued: true })
    writeText(d, 'content', 'nada.')
    writeText(d, 'content', 'RESERVADO AO FISCO', { x: 40 })
    const runs = pdfTextRuns(pdfContentOps(await w.end())[0])
    expect(runs.map(r => r.text)).toEqual(['INF. COMPL.: ', 'nada.', 'RESERVADO AO FISCO'])
    expect(runs[2].yPdf).toBeLessThan(runs[0].yPdf - 1)
  })

  it('[CORRIGIDO — D-NE152] R11-L1b — cadeia de 7 pt no pé exato fechada com VAZIO de outro papel (12 pt): nenhuma folha nova (hoje: folha VAZIA — a R10-L1 pela porta da cadeia)', () => {
    const d = createPdf({ marginCm: 1, title: 'R11L1b', fontRoles: ROLES }).doc
    const m = measureText(d, 'content', 'Obs: ', { sizePt: 7, width: 300 })
    writeText(d, 'content', 'Obs: ', { x: 40, y: d.page.maxY() - m.height, width: 300, sizePt: 7, continued: true })
    expect(sheetsOf(d)).toBe(1)
    writeText(d, 'title', '', { sizePt: 12 })
    expect(sheetsOf(d)).toBe(1)                                                                   // hoje: 2 (o pdfkit confere a entrada com 12 pt)
  })
})

describe('NE-1b gate R11 — [ACHADO LOW] R11-L2: a conferência "lugar para uma linha" depois do sheetStart (re-gate D5) é float64 SEM folga — o cabeçalho que termina EXATAMENTE onde cabe uma linha do conteúdo invalida o documento (D-NE144)', () => {
  /**
   * `doc.y > room` com `room = altura − margem de baixo − altura da linha` e o `y` ACUMULADO pelas linhas do cabeçalho: 1 a 3 ulps de float64
   * (1e-13 pt) acima do `room` em ~28 % das combinações (varredura de 252: conteúdo 6–11 pt × cabeçalho 6–12 pt × 1/3/7 linhas × Times-Bold/
   * Courier; cabeçalho medido pelo `measureText` e posto em `room − altura medida`). A linha do conteúdo CABE (o quebrador do pdfkit confere em
   * float32 depois de emitir), mas a base recusa — e com a D-NE144 o documento fica INVÁLIDO, sem conserto. A mesma classe do R10-M1, agora na
   * conferência da própria base. Cabeçalho que deixa lugar para EXATAMENTE uma linha não é o layout do DANFE (o cabeçalho é ~1/3 da folha) — LOW.
   * Correção sugerida (sem decisão — a D5 continua): a mesma folga relativa da D-NE140, `doc.y - room > Math.abs(room) * 2 ** -40`.
   */
  const CASES: ['title' | 'fixed', number, number][] = [['fixed', 6, 3], ['title', 7, 3], ['title', 7, 7]]   // papel/corpo/linhas do cabeçalho
  for (const [role, headerPt, k] of CASES) {
    it(`[CORRIGIDO — ACHADO LOW] R11-L2 — conteúdo Times-Roman 6 pt; cabeçalho ${role} ${headerPt} pt, ${k} linhas, terminando em "pé − 1 linha": o conteúdo segue e o documento fecha (hoje: "y fora da área útil" + D-NE144)`, async () => {
      const lh = lineHeight('Times-Roman', 6)
      const w = createPdf({
        marginCm: 1, title: 'R11L2', creationDate: FIXED, fontRoles: ROLES,
        sheetStart: (d, n) => {
          if (n !== 2) { d.y = 60; return }
          const room = d.page.height - d.page.margins.bottom - lh
          const h = measureText(d, role, lines(k, 'cab'), { width: 300, sizePt: headerPt }).height
          writeText(d, role, lines(k, 'cab'), { x: 40, y: room - h, width: 300, sizePt: headerPt })
        },
      })
      expect(errorOf(() => writeText(w.doc, 'content', lines(150, 'item'), { x: 40, y: 40, sizePt: 6 }))).toBeNull()
      const pdf = await w.end()
      expect(pdfTextRuns(pdfContentOps(pdf)[1]).filter(r => r.text.startsWith('item'))).toHaveLength(1)   // uma linha do conteúdo na folha 2
    })
  }
})

describe('NE-1b gate R11 — [ACHADO LOW] R11-L3: com o documento já inválido, o "abriu folha" de OUTRO sheetStart sobe com a causa ANTERIOR', () => {
  /**
   * `if (starting) { broken = broken ?? '…abriu folha…'; throw new Error(\`base de PDF: ${broken}\`) }` — o erro IMEDIATO usa o `broken`, que
   * guarda a PRIMEIRA causa. Com a D-NE144 o `broken` passou a ser marcado por qualquer falha do `sheetStart`: o cabeçalho da folha 2 falha
   * (erro da família, engolido) e o da folha 3 transborda — quem chama recebe "o sheetStart falhou (… D-NE144)" para um erro que é OUTRO (abriu
   * folha). Diagnóstico enganoso; o documento já estava morto — LOW. Correção sugerida: o `throw` imediato com o texto FIXO da própria causa
   * (`'base de PDF: o sheetStart abriu folha (…)'`) e o `broken ??=` só para o `end()`.
   */
  it('[CORRIGIDO — ACHADO LOW] R11-L3 — folha 2: a família lança (engolido); folha 3: o cabeçalho transborda — o erro diz "abriu folha" (hoje: "o sheetStart falhou")', () => {
    const w = createPdf({
      marginCm: 1, title: 'R11L3', fontRoles: ROLES,
      sheetStart: (d, n) => {
        if (n === 2) throw new Error('falha da família')
        if (n === 3) writeText(d, 'content', lines(300, 'cab'), { x: 40, y: 20 })
        d.y = 60
      },
    })
    expect(errorOf(() => writeText(w.doc, 'content', lines(100, 'item'), { x: 40, y: 40, sizePt: 9 }))?.message).toBe('falha da família')
    const second = errorOf(() => writeText(w.doc, 'content', lines(100, 'mais'), { x: 40, y: 40, sizePt: 9 }))
    expect(second?.message).toMatch(/^base de PDF: o sheetStart abriu folha/)
  })
})

describe('NE-1b gate R11 — [ACHADO LOW] R11-L4: a conferência do `y` depois do sheetStart fica FORA do `try` da D-NE144 — um acessor no `doc.y` que lança escapa sem invalidar', () => {
  /**
   * O `try/catch` que marca o `broken` envolve só o `isolated`; a conferência `!Number.isFinite(doc.y) || doc.y < 0 || doc.y > room` vem depois e
   * lê o `y` TRÊS vezes. Um `sheetStart` que troca o `y` por um acessor (`Object.defineProperty(doc, 'y', { get() { throw … } })`) faz o erro subir
   * pelo `addPage` SEM marcar o documento — o `end()` fecha. Mau uso DELIBERADO de interno do pdfkit (o `y` é campo de dados) — LOW. Correção
   * sugerida: ler o `y` UMA vez dentro do trecho protegido (a falha da conferência também marca o `broken`).
   */
  it('[CORRIGIDO — ACHADO LOW] R11-L4 — acessor no `y` que lança na conferência: o end() recusa pela D-NE144 (hoje: fecha)', () => {
    const w = createPdf({
      marginCm: 1, title: 'R11L4', fontRoles: ROLES,
      sheetStart: (d, n) => {
        if (n === 2) Object.defineProperty(d, 'y', { configurable: true, get() { throw new Error('acessor do y') }, set() { /* engole */ } })
      },
    })
    expect(errorOf(() => w.doc.addPage())?.message).toBe('acessor do y')
    Object.defineProperty(w.doc, 'y', { configurable: true, writable: true, value: 100 })               // a família "conserta" o y e tenta fechar
    let pending: Promise<Buffer> | undefined
    const refused = errorOf(() => { pending = w.end() })
    pending?.catch(() => undefined)
    expect(refused?.message).toMatch(D144)
  })
})

describe('NE-1b gate R11 — [ACHADO LOW] R11-L5 (oráculo): o `liveContentOps` anota a opacidade com o número JS cru; o PDF grava 6 casas (`PDFObject.number`)', () => {
  /**
   * O ExtGState sai no PDF com `ca` arredondado a 1e-6 (`Math.round(n * 1e6) / 1e6`); o `liveContentOps` anota `%ca=` com `String(ca)`. Para
   * opacidade com mais de 6 casas os dois oráculos divergem — e 0,9999999 vira "translúcido" no vivo e "opaco" no final (o `pdfTextRuns` decide
   * por `ca < 1`). Só oráculo de teste (a produção não lê isso) — LOW. Correção sugerida: anotar com `String(Math.round(ca * 1e6) / 1e6)`.
   */
  it('[CORRIGIDO — ACHADO LOW] R11-L5 — marca d\'água com opacidade 0,9999999: o conteúdo vivo antes do end() = o do PDF final (hoje: difere na anotação e na translucidez)', async () => {
    const w = createPdf({ marginCm: 1, title: 'R11L5', creationDate: FIXED, fontRoles: ROLES })
    drawWatermark(w.doc, 'COPIA', { font: 'Helvetica', sizePt: 40, color: 'gray', opacity: 0.9999999 })
    writeText(w.doc, 'content', 'corpo', { x: 40, y: 100 })
    const live = liveContentOps(w.doc)
    const final = pdfContentOps(await w.end())
    expect(pdfTextRuns(live[0]).map(r => r.translucent)).toEqual(pdfTextRuns(final[0]).map(r => r.translucent))
    expect(live).toEqual(final)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ATAQUES QUE RESISTIRAM (verdes — ficam como regressão)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate R11 — `fitFloat32` com a folga relativa 2^-40 × pé (R10-M1) resistiu', () => {
  const PAPERS: ('A4' | { widthCm: number; heightCm: number })[] = ['A4', { widthCm: 21.6, heightCm: 35.5 }, { widthCm: 50, heightCm: 508 }]
  const MARGINS: (number | { top: number; right: number; bottom: number; left: number })[] = [1, { top: 1, right: 1, bottom: 0, left: 1 }, 0]

  it('varredura: papel A4/Ofício II/508 cm (14.400 pt) × margem 1 cm/de baixo 0/0 × 3 fontes × corpos 5–1000 (y NEGATIVO no corpo 1000) × cursor da medida no topo/meio/baixo × y explícito ou só x: a linha posta em `pé − altura medida` nunca abre folha', () => {
    const fails: string[] = []
    let negative = 0
    for (const paper of PAPERS) for (const marginCm of MARGINS) for (const role of ['title', 'content', 'fixed']) {
      for (const s of [5, 7, 8.5, 9, 10.5, 12, 100, 1000]) for (const at of ['topo', 'meio', 'baixo', 'só x'] as const) {
        const d = createPdf({ marginCm, paper, title: 'F1', fontRoles: ROLES }).doc
        if (at === 'meio') d.y = d.page.height / 2 + 0.3
        if (at === 'baixo') d.y = d.page.maxY() - 1.7
        const m = measureText(d, role, 'linha', { sizePt: s, width: 300 })
        const y = d.page.maxY() - m.height
        if (y < 0) negative++
        const e = at === 'só x'
          ? errorOf(() => { d.y = y; writeText(d, role, 'linha', { x: 40, width: 300, sizePt: s }) })
          : errorOf(() => writeText(d, role, 'linha', { x: 40, y, width: 300, sizePt: s }))
        if (e || sheetsOf(d) !== 1) fails.push(`${JSON.stringify(paper)}/${JSON.stringify(marginCm)}/${role}/${s}/${at}: ${e?.message ?? sheetsOf(d)}`)
      }
    }
    expect(fails).toEqual([])
    expect(negative).toBeGreaterThan(0)                                                           // o corpo 1000 no A4 entrou com y < 0
  })

  it('o que NÃO cabe não é puxado: 1e-9 pt além do pé no A4 (folga 7e-10) e 1e-7 pt no papel de 14.400 pt (folga 1,3e-8) vão para a folha seguinte; dentro da folga sobe < 1e-4 pt no A4 e < 1e-3 pt no papel de 14.400 pt', () => {
    for (const [paper, beyond, within, maxRise] of [
      ['A4', 1e-9, 5e-10, 1e-4], [{ widthCm: 50, heightCm: 508 }, 1e-7, 1e-8, 1e-3],
    ] as ['A4' | { widthCm: number; heightCm: number }, number, number, number][]) {
      for (const [role, s] of [['content', 7], ['title', 8.5], ['fixed', 9]] as ['content' | 'title' | 'fixed', number][]) {
        const font = ROLES[role]
        const lh = lineHeight(font, s)
        const out = createPdf({ marginCm: 1, paper, title: 'F2', fontRoles: ROLES }).doc
        writeText(out, role, 'linha', { x: 40, y: out.page.maxY() - lh + beyond, width: 300, sizePt: s })
        expect(sheetsOf(out)).toBe(2)
        const inn = createPdf({ marginCm: 1, paper, title: 'F2', fontRoles: ROLES }).doc
        const y = inn.page.maxY() - lh + within
        writeText(inn, role, 'linha', { x: 40, y, width: 300, sizePt: s })
        expect(sheetsOf(inn)).toBe(1)
        expect(Math.abs(inn.y - (y + lh))).toBeLessThan(maxRise)
      }
    }
  })

  it('depois de uma cadeia FECHADA (com texto e com o vazio) a 1ª linha no pé exato é compensada como fora da cadeia — uma folha', () => {
    for (const close of ['fim.', '']) for (const s of [7, 8.5, 9]) for (const role of ['title', 'content', 'fixed'] as const) {
      const d = createPdf({ marginCm: 1, title: 'F3', fontRoles: ROLES }).doc
      writeText(d, role, 'Obs: ', { x: 40, y: 300, width: 300, sizePt: s, continued: true })
      writeText(d, role, close, { sizePt: s })
      expect(internals(d)._wrapper).toBeNull()
      const m = measureText(d, role, 'linha', { sizePt: s, width: 300 })
      writeText(d, role, 'linha', { x: 40, y: d.page.maxY() - m.height, width: 300, sizePt: s })
      expect(sheetsOf(d)).toBe(1)
    }
  })
})

describe('NE-1b gate R11 — D-NE144 resistiu (fora do R11-L2/L3/L4)', () => {
  it('falso positivo: `sheetStart` com medida, marca d\'água, barras, QR, linha única e os três vazios (sem width, com width, lineBreak: false) — o transbordo segue, o documento FECHA, cada folha com o cabeçalho e balanceada', async () => {
    const w = createPdf({
      marginCm: 1, title: 'P1', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => {
        const m = measureText(d, 'title', `CAB ${n}`, { x: 40, sizePt: 10 })
        drawWatermark(d, 'SEM VALOR', { font: 'Helvetica', sizePt: 40, color: 'gray', opacity: 0.3 })
        drawBars(d, BARS, { x: 30, y: 30, width: cmToPt(11.5), height: 12 })
        drawMatrix(d, QR, { x: 480, y: 20, size: 60 })
        writeText(d, 'title', `CAB ${n}`, { x: 40, y: 50, width: m.width + 1, lineBreak: false, sizePt: 10 })
        writeText(d, 'content', '', { x: 40, y: 64 })
        writeText(d, 'content', '', { x: 40, y: 64, width: 100 })
        writeText(d, 'content', '', { x: 40, y: 64, lineBreak: false })
        d.y = 90
      },
    })
    expect(errorOf(() => writeText(w.doc, 'content', lines(150, 'item'), { x: 40, sizePt: 9 }))).toBeNull()
    const ops = pdfContentOps(await w.end())
    expect(ops).toHaveLength(3)
    expect(ops.map(qDepth)).toEqual([BALANCED, BALANCED, BALANCED])
    ops.forEach((o, i) => {
      const runs = pdfTextRuns(o)
      expect(runs.filter(r => r.text === `CAB ${i + 1}`)).toHaveLength(1)
      expect(runs.filter(r => r.text.startsWith('item')).every(r => r.size === 9)).toBe(true)
    })
  })

  it('falso positivo: cabeçalho de várias linhas que termina com FOLGA de 1e-6 pt antes de "pé − 1 linha" (fora do R11-L2) e rodapé no pé exato desenhado NO sheetStart — o documento fecha', async () => {
    const lh = lineHeight('Times-Roman', 9)
    const w = createPdf({
      marginCm: 1, title: 'P2', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => {
        const foot = measureText(d, 'fixed', lines(3, 'canhoto'), { width: 300, sizePt: 7 }).height
        writeText(d, 'fixed', lines(3, 'canhoto'), { x: 40, y: d.page.maxY() - foot, width: 300, sizePt: 7 })      // rodapé no pé exato (D-NE140)
        if (n !== 2) { d.y = 60; return }
        const room = d.page.height - d.page.margins.bottom - lh
        const h = measureText(d, 'title', lines(5, 'cab'), { width: 300, sizePt: 8 }).height
        writeText(d, 'title', lines(5, 'cab'), { x: 40, y: room - h - 1e-6, width: 300, sizePt: 8 })
      },
    })
    expect(errorOf(() => writeText(w.doc, 'content', lines(150, 'item'), { x: 40, y: 40, sizePt: 9 }))).toBeNull()
    const ops = pdfContentOps(await w.end())
    expect(ops.map(qDepth).every(q => q.final === 0 && q.min === 0)).toBe(true)
    expect(ops.every(o => pdfTextRuns(o).filter(r => r.text.startsWith('canhoto')).length === 3)).toBe(true)
  })

  it('falso negativo: exceção NÃO-Error no sheetStart (string, null, undefined, número, objeto sem protótipo) e thenable cujo `then` lança (getter ou chamada) — sobe o MESMO valor, o end() recusa sempre, a causa nunca ecoa o dado da família', () => {
    const marker = Object.create(null) as object
    const throwers: [string, () => unknown][] = [
      ['string', () => { throw 'segredo-da-familia' }], ['null', () => { throw null }], ['undefined', () => { throw undefined }],
      ['número', () => { throw 42 }], ['objeto', () => { throw marker }],
    ]
    for (const [, thrower] of throwers) {
      const w = createPdf({ marginCm: 1, title: 'N1', fontRoles: ROLES, sheetStart: (_d, n) => { if (n === 2) thrower() } })
      const got = thrown(() => w.doc.addPage())
      const want = thrown(thrower)
      expect(got).toEqual(want)
      if (typeof want.value === 'object' && want.value !== null) expect(got.value).toBe(marker)
      const refused = errorOf(() => w.end())
      expect(refused?.message).toMatch(D144)
      expect(refused?.message).not.toContain('segredo')
    }
    const thenables: object[] = [{ get then() { throw new Error('segredo-do-getter') } }, { then() { throw new Error('segredo-da-chamada') } }]
    for (const t of thenables) {
      const w = createPdf({ marginCm: 1, title: 'N2', fontRoles: ROLES, sheetStart: ((_d: PDFKit.PDFDocument, n: number) => (n === 2 ? t : undefined)) as never })
      expect(errorOf(() => w.doc.addPage())).not.toBeNull()
      const refused = errorOf(() => w.end())
      expect(refused?.message).toMatch(D144)
      expect(refused?.message).not.toContain('segredo')
    }
  })
})

describe('NE-1b gate R11 — D-NE145 (`advance` = a ÚLTIMA linha) resistiu', () => {
  const d = createPdf({ marginCm: 1, title: 'A1', fontRoles: ROLES }).doc
  const m = (t: string, o: { width?: number } = {}) => measureText(d, 'content', t, { x: 40, sizePt: 10, ...o })

  it('última linha VAZIA ("abc\\n", só "\\n"): `advance` 0 (o próximo trecho entra no começo da linha), `width` a mais larga, altura de 1 linha', () => {
    expect(m('abc\n')).toEqual(expect.objectContaining({ width: m('abc').width, advance: 0, height: m('abc').height }))
    expect(m('\n')).toEqual(expect.objectContaining({ width: 0, advance: 0, height: m('abc').height }))
  })

  it('NBSP: na linha única conta no `advance` e não na `width`; NBSP como ÚLTIMA linha = o avanço do NBSP', () => {
    expect(m('R$ ').width).toBeCloseTo(m('R$').width, 9)
    expect(m('R$ ').advance).toBeCloseTo(m('R$').width + m(' ').advance, 9)
    expect(m('abc\n ').advance).toBeCloseTo(m(' ').advance, 9)
    expect(m('abc\n ').width).toBeCloseTo(m('abc').width, 9)
  })

  it('CONHECIMENTO NEGATIVO (D-NE145 — "não se aplica"): com `width` que quebra, `advance` (e `width`) são da linha SEM a quebra do quebrador — maiores que a largura pedida', () => {
    const r = m('palavra palavra palavra palavra palavra', { width: 60 })
    expect(r.advance).toBeGreaterThan(60)
    expect(r.height).toBeGreaterThan(m('palavra', { width: 60 }).height * 4)
  })
})

describe('NE-1b gate R11 — D-NE146 (`lineBreak: false` sem quebra de linha) resistiu', () => {
  it('U+2028/U+2029/NEL/VT/FF viram "?" (contados) e saem numa linha só — com e sem `width`; "\\r" e "\\r\\n" viram "\\n" e são recusados; `continued: false` e `continued: true` com "\\n" caem na D-NE146', async () => {
    const w = createPdf({ marginCm: 1, title: 'B1', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    const seps = [' ', ' ', '\u0085', '\u000B', '\u000C']
    seps.forEach((s, i) => {
      expect(writeText(d, 'content', `a${s}b`, { x: 40, y: 100 + 15 * i, lineBreak: false })).toEqual({ replaced: 1 })
      expect(writeText(d, 'content', `a${s}b`, { x: 300, y: 100 + 15 * i, width: 100, lineBreak: false })).toEqual({ replaced: 1 })
    })
    for (const t of ['a\rb', 'a\r\nb', 'a\nb', '\r']) for (const o of [{}, { width: 100 }, { continued: false }]) {
      expect(errorOf(() => writeText(d, 'content', t, { x: 40, y: 400, lineBreak: false, ...o }))?.message).toMatch(/não leva quebra de linha \(D-NE146\)$/)
    }
    expect(errorOf(() => writeText(d, 'content', 'a\nb', { x: 40, y: 400, lineBreak: false, continued: true }))?.message).toMatch(/D-NE146/)
    const runs = pdfTextRuns(pdfContentOps(await w.end())[0])
    expect(runs.map(r => r.text)).toEqual(Array(2 * seps.length).fill('a?b'))
    expect(new Set(runs.filter(r => r.x < 200).map(r => r.yPdf)).size).toBe(seps.length)   // cada uma na SUA linha de base, uma vez
  })
})

describe('NE-1b gate R11 — D-NE147 (o vazio não chama o pdfkit) resistiu fora do R11-L1', () => {
  it('só x, só y, sublinhado/riscado no pé, `undefined`/`null`/`[]`/`toString` vazio no pé: nada escrito, nenhum traço, nenhuma folha, x/y como informados; `0` escreve "0"; sem largura útil a partir de x recusa como a medida', async () => {
    const w = createPdf({ marginCm: 1, title: 'V1', creationDate: FIXED, fontRoles: ROLES })
    const d = w.doc
    writeText(d, 'content', 'antes', { x: 40, y: 100 })
    const yAfter = d.y
    writeText(d, 'content', '', { x: 77 })
    expect([d.x, d.y]).toEqual([77, yAfter])
    writeText(d, 'content', '', { y: 300 })
    expect([d.x, d.y]).toEqual([77, 300])
    writeText(d, 'content', '', { x: 50, y: d.page.maxY(), width: 200, underline: true, strike: true })
    expect([d.x, d.y, sheetsOf(d)]).toEqual([50, d.page.maxY(), 1])
    for (const [i, t] of ([undefined, null, [], { toString: () => '' }] as unknown[]).entries()) {
      expect(writeText(d, 'content', t as string, { x: 60 + i, y: d.page.maxY() })).toEqual({ replaced: 0 })
      expect([d.x, sheetsOf(d)]).toEqual([60 + i, 1])
    }
    writeText(d, 'content', 0 as unknown as string, { x: 64, y: 400 })
    expect(errorOf(() => writeText(d, 'content', '', { x: d.page.width - 5 }))?.message).toMatch(/não há largura útil/)
    expect(errorOf(() => measureText(d, 'content', '', { x: d.page.width - 5 }))?.message).toMatch(/não há largura útil/)
    const ops = pdfContentOps(await w.end())
    expect(ops).toHaveLength(1)
    expect(pdfTextRuns(ops[0]).map(r => r.text)).toEqual(['antes', '0'])
    expect(ops[0]).not.toMatch(/ l\n/)
  })

  it('vazio no `sheetStart` (com `y`) e na passada no pé e em `y = altura da folha`: nenhuma folha nova, o documento fecha; o vazio é o último ato do sheetStart → o conteúdo começa no `y` dele', async () => {
    const w = createPdf({
      marginCm: 1, title: 'V2', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => { writeText(d, 'title', `CAB ${n}`, { x: 40, y: 20, lineBreak: false }); writeText(d, 'content', '', { x: 40, y: 50 }) },
    })
    expect(w.doc.y).toBe(50)
    writeText(w.doc, 'content', lines(120, 'item'), { x: 40, sizePt: 9 })
    const pdf = await w.end(dd => {
      writeText(dd, 'content', '', { x: 40, y: dd.page.maxY() })
      writeText(dd, 'content', '', { x: 40, y: dd.page.height, width: 100 })
    })
    expect(pdfPageCount(pdf)).toBe(2)
  })
})

describe('NE-1b gate R11 — volta à folha do isolado pelo PROTÓTIPO (R10-L2) resistiu com espiões e embrulhos no `switchToPage`/`save`/`restore`', () => {
  const overflowing = () => createPdf({
    marginCm: 1, title: 'S', creationDate: FIXED, fontRoles: ROLES,
    sheetStart: (d, n) => { writeText(d, 'title', n === 2 ? lines(200, 'cab') : `CAB ${n}`, { x: 40, y: 20 }); d.y = 60 },
  })
  const OPENED = 'base de PDF: o sheetStart abriu folha (o que ele escreve não cabe na folha)'

  const spies: [string, (d: PDFKit.PDFDocument) => jest.SpyInstance[]][] = [
    ['espião no `switchToPage` do PROTÓTIPO', d => [jest.spyOn(Object.getPrototypeOf(d), 'switchToPage')]],
    ['espião PRÓPRIO no `restore`', d => [jest.spyOn(d, 'restore')]],
    ['espião próprio no `save` + espião no `restore` do protótipo', d => [jest.spyOn(d, 'save'), jest.spyOn(Object.getPrototypeOf(d), 'restore')]],
  ]
  for (const [name, install] of spies) {
    it(`${name}: o sheetStart que transborda sobe com a causa dele, a pilha volta a zero, a fonte da família volta, cada folha balanceada, o end() recusa (D-NE144)`, () => {
      const w = overflowing()
      const d = w.doc
      const installed = install(d)
      const e = errorOf(() => writeText(d, 'content', lines(120, 'item'), { x: 40, sizePt: 9 }))
      const state = { stack: internals(d)._ctmStack.length, font: internals(d)._font.name, size: internals(d)._fontSize }
      const live = liveContentOps(d).map(qDepth)
      installed.forEach(s => s.mockRestore())
      expect(e?.message).toBe(OPENED)
      expect(state).toEqual({ stack: 0, font: 'Times-Roman', size: 9 })
      expect(live.every(q => q.final === 0 && q.min === 0)).toBe(true)
      expect(errorOf(() => w.end())?.message).toMatch(/ficou inválido e não fecha — o sheetStart abriu folha/)
    })
  }

  it('embrulho da FAMÍLIA (sem a marca) no `switchToPage` que recusa sempre: a volta passa por baixo dele, o embrulho continua no lugar e o documento fica inválido', () => {
    const w = overflowing()
    const d = w.doc
    const wrapper = function refuse(): never { throw new Error('a família trava a troca') }
    internals(d).switchToPage = wrapper
    expect(errorOf(() => writeText(d, 'content', lines(120, 'item'), { x: 40, sizePt: 9 }))?.message).toBe(OPENED)
    expect([internals(d).switchToPage, internals(d)._ctmStack.length]).toEqual([wrapper, 0])
    expect(liveContentOps(d).map(qDepth).every(q => q.final === 0 && q.min === 0)).toBe(true)
    expect(() => w.end()).toThrow(/ficou inválido e não fecha/)
  })

  it('LIMITE (mau uso deliberado): o `switchToPage` do PROTÓTIPO sabotado para lançar — a limpeza do isolado para no meio (q aberto, fonte do cabeçalho), mas o documento MORRE: o end() recusa', () => {
    const w = overflowing()
    const d = w.doc
    const spy = jest.spyOn(Object.getPrototypeOf(d), 'switchToPage').mockImplementation(() => { throw new Error('protótipo sabotado') })
    const e = errorOf(() => writeText(d, 'content', lines(120, 'item'), { x: 40, sizePt: 9 }))
    spy.mockRestore()
    expect(e?.message).toBe('protótipo sabotado')
    expect(() => w.end()).toThrow(/ficou inválido e não fecha/)
  })
})

describe('NE-1b gate R11 — `liveContentOps` honesto fora do R11-L5: coincide com o PDF final nos documentos que fecham', () => {
  it('3 folhas com cabeçalho, marca d\'água (0,3), barras, QR, retângulo e texto: o vivo antes do end() = o final (mesma anotação de opacidade); folha só com TRAÇO sai do `pdfContentOps` (sem BT/re) e fica no vivo — filtrado pelo mesmo critério, coincide', async () => {
    const w = createPdf({
      marginCm: 1, title: 'O1', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => {
        drawWatermark(d, 'SEM VALOR', { font: 'Helvetica', sizePt: 40, color: 'gray', opacity: 0.3 })
        drawBars(d, BARS, { x: 30, y: 30, width: cmToPt(11.5), height: 12 })
        drawMatrix(d, QR, { x: 480, y: 20, size: 60 })
        writeText(d, 'title', `CAB ${n}`, { x: 40, y: 50, lineBreak: false })
        d.y = 90
      },
    })
    const d = w.doc
    writeText(d, 'content', lines(150, 'item'), { x: 40, sizePt: 9 })
    d.rect(10, 10, 20, 20).fill()
    const live = liveContentOps(d)
    const final = pdfContentOps(await w.end())
    expect(live).toHaveLength(3)
    expect(live).toEqual(final)
    expect(live.map(qDepth)).toEqual(final.map(qDepth))

    const v = createPdf({ marginCm: 1, title: 'O2', creationDate: FIXED, fontRoles: ROLES })
    writeText(v.doc, 'content', 'folha 1', { x: 40, y: 100 })
    v.doc.addPage()
    v.doc.moveTo(40, 100).lineTo(200, 100).stroke()                                              // folha 2: só traço
    const vivo = liveContentOps(v.doc)
    const fim = pdfContentOps(await v.end())
    expect([vivo.length, fim.length]).toEqual([2, 1])
    expect(vivo.filter(o => /\bBT\b|\bre\b/.test(o))).toEqual(fim)
  })
})
