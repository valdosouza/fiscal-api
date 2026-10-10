/// <reference types="jest" />
// GATE ADVERSARIAL do delta das APIs fiscais (sessão 2026-10-10) — lado do NÚCLEO (fiscal-api), só unit. Alvos:
//  - L6: a cerca D-F31 no núcleo (`contrato.test.ts`) — a regex pega as formas REAIS de escrita no ERP?
//  - D-F50: `lockIssuerRows` (travante) × `issuerRowsState` (não travante) × `emissionStillInErp` × `assertEmitterWritable`
//    respondem a MESMA coisa em todos os estados da habilitação (a prova no motor real está na suíte ao vivo r8 da nfse-api).
// Achado (o `it.failing` fixa o estado atual; a correção é do Valdo):
//  - [LOW ADV-R8-06] a regex da cerca é sintática e deixa passar escrita no ERP por UPDATE multi-tabela (`UPDATE a JOIN
//    \`${s}\`.b … SET b.x`), identificador `??` do mysql2, minúsculas, expressão no template (`${inst.schemaName}`/
//    `${assertSchema(s)}`), concatenação, `DELETE alias FROM`, modificadores (`LOW_PRIORITY`/`IGNORE` no UPDATE), DDL
//    (`ALTER`/`TRUNCATE`/`DROP`) e código depois de `//` dentro de string na MESMA linha. Hoje NENHUMA escrita real escapa
//    (conferido: as escritas do núcleo são todas sem qualificador) — a defesa de produção é o GRANT (D-F15/D-F48).
import fs from 'fs'
import path from 'path'
import { emissionStillInErp } from '../establishment/establishment'
import { lockIssuerRows, issuerRowsState, assertEmitterWritable } from '../establishment/establishment.repository'

// A cerca EXATAMENTE como o `contrato.test.ts` a usa (peça `./fence` — correção do ADV-R8-06: lista branca + comentários
// tirados pelo compilador)
import { erpWrites } from './fence'
const STRIP_COMMENTS = (code: string) => code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
const caught = (code: string) => erpWrites(code).length > 0

// formas de escrita QUALIFICADA no ERP como apareceriam no FONTE .ts (dentro de template literal: \` escapado)
const ESCAPES: Record<string, string> = {
  'UPDATE multi-tabela (JOIN)': "q.query(`UPDATE tb_establishment_issuer f JOIN \\`${s}\\`.tb_establishment_issuer e ON e.tb_institution_id = f.tb_institution_id SET e.deleted = 'S'`)",
  'identificador ?? do mysql2': "q.query('UPDATE ??.tb_establishment_issuer SET deleted = ? WHERE tb_institution_id = ?', [s, 'S', 1])",
  'minúsculas': "q.query(`update \\`${s}\\`.tb_invoice set deleted = 'S'`)",
  'expressão no template (propriedade)': "q.query(`UPDATE \\`${inst.schemaName}\\`.tb_invoice SET deleted = 'S'`)",
  'expressão no template (chamada)': "q.query(`UPDATE \\`${assertSchema(s)}\\`.tb_invoice SET deleted = 'S'`)",
  'concatenação': "q.query('UPDATE `' + s + '`.tb_invoice SET deleted = \\'S\\'')",
  'sem crase': "q.query(`UPDATE ${s}.tb_invoice SET deleted = 'S'`)",
  'DELETE alias FROM': "q.query(`DELETE e FROM \\`${s}\\`.tb_invoice e WHERE e.id = 1`)",
  'UPDATE LOW_PRIORITY': "q.query(`UPDATE LOW_PRIORITY \\`${s}\\`.tb_invoice SET deleted = 'S'`)",
  'INSERT LOW_PRIORITY': "q.query(`INSERT LOW_PRIORITY INTO \\`${s}\\`.tb_invoice (id) VALUES (1)`)",
  'DDL ALTER/TRUNCATE/DROP': "q.query(`ALTER TABLE \\`${s}\\`.tb_invoice ADD x INT`); q.query(`TRUNCATE \\`${s}\\`.tb_invoice`)",
  '// dentro de string na mesma linha': "const u = 'http://x'; q.query(`UPDATE \\`${s}\\`.tb_invoice SET deleted = 'S'`)",
}
const CAUGHT_CONTROLS: Record<string, string> = {
  'forma usada pelo código': "q.query(`UPDATE \\`${s}\\`.tb_invoice SET deleted = 'S'`)",
  'INSERT IGNORE INTO': "q.query(`INSERT IGNORE INTO \\`${schema}\\`.tb_invoice (id) VALUES (1)`)",
  'quebra de linha antes do schema': "q.query(`INSERT INTO\n   \\`${s}\\`.tb_invoice (id) VALUES (1)`)",
  'central setes_*': "q.query(`DELETE FROM setes_central.tb_entity WHERE id = 1`)",
  'REPLACE INTO': "q.query(`REPLACE INTO \\`${s}\\`.tb_invoice (id) VALUES (1)`)",
}

