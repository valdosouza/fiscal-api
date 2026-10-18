/// <reference types="jest" />
// GATE ADVERSARIAL do DELTA 4110957..HEAD da NE-1b (revisor independente, 2026-10-18 — skill `testar-adversarial.md`): ataques à leva do gate R12
// (c01496c — R12-L1/socrático L2: o fechamento da cadeia pelo vazio soma na ORDEM do pdfkit; R12-L3: o oráculo vivo falha fechado depois do
// `end()`/`flushPages`) e à Rodada 13 (f71c802 — D-NE153: o trecho VAZIO com `continued: true` não vai ao pdfkit; com a cadeia ABERTA a cadeia
// segue IGUAL, SEM cadeia é recusado com erro de uso legível).
// Os gates anteriores estão em `adversarial-ne1b-gate`, `-delta-gate`, `-r7-gate`, `-final-gate`, `-r9-gate`, `-r10-gate`, `-r11-gate` e
// `-r12-gate`; os positivos da rodada em `pdf-rodada11` (não repetidos aqui).
//
// Ataque que RESISTIU fica como teste verde; achado CONFIRMADO fica como `it.failing` com o rótulo "[ACHADO <SEVERIDADE>]" — o corpo afirma o
// comportamento CORRETO, então quando a correção entrar o `it.failing` passa a FALHAR e vira `it` comum.
import zlib from 'zlib'
import PDFDocument from 'pdfkit'
import { createPdf, writeText, measureText } from '../pdf'
import { pdfContentOps, pdfTextRuns, pdfTextByStream, pdfPageCount, liveContentOps, qDepth } from './pdf-oracle'

const FIXED = new Date('2026-10-18T03:00:00Z')
const ROLES = { title: 'Times-Bold', content: 'Times-Roman', fixed: 'Courier' } as const
type Role = keyof typeof ROLES
type Opts = Record<string, unknown>
type Step = (d: PDFKit.PDFDocument) => void
type Header = (d: PDFKit.PDFDocument, n: number) => void
const lines = (n: number, p = 'linha') => Array.from({ length: n }, (_, i) => `${p} ${i + 1}`).join('\n')
const internals = (doc: PDFKit.PDFDocument) => doc as unknown as Record<string | symbol, any>
const errorOf = (fn: () => unknown): Error | null => { try { fn(); return null } catch (e) { return e as Error } }
const BALANCED = { final: 0, min: 0 }
const D153 = /^fontes da base: trecho vazio com continued sem cadeia aberta — abra a cadeia com o 1º trecho que tem texto \(D-NE153\)$/
const D144 = /^base de PDF: o documento ficou inválido e não fecha — o sheetStart falhou \(a folha ficou sem o cabeçalho inteiro — D-NE144\) \(monte de novo\)$/
const newDoc = (sheetStart?: Header) =>
  createPdf({ marginCm: 1, title: 'R13', creationDate: FIXED, fontRoles: ROLES, ...(sheetStart ? { sheetStart } : {}) })
const w = (role: Role, text: unknown, opts: Opts = {}): Step => d => { writeText(d, role, text as string, opts as never) }

/** Os escalares do quebrador de linha do pdfkit (o que decide onde o próximo trecho entra) e quantos ouvintes ele tem. */
const WRAPPER_FIELDS = ['continuedX', 'spaceLeft', 'lineWidth', 'startX', 'startY', 'column', 'maxY', 'indent', 'indentApplied', 'lastLine',
  'ellipsis', 'characterSpacing', 'wordSpacing', 'horizontalScaling', 'height'] as const
const wrapperScalars = (wr: any): unknown => wr ? {
  ...Object.fromEntries(WRAPPER_FIELDS.map(k => [k, wr[k]])),
  // o EventEmitter PRÓPRIO do pdfkit 0.20.2 (sem `listenerCount`): os ouvintes `once` pendentes contam
  listeners: ['line', 'firstLine', 'lastLine', 'sectionStart', 'sectionEnd', 'pageBreak'].map(e => wr._listeners?.[e]?.length ?? 0),
} : null

/** O estado da família que o vazio não pode tocar — por VALOR (para o gêmeo) e por IDENTIDADE (para o mesmo documento). */
function stateOf(d: PDFKit.PDFDocument) {
  const i = internals(d)
  return {
    x: d.x, y: d.y, font: i._font?.name, size: i._fontSize, lineGap: i._lineGap, fill: JSON.stringify(i._fillColor),
    textOptions: JSON.stringify(i._textOptions), wrapper: wrapperScalars(i._wrapper), open: !!i._wrapper,
    sheets: i._pageBuffer.length, page: i._pageBuffer.indexOf(d.page), ctm: JSON.stringify(i._ctm), stack: i._ctmStack.length,
  }
}
const identity = (d: PDFKit.PDFDocument) => ({ wrapper: internals(d)._wrapper, textOptions: internals(d)._textOptions })

