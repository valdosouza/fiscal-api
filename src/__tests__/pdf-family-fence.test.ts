/// <reference types="jest" />
// fiscal-api:PDF.E2.P1.T1 — a cerca da família do DANFE (peça em `pdf-family-fence.ts`; D-NE126, D-NE129, D-NE130, D-NE142). A cerca roda
// sobre o DANFE por CÓPIA na suíte da nfe-api (Valdo 2026-11-21); aqui a regra é provada: cada item da lista barrado, os caminhos permitidos
// limpos e a cerca não é cega ao código real que usa o pdfkit cru (a própria base, que é quem implementa as portas).
import fs from 'fs'
import path from 'path'
import { isPdfFamilyFile, pdfFamilyViolations, type FenceRule } from './pdf-family-fence'

const rules = (code: string): FenceRule[] => [...new Set(pdfFamilyViolations(code).map(v => v.rule))].sort()

describe('PDF.E2.P1.T1 — a cerca da família do DANFE barra', () => {
  it('(a) `doc.text` cru, `doc.list` e `doc.table` como chamada — direta, encadeada, opcional ou por call/apply/bind', () => {
    const cases = [
      "doc.text('Chave de acesso', 10, 20)",
      "doc.fontSize(8).text('x')",
      "doc?.text('x')",
      "doc.text?.('x')",
      "doc.list(['a', 'b'])",
      "doc.table({ data: [] })",
      "doc.text.call(doc, 'x')",
      "doc.text.apply(doc, ['x'])",
      "const w = doc.text.bind(doc); w('x')",
      "doc.list.call(doc, [])",
    ]
    expect(cases.map(c => [c, rules(c)])).toEqual(cases.map(c => [c, ['a']]))
  })

  it('(b) as medidas cruas do pdfkit (`heightOfString`/`widthOfString`) em qualquer referência', () => {
    const cases = [
      "const h = doc.heightOfString('x', { width: 100 })",
      "const w = doc.widthOfString('x')",
      "const m = doc.widthOfString",
      "const { heightOfString } = doc",
      "const { widthOfString: medir } = doc",
    ]
    expect(cases.map(c => [c, rules(c)])).toEqual(cases.map(c => [c, ['b']]))
  })

  it('(a) TODO `doc.font(…)` como chamada, inclusive com o nome de um papel, e (b) o `registerFont` em qualquer referência (Valdo 2026-11-21: "Barrar todo doc.font", "Só a chamada")', () => {
    const cases: [string, FenceRule[]][] = [
      ["doc.font('Helvetica-Bold')", ['a']],
      ["doc.font('titulo')", ['a']],
      ["doc.font('Times-Roman').fontSize(8)", ['a']],
      ["(doc.font as any)('Courier')", ['a']],
      ["doc.font.call(doc, 'Courier')", ['a']],
      ['const { font } = doc', ['b']],
      ["doc.registerFont('titulo', 'Symbol')", ['b']],
      ['const r = doc.registerFont', ['b']],
      ['const { registerFont: r } = doc', ['b']],
    ]
    expect(cases.map(([c]) => [c, rules(c)])).toEqual(cases)
  })

  it('"Só a chamada": ler o campo `font` de um dado passa (o `WatermarkStyle.font` da própria base, um estilo da família)', () => {
    for (const c of ["drawWatermark(doc, 'HOMOLOGACAO', { font: MARCA.font, sizePt: 60 })", 'const f = ESTILOS.titulo.font',
      'const { font, sizePt } = estiloDe(campo)']) {
      expect([c, pdfFamilyViolations(c)]).toEqual([c, []])
    }
  })

  it('(c) os nomes por colchete, chave computada ou Reflect — o caminho de reflexão', () => {
    const cases = [
      "doc['text']('x')",
      'doc[`text`](\'x\')',
      "doc['list']([])",
      "doc['table']({})",
      "doc['heightOfString']('x')",
      "doc['clip']()",
      "doc['font']('Courier')",
      "const { ['font']: f } = doc",
      "Reflect.apply(doc.save, doc, []); Reflect.get(doc, 'text')",
      "Reflect.apply(Reflect.get(doc, 'widthOfString'), doc, ['x'])",
    ]
    expect(cases.map(c => [c, rules(c)])).toEqual(cases.map(c => [c, ['c']]))
  })

  it("(d) `doc.on('pageAdded')` — e todo ouvinte ou texto com o nome", () => {
    const cases = [
      "doc.on('pageAdded', () => desenhar(doc))",
      "doc.once('pageAdded', f)",
      "doc.addListener(`pageAdded`, f)",
      "doc.prependListener('pageAdded', f)",
      "const EVENTO = 'pageAdded'; doc.on(EVENTO, f)",
    ]
    expect(cases.map(c => [c, rules(c)])).toEqual(cases.map(c => [c, ['d']]))
  })

  it('(e) `clip()` fora de `save()` aberto na mesma função', () => {
    const cases = [
      'doc.rect(0, 0, 10, 10).clip()',
      'doc.rect(0, 0, 10, 10).clip(); doc.save(); doc.restore()',                    // o save vem DEPOIS do clip
      'doc.save(); doc.restore(); doc.rect(0, 0, 10, 10).clip()',                    // o save já fechou
      'doc.save(); doc.rect(0, 0, 10, 10).clip()',                                   // save sem restore
      'doc.save(); doc.rect(0, 0, 10, 10).clip(); doc.restore(); doc.restore()',     // restore a mais
      'doc.rect(0, 0, 10, 10).clip().save()',                                        // o save do encadeado vem depois do clip
      'function recorta(doc) { doc.rect(0, 0, 10, 10).clip() }\ndoc.save(); recorta(doc); doc.restore()', // auxiliar: o save é de quem chama
      'doc.save(); [1].forEach(() => { doc.rect(0, 0, 10, 10).clip() }); doc.restore()',                 // callback = outra função
    ]
    expect(cases.map(c => [c, rules(c)])).toEqual(cases.map(c => [c, ['e']]))
  })

  it('(e) a mudança de MATRIZ (`rotate`/`translate`/`scale`/`transform`) fora de `save()` aberto — como o `clip` (A1; Valdo: "Entram na cerca")', () => {
    const cases = [
      'doc.translate(200, 300)',
      "doc.rotate(-90, { origin: [20, 800] }); writeText(doc, 'c', 'x', { lineBreak: false, width: 50 })",
      'doc.scale(0.5).rect(0, 0, 10, 10).stroke()',
      'doc.transform(1, 0, 0, 1, 10, 10)',
      'doc.save(); doc.restore(); doc.rotate(90)',
      'function gira(doc) { doc.rotate(90) }\ndoc.save(); gira(doc); doc.restore()',
    ]
    expect(cases.map(c => [c, rules(c)])).toEqual(cases.map(c => [c, ['e']]))
    expect(rules("doc['rotate'](90)")).toEqual(['c'])
  })

  it('a matriz DENTRO de save()/restore() passa, e `scale`/`rotate` como DADO não são acusados', () => {
    for (const c of ['doc.save().translate(10, 10).scale(0.5); drawMatrix(doc, qr, { x: 0, y: 0, size: 80 }); doc.restore()',
      'doc.save()\ntry { doc.transform(1, 0, 0, 1, 5, 5) } finally { doc.restore() }',
      'const fator = opcoes.scale', 'const { rotate, scale } = opcoes', 'const r = layout.rotate']) {
      expect([c, pdfFamilyViolations(c)]).toEqual([c, []])
    }
  })

  it('(b) `clip` como referência que não é a chamada direta', () => {
    for (const c of ['const recortar = doc.clip', 'const { clip } = doc', 'const { clip: r } = doc', 'doc.save(); doc.clip.call(doc); doc.restore()',
      "const { 'clip': r } = doc", 'let r; ({ clip: r } = doc)']) {
      expect([c, rules(c)]).toEqual([c, ['b']])
    }
  })

  it('(a)/(b) na desestruturação: chave em texto, na atribuição, e o método solto (`text` de um objeto que não é resultado de chamada)', () => {
    const cases: [string, FenceRule[]][] = [
      ["const { 'font': f } = doc", ['b']],
      ["const { 'widthOfString': w } = doc", ['b']],
      ['let f; ({ font: f } = doc)', ['b']],
      ['let font; ({ font } = doc)', ['b']],
      ['const { text: t } = doc', ['b']],
      ['const { list } = doc', ['b']],
    ]
    expect(cases.map(([c]) => [c, rules(c)])).toEqual(cases)
  })

  it('(e) cada `clip` fora de lugar é acusado UMA vez (a função aninhada conta à parte, sem repetir na de fora)', () => {
    expect(pdfFamilyViolations('doc.save(); [1].forEach(() => { doc.rect(0, 0, 1, 1).clip() }); doc.restore()').map(v => v.rule)).toEqual(['e'])
    expect(pdfFamilyViolations('function a() { function b() { doc.clip() } }').map(v => v.rule)).toEqual(['e'])
  })

  it('a violação traz a linha e o trecho', () => {
    const v = pdfFamilyViolations("import { writeText } from 'fiscal-api/pdf'\n\nwriteText(doc, 'conteudo', 'ok')\ndoc.text('cru')\n")
    expect(v).toEqual([{ rule: 'a', line: 4, snippet: "doc.text('cru')" }])
  })
})

