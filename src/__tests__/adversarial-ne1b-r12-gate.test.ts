/// <reference types="jest" />
// GATE ADVERSARIAL do DELTA 15f3373..HEAD da NE-1b (revisor independente, 2026-10-18 — skill `testar-adversarial.md`): ataques à leva do gate R11
// (877402f — R11-L2 folga relativa no "lugar para 1 linha" depois do `sheetStart`; R11-L3 a mensagem da PRÓPRIA causa; R11-L4 o `y` lido uma vez
// dentro do trecho que invalida; R11-L5/socrático L3 o oráculo vivo arredonda como o PDF e falha fechado) e à Rodada 12 (f2ca95a — D-NE152: o
// texto VAZIO que fecha a cadeia aberta é fechado pela BASE, `x`/`y` onde o fechamento com texto deixaria, nenhuma folha abre).
// Os gates anteriores estão em `adversarial-ne1b-gate`, `-delta-gate`, `-r7-gate`, `-final-gate`, `-r9-gate`, `-r10-gate` e `-r11-gate`; os
// positivos da rodada em `pdf-rodada11` (não repetidos aqui).
//
// Ataque que RESISTIU fica como teste verde; achado CONFIRMADO fica como `it.failing` com o rótulo "[ACHADO <SEVERIDADE>]" — o corpo afirma o
// comportamento CORRETO, então quando a correção entrar o `it.failing` passa a FALHAR e vira `it` comum.
import { createPdf, writeText, measureText } from '../pdf'
import { pdfContentOps, pdfTextRuns, pdfPageCount, liveContentOps, qDepth } from './pdf-oracle'

const FIXED = new Date('2026-10-18T03:00:00Z')
const ROLES = { title: 'Times-Bold', content: 'Times-Roman', fixed: 'Courier' } as const
type Role = keyof typeof ROLES
const lines = (n: number, p = 'linha') => Array.from({ length: n }, (_, i) => `${p} ${i + 1}`).join('\n')
const internals = (doc: PDFKit.PDFDocument) => doc as unknown as Record<string | symbol, any>
const sheetsOf = (doc: PDFKit.PDFDocument): number => internals(doc)._pageBuffer.length
const errorOf = (fn: () => unknown): Error | null => { try { fn(); return null } catch (e) { return e as Error } }
const D144 = /^base de PDF: o documento ficou inválido e não fecha — o sheetStart (falhou|deixou o y fora da área útil|abriu folha).*\(monte de novo\)$/
const BALANCED = { final: 0, min: 0 }

type Step = (d: PDFKit.PDFDocument) => void
type CloseOpts = Record<string, unknown> & { role?: Role }
interface After { x: number; y: number; sheets: number; page: number; open: boolean; added: string[] }
/**
 * Abre a cadeia num documento NOVO, fecha com `closeText` e devolve onde ficaram `x`/`y`, a folha e o que entrou no conteúdo VIVO de cada folha
 * pelo fechamento (o gêmeo fechado com texto é o oráculo da D-NE152).
 */