describe('L6 — a cerca D-F31 do núcleo × formas reais de escrita no ERP', () => {
  it('sem achado: as formas que o código USA hoje são pegas (a regex não é cega)', () => {
    for (const [name, code] of Object.entries(CAUGHT_CONTROLS)) expect([name, caught(code)]).toEqual([name, true])
  })
  it('sem achado: NENHUMA escrita qualificada real escapa hoje — toda escrita de src/ (fora dos testes) é em tabela SEM qualificador (banco da conexão = fiscal_api)', () => {
    const root = path.resolve(__dirname, '..')
    const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
      d.isDirectory() ? (d.name === '__tests__' ? [] : files(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : [])
    // varredura LARGA (maiúsc./minúsc., modificadores, DDL): todo alvo de escrita tem de ser um nome SIMPLES de tabela (sem
    // qualificador, sem `${…}`, sem `??`) e nenhum UPDATE pode ter JOIN antes do SET (multi-tabela)
    const WRITE = /\b(INSERT(?:\s+(?:IGNORE|LOW_PRIORITY|HIGH_PRIORITY|DELAYED))*\s+INTO|REPLACE(?:\s+(?:LOW_PRIORITY|DELAYED))*\s+INTO|UPDATE(?:\s+(?:IGNORE|LOW_PRIORITY))*|DELETE(?:\s+\w+)?\s+FROM|ALTER\s+TABLE|TRUNCATE(?:\s+TABLE)?|DROP\s+TABLE)\s+(\S+)([^;]{0,200})/gi
    const suspicious = files(root).flatMap(f => {
      const code = STRIP_COMMENTS(fs.readFileSync(f, 'utf8'))
      const out: string[] = []
      for (const m of code.matchAll(WRITE)) {
        const target = m[2].replace(/^\\?`|\\?`$/g, '')
        const multi = /^UPDATE/i.test(m[1]) && /\bJOIN\b/i.test(m[3].split(/\bSET\b/i)[0])
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target) || multi) out.push(`${path.relative(root, f)}: ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`)
      }
      return out
    })
    expect(suspicious).toEqual([])
    // a varredura larga não é cega: as formas que escapam da cerca seriam apontadas por ela
    const flagged = (code: string) => [...code.matchAll(WRITE)].some(m => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(m[2].replace(/^\\?`|\\?`$/g, ''))
      || (/^UPDATE/i.test(m[1]) && /\bJOIN\b/i.test(m[3].split(/\bSET\b/i)[0])))
    for (const name of ['UPDATE multi-tabela (JOIN)', 'identificador ?? do mysql2', 'minúsculas', 'expressão no template (propriedade)', 'DELETE alias FROM', 'UPDATE LOW_PRIORITY']) {
      expect([name, flagged(ESCAPES[name])]).toEqual([name, true])
    }
  })
  it('[LOW ADV-R8-06 — CORRIGIDO] a cerca D-F31 pega TODA escrita qualificada no ERP (JOIN, ??, minúsculas, expressão no template, concatenação, alias, modificadores, DDL, // em string)', () => {
    const escaped = Object.entries(ESCAPES).filter(([, code]) => !caught(code)).map(([name]) => name)
    expect(escaped).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// D-F50 — leitura travante × não travante × predicado × guarda de escrita, em TODOS os estados (banco FALSO que interpreta
// os 3 SQL da peça; o motor real está na suíte ao vivo r8 da nfse-api)
// ---------------------------------------------------------------------------------------------------------------------
type Row = { model: 'SE' | '55' | '65'; cutoverAt: string | null; deleted: 'N' | 'S' }
function fakeDb(rows: Row[], erpHasSe: boolean) {
  return {
    query: jest.fn(async (sql: string, p: any[] = []) => {
      if (/SELECT model, cutover_at AS c FROM tb_establishment_issuer[\s\S]*FOR UPDATE/.test(sql)) {
        const models = p.slice(1)
        return [rows.filter(r => models.includes(r.model)).map(r => ({ model: r.model, c: r.cutoverAt }))]
      }
      if (/SELECT COUNT\(\*\) AS n, SUM\(cutover_at IS NULL\) AS r, SUM\(model = \?\) AS s FROM tb_establishment_issuer/.test(sql)) {
        const models = p.slice(2)
        const inDomain = rows.filter(r => models.includes(r.model))
        return [[{ n: inDomain.length, r: inDomain.length ? inDomain.filter(r => r.cutoverAt == null).length : null,
          s: inDomain.length ? inDomain.filter(r => r.model === p[0]).length : null }]]
      }
      if (/`setes_x`\.tb_establishment_issuer/.test(sql)) return [erpHasSe ? [{ x: 1 }] : []]
      throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`)
    }),
  } as any
}
const T = '2026-10-10 10:00:00'
const STATES: Record<string, Row[]> = {
  'nenhuma linha': [],
  'SE réplica viva': [{ model: 'SE', cutoverAt: null, deleted: 'N' }],
  'SE réplica excluída': [{ model: 'SE', cutoverAt: null, deleted: 'S' }],
  'SE virada': [{ model: 'SE', cutoverAt: T, deleted: 'N' }],
  'SE virada excluída': [{ model: 'SE', cutoverAt: T, deleted: 'S' }],
  'só 55 virada': [{ model: '55', cutoverAt: T, deleted: 'N' }],
  '55 + 65 viradas (sem SE)': [{ model: '55', cutoverAt: T, deleted: 'N' }, { model: '65', cutoverAt: T, deleted: 'N' }],
  '55 virada + SE réplica': [{ model: '55', cutoverAt: T, deleted: 'N' }, { model: 'SE', cutoverAt: null, deleted: 'N' }],
  '55 virada + SE virada': [{ model: '55', cutoverAt: T, deleted: 'N' }, { model: 'SE', cutoverAt: T, deleted: 'N' }],
  '55 virada + SE virada excluída': [{ model: '55', cutoverAt: T, deleted: 'N' }, { model: 'SE', cutoverAt: T, deleted: 'S' }],
  'só 55 réplica (versão antiga do script)': [{ model: '55', cutoverAt: null, deleted: 'N' }],
}
// o que a D-F50 promete: réplica em qualquer linha → ERP; SE presente (viva/excluída) e não réplica → API; sem SE → o ERP decide
const EXPECTED_STILL_IN_ERP = (rows: Row[], erpHasSe: boolean) =>
  rows.some(r => r.cutoverAt == null) ? true : rows.some(r => r.model === 'SE') ? false : erpHasSe

describe('D-F50 — trava × contagem × predicado × guarda de escrita respondem igual em TODOS os estados', () => {
  for (const erpHasSe of [true, false]) {
    for (const [name, rows] of Object.entries(STATES)) {
      it(`sem achado: ${name} | ERP ${erpHasSe ? 'COM' : 'sem'} SE`, async () => {
        const db = fakeDb(rows, erpHasSe)
        const locked = await lockIssuerRows(db, 1)
        const state = await issuerRowsState(db, 1)
        expect(state).toEqual(locked)                                                     // leitura travante = não travante
        const still = await emissionStillInErp(db, 'setes_x', 1)
        expect(still).toBe(EXPECTED_STILL_IN_ERP(rows, erpHasSe))
        const writable = await assertEmitterWritable(db, 'setes_x', 1).then(() => true, (e: any) => (e?.code === 'FISCAL_CUTOVER_PENDING' ? false : e))
        expect(writable).toBe(!still)                                                     // a guarda de escrita é o MESMO predicado
      })
    }
  }
})