describe('PDF.E2.P1.T1 — a cerca deixa passar', () => {
  it('o texto GIRADO da D-NE130: save() → rotate() → writeText → restore()', () => {
    const code = `
      import { writeText, measureText } from 'fiscal-api/pdf'
      export function canhoto(doc: PDFKit.PDFDocument, x: number, y: number): void {
        doc.save()
        doc.rotate(-90, { origin: [x, y] })
        writeText(doc, 'conteudo', 'RECEBEMOS DE', { x, y, sizePt: 6, lineBreak: false, width: measureText(doc, 'conteudo', 'RECEBEMOS DE', { sizePt: 6, width: 200 }).width + 1 })
        doc.restore()
      }`
    expect(pdfFamilyViolations(code)).toEqual([])
  })

  it('o recorte DENTRO de save()/restore() — encadeado, em linhas separadas, aninhado e com o restore no finally', () => {
    const cases = [
      "doc.save().rect(0, 0, 10, 10).clip(); writeText(doc, 'c', 'x'); doc.restore()",
      "doc.save()\ndoc.rect(0, 0, 10, 10)\ndoc.clip()\nwriteText(doc, 'c', 'x')\ndoc.restore()",
      'doc.save(); doc.save(); doc.rect(0, 0, 1, 1).clip(); doc.restore(); doc.rect(0, 0, 2, 2).clip(); doc.restore()',
      "doc.save()\ntry { doc.rect(0, 0, 10, 10).clip(); writeText(doc, 'c', 'x') } finally { doc.restore() }",
      'function celula(doc) { doc.save(); doc.rect(0, 0, 10, 10).clip(); doc.restore() }\ncelula(doc); celula(doc)',
      'const f = () => { doc.save(); doc.rect(0, 0, 1, 1).clip(); doc.restore() }',
    ]
    expect(cases.map(c => [c, pdfFamilyViolations(c)])).toEqual(cases.map(c => [c, []]))
  })

  it('o `.text` e os campos `list`/`table` de OUTROS objetos, o desenho vetorial, as portas e os comentários', () => {
    const code = `
      import { writeText, measureText, toWinAnsi, drawBars } from 'fiscal-api/pdf'
      // doc.text('x') e doc.font('y') num comentário não contam; nem doc.on('pageAdded')
      const { text, replaced } = toWinAnsi(nome)
      const t = toWinAnsi(nome).text
      const linhas = itens.list
      const grade = layout.table
      const rotulo = { label: 'text', tipo: 'font' }
      doc.rect(0, 0, 10, 10).lineWidth(0.5).stroke()
      doc.moveTo(0, 0).lineTo(10, 0).stroke()
      doc.on('error', falhou)
      writeText(doc, 'conteudo', text, { x: 10, y: 20 })
      const m = measureText(doc, 'conteudo', 'x', { width: 100 })
      drawBars(doc, barras, { x: 0, y: 0 })
    `
    expect(pdfFamilyViolations(code)).toEqual([])
  })
})

