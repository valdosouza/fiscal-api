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

/**
 * O predicado da cerca da F2a: o spec `<arquivo>: <módulo>` de um import do setes-api é permitido? `fiscal-api/reading` e as peças puras
 * `fiscal-api/federal-id` (D-CJ2) e `fiscal-api/ibscbs-assessment` (D-IB129 — a regra da opção de apuração e o contrato da view, também
 * no teste DDL do setes-api) e `fiscal-api/merchandise-total` (D-NE215 — a fórmula do vNF que o ERP usa para cunhar) em qualquer arquivo; `fiscal-api/access` só no adaptador `@shared/access` (D-AU6). O barrel e os outros
 * subpaths, nunca.
 */
const f2aSpecAllowed = (s: string): boolean => s.endsWith(': fiscal-api/reading') || s.endsWith(': fiscal-api/federal-id')
  || s.endsWith(': fiscal-api/ibscbs-assessment') || s.endsWith(': fiscal-api/merchandise-total') || /(?:^|[\\/])src[\\/]shared[\\/]access[\\/]index\.ts: fiscal-api\/access$/.test(s)

/** O lado de ESCRITA do núcleo — nada disto pode sair pela superfície de leitura. */
const WRITE_SIDE = [
  'defineVoiceFamily', 'withInvoiceTx', 'assertInvoiceTx', 'recordVoiceOnce', 'recordKindOnce', 'reserveCancelRequest', 'releaseCancelRequest',
  'classifyAuthorityError', 'OUTCOME_KIND', 'unhandledOutcome', 'writeIssuer', 'deleteIssuer', 'uploadCertificate', 'clearCertificate',
  'deleteCertificate', 'storeCertificate', 'upsertIssuer', 'openIssuer', 'nextDpsNumber', 'acquireRefreshLease', 'signXml', 'httpsRequest',
  'authorityJson', 'createFiscalPool', 'erp',
  // FAMILIA.E5.P5 (D-NE255/D-NE257): o último número da NF-e é gerado pela família na transmissão — o ERP web não gera número
  'nextInvoiceNumber', 'lockNumberSequence', 'openNumberSequence', 'assertNumberSequenceDomainsEnforced',
]

