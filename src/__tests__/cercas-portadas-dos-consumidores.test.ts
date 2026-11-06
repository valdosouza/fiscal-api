/// <reference types="jest" />
// CERCAS PORTADAS DOS CONSUMIDORES (D-F228, Valdo 2026-11-06 — "Cada um no seu"; `prompt_apis_fiscais_isoladas.md` §23).
//
// Desde a D-F221…D-F225 os consumidores (nfse-api, nfe-api, setes-api) usam o núcleo SÓ pelo pacote versionado em `vendor/`. As
// conferências do CÓDIGO-FONTE do núcleo que moravam nos testes deles liam a PASTA IRMÃ (`<workspace>/fiscal-api/src`) — quando o
// núcleo anda e o `vendor/` não, elas provavam outro artefato. A garantia de "o fonte do núcleo é assim" passa a morar AQUI, na suíte que
// roda na tag; cada bloco diz de onde veio. O que é de EXECUÇÃO (o `dist` que roda, o `mysql2` do pool) continua nos consumidores, lido
// do pacote INSTALADO. Puro: sem banco, sem socket, sem fisco; só lê `src/` deste repositório.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const SRC_ROOT = path.resolve(__dirname, '..')
const CORE_ROOT = path.resolve(SRC_ROOT, '..')
const read = (f: string) => fs.readFileSync(f, 'utf8')
const rel = (f: string) => path.relative(CORE_ROOT, f).replace(/\\/g, '/')
/** `.ts` de uma pasta, recursivo, sem `__tests__` nem `node_modules` (o código do núcleo, não os testes). */
const walkTs = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? (d.name === '__tests__' || d.name === 'node_modules' ? [] : walkTs(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []))
const sqlUnder = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir).filter(n => n.endsWith('.sql')).map(n => path.join(dir, n)))
const CORE_TS = () => walkTs(SRC_ROOT)

// ===========================================================================
// A — D-F102/D-F105: nenhum SQL do núcleo grava S na voz da NFS-e
//     (veio de `nfse-api/src/__tests__/voice-kind-fence.ts` — o núcleo estava no `voiceFenceScope` com `sqlOnly`)
// ===========================================================================

