// Cerca D-F31 do NÚCLEO (lista fechada do que uma API fiscal escreve no ERP) — peça de TESTE compartilhada pela cerca
// (`contrato.test.ts`) e pela prova adversarial (`adversarial-r8.test.ts`). Gate adversarial r8 (ADV-R8-06): a regex antiga
// era sintática (só `INSERT/UPDATE/DELETE` maiúsculos com `${x}` simples) e deixava passar UPDATE multi-tabela, `??` do mysql2,
// minúsculas, expressão no template, concatenação, `DELETE alias FROM`, modificadores, DDL e `//` dentro de string. Agora a
// regra é por LISTA BRANCA: o alvo de toda escrita tem de ser um nome SIMPLES de tabela (sem qualificador = o banco da
// conexão, `fiscal_api`); qualquer outra coisa é escrita fora do `fiscal_api`.
import ts from 'typescript'

const BARE = String.raw`(?!\\?` + '`' + String.raw`?[A-Za-z_]\w*\\?` + '`' + String.raw`?(?![\w.]))`
const VERB = String.raw`(?<!\bFOR\s{1,10})\b(?:INSERT(?:\s+(?:IGNORE|LOW_PRIORITY|HIGH_PRIORITY|DELAYED))*\s+INTO|REPLACE(?:\s+(?:LOW_PRIORITY|DELAYED))*\s+INTO|UPDATE(?:\s+(?:IGNORE|LOW_PRIORITY))*|DELETE(?:\s+\w+)?\s+FROM|ALTER\s+TABLE|TRUNCATE(?:\s+TABLE)?|DROP\s+TABLE)`
const JOIN_IN_UPDATE = String.raw`(?<!\bFOR\s{1,10})\bUPDATE\b[^;` + '`' + String.raw`]*?\bJOIN`

/** Escrita cujo ALVO não é um nome simples de tabela (ou UPDATE com JOIN em tabela qualificada). */
export const ERP_WRITE = new RegExp(`${VERB}\\s+(?=\\S)${BARE}|${JOIN_IN_UPDATE}\\s+(?=\\S)${BARE}`, 'gi')

/** Comentários fora pelo compilador (string com `//`, como uma URL, fica intacta — a regex de linha a cortava). */
export function stripComments(code: string): string {
  const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return ts.createPrinter({ removeComments: true }).printFile(sf)
}

export function erpWrites(code: string): string[] {
  return (stripComments(code).match(ERP_WRITE) ?? []).map(m => m.replace(/\s+/g, ' '))
}

/**
 * EXCEÇÕES NOMEADAS da lista branca — arquivo + VERBO + ALVO + LIGAÇÃO exatos (nunca "o arquivo inteiro"). NE-1a parte 2 (D-F108/D-NE74):
 * o escritor GENÉRICO da voz (`voice/event-table.ts`) só ACRESCENTA (`INSERT INTO`) na tabela que o DESCRITOR da família declara —
 * `${table}`, e só ela. O nome não é literal ali por desenho (o núcleo é CEGO à família); quem garante que é um nome SIMPLES (banco da
 * conexão = `fiscal_api`) é o `defineVoiceFamily` (provado em `ne1a-escritor.test.ts`). Gates da parte 2: o VERBO entra (o socrático
 * provou `UPDATE`/`DELETE` em `${table}` passando — a voz é APPEND-ONLY) e a LIGAÇÃO também (NE1A2-08: um parâmetro chamado `table` no
 * mesmo arquivo passava) — no arquivo, o ÚNICO nome `table` declarado é `const table = d.eventTable`.
 */
export const NAMED_WRITE_EXCEPTIONS: readonly {
  readonly file: string; readonly verb: string; readonly target: string; readonly binding: string; readonly why: string
}[] = Object.freeze([
  Object.freeze({ file: 'voice/event-table.ts', verb: 'INSERT INTO', target: '${table}', binding: 'd.eventTable',
    why: 'a voz é append-only: o escritor genérico só acrescenta na tabela do descritor da família — nome simples validado no defineVoiceFamily' }),
])
/** No código, o nome [name] é declarado UMA vez só, por `const name = <init>` (nenhum parâmetro, desestruturação ou função com o nome). */
function bindingHolds(code: string, name: string, init: string): boolean {
  const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const decls: string[] = []
  const visit = (n: ts.Node): void => {
    const named = (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n)
      || ts.isClassDeclaration(n) || ts.isImportSpecifier(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === name
    if (named) decls.push(ts.isVariableDeclaration(n) && n.initializer && ts.isVariableDeclarationList(n.parent) && (n.parent.flags & ts.NodeFlags.Const)
      ? `const=${n.initializer.getText(sf)}` : ts.SyntaxKind[n.kind])
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return decls.length === 1 && decls[0] === `const=${init}`
}
/** A escrita [verb] [target] em [relFile] (relativo a `src/`, barras normais) é exceção nomeada? ([code] = o arquivo, para a ligação) */
export function isNamedWriteException(relFile: string, verb: string, target: string, code: string): boolean {
  const f = relFile.replace(/\\/g, '/')
  const v = verb.replace(/\s+/g, ' ').trim().toUpperCase()
  return NAMED_WRITE_EXCEPTIONS.some(e => e.file === f && e.verb === v && e.target === target
    && bindingHolds(code, e.target.slice(2, -1), e.binding))
}
/** As escritas fora da lista branca de um arquivo de `src/` — as exceções nomeadas dele (verbo, alvo e ligação exatos) fora. */
export function erpWritesIn(relFile: string, code: string): string[] {
  const c = stripComments(code)
  const out: string[] = []
  for (const m of c.matchAll(ERP_WRITE)) {
    const target = c.slice((m.index ?? 0) + m[0].length).match(/^\S+/)?.[0] ?? ''
    if (!isNamedWriteException(relFile, m[0], target, code)) out.push(m[0].replace(/\s+/g, ' ') + target)
  }
  return out
}