function closeChain(open: Step, closeText: string, close: CloseOpts = {}, sheetStart?: (d: PDFKit.PDFDocument, n: number) => void): After {
  const d = createPdf({ marginCm: 1, title: 'R12', creationDate: FIXED, fontRoles: ROLES, ...(sheetStart ? { sheetStart } : {}) }).doc
  open(d)
  const before = liveContentOps(d)
  const { role = 'content', ...opts } = close
  writeText(d, role, closeText, opts)
  const after = liveContentOps(d)
  return { x: d.x, y: d.y, sheets: sheetsOf(d), page: internals(d)._pageBuffer.indexOf(d.page), open: !!internals(d)._wrapper,
    added: after.map((ops, i) => ops.slice((before[i] ?? '').length)) }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ACHADOS CONFIRMADOS
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate R12 — [ACHADO LOW] R12-L1: com `paragraphGap` (da cadeia ou do fechamento) o `y` do vazio difere do fechamento com texto em 1 ulp — a D-NE152 promete "onde o fechamento com texto deixaria"', () => {
  /**
   * O pdfkit soma em DUAS parcelas: o `_line` faz `y += altura da linha + lineGap` e o `once('line')` do `lastLine` faz `y += paragraphGap`. A base
   * soma de uma vez — `y += altura + lineGap + paragraphGap` — e a associação de float64 muda o último bit em ~25 % das combinações (885 de 3.240 na
   * varredura exploratória do gate; 82 das 324 abaixo: corpos 6–10,3 × papel/corpo do fechamento × `lineGap`/`paragraphGap` × `y` 100/333,33/700,1).
   * A paridade do `pdf-rodada11` compara com `toBeCloseTo(…, 9)` e esconde a diferença. Efeito: 1e-13 pt, absorvido por toda folga da base (D-NE140,
   * R11-L2) e pelo float32 do pdfkit — nenhuma folha, nenhum desenho muda; só o contrato "exatamente" e a família que compare posições com `===`
   * — LOW. Correção sugerida (sem decisão — a D-NE152 continua): somar na ordem do pdfkit, `doc.y += currentLineHeight(true) + lineGap` e DEPOIS
   * `doc.y += paragraphGap` (provado abaixo: a fórmula em duas parcelas reproduz o fechamento com texto bit a bit em TODAS as combinações).
   */
  const SIZES = [6, 8.5, 10.3]
  const CHAIN_PG = [undefined, 0.1, 2.3]
  const CLOSE_PG = [undefined, 0.3, 1.1]
  const CLOSE_LG = [undefined, 0.7]
  const CLOSE_SIZE = [undefined, 7.7]
  const Y0 = [100, 333.33, 700.1]
  const grid = function* () {
    for (const s of SIZES) for (const pg of CHAIN_PG) for (const cpg of CLOSE_PG) for (const clg of CLOSE_LG) for (const cs of CLOSE_SIZE) for (const y0 of Y0) {
      const chain: Record<string, number> = { sizePt: s, lineGap: 1.7 }
      if (pg !== undefined) chain.paragraphGap = pg
      const close: CloseOpts = { role: 'title' }
      if (cs !== undefined) close.sizePt = cs
      if (clg !== undefined) close.lineGap = clg
      if (cpg !== undefined) close.paragraphGap = cpg
      const open: Step = d => { writeText(d, 'content', 'INF. COMPL.: ', { x: 40, y: y0, width: 300, continued: true, ...chain }) }
      yield { chain, close, y0, open }
    }
  }

  it('[CORRIGIDO — ACHADO LOW] R12-L1 — 324 combinações com e sem `paragraphGap`: o `y` do vazio é IGUAL (===) ao do fechamento com texto (hoje: difere em 1 ulp em parte delas)', () => {
    const diverge: string[] = []
    for (const { chain, close, y0, open } of grid()) {
      const empty = closeChain(open, '', close)
      const text = closeChain(open, 'X', close)
      if (empty.y !== text.y || empty.x !== text.x) diverge.push(`${JSON.stringify({ chain, close, y0 })}: ${empty.y} × ${text.y}`)
    }
    expect(diverge).toEqual([])
  })

  it('a prova da correção: a soma em DUAS parcelas (altura + lineGap, depois paragraphGap) reproduz o fechamento com texto bit a bit; a de UMA parcela é o que a base faz hoje', () => {
    let oneStepDiverges = 0
    for (const { chain, close, y0, open } of grid()) {
      const text = closeChain(open, 'X', close)
      const empty = closeChain(open, '', close)
      const probe = createPdf({ marginCm: 1, title: 'lh', fontRoles: ROLES }).doc
      const lh = probe.font(ROLES.title).fontSize((close.sizePt as number | undefined) ?? chain.sizePt).currentLineHeight(true)
      const lg = (close.lineGap as number | undefined) ?? chain.lineGap
      const pg = (close.paragraphGap as number | undefined) ?? chain.paragraphGap ?? 0
      expect((y0 + (lh + lg)) + pg).toBe(text.y)                                                   // a ordem do pdfkit
      expect(empty.y).toBe(text.y)                                                                  // a base, CORRIGIDA, na ordem do pdfkit
      if (y0 + (lh + lg + pg) !== text.y) oneStepDiverges++                                         // a soma de UMA vez (a base antes da correção)
    }
    expect(oneStepDiverges).toBeGreaterThan(0)                                                      // a grade distingue as duas ordens (não é vazia)
  })
})

