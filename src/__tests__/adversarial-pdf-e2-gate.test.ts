/// <reference types="jest" />
// GATE ADVERSARIAL do passo fiscal-api:PDF.E2.P1 (revisor independente, 2026-11-21 — ficha `SUBJECT/PDF/ficha-pdf-e2-p1-cerca-danfe.md`):
//   T1 — a cerca da família do DANFE (`pdf-family-fence.ts`, por AST);
//   T2 — o `writeText` refeito (`openChain`/`closeChain`/`assertUsableWidth`/`writeEmpty`), que tem de se comportar IGUAL ao de af3faea (a única
//        diferença aceita é recusar o estado partido `_wrapper` sem `_textOptions`, ou o contrário).
// Os positivos do passo estão em `pdf-family-fence.test.ts` e `pdf-e2-writetext.test.ts` (não repetidos aqui).
//
// Ataque que RESISTIU fica como teste verde; achado CONFIRMADO fica como `it.failing` com o rótulo "[ACHADO <SEVERIDADE>]" — o corpo afirma o
// comportamento CORRETO, então quando a correção entrar o `it.failing` passa a FALHAR e vira `it` comum.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import { execFileSync } from 'child_process'
import ts from 'typescript'
import * as NEW from '../pdf'
import { pdfContentOps } from './pdf-oracle'
import { pdfFamilyViolations, isPdfFamilyFile, type FenceRule } from './pdf-family-fence'

const ROOT = path.resolve(__dirname, '..', '..')
const BASE_COMMIT = 'af3faea'                     // o núcleo ANTES do passo (pacote 4.0.0) — o oráculo da paridade da T2
const FIXED = new Date('2026-11-21T03:00:00Z')
const rules = (code: string): FenceRule[] => [...new Set(pdfFamilyViolations(code).map(v => v.rule))].sort()

/**
 * Carrega a base de PDF de `BASE_COMMIT` (tirada do git, transpilada para JS num diretório temporário e carregada pelo `require` do Node — fora
 * do registro do Jest). Sem git ou sem o commit (cópia rasa, pacote), devolve null e a paridade é pulada.
 */
