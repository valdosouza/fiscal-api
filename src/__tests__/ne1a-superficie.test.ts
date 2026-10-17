/// <reference types="jest" />
// D-NE77 (= Q-NE77 (a), gates da parte 2 da NE-1a — Valdo 2026-10-12): a SUPERFÍCIE DE LEITURA `fiscal-api/reading` é a fronteira do contrato
// publicado para a F2a (o setes-api lendo a voz) — fato de COMPILAÇÃO, não só o GRANT em execução.
import { setesApiPath, relWorkspace } from './setes-api-dir'   // D-F117: SETES_API_DIR, falha alto
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
  it('só re-exporta os módulos do contrato de leitura (vocabulário, projeção comum, leitor que mapeia, leitura por família, referência) — nada mais', () => {
    const sf = ts.createSourceFile('reading.ts', read(path.join(SRC, 'reading.ts')), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    // gates da A1 da F2a: lista EXPLÍCITA (`export { … }`/`export type { … }`) nos módulos que têm algo FORA da superfície
    const froms = sf.statements.map(s => (ts.isExportDeclaration(s) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier))
      ? `${s.exportClause ? (s.isTypeOnly ? 'type ' : '{} ') : '* '}${s.moduleSpecifier.text}` : `OUTRO: ${s.getText(sf).slice(0, 60)}`)
    expect(froms).toEqual(['* ./voice/kinds', '{} ./voice/reading', 'type ./voice/reading', '* ./voice/family-reader', '{} ./voice/families/service',
      'type ./voice/families/service', '* ./voice/families', '* ./ref/invoice-ref'])
    // e esses módulos não puxam o lado de escrita por dentro (só a peça do conjunto imutável fora deles)
    const imports = (rel: string) => [...read(path.join(SRC, rel)).matchAll(/from '([^']+)'/g)].map(m => m[1])
    const ALLOWED: Record<string, string[]> = {
      'voice/kinds.ts': ['../util/readonly-set'],
      'voice/reading.ts': ['./kinds', '../ref/invoice-ref'],
      // D-NE66 (b), F2a: o leitor que já MAPEIA usa o SQL cru INTERNO (`view-query`, fora da superfície e do barrel)
      'voice/family-reader.ts': ['./reading', './view-query', './families', '../ref/invoice-ref'],
      'voice/view-query.ts': ['./reading', '../ref/invoice-ref'],
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
    for (const n of ['VOICE_READINGS', 'SERVICE_VOICE_READING', 'isLiveTransmission', 'isFiscalRecord', 'currentOf', 'localCancelPending', 'invoiceRef', 'KIND_CLASS',
      'readFamilyTransmissions', 'readFamilyTransmissionsMany', 'reconfirmationVerdict']) {
      expect([n, n in reading]).toEqual([n, true])
    }
    // D-NE66 (b) (executada na F2a): o SQL cru da view deixou de ser caminho PÚBLICO — nem a superfície nem o barrel o exportam
    for (const n of ['familyViewQuery', 'familyViewQueryMany', 'familyViewQueryLives']) expect([n, n in reading, n in barrel]).toEqual([n, false, false])
  })
  it('gates da A1 da F2a: a superfície = o que os módulos exportam MENOS a lista de FORA (SELECT cru — F2A1-04; o booleano da prova — D-F118; a guarda interna) — export NOVO num módulo quebra esta cerca até alguém decidir se entra; os de fora seguem no barrel', async () => {
    const OUT = ['familyViewSelect', 'transmissionViewSelect', 'reconfirmationProven', 'assertOneInvoiceLife']
    const mods = await Promise.all(['../voice/kinds', '../voice/reading', '../voice/family-reader', '../voice/families/service', '../voice/families', '../ref/invoice-ref']
      .map(m => import(m)))
    const expected = [...new Set(mods.flatMap(m => Object.keys(m)))].filter(n => !OUT.includes(n)).sort()
    expect(Object.keys(reading).sort()).toEqual(expected)
    for (const n of OUT) expect([n, n in reading, n in barrel]).toEqual([n, false, true])
  })
  it('o package.json publica o subpath (`exports` + `typesVersions` para a resolução antiga do TypeScript) e o barrel; nada de caminho interno', () => {
    const pkg = JSON.parse(read(path.resolve(SRC, '..', 'package.json')))
    // D-CJ2 (frente do CNPJ alfanumérico, 2026-10-15): o 2º subpath é a inscrição federal — peça PURA (sem banco), mesma forma de publicar
    // D-NE121 (NE-1b, 2026-10-17): o 3º subpath é a base de PDF — fora do índice principal e do `reading` (cerca `pdf-cerca.test.ts`)
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './federal-id', './package.json', './pdf', './reading'])
    expect(pkg.exports['./reading']).toEqual({ types: './dist/reading.d.ts', default: './dist/reading.js' })
    expect(pkg.typesVersions['*'].reading).toEqual(['dist/reading.d.ts'])
    expect(pkg.exports['./federal-id']).toEqual({ types: './dist/federal-id.d.ts', default: './dist/federal-id.js' })
    expect(pkg.typesVersions['*']['federal-id']).toEqual(['dist/federal-id.d.ts'])
    expect(pkg.exports['./pdf']).toEqual({ types: './dist/pdf.d.ts', default: './dist/pdf.js' })
    expect(pkg.typesVersions['*'].pdf).toEqual(['dist/pdf.d.ts'])
    // o pdfkit é peer OPCIONAL (o setes-api não instala) e a lib de símbolos tem versão EXATA (D-NE119)
    expect(pkg.peerDependencies.pdfkit).toBeDefined()
    expect(pkg.peerDependenciesMeta?.pdfkit?.optional).toBe(true)
    expect(pkg.dependencies['bwip-js']).toBe('4.11.4')
  })
  it('CERCA da F2a: o setes-api só importa `fiscal-api/reading` e `fiscal-api/federal-id` (D-CJ2 — peça pura, nada do lado de escrita)', () => {
    const root = setesApiPath('src')                                        // D-F117: a worktree da F2a (ou a árvore viva) — tem de existir
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
        if (spec && /^fiscal-api(?:\/|$)/.test(spec)) specs.push(`${relWorkspace(f)}: ${spec}`)
        ts.forEachChild(n, visit)
      }
      visit(sf)
    }
    expect(specs.filter(s => !s.endsWith(': fiscal-api/reading') && !s.endsWith(': fiscal-api/federal-id'))).toEqual([])
  })
})