describe('PDF.E2.P1.T1 — o escopo da família (`isPdfFamilyFile`)', () => {
  it('é da família quem importa `fiscal-api/pdf` ou `pdfkit` (de qualquer forma) ou cita o tipo `PDFKit`', () => {
    const yes = [
      "import { writeText } from 'fiscal-api/pdf'",
      "import type { PdfWriter } from 'fiscal-api/pdf'",
      "export { createPdf } from 'fiscal-api/pdf'",
      "import PDFDocument from 'pdfkit'",
      "const P = require('pdfkit')",
      "const m = await import('fiscal-api/pdf')",
      "import P = require('pdfkit')",
      'export function f(doc: PDFKit.PDFDocument) {}',
      "type D = import('pdfkit')",
    ]
    expect(yes.map(c => [c, isPdfFamilyFile(c)])).toEqual(yes.map(c => [c, true]))
  })
  it('não é da família o resto (inclusive quem só fala de PDF em texto ou comentário)', () => {
    const no = [
      "import { parseXml } from 'fiscal-api/xml'",
      "import x from 'fiscal-api/pdfx'",
      "// import { writeText } from 'fiscal-api/pdf'",
      "const s = 'pdfkit'",
      'export function f(doc: unknown) {}',
    ]
    expect(no.map(c => [c, isPdfFamilyFile(c)])).toEqual(no.map(c => [c, false]))
  })
})

describe('PDF.E2.P1.T1 — a cerca não é cega ao código real', () => {
  // a BASE implementa as portas com o pdfkit cru — é o código que a família NUNCA pode ter; cada regra que cabe nela tem de disparar
  const SRC = path.resolve(__dirname, '..', 'pdf')
  const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8')
  it('`fonts.ts` (doc.text, medidas cruas, doc.font, registerFont) e `pdf-writer.ts` (pageAdded) disparam as regras a, b e d', () => {
    expect(rules(read('fonts.ts'))).toEqual(expect.arrayContaining(['a', 'b']))
    const fonts = pdfFamilyViolations(read('fonts.ts')).map(v => v.snippet)
    expect(fonts.some(s => s.startsWith('doc.text('))).toBe(true)
    expect(fonts.some(s => s.includes('widthOfString'))).toBe(true)
    expect(fonts.some(s => s.includes('heightOfString'))).toBe(true)
    expect(fonts.some(s => s.startsWith('doc.registerFont'))).toBe(true)
    expect(rules(read('pdf-writer.ts'))).toContain('d')
    expect(isPdfFamilyFile(read('pdf-writer.ts'))).toBe(true)
  })
})
