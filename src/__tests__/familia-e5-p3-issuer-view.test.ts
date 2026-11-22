/// <reference types="jest" />
// fiscal-api:FAMILIA.E5.P3.T1 — D-NE170 (= Q-NE170 (a), Valdo 2026-10-31): a VIEW PUBLICADA da habilitação por modelo (migration 007) e o
// leitor dela (`establishment/issuer-view.ts`). Nomes do guardião (anexo `ficha-familia-e5-p3-pareceres.md`). Puro — a prova no motor (aplica,
// reaplica, fundível, equivalente à tabela) é o bloco FAMILIA.E5.P3.T1 de `motor-banco.live.test.ts`.
import fs from 'fs'
import path from 'path'
import {
  ISSUER_VIEW, issuerViewSelect, issuerViewQuery, mapIssuerView, readIssuerView, assertIssuerViewReadable,
} from '../establishment/issuer-view'
import { splitStatements } from '../db/migrations'

const SCOPE = { institutionId: 1, model: '55' as const }
const line = (over: Record<string, unknown> = {}) => ({ institutionId: 1, model: '55', environment: 'H', cutoverAt: '2026-11-22 12:00:00', ...over })
const fake = (rows: unknown) => {
  const calls: { sql: string; params: unknown[] }[] = []
  const q: any = { query: jest.fn(async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return [rows] }) }
  return { q, calls }
}
const SRC = path.resolve(__dirname, '..')
const MIGRATION = fs.readFileSync(path.join(SRC, 'migrations', 'sql', '007_issuer_view.sql'), 'utf8')

describe('a migration 007 — view publicada, fundível, só as quatro colunas (PADROES §11 regra 3)', () => {
  const stmts = splitStatements(MIGRATION)
  it('um comando só: CREATE OR REPLACE VIEW (reaplicável) sobre a tabela da habilitação, com as quatro colunas e `deleted` no WHERE', () => {
    expect(stmts).toHaveLength(1)
    const sql = stmts[0].replace(/\s+/g, ' ')
    expect(sql).toBe('CREATE OR REPLACE VIEW `vw_establishment_issuer` AS SELECT i.`tb_institution_id`, i.`model`, i.`environment`, i.`cutover_at` '
      + "FROM `tb_establishment_issuer` i WHERE i.`deleted` = 'N'")
  })
  it('nada que impeça a fusão (subconsulta, GROUP BY, DISTINCT, LIMIT, UNION, agregação, ALGORITHM=TEMPTABLE) nem regra de aplicação', () => {
    const sql = stmts[0].toUpperCase()
    for (const bad of ['(SELECT', 'GROUP BY', 'DISTINCT', 'LIMIT', 'UNION', 'HAVING', 'COUNT(', 'MAX(', 'MIN(', 'TEMPTABLE', 'CUTOVER_AT IS', 'CAN_ISSUE']) {
      expect([bad, sql.includes(bad)]).toEqual([bad, false])
    }
    // os internos da NFS-e e do rodízio e a auditoria NÃO se publicam
    for (const internal of ['serie', 'dps_last_number', 'refresh_lease_until', 'tb_user_id', 'created_at', 'updated_at']) {
      expect([internal, stmts[0].includes(internal)]).toEqual([internal, false])
    }
    expect(ISSUER_VIEW).toBe('vw_establishment_issuer')
  })
})

describe('a consulta — a PK inteira, tudo por parâmetro', () => {
  it('SELECT publicado sobre a view, virada em UTC, filtro por institution × modelo', () => {
    const { sql, params } = issuerViewQuery('fiscal_api', SCOPE)
    expect(sql.replace(/\s+/g, ' ')).toBe("SELECT v.tb_institution_id AS institutionId, v.model AS model, v.environment AS environment, "
      + "DATE_FORMAT(v.cutover_at, '%Y-%m-%d %H:%i:%s') AS cutoverAt FROM `fiscal_api`.vw_establishment_issuer v WHERE v.tb_institution_id = ? AND v.model = ?")
    expect(params).toEqual([1, '55'])
    expect(issuerViewSelect('fiscal_api', 'x')).toContain('x.environment AS environment')
  })
  it('todos os modelos do domínio (a habilitação, não a numeração); escopo ausente ou torto é erro de quem chama', () => {
    for (const model of ['SE', '55', '65'] as const) expect(issuerViewQuery('fiscal_api', { institutionId: 7, model }).params).toEqual([7, model])
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ ...SCOPE, model: undefined }, /modelo fora do domínio/], [{ ...SCOPE, model: 'se' }, /modelo fora do domínio/], [{ ...SCOPE, model: '57' }, /modelo/],
      [{ ...SCOPE, institutionId: 0 }, /estabelecimento inválido/], [{ ...SCOPE, institutionId: undefined }, /estabelecimento/], [{ ...SCOPE, institutionId: '1' }, /estabelecimento/],
      [{ ...SCOPE, institutionId: 1.5 }, /estabelecimento/], [{ ...SCOPE, institutionId: 2_147_483_648 }, /estabelecimento/],
    ]
    for (const [scope, re] of bad) expect(() => issuerViewQuery('fiscal_api', scope as any)).toThrow(re)
    expect(() => issuerViewQuery(undefined as any, SCOPE)).toThrow(/Banco fiscal inválido/)
    expect(() => issuerViewQuery('fiscal_api; DROP', SCOPE)).toThrow(/Banco fiscal inválido/)
    expect(() => issuerViewQuery('fiscal_api', SCOPE, 'v; --')).toThrow(/Alias/)
  })
})

