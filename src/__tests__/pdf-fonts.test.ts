/// <reference types="jest" />
// NE-1b (D-NE120): fontes-padrão WinAnsi — a regra de substituição VISÍVEL e a ida e volta de TODO caractere representável por um PDF real.
import { toWinAnsi, registerFontRoles, STANDARD_FONTS, WINANSI_REPLACEMENT, createPdf, writeText, measureText } from '../pdf'
import { pdfTextByStream } from './pdf-oracle'

const CP1252_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'
const LATIN1_PRINTABLE = Array.from({ length: 0x7F - 0x20 }, (_, i) => String.fromCharCode(0x20 + i)).join('')
  + Array.from({ length: 0x100 - 0xA0 }, (_, i) => String.fromCharCode(0xA0 + i)).join('')

describe('NE-1b — fontes-padrão e WinAnsi', () => {
  it('pt-BR inteiro e os extras do CP1252 passam intactos', () => {
    for (const t of ['Ação, ÉÍÓÚ çãõ â ê ô à nº ª ° §', CP1252_EXTRA, LATIN1_PRINTABLE]) {
      expect(toWinAnsi(t)).toEqual({ text: t, replaced: 0 })
    }
  })

  it('NFC: letra + acento combinante vira a letra acentuada (não vira "?")', () => {
    expect(toWinAnsi('ação')).toEqual({ text: 'ação', replaced: 0 })
  })

  it('fora do WinAnsi vira "?" VISÍVEL e contado — um por caractere (emoji conta 1)', () => {
    expect(WINANSI_REPLACEMENT).toBe('?')
    expect(toWinAnsi('ok 😀')).toEqual({ text: 'ok ?', replaced: 1 })
    expect(toWinAnsi('Ω→✓')).toEqual({ text: '???', replaced: 3 })
    expect(toWinAnsi('bip\u0007 nel\u0085')).toEqual({ text: 'bip? nel?', replaced: 2 })
    expect(toWinAnsi('\u0081\u008D')).toEqual({ text: '??', replaced: 2 })   // buracos do CP1252 também
  })

  it('quebra de linha única \\n; tabulação vira espaço', () => {
    expect(toWinAnsi('a\r\nb\rc\nd\te')).toEqual({ text: 'a\nb\nc\nd e', replaced: 0 })
  })

  it('papéis: só nomes em minúscula que não colidem com fonte-padrão, e só fonte-padrão WinAnsi', () => {
    const { doc } = createPdf({ marginCm: 1, title: 'papéis' })
    expect(() => registerFontRoles(doc, {} as any)).toThrow(RangeError)
    expect(() => registerFontRoles(doc, { Title: 'Times-Bold' } as any)).toThrow(RangeError)
    expect(() => registerFontRoles(doc, { Courier: 'Courier' } as any)).toThrow(RangeError)
    expect(() => registerFontRoles(doc, { title: 'Symbol' } as any)).toThrow(RangeError)
    expect(() => registerFontRoles(doc, { title: 'ZapfDingbats' } as any)).toThrow(RangeError)
    expect(() => registerFontRoles(doc, { title: 'Arial' } as any)).toThrow(RangeError)
    registerFontRoles(doc, { title: 'Times-Bold', content: 'Times-Roman', fixed: 'Courier' })
    expect(() => doc.font('title')).not.toThrow()
  })

  it('D-NE126 — `writeText` é a porta de texto: papel REGISTRADO, sempre pelo `toWinAnsi` (troca visível e contada), posição e corpo validados', async () => {
    const w = createPdf({ marginCm: 1, title: 'porta de texto', creationDate: new Date('2026-10-17T03:00:00Z'), fontRoles: { content: 'Times-Roman' } })
    expect(writeText(w.doc, 'content', 'Ação 10μm → ok', { sizePt: 9 })).toEqual({ replaced: 2 })
    expect(writeText(w.doc, 'content', 'nº 5 — € 3', { x: 40, y: 200 })).toEqual({ replaced: 0 })
    expect(() => writeText(w.doc, 'title', 'sem papel')).toThrow(RangeError)                        // não registrado: recusa legível (o pdfkit tentaria abrir um ARQUIVO)
    expect(() => writeText(w.doc, 'toString', 'x')).toThrow(RangeError)
    expect(() => writeText(w.doc, 'content', 'x', { x: NaN })).toThrow(RangeError)
    expect(() => writeText(w.doc, 'content', 'x', { y: 1e21 })).toThrow(RangeError)
    expect(() => writeText(w.doc, 'content', 'x', { sizePt: 0 })).toThrow(RangeError)
    const lines = pdfTextByStream(await w.end()).flat()
    expect(lines).toEqual(expect.arrayContaining(['Ação 10?m ? ok', 'nº 5 — € 3']))
  })

  it('D-NE132/D-NE133 — LINHA ÚNICA (`lineBreak: false` com `width`): uma linha só, alinhada pela base dentro da largura; não cabe = recusa legível; o `x` volta para onde a escrita começou', async () => {
    const w = createPdf({ marginCm: 1, title: 'linha única', creationDate: new Date('2026-10-17T03:00:00Z'), fontRoles: { content: 'Times-Roman' } })
    const cell = { width: 120, lineBreak: false, sizePt: 8 } as const
    const value = '1.234,56'
    const textWidth = measureText(w.doc, 'content', value, { sizePt: 8 }).width
    writeText(w.doc, 'content', value, { ...cell, x: 300, y: 100, align: 'right' })
    expect(w.doc.x).toBe(300)
    writeText(w.doc, 'content', value, { ...cell, y: 120, align: 'center' })         // só y: o x corrente é o 300 de onde a anterior COMEÇOU
    writeText(w.doc, 'content', value, { ...cell, y: 140 })
    expect(() => writeText(w.doc, 'content', 'VALOR TOTAL DOS PRODUTOS 1.234.567,89', { ...cell, width: 60, y: 160 })).toThrow(/não cabe na largura/)
    expect(() => writeText(w.doc, 'content', 'a\nb', { ...cell, y: 180 })).toThrow(/não leva quebra de linha/)
    expect(() => writeText(w.doc, 'content', 'a', { ...cell, y: 200, continued: true })).toThrow(/não combina com lineBreak: false/)   // D-NE136
    expect(() => writeText(w.doc, 'content', 'a', { ...cell, y: 200, height: 20 })).toThrow(/não se aplica à linha única/)
    // D-NE137: os espaços do FIM não contam — "1.234,56   " à direita encosta na borda da célula como "1.234,56"
    writeText(w.doc, 'content', `${value}   `, { ...cell, x: 300, y: 220, align: 'right' })
    const { pdfContentOps, pdfTextRuns } = await import('./pdf-oracle')
    const runs = pdfTextRuns(pdfContentOps(await w.end())[0])
    expect(runs.map(r => r.text)).toEqual([value, value, value, value])
    expect(runs[0].x).toBeCloseTo(300 + 120 - textWidth, 4)
    expect(runs[1].x).toBeCloseTo(300 + (120 - textWidth) / 2, 4)
    expect(runs[2].x).toBeCloseTo(300, 4)
    expect(runs[3].x).toBeCloseTo(300 + 120 - textWidth, 4)                          // aparado: mesma posição do valor sem os espaços
  })

  it('D-NE131 — um papel, uma fonte: registrar de novo com a MESMA fonte é inofensivo; com OUTRA, recusado (a grade medida não muda no meio)', async () => {
    const w = createPdf({ marginCm: 1, title: 'um papel', creationDate: new Date('2026-10-17T03:00:00Z'), fontRoles: { content: 'Times-Roman' } })
    expect(() => registerFontRoles(w.doc, { content: 'Times-Roman' })).not.toThrow()
    expect(() => registerFontRoles(w.doc, { content: 'Courier' })).toThrow(/já é Times-Roman/)
    expect(() => registerFontRoles(w.doc, { outro: 'Courier', content: 'Courier' } as any)).toThrow(RangeError)
    expect(() => writeText(w.doc, 'outro', 'x')).toThrow(/não registrado/)                       // recusa do lote INTEIRO: nada foi registrado
    await w.end()
  })

  it('papel com nome de propriedade do JS ("toString", "constructor", "__proto__") é recusado no registro (gate adversarial A9)', () => {
    const { doc } = createPdf({ marginCm: 1, title: 'papéis do JS' })
    for (const role of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
      expect(() => registerFontRoles(doc, { [role]: 'Times-Roman' } as any)).toThrow(RangeError)
    }
    expect(() => createPdf({ marginCm: 1, title: 'x', fontRoles: { constructor: 'Courier' } as any })).toThrow(RangeError)
  })

  it('em CADA fonte-padrão, todo caractere representável atravessa um PDF real e volta igual', async () => {
    const w = createPdf({ marginCm: 1, title: 'ida e volta', creationDate: new Date('2026-10-17T03:00:00Z') })
    const sample = LATIN1_PRINTABLE.replace(/­/g, '') + CP1252_EXTRA          // o hífen opcional (U+00AD) não é desenhado — conferido à parte
    for (const font of STANDARD_FONTS) w.doc.font(font).fontSize(6).text(toWinAnsi(sample).text, { lineBreak: false })
    const pages = pdfTextByStream(await w.end())
    const lines = pages.flat()
    for (const font of STANDARD_FONTS) expect([font, lines.some(l => l === sample)]).toEqual([font, true])
  })
})