const VOICE_TABLE = 'invoice_service_transmission_event'
/** O 'S' em qualquer aspa do MySQL (simples; duplas sem ANSI_QUOTES) — gate R22, R22-07. */
const S_LIT = String.raw`(?:'S'|"S")`
/** INSERT/REPLACE com ou sem INTO e com os modificadores do MySQL — R22-07. */
const INSERT_HEAD = String.raw`\b(?:INSERT|REPLACE)\b(?:\s+(?:LOW_PRIORITY|HIGH_PRIORITY|DELAYED|IGNORE))*(?:\s+INTO)?\s`
/** SQL de ESCRITA na voz DA NFS-e que grava S (D-F105: só a tabela da família de serviço) — o statement inteiro, em várias linhas. */
function sqlWritesS(statement: string): boolean {
  const s = statement.replace(/\s+/g, ' ')
  if (new RegExp(String.raw`${INSERT_HEAD}[^;]*${VOICE_TABLE}\b[^;]*${S_LIT}`, 'i').test(s)) return true
  return new RegExp(String.raw`\bUPDATE\b[^;]*${VOICE_TABLE}\b[^;]*\b(?:\w+\.)?` + '`?kind`?' + String.raw`\s*=\s*(?:(?:CASE\b|IF\s*\()[^;]*?)?${S_LIT}`, 'i').test(s)
}
function stringConsts(sf: ts.SourceFile): Map<string, string> {
  const m = new Map<string, string>()
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
      && (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer))) m.set(n.name.text, n.initializer.text)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return m
}
/** Texto de um literal/template; `${X}` vira o valor de uma CONSTANTE string do mesmo arquivo quando houver (R22-06), senão `?`. */
function sqlTextOf(n: ts.Node, consts: Map<string, string>): string | null {
  if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) return n.text
  if (!ts.isTemplateExpression(n)) return null
  return [n.head.text, ...n.templateSpans.map((sp, i) => ((ts.isIdentifier(sp.expression) && consts.get(sp.expression.text)) || '?') + n.templateSpans[i].literal.text)].join('')
}
/** No NÚCLEO só o SQL conta (D-F105: o `kind: 'S'` em TypeScript daqui é da NF-e). AST — comentários fora pelo compilador. */
function tsSqlProducesS(code: string): boolean {
  const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const consts = stringConsts(sf)
  let hit = false
  const visit = (n: ts.Node): void => {
    if (hit) return
    const sql = sqlTextOf(n, consts)
    if (sql && sqlWritesS(sql)) hit = true
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hit
}
const sqlFileProducesS = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').split(';').some(sqlWritesS)

describe('A — D-F102/D-F105 no núcleo: nenhum SQL grava S na voz da NFS-e (portado da cerca da nfse-api — D-F228)', () => {
  it('a cerca não é cega: pega INSERT/UPDATE com S na tabela da NFS-e — em várias linhas, com schema por substituição e com a tabela por CONSTANTE; não pega o `kind: \'S\'` de TypeScript (é da NF-e)', () => {
    expect(tsSqlProducesS("await q.query(`INSERT INTO\n  tb_invoice_service_transmission_event\n  (kind, source)\n  VALUES ('S', 'P')`)")).toBe(true)
    expect(tsSqlProducesS("await q.query(`INSERT INTO \\`${db}\\`.tb_invoice_service_transmission_event (kind, source) VALUES ('S', 'P')`)")).toBe(true)
    expect(tsSqlProducesS("await q.query(`UPDATE \\`${db}\\`.tb_invoice_service_transmission_event SET kind = 'S' WHERE attempt = ?`, [a])")).toBe(true)
    expect(tsSqlProducesS("const VOICE = 'tb_invoice_service_transmission_event'\nawait q.query(`INSERT INTO ${VOICE} (kind, source) VALUES ('S', 'P')`)")).toBe(true)
    expect(tsSqlProducesS("const voice = { kind: 'S', source: 'P' }")).toBe(false)
    expect(sqlFileProducesS("-- comentário: INSERT INTO tb_invoice_service_transmission_event VALUES ('S')\nSELECT 1;")).toBe(false)
    expect(sqlFileProducesS("INSERT INTO tb_invoice_service_transmission_event (kind)\nVALUES ('S');")).toBe(true)
  })
  it('o código REAL do núcleo (src .ts e migrations .sql) não tem produtor de S da NFS-e', () => {
    const files = [...CORE_TS(), ...sqlUnder(path.join(SRC_ROOT, 'migrations', 'sql'))]
    expect(files.length).toBeGreaterThan(10)
    expect(files.filter(f => (f.endsWith('.sql') ? sqlFileProducesS(read(f)) : tsSqlProducesS(read(f)))).map(rel)).toEqual([])
  })
})

// ===========================================================================
// B — as políticas do núcleo gravam K/N LITERAIS pelo escritor recebido (veio do r21 da nfse-api, ATAQUE 2)
// ===========================================================================

describe('B — `voice/policy.ts`: K e N literais, dh NULL, pelo escritor recebido (portado do r21 da nfse-api — D-F228)', () => {
  it('nenhuma outra escrita de kind na política', () => {
    const policy = read(path.join(SRC_ROOT, 'voice', 'policy.ts'))
    expect(policy).toMatch(/return write\(itx, attempt, userId, \{ kind: 'K', source: 'P', dh: null, message: CANCEL_REQUEST_IN_FLIGHT \}\)/)
    expect(policy).toMatch(/await write\(itx, attempt, userId, \{ kind: 'N', source: 'P', dh: null, message: message\.slice\(0, 255\) \}\)/)
    expect(policy.match(/\bkind: '[A-Z]'/g)).toEqual(["kind: 'K'", "kind: 'N'"])
  })
})

// ===========================================================================
// C — o aviso da D-F102 no vocabulário (veio do r21 da nfse-api, LOW R21-03)
// ===========================================================================

describe('C — `voice/kinds.ts`: o aviso da D-F102 nomeia os DOIS portões da saída (portado do r21 da nfse-api — D-F228)', () => {
  it('o bloco de comentário imediatamente acima de `export type TransmissionEventKind`', () => {
    const c = read(path.join(SRC_ROOT, 'voice', 'kinds.ts')).replace(/\r\n/g, '\n')
    const i = c.indexOf('export type TransmissionEventKind')
    expect(i).toBeGreaterThan(0)
    const near = c.slice(Math.max(0, c.lastIndexOf('\n\n', i)), i)
    expect(near).toMatch(/D-F102/)
    expect(near).toMatch(/recordInterruptedFailure|reconcileInterrupted|sob a trava/)
  })
})

// ===========================================================================
// D — o escritor GENÉRICO da voz (`voice/event-table.ts`) e os casts de `kind` (vieram do r22 e do ne1a da nfse-api)
// ===========================================================================

describe('D — o escritor genérico da voz no núcleo (portado do r22/ne1a da nfse-api — D-F228)', () => {
  const tableFile = path.join(SRC_ROOT, 'voice', 'event-table.ts')
  it('`VoiceFamily<K>.insertTransmissionEvent` é PROPRIEDADE-FUNÇÃO (nunca método — bivariante) de `(InvoiceTx, …, VoiceEventInput<K>)`', () => {
    const sf = ts.createSourceFile(tableFile, read(tableFile), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const fam = sf.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === 'VoiceFamily')!
    expect(fam).toBeDefined()
    const members = fam.members.filter(m => m.name?.getText(sf) === 'insertTransmissionEvent')
    expect(members.map(m => ts.SyntaxKind[m.kind])).toEqual(['PropertySignature'])
    const fnType = (members[0] as ts.PropertySignature).type!
    expect(ts.isFunctionTypeNode(fnType)).toBe(true)
    const ps = (fnType as ts.FunctionTypeNode).parameters
    expect([ps[0].type?.getText(sf), ps[ps.length - 1].type?.getText(sf)]).toEqual(['InvoiceTx', 'VoiceEventInput<K>'])
  })
  it('escreve pela tabela do DESCRITOR (`INSERT INTO ${table}`), nunca pelo literal da tabela da NFS-e', () => {
    const core = read(tableFile)
    expect(core).toMatch(/INSERT INTO \$\{table\}/)
    expect(core).not.toMatch(/tb_invoice_service_transmission_event/)
  })
  it('D-NE12: nenhum `terminal = 0` literal (nem `VALUES (?, ?, 0,`) — escritor (MAX+1) e os dois leitores de idempotência pelo terminal da REFERÊNCIA', () => {
    const LIT = /\bterminal\s*=\s*0\b|VALUES \(\?, \?, 0,/g
    const code = read(tableFile).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    expect(code.match(LIT) ?? []).toEqual([])
    expect((code.match(/\bterminal = \?/g) ?? []).length).toBe(3)
  })
  it('D-F106: NENHUM cast toca a escrita no núcleo — nada dentro de chamada ao escritor, nem tipo da voz, nem no valor de `kind`', () => {
    const kindCasts = (code: string): string[] => {
      const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const out: string[] = []
      const inWriter = (n: ts.Node): boolean => { for (let p = n.parent; p; p = p.parent) if (ts.isCallExpression(p) && /insertTransmissionEvent$/.test(p.expression.getText(sf))) return true; return false }
      const visit = (n: ts.Node): void => {
        if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) {
          const t = n.type.getText(sf)
          const isKindValue = ts.isPropertyAssignment(n.parent) && n.parent.name.getText(sf) === 'kind'
          if (inWriter(n) || /ServiceVoiceWriteKind|TransmissionEventInput|TransmissionEventKind|TransmissionEventRow/.test(t) || isKindValue) out.push(`${t} @ ${n.getText(sf).slice(0, 60)}`)
        }
        ts.forEachChild(n, visit)
      }
      visit(sf)
      return out
    }
    expect(kindCasts("insertTransmissionEvent(itx, 1, null, { kind: 'S' as 'A', source: 'P' })").length).toBeGreaterThan(0)   // não é cega
    const files = CORE_TS()
    expect(files.length).toBeGreaterThan(20)
    expect(files.flatMap(f => kindCasts(read(f)).map(h => `${rel(f)}: ${h}`))).toEqual([])
  })
})

// ===========================================================================
// E — a leitura publicada da família de serviço decide o registro pelo FATO (veio do `ne1a-registro.test.ts` da nfse-api, D-NE68 (b))
// ===========================================================================

describe('E — `voice/families/service.ts`: o registro pelo FATO, nunca pela chave (portado da nfse-api — D-F228)', () => {
  it('sem `!!t.accessKey`; a regra exportada lê `authorityRecordedOf`', () => {
    const core = read(path.join(SRC_ROOT, 'voice', 'families', 'service.ts')).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    expect(core).not.toMatch(/!!t\.accessKey/)
    expect(core).toMatch(/lifeList\.some\(t => authorityRecordedOf\(t\)\)/)
  })
})

// ===========================================================================
// F — D-F100: nenhum log leva o erro INTEIRO nem o corpo da resposta (veio do r20 da nfse-api, que varria nfse-api + núcleo)
// ===========================================================================

describe('F — D-F100 no núcleo: logs sem erro inteiro e sem corpo/texto/raw da resposta (portado do r20 da nfse-api — D-F228)', () => {
  it('a única exceção é `src/db/pool.ts` (conexão nova sem invariante — erro do DRIVER, nunca resposta do fisco)', () => {
    const uncomment = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const offenders: string[] = []
    for (const f of CORE_TS()) {
      const code = uncomment(read(f))
      for (const m of code.matchAll(/logger\.(?:info|warn|error)\(/g)) {
        let depth = 1, i = m.index! + m[0].length
        while (i < code.length && depth > 0) { const ch = code[i++]; if (ch === '(') depth += 1; else if (ch === ')') depth -= 1 }
        const args = code.slice(m.index! + m[0].length, i - 1).replace(/'[^'\n]*'|`[^`]*`|"[^"\n]*"/g, "''")
        const safe = args.replace(/errMsg\([^)]*\)/g, 'X').replace(/Buffer\.byteLength\([^)]*\)/g, 'X')
        const bare = /[:{,]\s*(?:err|error|aerr|touchErr)\s*(?=[,})])/.test(safe)
        const raw = /\.body\b|[:{,]\s*(?:text|raw|body|data)\s*(?=[,})])/.test(safe)
        if (bare || raw) offenders.push(`${rel(f)} :: ${args.replace(/\s+/g, ' ').slice(0, 120)}`)
      }
    }
    expect(offenders).toEqual([expect.stringMatching(/^src\/db\/pool\.ts :: /)])
  })
})