describe('a leitura — mapa ESTRITO, `null` sem linha, uma linha no máximo', () => {
  it('mapeia a linha (número como vindo do driver — string ou number), congelada; virada NULL = réplica (não some)', async () => {
    const { q, calls } = fake([line({ institutionId: '1' })])
    const out = await readIssuerView(q, 'fiscal_api', SCOPE)
    expect(out).toEqual(line())
    expect(Object.isFrozen(out)).toBe(true)
    expect(calls[0].params).toEqual([1, '55'])
    expect(await readIssuerView(fake([line({ cutoverAt: null })]).q, 'fiscal_api', SCOPE)).toEqual(line({ cutoverAt: null }))
    expect(await readIssuerView(fake([line({ cutoverAt: undefined, environment: 'P' })]).q, 'fiscal_api', SCOPE)).toEqual(line({ cutoverAt: null, environment: 'P' }))
  })
  it('sem linha = `null` (não habilitado ou apagado) — quem chama decide; mais de uma = view torta, falha ALTO; driver sem lista, falha ALTO', async () => {
    expect(await readIssuerView(fake([]).q, 'fiscal_api', SCOPE)).toBeNull()
    await expect(readIssuerView(fake([line(), line()]).q, 'fiscal_api', SCOPE)).rejects.toThrow(/2 linhas para a PK 1\/55/)
    await expect(readIssuerView(fake({ affectedRows: 0 }).q, 'fiscal_api', SCOPE)).rejects.toThrow(/não devolveu linhas/)
  })
  it('linha de OUTRO escopo, modelo/ambiente fora do domínio, estabelecimento ou virada tortos falham ALTO', () => {
    for (const [over, re] of [
      [{ institutionId: 2 }, /fora do escopo pedido/], [{ model: '65' }, /fora do escopo pedido/], [{ model: 'SE' }, /fora do escopo pedido/],
      [{ model: 'se' }, /modelo fora do domínio/], [{ model: null }, /modelo fora do domínio/],
      [{ environment: 'h' }, /sem ambiente H\/P/], [{ environment: null }, /sem ambiente H\/P/], [{ environment: 'X' }, /sem ambiente H\/P/],
      [{ institutionId: '01' }, /estabelecimento inválido/], [{ institutionId: '1e0' }, /estabelecimento inválido/], [{ institutionId: 0 }, /estabelecimento inválido/],
      [{ institutionId: null }, /estabelecimento inválido/], [{ institutionId: 1.5 }, /estabelecimento inválido/],
      [{ cutoverAt: 123 }, /cutover_at inválido/], [{ cutoverAt: new Date() }, /cutover_at inválido/], [{ cutoverAt: '2026-11-22' }, /cutover_at inválido/],
      [{ cutoverAt: '' }, /cutover_at inválido/],
    ] as [Record<string, unknown>, RegExp][]) {
      expect(() => mapIssuerView(line(over), SCOPE)).toThrow(re)
    }
  })
})

describe('o boot de quem lê — a view responde ao SELECT publicado, senão falha ALTO', () => {
  it('pergunta `WHERE 1 = 0` com TODAS as colunas; erro do banco vira mensagem com o código e a causa', async () => {
    const { q, calls } = fake([])
    await assertIssuerViewReadable(q, 'fiscal_api')
    expect(calls[0].sql.replace(/\s+/g, ' ')).toMatch(/AS cutoverAt FROM `fiscal_api`\.vw_establishment_issuer v WHERE 1 = 0$/)
    const broken: any = { query: jest.fn(async () => { throw Object.assign(new Error('denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' }) }) }
    await expect(assertIssuerViewReadable(broken, 'fiscal_api')).rejects.toThrow(/vw_establishment_issuer\) não responde .*ER_TABLEACCESS_DENIED_ERROR.*migration 007/)
  })
})

describe('a cerca do módulo — só leitura (entra na superfície `fiscal-api/reading`)', () => {
  it('importa só o catálogo dos modelos e TIPOS da voz — nunca o lado de escrita da habilitação', () => {
    const src = fs.readFileSync(path.join(SRC, 'establishment', 'issuer-view.ts'), 'utf8')
    const imports = [...src.matchAll(/^import (type )?.* from '([^']+)'/gm)].map(m => `${m[1] ?? ''}${m[2]}`)
    expect(imports).toEqual(['./issuer-models', 'type ../voice/kinds', 'type ../voice/family-reader'])
  })
})
