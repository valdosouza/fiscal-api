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