/** Monta o documento passo a passo; devolve o conteúdo VIVO de cada folha (antes do `end()`) e o estado final. */
function build(steps: Step[], sheetStart?: Header) {
  const writer = newDoc(sheetStart)
  for (const s of steps) s(writer.doc)
  return { writer, live: liveContentOps(writer.doc), state: stateOf(writer.doc) }
}

/** Opções do trecho VAZIO do meio — todas as da porta, uma a uma e combinadas, inclusive as que mexeriam na posição. */
const EMPTY_VARIANTS: [string, Role, Opts][] = [
  ['sem opção', 'content', {}],
  ['`width` diferente', 'content', { width: 50 }],
  ['`x`/`y` explícitos', 'content', { x: 300, y: 500 }],
  ['só `x`', 'content', { x: 300 }],
  ['só `y` (no pé)', 'content', { y: 800 }],
  ['`lineGap`', 'content', { lineGap: 5 }],
  ['`align: right`', 'content', { align: 'right' }],
  ['`align: justify`', 'content', { align: 'justify' }],
  ['sublinhado e riscado', 'content', { underline: true, strike: true }],
  ['corpo 30', 'content', { sizePt: 30 }],
  ['OUTRO papel e corpo', 'title', { sizePt: 20 }],
  ['papel fixo', 'fixed', {}],
  ['`paragraphGap` e `indent`', 'content', { paragraphGap: 10, indent: 20 }],
  ['`height` e `ellipsis`', 'content', { height: 5, ellipsis: true }],
  ['`lineBreak: true` explícito', 'content', { lineBreak: true }],
  ['tudo junto', 'title', { x: 120, y: 333.3, width: 77, sizePt: 25, lineGap: 3, paragraphGap: 4, indent: 9, align: 'center', underline: true, strike: true, height: 50, ellipsis: false }],
]
const EMPTY_TEXTS: [string, unknown][] = [
  ["''", ''], ['null', null], ['undefined', undefined], ['objeto com toString vazio', { toString: () => '' }], ['[]', []], ["new String('')", new String('')],
]

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ACHADO CONFIRMADO (fora do delta — o oráculo do PDF FINAL; o do conteúdo vivo, alvo da c01496c, resistiu)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** PNG RGB 8 bits sem alfa, montado aqui (sem arquivo): 60 × 20 pixels de cor ruidosa; a linha 7 traz os bytes " re " (um cinza qualquer). */
function noisyPng(withRe: boolean): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b: Buffer) => { let c = 0xFFFFFFFF; for (const x of b) c = table[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length)
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, 'latin1'), data])))
    return Buffer.concat([head, Buffer.from(type, 'latin1'), data, sum])
  }
  const W = 60, H = 20, row = 1 + W * 3
  let seed = 1
  const raw = Buffer.alloc(H * row)
  for (let y = 0; y < H; y++) for (let i = 1; i < row; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; raw[y * row + i] = 0x80 | (seed & 0x3f) }
  if (withRe) raw.write(' re ', 7 * row + 10, 'latin1')
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