// ===========================================================================
// G — D-F39: a habilitação que NASCE pela API fiscal nasce virada (veio do `adversarial-f2a-r13-gate.test.ts` do setes-api, FATO R13-ADV-03)
// ===========================================================================

describe('G — `establishment/establishment.repository.ts`: habilitação nova nasce com `cutover_at = NOW()` (portado do setes-api — D-F228)', () => {
  it('o INSERT grava o `cutover_at` com NOW(); o comentário diz por quê (lacuna (b) fechada; 55/65 nascem virados)', () => {
    const src = read(path.join(SRC_ROOT, 'establishment', 'establishment.repository.ts'))
    expect(src).toContain("VALUES (?, ?, ?, ?, 0, ?, NOW(), NOW(), 'N', NOW())")
    expect(src).toContain('habilitação que NASCE pela API fiscal nasce virada (cutover_at = NOW())')
    expect(src).toContain('55/65 nascem virados e não dependem')
  })
})

// ===========================================================================
// H — D-PV53: o núcleo não guarda NÚMERO de privilégio (veio da cerca D-PV9 do setes-api, `privilege-catalog-fence.test.ts`)
// ===========================================================================

describe('H — D-PV53 no núcleo: nenhum `PRIVILEGE_<NOME> = <número>` (portado do setes-api — D-F228)', () => {
  it('nem na fonte de fatos (`erp/facts.ts`, onde a cerca do setes-api olhava) nem em lugar nenhum do `src`', () => {
    const constants = (code: string) => [...code.matchAll(/\bconst\s+PRIVILEGE_([A-Z]+)\s*(?::[^=]*)?=\s*(\d+)/g)].map(m => m[1])
    expect(constants('export const PRIVILEGE_FATURAR = 5')).toEqual(['FATURAR'])   // não é cega
    expect(fs.existsSync(path.join(SRC_ROOT, 'erp', 'facts.ts'))).toBe(true)
    expect(CORE_TS().filter(f => constants(read(f)).length > 0).map(rel)).toEqual([])
  })
})
