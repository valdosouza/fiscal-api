/// <reference types="jest" />
// NE-1b (D-NE121 — as duas cercas do guardião, prompt da NF-e §14.4): (1) a base de PDF é CEGA ao fisco — `src/pdf/**` só importa dentro de
// `src/pdf/` e as duas libs de desenho; (2) quem não desenha PDF não a carrega — nem o índice principal, nem `reading`, nem `federal-id` alcançam
// `pdf/`; `bwip-js` só pela porta `barcode/lib.ts`; `pdfkit` só dentro de `src/pdf/`.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const SRC = path.resolve(__dirname, '..')
const PDF_DIR = path.join(SRC, 'pdf')
const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, '/')

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? (d.name === '__tests__' ? [] : walk(path.join(dir, d.name))) : /\.ts$/.test(d.name) && !/\.test\.ts$/.test(d.name) ? [path.join(dir, d.name)] : [])
}

/** Todo especificador de módulo do arquivo: import/export (inclusive `import type`), require(), import(). */
function specifiers(file: string): string[] {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text)
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) out.push(n.moduleReference.expression.text)
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))
      && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) out.push(n.arguments[0].text)
    else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) out.push(n.argument.literal.text)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

function resolveRelative(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(from), spec)
  for (const c of [`${base}.ts`, path.join(base, 'index.ts')]) if (fs.existsSync(c)) return c
  return null
}

describe('NE-1b — cercas da base de PDF', () => {
  const ALL = walk(SRC)
  const PDF_FILES = ALL.filter(f => f.startsWith(PDF_DIR + path.sep) || f === path.join(SRC, 'pdf.ts'))

  it('a base é cega ao fisco: `pdf.ts` e `src/pdf/**` só importam dentro de `src/pdf/` + `pdfkit` + `bwip-js`', () => {
    expect(PDF_FILES.length).toBeGreaterThanOrEqual(7)
    const off: string[] = []
    for (const f of PDF_FILES) {
      for (const s of specifiers(f)) {
        if (s === 'pdfkit' || s === 'bwip-js') continue
        const r = resolveRelative(f, s)
        if (!r || !(r.startsWith(PDF_DIR + path.sep))) off.push(`${rel(f)} → ${s}`)
      }
    }
    expect(off).toEqual([])
  })

  it('`bwip-js` entra por UMA porta (`pdf/barcode/lib.ts`) e `pdfkit` só dentro de `src/pdf/`', () => {
    const bwip = ALL.filter(f => specifiers(f).includes('bwip-js')).map(rel)
    expect(bwip).toEqual(['pdf/barcode/lib.ts'])
    const pdfkit = ALL.filter(f => specifiers(f).includes('pdfkit')).map(rel)
    expect(pdfkit.length).toBeGreaterThan(0)
    expect(pdfkit.filter(f => !f.startsWith('pdf/'))).toEqual([])
  })

  it('quem não desenha PDF não carrega a base: o grafo de `index.ts`, `reading.ts`, `federal-id.ts`, `ibscbs-assessment.ts` e `merchandise-total.ts` nunca chega em `pdf.ts`/`pdf/` nem nas libs', () => {
    for (const entry of ['index.ts', 'reading.ts', 'federal-id.ts', 'ibscbs-assessment.ts', 'merchandise-total.ts']) {
      const seen = new Set<string>()
      const stack = [path.join(SRC, entry)]
      const external = new Set<string>()
      while (stack.length) {
        const f = stack.pop()!
        if (seen.has(f)) continue
        seen.add(f)
        for (const s of specifiers(f)) {
          const r = resolveRelative(f, s)
          if (r) stack.push(r)
          else external.add(s)
        }
      }
      const reached = [...seen].map(rel).filter(f => f === 'pdf.ts' || f.startsWith('pdf/'))
      expect([entry, reached, ['pdfkit', 'bwip-js'].filter(x => external.has(x))]).toEqual([entry, [], []])
    }
  })

  it('a superfície `fiscal-api/pdf` re-exporta as peças de desenho — a porta da lib (`barcode/lib`) fica de fora', () => {
    const exported = specifiers(path.join(SRC, 'pdf.ts'))
    expect(exported).toEqual(['./pdf/units', './pdf/fonts', './pdf/pdf-writer', './pdf/draw', './pdf/barcode/code128', './pdf/barcode/qr'])
  })
})