function loadBase(): typeof NEW | null {
  let files: string[]
  try {
    files = execFileSync('git', ['ls-tree', '-r', '--name-only', BASE_COMMIT, 'src/pdf', 'src/pdf.ts'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(f => f.endsWith('.ts'))
  } catch { return null }
  if (files.length === 0) return null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-e2-base-'))
  const external = (name: string): string => JSON.stringify(require.resolve(name, { paths: [ROOT] }))
  for (const f of files) {
    const src = execFileSync('git', ['show', `${BASE_COMMIT}:${f}`], { cwd: ROOT, encoding: 'utf8' })
    const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } })
      .outputText.replace(/require\("(pdfkit|bwip-js)"\)/g, (_m, name: string) => `require(${external(name)})`)
    const out = path.join(dir, f.replace(/^src[\\/]/, '').replace(/\.ts$/, '.js'))
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, js)
  }
  return createRequire(path.join(dir, 'index.js'))(path.join(dir, 'pdf.js')) as typeof NEW
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// T2 — paridade do writeText com o de antes
// ---------------------------------------------------------------------------------------------------------------------------------------------
describe('PDF.E2.P1 gate adversarial — T2: o writeText novo é IGUAL ao de af3faea (byte a byte e por estado)', () => {
  const OLD = loadBase()
  const maybe = OLD ? it : it.skip
  const ROLES = { title: 'Times-Bold', content: 'Times-Roman', fixed: 'Courier' } as const
  type Mod = typeof NEW
  type Doc = PDFKit.PDFDocument
  const TEXTS = ['', '', ' ', '   ', 'Chave', 'Endereço: ', 'a b c d e f g h i j k l m n o p q r s t u v w x y z '.repeat(3), 'linha1\nlinha2', '\n',
    'emoji \u{1F600}', 'R$ 1.234,56', 'x'.repeat(200)]
  const X = [undefined, undefined, 10, 40, 300, 560, 570, 590, 600, -5]
  const Y = [undefined, undefined, 10, 40, 700, 780, 790, 800, 815, 830]
  const state = (doc: Doc) => {
    const d = doc as unknown as Record<string, any>
    return { x: d.x, y: d.y, font: d._font?.name, size: d._fontSize, lineGap: d._lineGap, open: !!d._wrapper, startX: d._wrapper?.startX ?? null,
      textOptions: JSON.stringify(d._textOptions), sheets: d._pageBuffer.length, page: d._pageBuffer.indexOf(d.page) }
  }
  const run = (M: Mod, d: Doc, role: string, text: string, o: Record<string, unknown>) => {
    let err: [string, string] | null = null
    try { M.writeText(d, role, text, o as never) } catch (e) { err = [(e as Error).constructor.name, (e as Error).message] }
    return JSON.stringify([err, state(d)])
  }

  maybe('sorteio (semente fixa): 500 roteiros de 1 a 8 trechos — vazios e com texto × opções × cadeia aberta/fechada, pé da folha, sem largura útil, linha única com e sem width, com e sem sheetStart', async () => {
    let seed = 20261121
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]
    const opts = () => {
      const o: Record<string, unknown> = {}
      if (rnd() < 0.4) o.x = pick(X)
      if (rnd() < 0.4) o.y = pick(Y)
      if (rnd() < 0.2) o.sizePt = pick([6, 9, 20, 40])
      if (rnd() < 0.4) o.width = pick([20, 100, 300, 500])
      if (rnd() < 0.4) o.lineBreak = pick([false, true])
      if (rnd() < 0.45) o.continued = pick([true, true, false])
      if (rnd() < 0.1) o.height = pick([10, 50])
      if (rnd() < 0.1) o.align = pick(['left', 'center', 'right', 'justify'])
      if (rnd() < 0.1) o.lineGap = pick([1, 5])
      if (rnd() < 0.1) o.paragraphGap = pick([0, 3])
      if (rnd() < 0.05) o.indent = 5
      if (rnd() < 0.05) o.underline = true
      if (rnd() < 0.05) o.ellipsis = true
      for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
      return o
    }
    const seen = new Set<string>()
    const divergences: unknown[] = []
    for (let n = 0; n < 500 && divergences.length < 3; n++) {
      const steps = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => [pick(Object.keys(ROLES)), pick(TEXTS), opts()] as const)
      const header = rnd() < 0.3
      const make = (M: Mod) => M.createPdf({ marginCm: 1, title: 'paridade', creationDate: FIXED, fontRoles: ROLES,
        ...(header ? { sheetStart: (d: Doc, s: number) => { M.writeText(d, 'title', `Cabeçalho ${s}`, { x: 30, y: 30, width: 200 }) } } : {}) })
      const a = make(OLD!), b = make(NEW)
      let diverged = false
      for (const [role, text, o] of steps) {
        const chain = !!(a.doc as unknown as { _wrapper?: unknown })._wrapper
        const sa = run(OLD!, a.doc, role, text, o), sb = run(NEW, b.doc, role, text, o)
        seen.add(`${text === '' ? 'vazio' : 'texto'}|${chain ? 'cadeia' : 'solto'}|${o.continued === true ? 'continued' : '-'}|${JSON.parse(sa)[0] ? 'erro' : 'ok'}`)
        if (sa !== sb) { divergences.push({ n, role, text, o, old: sa, new: sb }); diverged = true; break }
      }
      if (diverged) continue
      const end = async (w: { end: () => Promise<Buffer> }) => { try { return await w.end() } catch (e) { return (e as Error).message } }
      const [pa, pb] = [await end(a), await end(b)]
      if (typeof pa === 'string' || typeof pb === 'string' ? pa !== pb : !pa.equals(pb)) divergences.push({ n, end: true })
    }
    expect(divergences).toEqual([])
    // o sorteio passou pelos ramos que a T2 mexeu: o vazio com cadeia (fecha / continua), o vazio solto (D-NE147 / D-NE153) e o texto com cadeia
    expect([...seen].filter(k => k.startsWith('vazio|cadeia|-|ok') || k.startsWith('vazio|cadeia|continued|ok') || k.startsWith('vazio|solto|-|ok')
      || k.startsWith('vazio|solto|continued|erro') || k.startsWith('texto|cadeia|continued|ok')).length).toBe(5)
  }, 120_000)

  maybe('casos de borda dirigidos: fechamento pelo vazio no pé (com y, sizePt, lineGap e paragraphGap), vazio solto sem largura útil, linha única vazia, ordem das recusas', async () => {
    type Step = [string, string, Record<string, unknown>]
    const open: Step = ['content', 'Endereço: ', { x: 40, y: 790, width: 300, continued: true, lineGap: 2, paragraphGap: 4 }]
    const scripts: Step[][] = [
      [open, ['title', '', {}]],
      [open, ['title', '', { y: 805, sizePt: 30 }]],
      [open, ['title', '', { lineGap: 7, paragraphGap: 1 }]],
      [open, ['title', '', { continued: true, sizePt: 40 }], ['fixed', 'resto', {}]],
      [open, ['title', '', { lineBreak: false }]],
      [open, ['title', '', { lineBreak: false, width: 50 }]],
      [open, ['title', 'x', { lineBreak: false, continued: true }]],
      [['content', '', { x: 590 }]],
      [['content', '', { x: 590, continued: true }]],
      [['content', '', { x: 590, lineBreak: false, continued: true }]],
      [['content', '', { x: 590, lineBreak: false }]],
      [['content', '   ', { x: 40, y: 800, lineBreak: false, width: 100, underline: true }]],
      [['content', '', { x: 40, y: 830, sizePt: 40 }]],
      [open, ['title', 'meio', { continued: true }], ['title', '', { x: 590 }]],
    ]
    for (const steps of scripts) {
      const a = OLD!.createPdf({ marginCm: 1, title: 'borda', creationDate: FIXED, fontRoles: ROLES })
      const b = NEW.createPdf({ marginCm: 1, title: 'borda', creationDate: FIXED, fontRoles: ROLES })
      for (const [role, text, o] of steps) expect([steps, run(OLD!, a.doc, role, text, o)]).toEqual([steps, run(NEW, b.doc, role, text, o)])
      const [pa, pb] = [await a.end(), await b.end()]
      expect([steps, pa.equals(pb)]).toEqual([steps, true])
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// T1 — a cerca: o código plausível do DANFE passa; o código cru é visto
// ---------------------------------------------------------------------------------------------------------------------------------------------
describe('PDF.E2.P1 gate adversarial — T1: código plausível do DANFE pelas portas da base passa limpo (sem falso positivo)', () => {
  it('grid de itens, canhoto girado, logotipo recortado, QR, código de barras, marca d\'água, cabeçalho por folha e passada', () => {
    const danfe = `
      import { createPdf, writeText, measureText, drawBars, drawMatrix, drawWatermark, code128Bars, code128Symbols, qrMatrix, cmToPt,
        type PdfWriter, type WatermarkStyle } from 'fiscal-api/pdf'
      const MARCA: WatermarkStyle = { font: 'Helvetica-Bold', sizePt: 60, opacity: 0.2, color: '#999' }
      export function canhoto(doc: PDFKit.PDFDocument, x: number, y: number, emitente: string): void {
        const largura = measureText(doc, 'rotulo', 'RECEBEMOS DE ' + emitente, { sizePt: 6, width: 400 }).width + 1
        doc.save()
        try {
          doc.rotate(-90, { origin: [x, y] })
          writeText(doc, 'rotulo', 'RECEBEMOS DE ' + emitente, { x, y, sizePt: 6, lineBreak: false, width: largura })
        } finally { doc.restore() }
      }
      function logo(doc: PDFKit.PDFDocument, img: Buffer | null, box: { x: number; y: number; w: number; h: number }): void {
        if (!img) return
        doc.save()
        doc.rect(box.x, box.y, box.w, box.h).clip()
        doc.image(img, box.x, box.y, { fit: [box.w, box.h], align: 'center', valign: 'center' })
        doc.restore()
      }
      export function itens(doc: PDFKit.PDFDocument, linhas: readonly { cod: string; desc: string; qtd: string }[], limite: number): number {
        const COLUNAS = [{ campo: 'cod', x: 10, w: 60 }, { campo: 'desc', x: 72, w: 200 }, { campo: 'qtd', x: 274, w: 40 }] as const
        let i = 0
        for (const it of linhas) {
          const alto = Math.max(...COLUNAS.map(c => measureText(doc, 'conteudo', it[c.campo], { sizePt: 6, width: c.w }).height))
          if (doc.y + alto > limite) break
          const y0 = doc.y
          for (const c of COLUNAS) writeText(doc, 'conteudo', it[c.campo], { x: c.x, y: y0, sizePt: 6, width: c.w, align: c.campo === 'qtd' ? 'right' : 'left' })
          doc.moveTo(10, y0 + alto).lineTo(314, y0 + alto).lineWidth(0.3).stroke()
          doc.y = y0 + alto
          i++
        }
        return i
      }
      export function montar(chave: string, url: string, homologacao: boolean): PdfWriter {
        const w = createPdf({ marginCm: 0.5, title: 'DANFE', fontRoles: { rotulo: 'Helvetica', conteudo: 'Helvetica', titulo: 'Helvetica-Bold' },
          sheetStart: (doc, folha) => {
            if (homologacao) drawWatermark(doc, 'SEM VALOR FISCAL', MARCA)
            writeText(doc, 'titulo', 'DANFE', { x: 250, y: 20, sizePt: 10, lineBreak: false, width: 60, align: 'center' })
            drawBars(doc, code128Bars(code128Symbols(chave)), { x: 300, y: 40, width: cmToPt(8), height: cmToPt(1) })
            drawMatrix(doc, qrMatrix(url, { ecLevel: 'M' }), { x: 500, y: 40, size: 70 })
            writeText(doc, 'rotulo', 'Endereço: ', { x: 20, y: 60, sizePt: 7, width: 200, continued: true })
            writeText(doc, 'conteudo', 'Rua X, 1', { sizePt: 7 })
            void folha
          } })
        canhoto(w.doc, 20, 800, 'EMPRESA')
        logo(w.doc, null, { x: 20, y: 40, w: 80, h: 40 })
        return w
      }
      export const fechar = (w: PdfWriter) => w.end((doc, info) => {
        writeText(doc, 'rotulo', \`Folha \${info.sheet}/\${info.total}\`, { x: 500, y: 20, sizePt: 6, lineBreak: false, width: 60, align: 'right' })
      })
    `
    expect(isPdfFamilyFile(danfe)).toBe(true)
    expect(pdfFamilyViolations(danfe)).toEqual([])
  })

  it('o código REAL que usa o pdfkit cru (o DANFSe da nfse-api, padrão `doc.font(…).fontSize(…).text(…)`) é visto — a e b em cada linha', () => {
    const legado = `
      import PDFDocument from 'pdfkit'
      export function cabecalho(doc: PDFKit.PDFDocument, chave: string) {
        doc.font('Helvetica-Bold').fontSize(14).text('DANFSe', { align: 'center' })
        doc.font('Courier').fontSize(10).text(chave)
        doc.font('Helvetica').fontSize(9).text('Endereço: ', { continued: true }).text('Rua X')
      }`
    expect(isPdfFamilyFile(legado)).toBe(true)
    // "Só a chamada" (Valdo 2026-11-21): o `doc.font(…)` passou da regra (b) para a (a)
    expect(pdfFamilyViolations(legado).map(v => `${v.line}${v.rule}`)).toEqual(['4a', '4a', '5a', '5a', '6a', '6a', '6a'])
  })

  it('o clip DENTRO do save sobrevive a async/await, gerador, vírgula e reabertura de save/restore', () => {
    for (const c of [
      'async function f() { doc.save(); doc.rect(0, 0, 1, 1).clip(); await x; doc.restore() }',
      'function* g() { doc.save(); doc.rect(0, 0, 1, 1).clip(); yield 1; doc.restore() }',
      'const r = cond ? (doc.save(), doc.rect(0, 0, 1, 1).clip(), doc.restore()) : null',
      'doc.save(); doc.rect(0, 0, 1, 1).clip(); doc.restore(); doc.save(); doc.restore()',
      "doc.save(); celulas.forEach(c => writeText(doc, 'c', c)); doc.rect(0, 0, 1, 1).clip(); doc.restore()",
    ]) expect([c, pdfFamilyViolations(c)]).toEqual([c, []])
  })
})

describe('PDF.E2.P1 gate adversarial — T1: as formas de engano que a cerca VÊ (resistiu)', () => {
  it('casts, `!` e genéricos no OBJETO; `?.[…]`; `.clip?.()`; o restore só num ramo; clip em campo de classe; Reflect.apply(doc.clip)', () => {
    const cases: [string, FenceRule[]][] = [
      ["(doc as any).text('x')", ['a']],
      ["(<any>doc).text('x')", ['a']],
      ["doc!.text('x')", ['a']],
      ["doc.text<string>('x')", ['a']],
      ["doc?.['text']('x')", ['c']],
      ["doc?.['font']('x')", ['c']],
      ['doc.rect(0, 0, 1, 1).clip?.()', ['e']],
      ['doc.save(); if (!logo) { doc.restore() }; doc.rect(0, 0, 1, 1).clip(); doc.restore()', ['e']],
      ['class C { f = () => { doc.rect(0, 0, 1, 1).clip() } }', ['e']],
      ['Reflect.apply(doc.clip, doc, [])', ['b']],
      ["doc.save()\nconst f = () => doc.restore()\ndoc.rect(0, 0, 1, 1).clip(); f()", ['e']],
    ]
    expect(cases.map(([c]) => [c, rules(c)])).toEqual(cases)
  })

  it('o texto girado com QUEBRA de linha (fora da D-NE130, que pede linha única) que transborda é recusado ALTO pela base (D-NE134), nunca calado', () => {
    const w = NEW.createPdf({ marginCm: 1, title: 'girado', fontRoles: { c: 'Times-Roman' } })
    w.doc.save()
    w.doc.rotate(-90, { origin: [30, 805] })
    expect(() => NEW.writeText(w.doc, 'c', 'RECEBEMOS DE EMPRESA X OS PRODUTOS CONSTANTES DA NOTA FISCAL INDICADA AO LADO', { x: 30, y: 805, width: 120, sizePt: 6 }))
      .toThrow(/save\(\) aberto atravessando a quebra de folha .*D-NE134/)
  })
})

describe('PDF.E2.P1 gate adversarial — T1: falsos positivos CONHECIDOS (por desenho da ficha §6 — registrados, não achados)', () => {
  it('(a) `.text()`/`.list()`/`.table()` de qualquer objeto; a leitura de `.font` de um dado DEIXOU de ser acusada (Valdo 2026-11-21: "Só a chamada")', () => {
    expect(rules("drawWatermark(doc, 'HOMOLOGACAO', { font: MARCA.font, sizePt: 60 })")).toEqual([])
    expect(rules('const { font, sizePt } = ESTILO_CELULA')).toEqual(['b'])           // desestruturar de um IDENTIFICADOR segue barrado (bannedKey)
    expect(rules('const corpo = await resposta.text()')).toEqual(['a'])
    expect(rules('console.table(itens)')).toEqual(['a'])
    // o caminho limpo: passar o objeto inteiro, sem ler o campo
    expect(rules("drawWatermark(doc, 'HOMOLOGACAO', { ...MARCA, sizePt: 60 })")).toEqual([])
  })
  it('(e) o restore no catch E depois do try conta 2 restore para 1 save (o `finally` é o caminho limpo)', () => {
    expect(rules('doc.save(); try { doc.rect(0, 0, 1, 1).clip() } catch (e) { doc.restore(); throw e } doc.restore()')).toEqual(['e'])
    expect(rules('doc.save(); try { doc.rect(0, 0, 1, 1).clip() } finally { doc.restore() }')).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// ACHADOS
// ---------------------------------------------------------------------------------------------------------------------------------------------
describe('PDF.E2.P1 gate adversarial — [ACHADO MEDIUM, CORRIGIDO na sessão — Valdo: "Entram na cerca"] A1: `rotate`/`translate`/`scale`/`transform` FORA de `save()` vazam a matriz para o resto da folha e para a passada ("Folha n/N") — a mesma classe do `clip` da D-NE142, que a cerca não vê', () => {
  it('fato (verde): a matriz deixada pela família entra na passada — o "Folha 1/1" sai deslocado, sem erro', async () => {
    const w = NEW.createPdf({ marginCm: 1, title: 'vaza', creationDate: FIXED, fontRoles: { c: 'Times-Roman' } })
    w.doc.translate(200, 300)                         // a família posiciona o QR/logo pela matriz e não fecha com save/restore
    NEW.writeText(w.doc, 'c', 'conteudo', { x: 40, y: 40, width: 200 })
    const pdf = await w.end(doc => { NEW.writeText(doc, 'c', 'Folha 1/1', { x: 40, y: 800, width: 200, lineBreak: false }) })
    const ops = pdfContentOps(pdf)[0]
    const passada = ops.lastIndexOf('BT')
    // o `cm` da família está ANTES da passada, sem `Q` que o desfaça no nível dele
    expect(ops.indexOf('1 0 0 1 200 300 cm')).toBeGreaterThan(-1)
    expect(ops.indexOf('1 0 0 1 200 300 cm')).toBeLessThan(passada)
  })
  it('a cerca barra a mudança de matriz fora de `save()` aberto na mesma função (regra e)', () => {
    for (const c of ['doc.translate(200, 300); drawMatrix(doc, qr, { x: 0, y: 0, size: 80 })',
      "doc.rotate(-90, { origin: [20, 800] }); writeText(doc, 'c', 'x', { x: 20, y: 800, lineBreak: false, width: 50 })",
      'doc.scale(0.5)', 'doc.transform(1, 0, 0, 1, 10, 10)']) {
      expect([c, rules(c).length > 0]).toEqual([c, true])
    }
  })
})

describe('PDF.E2.P1 gate adversarial — [ACHADO LOW, CORRIGIDO na sessão] A2: (a) não desembrulha o ALVO da chamada — parênteses, cast, `!` e template marcado no MÉTODO escapam', () => {
  it('`(doc.text)(…)`, `(0, doc.text)(…)`, `(doc.text as Function)(…)`, `doc.text!(…)` e doc.text`…` deviam ser (a)', () => {
    for (const c of ["(doc.text)('x')", "(0, doc.text)('x')", "(doc.text as Function)('x')", "doc.text!('x')", 'doc.text`x`', "(doc.list as any)([])"]) {
      expect([c, rules(c)]).toEqual([c, ['a']])
    }
  })
})

describe('PDF.E2.P1 gate adversarial — [ACHADO LOW, CORRIGIDO na sessão] A3: o caminho de reflexão que a regra (c) promete cobrir tem portas abertas', () => {
  it('`Reflect.apply(doc.text, …)`, o método como callback (`forEach(doc.text, doc)`) e `({ font: f } = doc)` / `({ text: t } = doc)` deviam ser barrados', () => {
    for (const c of ["Reflect.apply(doc.text, doc, ['x'])", 'Reflect.apply(doc.list, doc, [[]])', 'linhas.forEach(doc.text, doc)',
      'let f; ({ font: f } = doc)', 'let t; ({ text: t } = doc); t.call(doc, "x")']) {
      expect([c, rules(c).length > 0]).toEqual([c, true])
    }
  })
})

describe('PDF.E2.P1 gate adversarial — [ACHADO LOW] A4: (e) conta save/restore em ORDEM DE TEXTO e sem olhar o objeto — controle de fluxo e outro receptor passam', () => {
  it.failing('save condicional, save dentro do laço com restore fora, e o save/restore de OUTRO objeto deviam ser (e)', () => {
    for (const c of ['if (a) doc.save(); doc.rect(0, 0, 1, 1).clip(); if (a) doc.restore()',
      'for (const c of cs) { doc.save(); doc.rect(0, 0, 1, 1).clip() }; doc.restore()',
      'outro.save(); doc.rect(0, 0, 1, 1).clip(); outro.restore()']) {
      expect([c, rules(c)]).toEqual([c, ['e']])
    }
  })
})

describe('PDF.E2.P1 gate adversarial — [ACHADO LOW] A5: o escopo não segue um barril local — arquivo do DANFE que importa as portas por `./pdf` fica fora', () => {
  it.failing('quem importa `writeText` de um barril local e recebe `doc` por um tipo local devia ser da família (ou a cópia devia varrer a pasta do DANFE inteira)', () => {
    expect(isPdfFamilyFile("import { writeText } from './pdf'\nexport function quadro(doc: Doc) { doc.font('Courier'); doc.text('x') }")).toBe(true)
  })
})

describe('PDF.E2.P1 gate adversarial — [ACHADO LOW] A6: texto fora das portas por APIs do pdfkit que a lista não cita', () => {
  it.failing('`addContent` (fluxo cru), `formText`/`note`/`textAnnotation` (texto fora do WinAnsi da porta) e o monkeypatch do `addPage` (um `pageAdded` disfarçado) deviam ser barrados', () => {
    for (const c of ["doc.addContent('BT /F1 8 Tf (x) Tj ET')", "doc.formText('campo', 10, 10, 100, 20, { value: 'x' })", "doc.note(10, 10, 50, 50, 'x')",
      'const orig = doc.addPage.bind(doc); doc.addPage = (o) => { const r = orig(o); cabecalho(doc); return r }']) {
      expect([c, rules(c).length > 0]).toEqual([c, true])
    }
  })
})