describe('NE-1b gate R12 — [ACHADO LOW] R12-L2: o vazio COM `continued: true` (o que ABRE a cadeia, ou um trecho do MEIO) ainda vai ao pdfkit e, no pé, abre folha — fechado pelo vazio (D-NE152), a folha fica VAZIA', () => {
  /**
   * A D-NE147 tirou do pdfkit o vazio SEM `continued` e a D-NE152 o vazio que FECHA a cadeia; o vazio com `continued: true` segue no pdfkit (o
   * `pdf-rodada11` fixa: "`continued: true` vazio abre cadeia"). A conferência de ENTRADA do quebrador (`y + altura da linha > pé`) roda mesmo com
   * texto vazio: (a) o rótulo opcional VAZIO que abre a cadeia no pé exato (o empilhamento de baixo para cima do R10-L1: `y = pé − altura medida`,
   * e o vazio mede 0) abre a folha 2; (b) o trecho do MEIO vazio de corpo maior que o da cadeia, no pé, também. Se o resto da cadeia é vazio e o
   * fechamento é o vazio (agora fechado pela base, sem folha), a folha 2 sai SÓ com o cabeçalho — a R10-L1/R11-L1b pela porta do `continued`.
   * Com texto, a folha abriria do mesmo jeito, mas com o texto nela. Caminho público com dado plausível (rótulo/campo opcional vazios no pé) — LOW
   * (o DANFE posiciona por caixa; precisa de TODOS os trechos vazios). Pede decisão — Q-NE156.
   */
  const header = (d: PDFKit.PDFDocument, n: number) => { writeText(d, 'title', `CAB ${n}`, { x: 40, y: 20, lineBreak: false }); d.y = 60 }

  it('[CORRIGIDO — D-NE153] R12-L2a — rótulo opcional VAZIO que abre a cadeia no pé exato (`y = pé − 0`) + campo VAZIO que fecha: nenhuma folha nova (hoje: a folha 2 só com o cabeçalho)', async () => {
    const w = createPdf({ marginCm: 1, title: 'R12L2a', creationDate: FIXED, fontRoles: ROLES, sheetStart: header })
    const d = w.doc
    writeText(d, 'content', 'corpo', { x: 40, y: 100 })
    const label = ''                                                                                // rótulo opcional ausente
    // D-NE153: o vazio que ABRIRIA a cadeia é recusado (abra com o 1º trecho que tem texto) — nenhuma folha abre
    expect(() => writeText(d, 'content', label, { x: 40, y: d.page.maxY() - measureText(d, 'content', label, { width: 300 }).height, width: 300, continued: true }))
      .toThrow(/trecho vazio com continued sem cadeia aberta.*D-NE153/)
    writeText(d, 'content', '')                                                                     // campo opcional ausente (D-NE147: nada)
    const pdf = await w.end()
    expect(pdfPageCount(pdf)).toBe(1)
  })

  it('[CORRIGIDO — D-NE153] R12-L2b — cadeia de 7 pt no pé exato, trecho do MEIO vazio de outro papel (12 pt, `continued: true`) e o fechamento vazio: nenhuma folha nova (hoje: a folha 2 só com o cabeçalho)', async () => {
    const w = createPdf({ marginCm: 1, title: 'R12L2b', creationDate: FIXED, fontRoles: ROLES, sheetStart: header })
    const d = w.doc
    const m = measureText(d, 'content', 'Obs: ', { sizePt: 7, width: 300 })
    writeText(d, 'content', 'Obs: ', { x: 40, y: d.page.maxY() - m.height, width: 300, sizePt: 7, continued: true })
    writeText(d, 'title', '', { sizePt: 12, continued: true })
    writeText(d, 'content', '', { sizePt: 7 })
    const pdf = await w.end()
    expect(pdfPageCount(pdf)).toBe(1)
  })

  it('D-NE153: o vazio que abriria a cadeia no pé é RECUSADO (nenhuma folha abre); com TEXTO no lugar, o texto vai para a folha 2 (a folha nunca fica vazia)', async () => {
    const empty = createPdf({ marginCm: 1, title: 'R12L2p', creationDate: FIXED, fontRoles: ROLES, sheetStart: header })
    expect(() => writeText(empty.doc, 'content', '', { x: 40, y: empty.doc.page.maxY(), width: 300, continued: true })).toThrow(/D-NE153/)
    expect(pdfContentOps(await empty.end()).map(o => pdfTextRuns(o).map(r => r.text))).toEqual([['CAB 1']])
    const text = createPdf({ marginCm: 1, title: 'R12L2p', creationDate: FIXED, fontRoles: ROLES, sheetStart: header })
    writeText(text.doc, 'content', 'valor', { x: 40, y: text.doc.page.maxY(), width: 300, continued: true })
    writeText(text.doc, 'content', '')
    expect(pdfContentOps(await text.end()).map(o => pdfTextRuns(o).map(r => r.text))).toEqual([['CAB 1'], ['CAB 2', 'valor']])
  })
})