describe('D-NE77 — a superfície de LEITURA `fiscal-api/reading`', () => {
  it('só re-exporta os módulos do contrato de leitura (vocabulário, projeção comum, leitor que mapeia, leitura por família, referência) — nada mais', () => {
    const sf = ts.createSourceFile('reading.ts', read(path.join(SRC, 'reading.ts')), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    // gates da A1 da F2a: lista EXPLÍCITA (`export { … }`/`export type { … }`) nos módulos que têm algo FORA da superfície
    const froms = sf.statements.map(s => (ts.isExportDeclaration(s) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier))
      ? `${s.exportClause ? (s.isTypeOnly ? 'type ' : '{} ') : '* '}${s.moduleSpecifier.text}` : `OUTRO: ${s.getText(sf).slice(0, 60)}`)
    // FAMILIA.E5.P3 (janela da NE-6 — D-NE158/D-NE161/D-NE170): + a leitura da NF-e, as faixas retiradas e a habilitação (as duas, lista explícita)
    expect(froms).toEqual(['* ./voice/kinds', '{} ./voice/reading', 'type ./voice/reading', '* ./voice/family-reader', '{} ./voice/families/service',
      'type ./voice/families/service', '* ./voice/families', '* ./voice/families/merchandise', '* ./ref/invoice-ref',
      '{} ./numbering/withdrawn-ranges', 'type ./numbering/withdrawn-ranges', '{} ./establishment/issuer-view', 'type ./establishment/issuer-view'])
    // e esses módulos não puxam o lado de escrita por dentro (só a peça do conjunto imutável fora deles)
    const imports = (rel: string) => [...read(path.join(SRC, rel)).matchAll(/from '([^']+)'/g)].map(m => m[1])
    const ALLOWED: Record<string, string[]> = {
      'voice/kinds.ts': ['../util/readonly-set'],
      'voice/reading.ts': ['./kinds', '../ref/invoice-ref'],
      // D-NE66 (b), F2a: o leitor que já MAPEIA usa o SQL cru INTERNO (`view-query`, fora da superfície e do barrel)
      // FAMILIA.E5.P3 (D-NE158): o leitor não importa mais o catálogo (a conferência perdeu o valor padrão) — a cerca segura a volta dele
      'voice/family-reader.ts': ['./reading', './view-query', '../ref/invoice-ref'],
      'voice/view-query.ts': ['./reading', '../ref/invoice-ref'],
      'voice/families/service.ts': ['../kinds', '../reading', '../../util/readonly-set'],
      'voice/families/index.ts': ['../reading', './service', './merchandise'],
      'voice/families/merchandise.ts': ['../reading'],
      'ref/invoice-ref.ts': [],
      // FAMILIA.E5.P3: as duas peças de leitura da numeração e da habilitação — só o catálogo dos modelos e TIPOS da voz
      'numbering/withdrawn-ranges.ts': ['../establishment/issuer-models', '../voice/kinds', '../voice/family-reader'],
      'establishment/issuer-view.ts': ['./issuer-models', '../voice/kinds', '../voice/family-reader'],
      'establishment/issuer-models.ts': ['../ref/invoice-ref'],
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
      'readFamilyTransmissions', 'readFamilyTransmissionsMany', 'reconfirmationVerdict',
      // FAMILIA.E5.P3 (janela da NE-6): a leitura da NF-e, as faixas retiradas e a habilitação (o número do 55 nasce na nfe-api — D-NE257)
      'MERCHANDISE_VOICE_READING', 'readWithdrawnRanges', 'assertWithdrawnRangesViewReadable', 'readIssuerView', 'assertIssuerViewReadable']) {
      expect([n, n in reading]).toEqual([n, true])
    }
    // D-NE66 (b) (executada na F2a): o SQL cru da view deixou de ser caminho PÚBLICO — nem a superfície nem o barrel o exportam
    for (const n of ['familyViewQuery', 'familyViewQueryMany', 'familyViewQueryLives']) expect([n, n in reading, n in barrel]).toEqual([n, false, false])
  })
  it('gates da A1 da F2a: a superfície = o que os módulos exportam MENOS a lista de FORA (SELECT cru — F2A1-04; o booleano da prova — D-F118; a guarda interna) — export NOVO num módulo quebra esta cerca até alguém decidir se entra; os de fora seguem no barrel', async () => {
    // FAMILIA.E5.P3: + o SQL cru das duas peças novas (F2A1-04; molde D-NE66 (b)) — fora da superfície, DENTRO do barrel
    const OUT = ['familyViewSelect', 'transmissionViewSelect', 'reconfirmationProven', 'assertOneInvoiceLife',
      'withdrawnRangesSelect', 'withdrawnRangesQuery', 'issuerViewSelect', 'issuerViewQuery']
    const mods = await Promise.all(['../voice/kinds', '../voice/reading', '../voice/family-reader', '../voice/families/service', '../voice/families',
      '../voice/families/merchandise', '../ref/invoice-ref', '../numbering/withdrawn-ranges', '../establishment/issuer-view']
      .map(m => import(m)))
    const expected = [...new Set(mods.flatMap(m => Object.keys(m)))].filter(n => !OUT.includes(n)).sort()
    expect(Object.keys(reading).sort()).toEqual(expected)
    for (const n of OUT) expect([n, n in reading, n in barrel]).toEqual([n, false, true])
  })
  it('o package.json publica o subpath (`exports` + `typesVersions` para a resolução antiga do TypeScript) e o barrel; nada de caminho interno', () => {
    const pkg = JSON.parse(read(path.resolve(SRC, '..', 'package.json')))
    // D-CJ2 (frente do CNPJ alfanumérico, 2026-10-15): o 2º subpath é a inscrição federal — peça PURA (sem banco), mesma forma de publicar
    // D-NE121 (NE-1b, 2026-10-17): o 3º subpath é a base de PDF — fora do índice principal e do `reading` (cerca `pdf-cerca.test.ts`)
    // D-AU6 (costura A1 da auth-api, 2026-10-31): o 4º subpath é o LEITOR do veredito de acesso `fiscal-api/access` (pilha de views — nada de
    // escrita; vira `auth-api/access` na A2)
    // D-IB128/D-IB129 (fase IBS/CBS, 2026-11-18): o 5º subpath é a opção de apuração do IBS/CBS — peça PURA (regra de leitura + contrato da view)
    // D-NE215 (NE-4, 2026-11-22 — FAMILIA.E5.P4.T2): o 6º subpath é a fórmula do vNF — peça PURA, lida pelo ERP (cunha) e pela nfe-api (confere)
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './access', './federal-id', './ibscbs-assessment', './merchandise-total', './package.json', './pdf', './reading'])
    expect(pkg.exports['./merchandise-total']).toEqual({ types: './dist/merchandise-total.d.ts', default: './dist/merchandise-total.js' })
    expect(pkg.typesVersions['*']['merchandise-total']).toEqual(['dist/merchandise-total.d.ts'])
    expect(pkg.exports['./ibscbs-assessment']).toEqual({ types: './dist/ibscbs-assessment.d.ts', default: './dist/ibscbs-assessment.js' })
    expect(pkg.typesVersions['*']['ibscbs-assessment']).toEqual(['dist/ibscbs-assessment.d.ts'])
    expect(pkg.exports['./access']).toEqual({ types: './dist/access.d.ts', default: './dist/access.js' })
    expect(pkg.typesVersions['*'].access).toEqual(['dist/access.d.ts'])
    expect(pkg.exports['./reading']).toEqual({ types: './dist/reading.d.ts', default: './dist/reading.js' })
    expect(pkg.typesVersions['*'].reading).toEqual(['dist/reading.d.ts'])
    expect(pkg.exports['./federal-id']).toEqual({ types: './dist/federal-id.d.ts', default: './dist/federal-id.js' })
    expect(pkg.typesVersions['*']['federal-id']).toEqual(['dist/federal-id.d.ts'])
    expect(pkg.exports['./pdf']).toEqual({ types: './dist/pdf.d.ts', default: './dist/pdf.js' })
    expect(pkg.typesVersions['*'].pdf).toEqual(['dist/pdf.d.ts'])
    // D-NE124 (= Q-NE124 (b), revê a D-NE121): UM motor de desenho em todo ambiente — pdfkit é dependência comum com versão EXATA (a base
    // depende de internos dele — `pdf/state.ts`), como a lib de símbolos (D-NE119); nada de peer
    expect(pkg.dependencies.pdfkit).toBe('0.20.2')
    expect(pkg.peerDependencies?.pdfkit).toBeUndefined()
    expect(pkg.peerDependenciesMeta?.pdfkit).toBeUndefined()
    expect(pkg.devDependencies?.pdfkit).toBeUndefined()
    expect(pkg.dependencies['bwip-js']).toBe('4.11.4')
    // re-gate N7: a superfície fala no namespace `PDFKit` — os tipos vão JUNTO (dependência exata) e o `.d.ts` publicado os referencia
    expect(pkg.dependencies['@types/pdfkit']).toBe('0.17.6')
    expect(pkg.devDependencies?.['@types/pdfkit']).toBeUndefined()
    // por linha com OU sem \r — num checkout do Windows (core.autocrlf) o fonte vem em CRLF (achado na janela D-NE123)
    expect(read(path.join(SRC, 'pdf.ts')).split(/\r?\n/)[0]).toBe('/// <reference types="pdfkit" preserve="true" />')
  })
  it('o predicado da cerca da F2a, com specs sintéticos: reading, federal-id e ibscbs-assessment em qualquer arquivo; access só no adaptador', () => {
    const ok = ['src/x/y.ts: fiscal-api/reading', 'src/x/y.ts: fiscal-api/federal-id', 'src/shared/ibscbs-assessment/index.ts: fiscal-api/ibscbs-assessment',
      'src/__tests__/ibscbs-assessment-view-ddl.test.ts: fiscal-api/ibscbs-assessment', 'src/shared/access/index.ts: fiscal-api/access',
      'src/shared/merchandise-total/index.ts: fiscal-api/merchandise-total',
      'src\\shared\\access\\index.ts: fiscal-api/access']
    const refused = ['src/x/y.ts: fiscal-api', 'src/x/y.ts: fiscal-api/pdf', 'src/x/y.ts: fiscal-api/access', 'src/x/y.ts: fiscal-api/ibscbs-assessment/x', 'src/x/y.ts: fiscal-api/merchandise-total/merchandise-total',
      'src/x/y.ts: fiscal-api/dist/ibscbs-assessment', 'src/shared/ibscbs-assessment/index.ts: fiscal-api',
      // gate adversarial de 2026-11-18 (L5): o adaptador é o `src/shared/access/index.ts`, não qualquer `…shared/access/index.ts`
      'src/modules/notshared/access/index.ts: fiscal-api/access', 'src/x/myshared/access/index.ts: fiscal-api/access']
    for (const s of ok) expect([s, f2aSpecAllowed(s)]).toEqual([s, true])
    for (const s of refused) expect([s, f2aSpecAllowed(s)]).toEqual([s, false])
  })
  it('CERCA da F2a: o setes-api só importa `fiscal-api/reading`, `fiscal-api/federal-id` (D-CJ2 — peça pura), `fiscal-api/ibscbs-assessment` (D-IB129 — peça pura) e, só no adaptador, `fiscal-api/access` (D-AU6)', () => {
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
    // D-AU6: `fiscal-api/access` só no ADAPTADOR do setes-api (`@shared/access` — um leitor do veredito lá)
    expect(specs.filter(s => !f2aSpecAllowed(s))).toEqual([])
  })
})