describe('NE-1b gate R13 — [ACHADO LOW] R13-L1 (oráculo, fora do delta): `pdfContentOps`/`pdfTextByStream` escolhem a "folha" pelo CONTEÚDO do fluxo (`BT`/`re`) — o fluxo de uma IMAGEM cujos bytes trazem " re " vira folha, e vem ANTES da folha de verdade', () => {
  /**
   * Os dois leitores varrem TODO `stream … endstream` do PDF e guardam o que casa `\bBT\b|\bre\b` (o vivo, `liveContentOps`, lê o `_pageBuffer` e não
   * tem o problema). O pdfkit grava o XObject da imagem ANTES do conteúdo da folha: um logotipo (o do emitente no DANFE, opcional no MOC; o da
   * prefeitura no DANFSe — §9 do prompt da NF-e) desenhado por `doc.image`, com os bytes 0x20 'r' 'e' 0x20 nos pixels (estimativa: ~9e-6 por
   * posição em byte ruidoso — da ordem de 1 em 5 imagens ruidosas de 20 KB; num logotipo de cores chapadas, bem menos), desloca a numeração:
   * `pdfContentOps(pdf)[0]` passa a ser a IMAGEM, `pdfTextRuns` dela é `[]`, o `.length` conta folhas a mais, e o
   * `qDepth` da imagem é {0,0} — a asserção de equilíbrio passa SOBRE O LUGAR ERRADO. Só oráculo de teste e só com imagem (nenhum teste atual usa
   * `doc.image` — conferido); não muda PDF nenhum — LOW. Correção sugerida (sem decisão): tomar as folhas pela árvore do PDF — o `/Contents N 0 R`
   * de cada `/Type /Page` (na ordem do `/Kids`) — ou, no mínimo, pular os fluxos cujo dicionário traz `/Subtype /Image` ou `/Type /XObject`.
   */
  it('[CORRIGIDO — ACHADO LOW] R13-L1 — 1 folha com texto e um logotipo: o oráculo vê 1 folha, e a folha 0 é a do texto (hoje: 2 "folhas", a 0 é a imagem)', async () => {
    const writer = newDoc()
    writeText(writer.doc, 'content', 'EMITENTE', { x: 40, y: 100 })
    writer.doc.image(noisyPng(true), 40, 200, { width: 100 })
    const pdf = await writer.end()
    expect(pdfPageCount(pdf)).toBe(1)
    expect(pdfContentOps(pdf)).toHaveLength(1)
    expect(pdfTextRuns(pdfContentOps(pdf)[0]).map(r => r.text)).toEqual(['EMITENTE'])
    expect(pdfTextByStream(pdf)).toEqual([['EMITENTE']])
  })

  it('CORRIGIDO: com " re " nos pixels o fluxo da IMAGEM não vira folha — 1 folha, a 0 é a do texto e começa pela matriz-base; sem " re ", igual', async () => {
    const make = async (withRe: boolean) => {
      const writer = newDoc()
      writeText(writer.doc, 'content', 'EMITENTE', { x: 40, y: 100 })
      writer.doc.image(noisyPng(withRe), 40, 200, { width: 100 })
      return writer.end()
    }
    const withRe = await make(true)
    const ops = pdfContentOps(withRe)
    expect({ pages: pdfPageCount(withRe), streams: ops.length }).toEqual({ pages: 1, streams: 1 })   // a imagem ficou de fora (isImageStream)
    expect(ops[0]).toMatch(/^1 0 0 -1 0 [\d.]+ cm\n/)
    expect(pdfTextRuns(ops[0]).map(r => r.text)).toEqual(['EMITENTE'])
    expect(pdfContentOps(await make(false))).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// D-NE153 — COM a cadeia aberta: o vazio não soma nada
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate R13 — D-NE153 com a cadeia ABERTA: o vazio `continued: true` é um no-op — o mesmo quebrador, as mesmas opções, o mesmo conteúdo', () => {
  const open: Step = d => {
    d.fillColor('#336699').lineGap(1.3)
    writeText(d, 'title', 'Endereço: ', { x: 40, y: 100, width: 400, continued: true, underline: true, paragraphGap: 2 })
  }

  for (const [name, role, opts] of EMPTY_VARIANTS) {
    for (const [tname, text] of EMPTY_TEXTS) {
      it(`${name} — texto ${tname}: identidade do quebrador e das opções da cadeia, estado e conteúdo vivo intactos`, () => {
        const writer = newDoc()
        const d = writer.doc
        open(d)
        const before = { state: stateOf(d), id: identity(d), live: liveContentOps(d) }
        expect(writeText(d, role, text as string, { ...opts, continued: true } as never)).toEqual({ replaced: 0 })
        expect(identity(d).wrapper).toBe(before.id.wrapper)
        expect(identity(d).textOptions).toBe(before.id.textOptions)
        expect(stateOf(d)).toEqual(before.state)
        expect(liveContentOps(d)).toEqual(before.live)
      })
    }
  }

  it('cada variante no MEIO de "Endereço: " … "Rua das Flores, 100" (fechamento sublinhado): o conteúdo VIVO e o estado final = o gêmeo SEM o vazio, byte a byte; cinco vazios seguidos também', () => {
    const tail: Step[] = [w('content', 'Rua das Flores, ', { continued: true }), w('fixed', '100', { underline: true })]
    const twin = build([open, ...tail])
    for (const [name, role, opts] of EMPTY_VARIANTS) {
      const got = build([open, w(role, '', { ...opts, continued: true }), ...tail])
      expect({ name, live: got.live, state: got.state }).toEqual({ name, live: twin.live, state: twin.state })
    }
    const many = build([open, ...EMPTY_VARIANTS.slice(0, 5).map(([, role, opts]) => w(role, '', { ...opts, continued: true })), ...tail])
    expect(many.live).toEqual(twin.live)
    expect(many.state).toEqual(twin.state)
  })

  it('a bateria DISTINGUE: o mesmo vazio pelo pdfkit CRU desloca "Rua…" pelo avanço do rótulo (o defeito do socrático M1) — a porta não', async () => {
    const runs = async (middle: Step | null) => {
      const writer = newDoc()
      open(writer.doc)
      if (middle) middle(writer.doc)
      writeText(writer.doc, 'content', 'Rua das Flores, 100')
      return pdfTextRuns(pdfContentOps(await writer.end())[0]).map(r => ({ text: r.text, x: r.x, y: r.yPdf }))
    }
    const control = await runs(null)
    expect(await runs(w('content', '', { continued: true }))).toEqual(control)
    const raw = await runs(d => { d.text('', { continued: true } as never) })
    expect(raw[1].x).toBeGreaterThan(control[1].x + 10)                                            // pelo pdfkit cru: deslocado
  })

  // contextos: [nome, abre a cadeia, fecha, sheetStart?]
  const footOpen: Step = d => {
    const m = measureText(d, 'content', 'Obs: ', { sizePt: 7, width: 300 })
    writeText(d, 'content', 'Obs: ', { x: 40, y: d.page.maxY() - m.height, width: 300, sizePt: 7, continued: true })
  }
  const header: Header = (d, n) => {
    writeText(d, 'title', `Folha ${n}: `, { x: 40, y: 20, width: 300, continued: true })
    writeText(d, 'title', 'de 3', { sizePt: 9 })
    d.y = 60
  }
  const wide = 'palavra '.repeat(60)
  const CONTEXTS: [string, Step, Step[], Header?][] = [
    ['no PÉ (cadeia de 7 pt; o vazio de 30 pt e `y` além do pé), fechada com vazio', footOpen, [w('content', '', { sizePt: 7 })]],
    ['no PÉ, fechada com TEXTO (o pdfkit abre a folha igual nos dois)', footOpen, [w('content', 'fim', { sizePt: 7 })], header],
    ['cadeia que TRANSBORDOU (o y está na folha 2), com sheetStart', w('content', lines(80, 'item') + ' fim: ', { x: 40, y: 100, width: 300, continued: true }),
      [w('content', 'X', { underline: true }), w('content', lines(30, 'depois'), { x: 40 })], header],
    ['cadeia `justify` de várias linhas', w('content', wide, { x: 40, y: 100, width: 250, continued: true, align: 'justify' }), [w('content', 'fim', { align: 'justify' })]],
    ['cadeia com `height` que estourou', w('content', wide, { x: 40, y: 100, width: 200, continued: true, height: 30 }), [w('content', 'X')]],
    ['cadeia CRUA do pdfkit com width', d => { d.font('Courier').fontSize(11); d.text('Obs: ', 40, 100, { width: 200, continued: true, lineGap: 3 } as never) }, [w('content', 'X')]],
    ['cadeia CRUA sem width', d => { d.text('Obs: ', 40, 100, { continued: true } as never) }, [w('content', 'X')]],
    ['cadeia CRUA girada', d => { d.text('Obs: ', 40, 100, { width: 200, continued: true, rotation: 30 } as never) }, [w('content', 'X')]],
    ['cadeia CRUA em 2 colunas que mudou de coluna', d => { d.text(wide.repeat(4), 40, 100, { width: 400, columns: 2, continued: true } as never) }, [w('content', 'X')]],
  ]
  for (const [name, openCtx, close, sheetStart] of CONTEXTS) {
    it(`${name}: com cada variante de vazio no meio, conteúdo vivo e estado = o gêmeo sem o vazio; nenhuma folha a mais`, () => {
      const twin = build([openCtx, ...close], sheetStart)
      for (const [vname, role, opts] of EMPTY_VARIANTS) {
        const got = build([openCtx, w(role, '', { ...opts, continued: true }), ...close], sheetStart)
        expect({ vname, live: got.live, state: got.state }).toEqual({ vname, live: twin.live, state: twin.state })
      }
    })
  }

  it('no SHEETSTART (cadeia do cabeçalho com vazios no meio) e na PASSADA ("Folha n/N"): o PDF final = o gêmeo sem os vazios, 3 folhas balanceadas', async () => {
    const make = async (withEmpty: boolean) => {
      const mid = (d: PDFKit.PDFDocument) => { if (withEmpty) { writeText(d, 'fixed', '', { continued: true, sizePt: 40 }); writeText(d, 'title', '', { continued: true, y: 9999 }) } }
      const writer = newDoc((d, n) => {
        writeText(d, 'title', `CAB ${n}: `, { x: 40, y: 20, width: 300, continued: true }); mid(d); writeText(d, 'content', 'emitente'); d.y = 60
      })
      writeText(writer.doc, 'content', lines(220, 'item'), { x: 40, sizePt: 9 })
      return pdfContentOps(await writer.end((d, { sheet, total }) => {
        writeText(d, 'title', 'Folha ', { x: 400, y: 20, width: 150, continued: true }); mid(d); writeText(d, 'title', `${sheet}/${total}`)
      }))
    }
    const twin = await make(false)
    const got = await make(true)
    expect(got).toEqual(twin)
    expect(got).toHaveLength(3)
    expect(got.map(qDepth)).toEqual([BALANCED, BALANCED, BALANCED])
    expect(got.map(o => pdfTextRuns(o).map(r => r.text).filter(t => /^(CAB|Folha|emitente|\d\/3)/.test(t)))).toEqual(
      [1, 2, 3].map(n => [`CAB ${n}: `, 'emitente', 'Folha ', `${n}/3`]))
  })

  it('a cadeia de FORA não vaza para o sheetStart: cadeia aberta no conteúdo + vazio `continued` DENTRO do cabeçalho (sem cadeia dele) = recusado (D-NE153) e o documento fica inválido (D-NE144)', () => {
    const writer = newDoc((d, n) => { if (n === 2) writeText(d, 'title', '', { continued: true }); d.y = 60 })
    writeText(writer.doc, 'content', 'Obs: ', { x: 40, y: 100, width: 300, continued: true })
    const outer = identity(writer.doc)
    expect(errorOf(() => writer.doc.addPage())?.message).toMatch(D153)
    expect(identity(writer.doc)).toEqual(outer)                                                    // a cadeia de fora volta intacta
    expect(liveContentOps(writer.doc).map(qDepth)).toEqual([BALANCED, BALANCED])
    expect(errorOf(() => writer.end())?.message).toMatch(D144)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// D-NE153 — SEM cadeia: recusado, sem rastro
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate R13 — D-NE153 SEM cadeia: o vazio `continued: true` é recusado com a mensagem da regra e não deixa rastro (estado, conteúdo, folha)', () => {
  const PRIOR: [string, Step][] = [
    ['documento novo', () => undefined],
    ['depois de cadeia fechada com TEXTO', d => { w('content', 'Obs: ', { x: 40, y: 100, width: 300, continued: true })(d); w('content', 'fim')(d) }],
    ['depois de cadeia fechada pelo VAZIO (D-NE152)', d => { w('content', 'Obs: ', { x: 40, y: 100, width: 300, continued: true })(d); w('content', '')(d) }],
    ['com cor, lineGap, fonte e corpo da família mexidos', d => { d.fillColor('red', 0.5).lineGap(7); d.font('Courier').fontSize(23); d.x = 77; d.y = 444 }],
    ['depois de escrita sem quebra (`lineBreak: false` sem `width`)', w('content', 'Rótulo', { x: 40, y: 100, lineBreak: false })],
    ['depois de `doc.text` CRU `lineBreak: false, continued: true` (o pdfkit não abre quebrador)', d => { d.text('cru', 40, 100, { lineBreak: false, continued: true } as never) }],
  ]
  const OPTS: [string, Role, Opts][] = [
    ['sem opção', 'content', {}],
    ['com x/y/width', 'content', { x: 40, y: 100, width: 300 }],
    ['no PÉ com corpo 30', 'title', { y: 812, sizePt: 30 }],
    ['sublinhado', 'fixed', { underline: true, x: 10 }],
    ['`lineBreak: true` explícito', 'content', { lineBreak: true }],
  ]
  for (const [pname, prior] of PRIOR) {
    it(`${pname}: cada texto vazio × cada opção — recusado (D-NE153); estado e conteúdo vivo idênticos; o documento ainda fecha com 1 folha`, async () => {
      const writer = newDoc()
      const d = writer.doc
      prior(d)
      const before = { state: stateOf(d), live: liveContentOps(d) }
      for (const [tname, text] of EMPTY_TEXTS) {
        for (const [oname, role, opts] of OPTS) {
          const err = errorOf(() => writeText(d, role, text as string, { ...opts, continued: true } as never))
          expect({ tname, oname, err: err?.message }).toEqual({ tname, oname, err: expect.stringMatching(D153) })
          expect(err).toBeInstanceOf(RangeError)
        }
      }
      expect(stateOf(d)).toEqual(before.state)
      expect(liveContentOps(d)).toEqual(before.live)
      expect(pdfPageCount(await writer.end())).toBe(1)
    })
  }

  it('o texto que só VIRA vazio é o vazio de verdade: nada no WinAnsi some — "\\r" vira quebra (escreve), "\\u0000"/ZWSP/BOM viram "?" (contados), "\\t" vira espaço; nenhum deles cai na D-NE153', () => {
    for (const text of ['\r', '\u0000', '\u200B', '\uFEFF', '\t', ' ', '\u00A0', '\u00AD']) {
      const writer = newDoc()
      const r = writeText(writer.doc, 'content', text, { x: 40, y: 100, width: 300, continued: true })
      expect(r.replaced).toBe(['\u0000', '\u200B', '\uFEFF'].includes(text) ? 1 : 0)
      expect(internals(writer.doc)._wrapper).toBeTruthy()                                        // abriu a cadeia (tem texto)
    }
  })

  it('o `toString` do texto roda UMA vez e só depois das opções conferidas (opção inválida: nem chega a ele)', () => {
    let calls = 0
    const text = { toString: () => { calls++; return '' } }
    const writer = newDoc()
    expect(errorOf(() => writeText(writer.doc, 'content', text as never, { continued: true, width: -1 }))?.message).toMatch(/width inválido/)
    expect(calls).toBe(0)
    expect(errorOf(() => writeText(writer.doc, 'content', text as never, { continued: true }))?.message).toMatch(D153)
    expect(calls).toBe(1)
  })

  it('`continued` que não é booleano (\'true\', 1, Boolean embrulhado, null) — com e sem cadeia, com vazio e com texto: recusado pela lista fechada; a cadeia aberta segue intacta', () => {
    for (const bad of ['true', 1, new Boolean(true), null, 'false', 0]) {
      for (const text of ['', 'X']) {
        const fresh = newDoc().doc
        expect(errorOf(() => writeText(fresh, 'content', text, { continued: bad } as never))?.message).toBe('fontes da base: continued tem de ser booleano')
        expect(internals(fresh)._wrapper).toBeFalsy()
        const chained = newDoc().doc
        writeText(chained, 'content', 'Obs: ', { x: 40, y: 100, width: 300, continued: true })
        const before = { state: stateOf(chained), id: identity(chained), live: liveContentOps(chained) }
        expect(errorOf(() => writeText(chained, 'content', text, { continued: bad } as never))?.message).toBe('fontes da base: continued tem de ser booleano')
        expect({ state: stateOf(chained), id: identity(chained), live: liveContentOps(chained) }).toEqual(before)
      }
    }
  })

  it('no SHEETSTART sem cadeia dele: a mensagem imediata é a da D-NE153, o end() recusa pela D-NE144, nenhuma folha órfã e tudo balanceado; na PASSADA: o end() lança a D-NE153, balanceado', () => {
    const bad = newDoc((d, n) => { if (n === 2) writeText(d, 'content', '', { continued: true, y: 30 }); d.y = 60 })
    expect(errorOf(() => writeText(bad.doc, 'content', lines(120, 'item'), { x: 40, sizePt: 9 }))?.message).toMatch(D153)
    expect(internals(bad.doc)._pageBuffer.length).toBe(2)
    expect(liveContentOps(bad.doc).map(qDepth)).toEqual([BALANCED, BALANCED])
    expect(errorOf(() => bad.end())?.message).toMatch(D144)
    const pass = newDoc()
    writeText(pass.doc, 'content', 'corpo', { x: 40, y: 100, width: 300, continued: true })      // cadeia ABERTA no conteúdo: não vale na passada
    const outer = identity(pass.doc)
    expect(errorOf(() => pass.end(d => { writeText(d, 'title', '', { continued: true }) }))?.message).toMatch(D153)
    expect(identity(pass.doc)).toEqual(outer)
    expect(liveContentOps(pass.doc).map(qDepth)).toEqual([BALANCED])
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// ORDEM das recusas
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate R13 — ordem das recusas (D-NE126/D-NE135/D-NE136/D-NE146/D-NE153/F-L5): a mensagem é a da regra certa e nenhuma deixa rastro', () => {
  const openChain: Step = w('content', 'Obs: ', { x: 40, y: 100, width: 300, continued: true })
  const MSG = {
    d136: /^fontes da base: "continued" não combina com lineBreak: false .*\(D-NE136\)$/,
    d135: /^fontes da base: há texto encadeado aberto .*\(D-NE135\)$/,
    d146: /^fontes da base: escrita com lineBreak: false não leva quebra de linha \(D-NE146\)$/,
    d153: D153,
    fl5: /^fontes da base: não há largura útil a partir de x \(além da margem direita\) — informe width$/,
    port: /^fontes da base: opção de texto "(columns|rotation)" fora da porta \(D-NE126\)$/,
    width: /^fontes da base: width inválido$/,
    size: /^fontes da base: corpo inválido$/,
    pos: /^fontes da base: posição x inválida$/,
    role: /^fontes da base: papel "nenhum" não registrado na base/,
    bool: /^fontes da base: continued tem de ser booleano$/,
  }
  const CASES: [string, boolean, Role | 'nenhum', unknown, Opts, RegExp | null][] = [
    ['vazio + continued + lineBreak:false, sem cadeia', false, 'content', '', { continued: true, lineBreak: false }, MSG.d136],
    ['vazio + continued + lineBreak:false, COM cadeia', true, 'content', '', { continued: true, lineBreak: false }, MSG.d136],
    ['vazio + continued + lineBreak:false + width (linha única)', false, 'content', '', { continued: true, lineBreak: false, width: 100 }, MSG.d136],
    ['null + continued + lineBreak:false', false, 'content', null, { continued: true, lineBreak: false }, MSG.d136],
    ['"\\n" + continued + lineBreak:false (quebra antes do continued)', true, 'content', '\n', { continued: true, lineBreak: false }, MSG.d146],
    ['vazio SEM continued + lineBreak:false, COM cadeia', true, 'content', '', { lineBreak: false }, MSG.d135],
    ['vazio + continued sem cadeia com x além da margem direita (a do vazio vem antes da F-L5)', false, 'content', '', { continued: true, x: 590 }, MSG.d153],
    ['TEXTO + continued sem cadeia com x além da margem direita', false, 'content', 'X', { continued: true, x: 590 }, MSG.fl5],
    ['vazio + continued COM cadeia e x além da margem direita: no-op (a F-L5 não vale na cadeia)', true, 'content', '', { continued: true, x: 590 }, null],
    ['vazio + continued + width 0', true, 'content', '', { continued: true, width: 0 }, MSG.width],
    ['vazio + continued + corpo 0', true, 'content', '', { continued: true, sizePt: 0 }, MSG.size],
    ['vazio + continued + x NaN', true, 'content', '', { continued: true, x: NaN }, MSG.pos],
    ['vazio + continued + columns', true, 'content', '', { continued: true, columns: 2 }, MSG.port],
    ['vazio + continued + rotation', false, 'content', '', { continued: true, rotation: 30 }, MSG.port],
    ['vazio + continued de papel não registrado', true, 'nenhum', '', { continued: true }, MSG.role],
    ["vazio + continued: 'true'", false, 'content', '', { continued: 'true' }, MSG.bool],
  ]
  for (const [name, chained, role, text, opts, msg] of CASES) {
    it(`${name}: ${msg ? msg.source.slice(0, 60) : 'aceito sem efeito'}`, () => {
      const d = newDoc().doc
      if (chained) openChain(d)
      const before = { state: stateOf(d), id: identity(d), live: liveContentOps(d) }
      const err = errorOf(() => writeText(d, role, text as string, opts as never))
      if (msg) expect(err?.message).toMatch(msg)
      else expect(err).toBeNull()
      expect({ state: stateOf(d), id: identity(d), live: liveContentOps(d) }).toEqual(before)
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// c01496c — a soma do fechamento pelo vazio na ORDEM do pdfkit (D-NE152 com `paragraphGap`, bit a bit) e o oráculo que falha fechado
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate R13 — c01496c: o vazio que fecha a cadeia deixa `x`/`y` IGUAIS (===) ao fechamento com texto, com `paragraphGap` em qualquer origem', () => {
  /** Gerador determinístico (mulberry32) — a varredura é reprodutível. */
  const rng = (seed: number) => () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const closeXY = (open: Step, closeText: string, role: Role, close: Opts) => {
    const d = newDoc().doc
    open(d)
    writeText(d, role, closeText, close as never)
    return { x: d.x, y: d.y, sheets: internals(d)._pageBuffer.length, open: !!internals(d)._wrapper }
  }

  it('800 combinações sorteadas (corpo, `y` não redondo, `lineGap` do documento/da cadeia/do fechamento, `paragraphGap` da cadeia/do 2º trecho/do fechamento, `y` explícito no fechamento, vazios no meio com `paragraphGap`): todas ===', () => {
    const r = rng(20261018)
    const ROLE_LIST: Role[] = ['title', 'content', 'fixed']
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
    const maybe = (p: number, v: () => number): number | undefined => (r() < p ? v() : undefined)
    const diverge: string[] = []
    for (let i = 0; i < 800; i++) {
      const docLG = maybe(0.3, () => r() * 5)
      const chain: Opts = { x: 30 + r() * 100, y: 40 + r() * 600, width: 200 + r() * 200, continued: true, sizePt: 5 + r() * 12 }
      const lg = maybe(0.5, () => 0.05 + r() * 4); if (lg !== undefined) chain.lineGap = lg
      const pg = maybe(0.6, () => r() * 7); if (pg !== undefined) chain.paragraphGap = pg
      const second: Opts | null = r() < 0.3 ? { continued: true, sizePt: 5 + r() * 12 } : null
      const pg2 = second ? maybe(0.7, () => r() * 7) : undefined; if (second && pg2 !== undefined) second.paragraphGap = pg2
      const empties = r() < 0.3 ? [{ continued: true, paragraphGap: r() * 50, lineGap: 0.1 + r() * 20, sizePt: 5 + r() * 40 }] : []
      const role = pick(ROLE_LIST)
      const close: Opts = {}
      const cs = maybe(0.5, () => 4 + r() * 14); if (cs !== undefined) close.sizePt = cs
      const clg = maybe(0.4, () => 0.05 + r() * 4); if (clg !== undefined) close.lineGap = clg
      const cpg = maybe(0.4, () => r() * 7); if (cpg !== undefined) close.paragraphGap = cpg
      const cy = maybe(0.3, () => 40 + r() * 600); if (cy !== undefined) close.y = cy
      const chainRole = pick(ROLE_LIST)                                                           // sorteado FORA do `open`: os dois gêmeos iguais
      const open: Step = d => {
        if (docLG !== undefined) d.lineGap(docLG)
        writeText(d, chainRole, 'Obs: ', chain as never)
        if (second) writeText(d, 'fixed', 'B ', second as never)
        for (const e of empties) writeText(d, 'title', '', e as never)
      }
      const empty = closeXY(open, '', role, close)
      const text = closeXY(open, 'X', role, close)
      if (empty.x !== text.x || empty.y !== text.y || empty.sheets !== text.sheets || empty.open || text.open) {
        diverge.push(`${i}: ${JSON.stringify({ docLG, chain, second, empties, role, close })} → ${JSON.stringify(empty)} × ${JSON.stringify(text)}`)
      }
    }
    expect(diverge).toEqual([])
  })

  it('cadeia CRUA do pdfkit com `paragraphGap`/`lineGap` (inclusive `lineGap: 0` — o pdfkit cai no do documento — e `paragraphGap` NaN): === ao fechamento com texto', () => {
    const r = rng(7)
    const diverge: string[] = []
    for (let i = 0; i < 200; i++) {
      const docLG = r() < 0.5 ? r() * 6 : 0
      const raw: Opts = { width: 250, continued: true, paragraphGap: r() < 0.2 ? NaN : r() * 9, lineGap: r() < 0.3 ? 0 : r() * 5 }
      const y0 = 40 + r() * 600
      const size = 5 + r() * 15
      const open: Step = d => { d.lineGap(docLG); d.font('Courier').fontSize(size); d.text('Obs: ', 40, y0, raw as never) }
      const close: Opts = r() < 0.5 ? { paragraphGap: r() * 9 } : {}
      const empty = closeXY(open, '', 'content', close)
      const text = closeXY(open, 'X', 'content', close)
      if (empty.x !== text.x || empty.y !== text.y) diverge.push(`${i}: ${JSON.stringify({ docLG, raw, y0, size, close })}: ${empty.y} × ${text.y}`)
    }
    expect(diverge).toEqual([])
  })
})

describe('NE-1b gate R13 — c01496c: o oráculo vivo falha FECHADO (R12-L3) e coincide com o PDF final enquanto o documento está vivo', () => {
  it('documento do pdfkit sem folha (autoFirstPage: false), com folhas despejadas (bufferPages: false, 2ª folha), depois do end() e depois de flushPages: lança "oráculo"; nunca devolve [] para o `.every` passar vazio', async () => {
    const none = new PDFDocument({ autoFirstPage: false, bufferPages: true })
    expect(() => liveContentOps(none)).toThrow(/^oráculo/)
    const unbuffered = new PDFDocument({ bufferPages: false })
    expect(liveContentOps(unbuffered)).toHaveLength(1)                                            // a 1ª folha ainda está viva
    unbuffered.addPage()
    expect(() => liveContentOps(unbuffered)).toThrow(/^oráculo/)                                  // a 1ª já foi despejada
    const ended = newDoc()
    writeText(ended.doc, 'content', 'corpo', { x: 40, y: 100 })
    await ended.end()
    expect(() => liveContentOps(ended.doc)).toThrow(/^oráculo/)
    const flushed = newDoc()
    flushed.doc.addPage()
    flushed.doc.flushPages()
    expect(() => liveContentOps(flushed.doc)).toThrow(/^oráculo/)
  })

  it('documento com D-NE153 (vazios no meio de cadeias, no conteúdo, no cabeçalho e no transbordo): o vivo antes do end() = o final, folha a folha', async () => {
    const writer = newDoc((d, n) => {
      writeText(d, 'title', `Folha ${n}: `, { x: 40, y: 20, width: 300, continued: true, underline: true })
      writeText(d, 'fixed', '', { continued: true, sizePt: 30 })
      writeText(d, 'title', '')
      d.y = 60
    })
    const d = writer.doc
    writeText(d, 'content', 'INF. COMPL.: ', { x: 40, y: 100, width: 300, continued: true })
    writeText(d, 'content', '', { continued: true, y: 700 })
    writeText(d, 'content', lines(150, 'item'), { sizePt: 9 })
    const live = liveContentOps(d)
    const final = pdfContentOps(await writer.end())
    expect(live.length).toBe(final.length)
    expect(live).toEqual(final)
    expect(final.map(qDepth).every(q => q.final === 0 && q.min === 0)).toBe(true)
    expect(final.length).toBeGreaterThan(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// CONHECIMENTO NEGATIVO fixado pelo gate (sem achado)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('NE-1b gate R13 — INFO: o vazio do meio NÃO aplica as opções dele (posição, corpo, papel) — a letra da D-NE153 ("a cadeia segue IGUAL")', () => {
  it('com `y` explícito no vazio do meio, o trecho seguinte sai onde sairia sem o vazio; com TEXTO no lugar, o pdfkit leva a cadeia para o `y` pedido', async () => {
    const runs = async (middle: [string, Opts] | null) => {
      const writer = newDoc()
      writeText(writer.doc, 'title', 'CNPJ: ', { x: 40, y: 100, width: 400, continued: true })
      if (middle) writeText(writer.doc, 'content', middle[0], { ...middle[1], continued: true } as never)
      writeText(writer.doc, 'content', 'FIM')
      return pdfTextRuns(pdfContentOps(await writer.end())[0]).map(r => ({ text: r.text, y: r.yPdf }))
    }
    const control = await runs(null)
    expect(await runs(['', { y: 300 }])).toEqual(control)
    const withText = await runs(['x', { y: 300 }])
    expect(withText[2].y).not.toBe(control[1].y)
  })
})


