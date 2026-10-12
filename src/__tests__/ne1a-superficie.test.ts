/// <reference types="jest" />
// D-NE77 (= Q-NE77 (a), gates da parte 2 da NE-1a — Valdo 2026-10-12): a SUPERFÍCIE DE LEITURA `fiscal-api/reading` é a fronteira do contrato
// publicado para a F2a (o setes-api lendo a voz) — fato de COMPILAÇÃO, não só o GRANT em execução.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import * as reading from '../reading'
import * as barrel from '../index'

const SRC = path.resolve(__dirname, '..')
const WORKSPACE = path.resolve(SRC, '..', '..')
const read = (f: string) => fs.readFileSync(f, 'utf8')

/** O lado de ESCRITA do núcleo — nada disto pode sair pela superfície de leitura. */
const WRITE_SIDE = [
  'defineVoiceFamily', 'withInvoiceTx', 'assertInvoiceTx', 'recordVoiceOnce', 'recordKindOnce', 'reserveCancelRequest', 'releaseCancelRequest',
  'classifyAuthorityError', 'OUTCOME_KIND', 'unhandledOutcome', 'writeIssuer', 'deleteIssuer', 'uploadCertificate', 'clearCertificate',
  'deleteCertificate', 'storeCertificate', 'upsertIssuer', 'openIssuer', 'nextDpsNumber', 'acquireRefreshLease', 'signXml', 'httpsRequest',
  'authorityJson', 'createFiscalPool', 'erp',
]

describe('D-NE77 — a superfície de LEITURA `fiscal-api/reading`', () => {
  it('só re-exporta os módulos do contrato de leitura (vocabulário, projeção comum, leitura por família, referência) — nada mais', () => {
    const sf = ts.createSourceFile('reading.ts', read(path.join(SRC, 'reading.ts')), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const froms = sf.statements.map(s => (ts.isExportDeclaration(s) && !s.exportClause && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) ? s.moduleSpecifier.text : `OUTRO: ${s.getText(sf).slice(0, 60)}`)
    expect(froms).toEqual(['./voice/kinds', './voice/reading', './voice/families/service', './voice/families', './ref/invoice-ref'])
    // e esses módulos não puxam o lado de escrita por dentro (só a peça do conjunto imutável fora deles)
    const imports = (rel: string) => [...read(path.join(SRC, rel)).matchAll(/from '([^']+)'/g)].map(m => m[1])
    const ALLOWED: Record<string, string[]> = {
      'voice/kinds.ts': ['../util/readonly-set'],
      'voice/reading.ts': ['./kinds', '../ref/invoice-ref'],
      'voice/families/service.ts': ['../kinds', '../reading', '../../util/readonly-set'],
      'voice/families/index.ts': ['../reading', './service'],
      'ref/invoice-ref.ts': [],
    }
    for (const [rel, ok] of Object.entries(ALLOWED)) expect([rel, imports(rel).filter(i => !ok.includes(i))]).toEqual([rel, []])
  })
  it('nenhum nome do lado de ESCRITA sai pela superfície de leitura; o barrel completo (das famílias) segue com tudo', () => {
    const exported = Object.keys(reading)
    expect(exported.length).toBeGreaterThan(20)
    expect(WRITE_SIDE.filter(n => exported.includes(n))).toEqual([])
    expect(WRITE_SIDE.filter(n => !(n in barrel))).toEqual([])
    // o contrato de leitura que a F2a usa está lá
    for (const n of ['VOICE_READINGS', 'SERVICE_VOICE_READING', 'isLiveTransmission', 'isFiscalRecord', 'currentOf', 'localCancelPending', 'invoiceRef', 'KIND_CLASS']) {
      expect([n, n in reading]).toEqual([n, true])
    }
  })
  it('o package.json publica o subpath (`exports` + `typesVersions` para a resolução antiga do TypeScript) e o barrel; nada de caminho interno', () => {
    const pkg = JSON.parse(read(path.resolve(SRC, '..', 'package.json')))
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './package.json', './reading'])
    expect(pkg.exports['./reading']).toEqual({ types: './dist/reading.d.ts', default: './dist/reading.js' })
    expect(pkg.typesVersions['*'].reading).toEqual(['dist/reading.d.ts'])
  })
  it('CERCA da F2a: o setes-api só importa `fiscal-api/reading` (hoje não importa nada do núcleo — a cerca vale a partir da F2a)', () => {
    const root = path.join(WORKSPACE, 'setes-api', 'src')
    if (!fs.existsSync(root)) return
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
      d.isDirectory() ? (d.name === 'node_modules' ? [] : walk(path.join(dir, d.name))) : /\.(?:ts|js)$/.test(d.name) ? [path.join(dir, d.name)] : [])
    const specs: string[] = []
    for (const f of walk(root)) {
      const code = read(f)
      if (!code.includes('fiscal-api')) continue
      const sf = ts.createSourceFile(f, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const visit = (n: ts.Node): void => {
        const spec = (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text
          : ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))
            && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) ? n.arguments[0].text : null
        if (spec && /^fiscal-api(?:\/|$)/.test(spec)) specs.push(`${path.relative(WORKSPACE, f).replace(/\\/g, '/')}: ${spec}`)
        ts.forEachChild(n, visit)
      }
      visit(sf)
    }
    expect(specs.filter(s => !s.endsWith(': fiscal-api/reading'))).toEqual([])
  })
})
