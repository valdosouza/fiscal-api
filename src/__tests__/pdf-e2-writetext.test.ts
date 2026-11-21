/// <reference types="jest" />
// fiscal-api:PDF.E2.P1.T2 — o `writeText` com a "cadeia aberta" lida de UMA forma só (`openChain`) e o despacho do texto vazio num ponto só
// (`writeEmpty`). O comportamento de antes segue provado pelas suítes da base (`pdf-*.test.ts`) e pelos gates permanentes (`adversarial-ne1b-*`);
// aqui fica só o que a forma única ACRESCENTA: o estado partido (um sem o outro) — que a porta não cria — vira recusa legível, nunca TypeError.
import { createPdf, writeText } from '../pdf'

const ROLES = { content: 'Times-Roman' } as const
const errorOf = (fn: () => unknown): Error | null => { try { fn(); return null } catch (e) { return e as Error } }
type Chain = { _wrapper: unknown; _textOptions: unknown }

describe('PDF.E2.P1.T2 — a cadeia aberta numa forma só', () => {
  it('a cadeia aberta pela porta tem os DOIS campos (o pdfkit 0.20.2 os põe e zera juntos) e o fechamento pelo vazio zera os dois', () => {
    const d = createPdf({ marginCm: 1, title: 'cadeia', fontRoles: ROLES }).doc
    writeText(d, 'content', 'Endereço: ', { x: 40, y: 40, width: 300, continued: true })
    const c = d as unknown as Chain
    expect([!!c._wrapper, !!c._textOptions]).toEqual([true, true])
    writeText(d, 'content', '')
    expect([c._wrapper, c._textOptions]).toEqual([null, null])
  })

  for (const [name, broken] of [
    ['só o _textOptions', (c: Chain) => { c._wrapper = null; c._textOptions = { width: 300, continued: true } }],
    ['só o _wrapper', (c: Chain) => { c._textOptions = null }],
  ] as const) {
    it(`estado partido (${name}) — estado interno mexido fora da base — é recusado com mensagem da base, em todo caminho (vazio, com texto, linha única)`, () => {
      for (const [text, opts] of [['', {}], ['', { continued: true }], ['x', {}], ['x', { lineBreak: false, width: 100 }]] as const) {
        const d = createPdf({ marginCm: 1, title: 'partido', fontRoles: ROLES }).doc
        writeText(d, 'content', 'Endereço: ', { x: 40, y: 40, width: 300, continued: true })
        broken(d as unknown as Chain)
        const e = errorOf(() => writeText(d, 'content', text, opts))
        expect([name, text, opts, e?.constructor.name, e?.message]).toEqual([name, text, opts, 'Error',
          'base de PDF: o texto encadeado do pdfkit ficou partido (estado interno do pdfkit mexido fora da base — PDF.E2.P1)'])
      }
    })
  }

  it('a linha ÚNICA vazia segue pelo caminho da linha única: `lineGap`/`paragraphGap`/`height` nela são recusados (D-NE132), como antes', () => {
    for (const k of ['lineGap', 'paragraphGap', 'height', 'indent']) {
      const d = createPdf({ marginCm: 1, title: 'linha única vazia', fontRoles: ROLES }).doc
      const e = errorOf(() => writeText(d, 'content', '', { x: 40, y: 40, width: 100, lineBreak: false, [k]: 3 }))
      expect([k, e?.message]).toEqual([k, `fontes da base: "${k}" não se aplica à linha única (lineBreak: false com width — D-NE132)`])
    }
  })

  it('com a cadeia ABERTA não há conferência de largura útil (F-L5): o fechamento pelo vazio e o trecho seguinte passam além da margem direita', () => {
    for (const [text, extra] of [['', {}], ['fim', {}], ['', { continued: true }]] as const) {
      const d = createPdf({ marginCm: 1, title: 'F-L5 com cadeia', fontRoles: ROLES }).doc
      writeText(d, 'content', 'Endereço: ', { x: 40, y: 40, width: 300, continued: true })
      d.x = d.page.width                                                        // o x corrente além da margem direita
      expect([text, extra, errorOf(() => writeText(d, 'content', text, { ...extra }))]).toEqual([text, extra, null])
    }
  })

  it('o vazio que CONTINUA a cadeia não toca nem a fonte nem o corpo (D-NE153 — nunca chega à troca de fonte do despacho)', () => {
    const d = createPdf({ marginCm: 1, title: 'no-op', fontRoles: { content: 'Times-Roman', title: 'Courier-Bold' } }).doc
    writeText(d, 'content', 'Endereço: ', { x: 40, y: 40, width: 300, continued: true, sizePt: 9 })
    const i = d as unknown as { _font: { name: string }; _fontSize: number }
    const before = [i._font.name, i._fontSize, d.x, d.y]
    writeText(d, 'title', '', { continued: true, sizePt: 20 })
    expect([i._font.name, i._fontSize, d.x, d.y]).toEqual(before)
  })
})