describe('NE-1b gate R12 — [ACHADO LOW] R12-L3 (oráculo): `liveContentOps` depois do `end()` (ou de um `flushPages`) devolve `[]` em vez de falhar — a falha FECHADA do socrático L3 nunca dispara', () => {
  /**
   * O `doc.end()` do pdfkit chama `flushPages()`, que ESVAZIA `_pageBuffer` (e avança `_pageBufferStart`): o `map` roda sobre nada e devolve `[]`
   * — a conferência da matriz-base por folha não chega a rodar. Asserção do tipo `liveContentOps(d).map(qDepth).every(…)` passa VAZIA (a classe do
   * socrático L1). O `flushPages` da família no meio do documento devolve só as folhas que sobraram, com a numeração da mensagem errada. Só
   * oráculo de teste (nenhum teste atual o chama depois do `end()` — conferido) — LOW. Correção sugerida: falhar se `_pageBufferStart !== 0` ou
   * `_pageBuffer.length === 0` antes do `map`.
   */
  it('[CORRIGIDO — ACHADO LOW] R12-L3a — depois do `end()`: lança (hoje: devolve [] e o `.every` passa vazio)', async () => {
    const w = createPdf({ marginCm: 1, title: 'R12L3a', creationDate: FIXED, fontRoles: ROLES })
    writeText(w.doc, 'content', 'corpo', { x: 40, y: 100 })
    expect(pdfContentOps(await w.end())).toHaveLength(1)
    expect(() => liveContentOps(w.doc)).toThrow(/oráculo/)
  })

  it('[CORRIGIDO — ACHADO LOW] R12-L3b — depois de um `flushPages` da família: lança (hoje: devolve só as folhas que sobraram)', () => {
    const w = createPdf({ marginCm: 1, title: 'R12L3b', creationDate: FIXED, fontRoles: ROLES })
    writeText(w.doc, 'content', 'folha 1', { x: 40, y: 100 })
    w.doc.flushPages()
    w.doc.addPage()
    writeText(w.doc, 'content', 'folha 2', { x: 40, y: 100 })
    expect(() => liveContentOps(w.doc)).toThrow(/oráculo/)
  })

  it('a prova do sintoma e da correção: depois do `end()` o vivo é `[]` e a asserção de equilíbrio passa VAZIA; a guarda sugerida (`_pageBufferStart`/folhas) lança ali e não muda nada antes do `end()`', async () => {
    const strict = (doc: PDFKit.PDFDocument): string[] => {
      if (internals(doc)._pageBufferStart !== 0 || internals(doc)._pageBuffer.length === 0) throw new Error('oráculo: o documento já despejou folhas')
      return liveContentOps(doc)
    }
    const w = createPdf({ marginCm: 1, title: 'R12L3p', creationDate: FIXED, fontRoles: ROLES })
    writeText(w.doc, 'content', 'corpo', { x: 40, y: 100 })
    expect(strict(w.doc)).toEqual(liveContentOps(w.doc))
    await w.end()
    expect(() => liveContentOps(w.doc)).toThrow(/oráculo/)                                       // CORRIGIDO: o oráculo falha fechado
    expect(() => strict(w.doc)).toThrow(/oráculo/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ATAQUES QUE RESISTIRAM (verdes — ficam como regressão)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate R12 — D-NE152: o vazio deixa `x`/`y` EXATAMENTE (===) onde o fechamento com texto deixaria (sem `paragraphGap` — fora do R12-L1)', () => {
  const chain = (text: string, opts: Record<string, unknown> = {}): Step => d => {
    writeText(d, 'content', text, { x: 40, y: 100, width: 200, continued: true, ...opts })
  }
  const wide = 'palavra '.repeat(40)
  const CASES: [string, Step, CloseOpts][] = [
    ['cadeia que já quebrou em várias linhas', chain(wide), {}],
    ['cadeia com quebras explícitas ("a\\nb\\nc")', chain('a\nb\nc'), {}],
    ['cadeia que termina em "\\n" (o pdfkit deixa o y no topo da linha dela)', chain('Obs:\n'), {}],
    ['cadeia com `indent`, várias linhas', chain(wide, { indent: 30 }), {}],
    ['fechamento com `indent`', chain('Obs: '), { indent: 25 }],
    ['cadeia `center` fechada `right`', chain('Obs: ', { align: 'center' }), { align: 'right' }],
    ['cadeia `justify` de várias linhas fechada `justify`', chain(wide, { align: 'justify' }), { align: 'justify' }],
    ['fechamento com `x`/`y` explícitos', chain('Obs: '), { x: 90, y: 300 }],
    ['fechamento só com `x`', chain('Obs: '), { x: 90 }],
    ['fechamento de outro papel e corpo, com `lineGap`', chain('Obs: ', { sizePt: 7 }), { role: 'fixed', sizePt: 11, lineGap: 2.3 }],
    ['`lineGap` só na cadeia', chain('Obs: ', { lineGap: 3.3 }), { role: 'title' }],
    ['`lineGap` do DOCUMENTO (doc.lineGap) e nenhum nas opções', d => { d.lineGap(4.1); chain('Obs: ')(d) }, {}],
    ['fechamento com `width`/`height` (o pdfkit reaproveita o quebrador da cadeia)', chain('Obs: '), { width: 50, height: 5 }],
    ['cadeia com `height` que estourou (o quebrador parou)', chain(wide, { height: 30 }), {}],
    ['cadeia de DOIS trechos de opções diferentes', d => { chain('A: ', { lineGap: 4 })(d); writeText(d, 'title', 'B ', { continued: true, sizePt: 14 }) }, {}],
    ['cadeia sublinhada/riscada fechada com sublinhado e riscado', chain('Obs: ', { underline: true, strike: true }), { underline: true, strike: true }],
    ['cadeia aberta pelo pdfkit CRU (Courier 11, sem papel da base, lineGap 3)', d => { d.font('Courier').fontSize(11); d.text('Obs: ', 40, 100, { width: 200, continued: true, lineGap: 3 } as never) }, {}],
    ['cadeia CRUA sem `width` (o pdfkit calcula)', d => { d.text('Obs: ', 40, 100, { continued: true } as never) }, {}],
    ['cadeia CRUA girada (rotation 30)', d => { d.text('Obs: ', 40, 100, { width: 200, continued: true, rotation: 30 } as never) }, {}],
    ['cadeia CRUA em 2 colunas que mudou de coluna', d => { d.text(wide.repeat(3), 40, 100, { width: 400, columns: 2, continued: true } as never) }, {}],
    ['cadeia que TRANSBORDOU de folha (o y está na folha 2)', d => { writeText(d, 'content', lines(80, 'item') + ' fim: ', { x: 40, y: 100, width: 300, continued: true }) }, {}],
    ['cadeia no PÉ, fechamento do mesmo corpo', d => {
      const m = measureText(d, 'content', 'Obs: ', { width: 300 })
      writeText(d, 'content', 'Obs: ', { x: 40, y: d.page.maxY() - m.height, width: 300, continued: true })
    }, {}],
    ['cadeia com um trecho VAZIO `continued: true` no MEIO (D-NE153: não soma nada)', d => { chain('Obs: ')(d); writeText(d, 'content', '', { continued: true }) }, {}],
  ]
  for (const [name, open, close] of CASES) {
    it(`${name}: x e y iguais (===), mesma folha, cadeia fechada; o vazio não acrescenta NADA ao conteúdo`, () => {
      const empty = closeChain(open, '', close)
      const text = closeChain(open, 'X', close)
      expect({ x: empty.x, y: empty.y, sheets: empty.sheets, page: empty.page, open: empty.open })
        .toEqual({ x: text.x, y: text.y, sheets: text.sheets, page: text.page, open: false })
      expect(empty.added.every(a => a === '')).toBe(true)
    })
  }

  it('com `sheetStart`: a cadeia que transborda e a cadeia aberta quando a família chama `addPage()` no MEIO dela (o cabeçalho abre e fecha a PRÓPRIA cadeia com o vazio) — a cadeia de fora sobrevive ao cabeçalho e o vazio fecha onde o texto fecharia', () => {
    const sheetStart = (d: PDFKit.PDFDocument, n: number) => {
      writeText(d, 'title', `Folha ${n}: `, { x: 40, y: 20, width: 200, continued: true })
      writeText(d, 'title', '')                                                                    // o cabeçalho fecha a dele com o vazio
      d.y += 10
    }
    const overflow: Step = d => { writeText(d, 'content', lines(80, 'item') + ' fim: ', { x: 40, y: 100, width: 300, continued: true }) }
    const explicit: Step = d => { writeText(d, 'content', 'Obs: ', { x: 60, y: 300, width: 300, continued: true }); d.addPage() }
    for (const open of [overflow, explicit]) {
      const empty = closeChain(open, '', {}, sheetStart)
      const text = closeChain(open, 'X', {}, sheetStart)
      expect(empty).toEqual({ ...text, open: false, added: empty.added })
      expect(empty.added.every(a => a === '')).toBe(true)
      expect(empty.page).toBe(1)
    }
    // a cadeia do cabeçalho fechada pelo vazio deixa o y onde o texto deixaria (o conteúdo começa ali — keep: ['y'])
    const withText = createPdf({ marginCm: 1, title: 'h', fontRoles: ROLES,
      sheetStart: (d, n) => { writeText(d, 'title', `Folha ${n}: `, { x: 40, y: 20, width: 200, continued: true }); writeText(d, 'title', 'X'); d.y += 10 } }).doc
    const withEmpty = createPdf({ marginCm: 1, title: 'h', fontRoles: ROLES, sheetStart }).doc
    expect(withEmpty.y).toBe(withText.y)
  })

  it('o que o pdfkit fazia com o `\'\'` e a base deixou de fazer não importa: o `doc.text(\'\')` CRU também não emite linha (nada de sublinhado, cor, BT/Tj) — só o q/cm/Q vazio da cadeia CRUA girada', () => {
    const rawClose = (open: Step): string[] => {
      const d = createPdf({ marginCm: 1, title: 'raw', fontRoles: ROLES }).doc
      open(d)
      const before = liveContentOps(d)
      d.text('', { underline: true, strike: true } as never)
      return liveContentOps(d).map((o, i) => o.slice(before[i].length))
    }
    expect(rawClose(d => { writeText(d, 'content', 'Obs: ', { x: 40, y: 100, width: 200, continued: true, underline: true }) })).toEqual([''])
    expect(rawClose(d => { d.fillColor('red'); writeText(d, 'content', 'Obs: ', { x: 40, y: 100, width: 200, continued: true }) })).toEqual([''])
    const rotated = rawClose(d => { d.text('Obs: ', 40, 100, { width: 200, continued: true, rotation: 30 } as never) })
    expect(rotated).toEqual([expect.stringMatching(/^q\n[-\d. ]+ cm\nQ\n$/)])
    // e o fechamento com texto SUBLINHADO desenha o traço só sob o texto do fechamento (o do trecho da cadeia já saiu na escrita dele)
    const text = closeChain(d => { writeText(d, 'content', 'Obs: ', { x: 40, y: 100, width: 200, continued: true, underline: true }) }, 'X', { underline: true })
    expect((text.added[0].match(/ l\n/g) ?? []).length).toBe(1)
    expect((text.added[0].match(/\bBT\b/g) ?? []).length).toBe(1)
  })

  it('CONHECIMENTO NEGATIVO (a letra da D-NE152 — "uma linha abaixo da linha encadeada"): com a linha encadeada CHEIA o texto do fechamento quebra para a linha seguinte (2 linhas); o vazio fica UMA linha abaixo — não há texto a quebrar', () => {
    const full: Step = d => {
      let t = ''
      while (measureText(d, 'content', t + 'W', { x: 40 }).width <= 200) t += 'W'                 // a cadeia cabe; mais um "W" não
      writeText(d, 'content', t, { x: 40, y: 100, width: 200, continued: true })
    }
    const lh = createPdf({ marginCm: 1, title: 'lh', fontRoles: ROLES }).doc.font(ROLES.content).fontSize(12).currentLineHeight(true)
    const empty = closeChain(full, '')
    const text = closeChain(full, 'W')
    expect(empty.y).toBeCloseTo(100 + lh, 9)
    expect(text.y).toBeCloseTo(100 + 2 * lh, 9)
  })
})

describe('NE-1b gate R12 — D-NE152 no PÉ: nenhuma folha abre; o `y` fica abaixo do pé e quem abre a folha é o próximo bloco COM conteúdo', () => {
  const footChain = (d: PDFKit.PDFDocument) => {
    const m = measureText(d, 'content', 'Obs: ', { sizePt: 7, width: 300 })
    writeText(d, 'content', 'Obs: ', { x: 40, y: d.page.maxY() - m.height, width: 300, sizePt: 7, continued: true })
  }

  it('cadeia de 7 pt no pé fechada com vazio de 12 pt, sublinhado: nenhuma folha, nenhum traço, cadeia fechada; o próximo bloco só com `x` abre a folha 2 e escreve NELA (folha nenhuma sai vazia)', async () => {
    const w = createPdf({ marginCm: 1, title: 'P1', creationDate: FIXED, fontRoles: ROLES, sheetStart: (d, n) => { writeText(d, 'title', `CAB ${n}`, { x: 40, y: 20, lineBreak: false }); d.y = 60 } })
    const d = w.doc
    footChain(d)
    const before = liveContentOps(d)
    writeText(d, 'title', '', { sizePt: 12, underline: true })
    expect({ sheets: sheetsOf(d), open: !!internals(d)._wrapper, x: d.x }).toEqual({ sheets: 1, open: false, x: 40 })
    expect(liveContentOps(d)).toEqual(before)
    expect(d.y).toBeGreaterThan(d.page.maxY())
    writeText(d, 'content', 'RESERVADO AO FISCO', { x: 40 })
    const pages = pdfContentOps(await w.end()).map(o => pdfTextRuns(o).map(r => r.text))
    expect(pages).toEqual([['CAB 1', 'Obs: '], ['CAB 2', 'RESERVADO AO FISCO']])
  })

  it('na PASSADA: fechar com o vazio de corpo maior no pé não abre folha (o documento fecha); com texto, a passada abriria folha (erro de uso) — o vazio é estritamente melhor', async () => {
    const pass = (close: string) => (d: PDFKit.PDFDocument) => { footChain(d); writeText(d, 'title', close, { sizePt: 12 }) }
    const ok = createPdf({ marginCm: 1, title: 'P2', creationDate: FIXED, fontRoles: ROLES })
    writeText(ok.doc, 'content', 'corpo', { x: 40, y: 100 })
    expect(pdfPageCount(await ok.end(pass('')))).toBe(1)
    const bad = createPdf({ marginCm: 1, title: 'P2', creationDate: FIXED, fontRoles: ROLES })
    writeText(bad.doc, 'content', 'corpo', { x: 40, y: 100 })
    expect(errorOf(() => bad.end(pass('X')))?.message).toMatch(/a passada por folha (abriu folha|trocou de folha)/)
  })

  it('no SHEETSTART: o vazio de corpo maior no pé não abre folha — a causa é "y fora da área útil" (D-NE144), nunca "abriu folha"; com o mesmo corpo e longe do pé o documento fecha', async () => {
    const bad = createPdf({ marginCm: 1, title: 'P3', fontRoles: ROLES, sheetStart: (d, n) => { if (n === 2) { footChain(d); writeText(d, 'title', '', { sizePt: 12 }) } } })
    expect(errorOf(() => bad.doc.addPage())?.message).toBe('base de PDF: o sheetStart deixou o y fora da área útil (sem lugar para o conteúdo da folha)')
    expect(sheetsOf(bad.doc)).toBe(2)
    expect(errorOf(() => bad.end())?.message).toMatch(/o sheetStart deixou o y fora da área útil \(D-NE144\)/)
    const good = createPdf({ marginCm: 1, title: 'P3', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => { writeText(d, 'title', `Folha ${n}: `, { x: 40, y: 20, width: 300, continued: true }); writeText(d, 'title', '') } })
    writeText(good.doc, 'content', lines(120, 'item'), { x: 40, sizePt: 9 })
    const ops = pdfContentOps(await good.end())
    expect(ops.map(qDepth)).toEqual([BALANCED, BALANCED])
    expect(ops.map(o => pdfTextRuns(o)[0].text)).toEqual(['Folha 1: ', 'Folha 2: '])
  })
})

describe('NE-1b gate R12 — pdf-writer: folga relativa no "lugar para 1 linha" (R11-L2), mensagem da PRÓPRIA causa (R11-L3), o `y` lido uma vez dentro do protegido (R11-L4)', () => {
  const lineHeight = (font: string, sizePt: number, paper?: { widthCm: number; heightCm: number }): number =>
    createPdf({ marginCm: 1, title: 'lh', fontRoles: ROLES, ...(paper ? { paper } : {}) }).doc.font(font).fontSize(sizePt).currentLineHeight(true)

  it('falso NEGATIVO: o cabeçalho que termina ALÉM da folga é recusado (A4: room + 1e-6 pt; papel de 14.400 pt: room + 1e-7 pt) — e DENTRO dela (metade da folga) o conteúdo segue e o documento fecha', async () => {
    const PAPERS: (undefined | { widthCm: number; heightCm: number })[] = [undefined, { widthCm: 50, heightCm: 508 }]
    for (const paper of PAPERS) {
      const lh = lineHeight('Times-Roman', 9, paper)
      const make = (delta: (room: number) => number) => createPdf({
        marginCm: 1, title: 'W1', creationDate: FIXED, fontRoles: ROLES, ...(paper ? { paper } : {}),
        sheetStart: (d, n) => { const room = d.page.height - d.page.margins.bottom - lh; d.y = n === 1 ? 60 : room + delta(room) },
      })
      const n = paper ? 1435 : 85                                                                  // ~8 linhas além da folha 1
      const beyond = make(() => (paper ? 1e-7 : 1e-6))
      expect(errorOf(() => writeText(beyond.doc, 'content', lines(n, 'item'), { x: 40, sizePt: 9 }))?.message).toMatch(/y fora da área útil/)
      expect(() => beyond.end()).toThrow(D144)
      const within = make(room => Math.abs(room) * 2 ** -41)
      expect(errorOf(() => { within.doc.y = 40; writeText(within.doc, 'content', lines(n, 'item'), { x: 40, sizePt: 9 }) })).toBeNull()
      const pages = pdfContentOps(await within.end())
      expect(pages.length).toBeGreaterThan(2)
      expect(pages.slice(1).every(o => pdfTextRuns(o).length === 1)).toBe(true)                    // uma linha por folha de transbordo
    }
  })

  it('falso POSITIVO: `y` no topo (0 e −0), exatamente em `room` e `room` na folha de corpo 1000 (a linha maior que a folha) — o topo e o `room` exato passam; corpo 1000 recusa (não há lugar), sem laço de folhas', () => {
    for (const y of [0, -0]) {
      const w = createPdf({ marginCm: 1, title: 'F1', fontRoles: ROLES, sheetStart: d => { d.y = y } })
      expect(errorOf(() => w.doc.addPage())).toBeNull()
    }
    const exact = createPdf({ marginCm: 1, title: 'F1', fontRoles: ROLES,
      sheetStart: (d, n) => { if (n === 2) d.y = d.page.height - d.page.margins.bottom - d.currentLineHeight(true) } })
    writeText(exact.doc, 'content', lines(200, 'item'), { x: 40, y: 40, sizePt: 9 })
    expect(sheetsOf(exact.doc)).toBeGreaterThan(2)                                                 // 1 linha por folha, sem recusa
    const huge = createPdf({ marginCm: 1, title: 'F1', fontRoles: ROLES, sheetStart: (d, n) => { if (n === 1) d.y = 40 } })
    expect(errorOf(() => writeText(huge.doc, 'content', 'a b c d e f', { x: 40, y: 40, width: 20, sizePt: 1000 }))?.message).toMatch(/y fora da área útil/)
    expect(sheetsOf(huge.doc)).toBe(2)
  })

  it('o `y` que não é número finito (string numérica, `Number` embrulhado, NaN, Infinity): recusado — a causa e a mensagem imediata são a do `y`', () => {
    for (const bad of ['60', new Number(60), NaN, Infinity] as unknown[]) {
      const w = createPdf({ marginCm: 1, title: 'Y', fontRoles: ROLES, sheetStart: (d, n) => { if (n === 2) (d as unknown as { y: unknown }).y = bad } })
      expect(errorOf(() => w.doc.addPage())?.message).toBe('base de PDF: o sheetStart deixou o y fora da área útil (sem lugar para o conteúdo da folha)')
      expect(errorOf(() => w.end())?.message).toMatch(/o sheetStart deixou o y fora da área útil \(D-NE144\)/)
    }
  })

  it('a mensagem imediata é SEMPRE a da causa daquela folha, e o `end()` diz a PRIMEIRA: família → y fora; y fora → abriu folha; save() sem restore → família', () => {
    const SEQ: [string, (d: PDFKit.PDFDocument) => void, RegExp][] = [
      ['família', () => { throw new Error('falha da família') }, /^falha da família$/],
      ['y fora', d => { d.y = d.page.height }, /^base de PDF: o sheetStart deixou o y fora da área útil/],
      ['abriu folha', d => { writeText(d, 'content', lines(300, 'cab'), { x: 40, y: 20 }) }, /^base de PDF: o sheetStart abriu folha/],
      ['save', d => { d.save() }, /^base de PDF: o sheetStart deixou save\(\) sem restore\(\)$/],
    ]
    const FIRST: Record<string, RegExp> = {
      'família': /o sheetStart falhou \(a folha ficou sem o cabeçalho inteiro — D-NE144\)/,
      'y fora': /o sheetStart deixou o y fora da área útil \(D-NE144\)/,
      'abriu folha': /o sheetStart abriu folha/,
      'save': /o sheetStart falhou \(a folha ficou sem o cabeçalho inteiro — D-NE144\)/,
    }
    for (let i = 0; i < SEQ.length; i++) {
      const order = [SEQ[i], SEQ[(i + 1) % SEQ.length]]
      const w = createPdf({ marginCm: 1, title: 'M', fontRoles: ROLES, sheetStart: (d, n) => { if (n >= 2) order[n - 2]?.[1](d); if (n >= 4 || n === 1) d.y = 60 } })
      for (const [, , msg] of order) expect(errorOf(() => w.doc.addPage())?.message).toMatch(msg)
      expect(errorOf(() => w.end())?.message).toMatch(FIRST[order[0][0]])
      expect(liveContentOps(w.doc).map(qDepth).every(q => q.final === 0 && q.min === 0)).toBe(true)
      expect(liveContentOps(w.doc).length).toBeGreaterThanOrEqual(3)                              // não é vazio
    }
  })

  it('LIMITE (mau uso deliberado — o `y` é campo de dados do pdfkit): um acessor que dá um `y` válido na conferência e outro depois escapa — a conferência é de UMA leitura, e o que vem depois é da família', async () => {
    let reads = 0
    const w = createPdf({ marginCm: 1, title: 'L', creationDate: FIXED, fontRoles: ROLES, sheetStart: (d, n) => {
      if (n === 2) Object.defineProperty(d, 'y', { configurable: true, get() { return ++reads === 1 ? 60 : NaN }, set() { /* engole */ } })
    } })
    expect(errorOf(() => w.doc.addPage())).toBeNull()
    expect(reads).toBe(1)                                                                          // UMA leitura na conferência (R11-L4)
    expect(w.doc.y).toBeNaN()                                                                      // o que vem depois é do acessor da família
    Object.defineProperty(w.doc, 'y', { configurable: true, writable: true, value: 60 })
    expect(pdfPageCount(await w.end())).toBe(2)                                                    // não marcado: o documento fecha
  })
})

describe('NE-1b gate R12 — oráculo `liveContentOps` antes do `end()` (fora do R12-L3): coincide com o PDF final num documento com fechamentos pelo vazio, sublinhado e transbordo', () => {
  it('3 folhas: cadeias fechadas pelo vazio (no corpo, no pé e no cabeçalho), sublinhado, cor e transbordo — o vivo antes do end() = o final (filtrado pelo mesmo critério)', async () => {
    const w = createPdf({
      marginCm: 1, title: 'O', creationDate: FIXED, fontRoles: ROLES,
      sheetStart: (d, n) => { writeText(d, 'title', `Folha ${n}: `, { x: 40, y: 20, width: 300, continued: true, underline: true }); writeText(d, 'title', ''); d.y = 60 },
    })
    const d = w.doc
    d.fillColor('#336699')
    writeText(d, 'content', 'INF. COMPL.: ', { x: 40, y: 100, width: 300, continued: true, underline: true })
    writeText(d, 'content', '')
    writeText(d, 'content', lines(150, 'item'), { x: 40, sizePt: 9 })
    const m = measureText(d, 'content', 'Obs: ', { sizePt: 7, width: 300 })
    writeText(d, 'content', 'Obs: ', { x: 40, y: d.page.maxY() - m.height, width: 300, sizePt: 7, continued: true })
    writeText(d, 'title', '', { sizePt: 12 })
    const live = liveContentOps(d)
    const final = pdfContentOps(await w.end())
    expect(live.length).toBe(3)
    expect(live.filter(o => /\bBT\b|\bre\b/.test(o))).toEqual(final)
    expect(final.map(qDepth)).toEqual([BALANCED, BALANCED, BALANCED])
  })
})
