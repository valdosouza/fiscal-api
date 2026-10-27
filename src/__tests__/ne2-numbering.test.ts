/// <reference types="jest" />
// NE-2 — D-NE161 (Valdo 2026-10-20): a leitura das faixas RETIRADAS da numeração é peça própria do núcleo (`numbering/`), fora do catálogo
// da voz e fora de `fiscal-api/reading` até o 1º leitor (NE-6); escopada por institution × modelo × série × AMBIENTE (D-NE163). Puro.
import fs from 'fs'
import path from 'path'
import {
  WITHDRAWN_RANGES_VIEW, WITHDRAWN_RANGE_MODELS, withdrawnRangesSelect, withdrawnRangesQuery, readWithdrawnRanges, mapWithdrawnRange,
  assertWithdrawnRangesViewReadable,
} from '../numbering/withdrawn-ranges'
import { modelsOf } from '../establishment/issuer-models'
import * as reading from '../reading'

const SCOPE = { institutionId: 1, model: '55' as const, serie: 1, environment: 'H' as const }
const line = (over: Record<string, unknown> = {}) => ({ institutionId: 1, id: 7, model: '55', serie: 1, numberFrom: 10, numberTo: 20, environment: 'H', createdAt: '2026-10-20 12:00:00', ...over })
const fake = (rows: unknown) => { const calls: { sql: string; params: unknown[] }[] = []; const q: any = { query: jest.fn(async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return [rows] }) }; return { q, calls } }

describe('a consulta — os quatro eixos OBRIGATÓRIOS, tudo por parâmetro', () => {
  it('SELECT publicado sobre a view, filtro por institution/model/serie/environment, ordem por número inicial', () => {
    const { sql, params } = withdrawnRangesQuery('fiscal_api', SCOPE)
    expect(sql).toMatch(/^SELECT v\.tb_institution_id AS institutionId, v\.id AS id, v\.model AS model, v\.serie AS serie, v\.number_from AS numberFrom, v\.number_to AS numberTo, v\.environment AS environment, DATE_FORMAT\(v\.created_at, '%Y-%m-%d %H:%i:%s'\) AS createdAt\s+FROM `fiscal_api`\.vw_invoice_number_void v WHERE v\.tb_institution_id = \? AND v\.model = \? AND v\.serie = \? AND v\.environment = \? ORDER BY v\.number_from, v\.number_to$/)
    expect(params).toEqual([1, '55', 1, 'H'])
    expect(WITHDRAWN_RANGES_VIEW).toBe('vw_invoice_number_void')
    expect(WITHDRAWN_RANGE_MODELS).toEqual(modelsOf('merchandise'))
    expect(withdrawnRangesSelect('fiscal_api', 'x')).toContain('x.number_from AS numberFrom')
  })
  it('eixo ausente ou torto é erro de quem chama — nunca "todas as séries"/"todos os ambientes"', () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ ...SCOPE, environment: undefined }, /ambiente inválido/], [{ ...SCOPE, environment: 'h' }, /ambiente inválido/], [{ ...SCOPE, environment: 'X' }, /ambiente/],
      [{ ...SCOPE, serie: undefined }, /série inválido/], [{ ...SCOPE, serie: 1000 }, /série inválido/], [{ ...SCOPE, serie: 1.5 }, /série/], [{ ...SCOPE, serie: '1' }, /série/],
      [{ ...SCOPE, model: 'SE' }, /modelo fora da numeração NOSSA/], [{ ...SCOPE, model: undefined }, /modelo/], [{ ...SCOPE, model: '5' }, /modelo/],
      [{ ...SCOPE, institutionId: 0 }, /estabelecimento inválido/], [{ ...SCOPE, institutionId: undefined }, /estabelecimento/],
    ]
    for (const [scope, re] of bad) expect(() => withdrawnRangesQuery('fiscal_api', scope as any)).toThrow(re)
    expect(() => withdrawnRangesQuery('fiscal_api; DROP', SCOPE)).toThrow(/Banco fiscal inválido/)
    expect(() => withdrawnRangesQuery('fiscal_api', SCOPE, 'v; --')).toThrow(/Alias/)
    expect(withdrawnRangesQuery('fiscal_api', { ...SCOPE, serie: 0 }).params[2]).toBe(0)      // série 0 existe na NF-e
    expect(withdrawnRangesQuery('fiscal_api', { ...SCOPE, model: '65' }).params[1]).toBe('65')
  })
})

describe('a leitura — mapa ESTRITO (view torta nunca entra na cunhagem)', () => {
  it('mapeia as linhas (números como vindos do driver — string ou number), congeladas, na ordem do banco', async () => {
    const { q, calls } = fake([line(), line({ id: '8', numberFrom: '30', numberTo: '30', serie: '1' })])
    const out = await readWithdrawnRanges(q, 'fiscal_api', SCOPE)
    expect(out).toEqual([{ ...line() }, { ...line(), id: 8, numberFrom: 30, numberTo: 30 }])
    expect(out.every(Object.isFrozen)).toBe(true)
    expect(calls[0].params).toEqual([1, '55', 1, 'H'])
  })
  it('linha de OUTRO eixo (série, ambiente, modelo, estabelecimento), modelo fora do domínio, ambiente torto ou faixa invertida falha ALTO', () => {
    for (const [over, re] of [
      [{ serie: 2 }, /fora do eixo pedido/], [{ environment: 'P' }, /fora do eixo pedido/], [{ model: '65' }, /fora do eixo pedido/], [{ institutionId: 2 }, /fora do eixo pedido/],
      [{ model: 'SE' }, /modelo fora do domínio/], [{ environment: 'h' }, /sem ambiente H\/P/], [{ numberFrom: 20, numberTo: 10 }, /faixa torta/], [{ numberFrom: 0, numberTo: 0 }, /faixa torta/],
      [{ numberFrom: 'x' }, /número inicial inválido/], [{ id: null }, /id inválido/],
      // gate adversarial (INPUT_LENIENCY): texto não canônico não é número do banco
      [{ numberFrom: '1e3' }, /número inicial inválido/], [{ numberTo: '0x10' }, /número final inválido/], [{ serie: ' 1 ' }, /série inválido/], [{ serie: '01' }, /série inválido/],
      [{ createdAt: 123 }, /created_at inválido/],
    ] as [Record<string, unknown>, RegExp][]) {
      expect(() => mapWithdrawnRange(line(over), SCOPE)).toThrow(re)
    }
  })
  it('driver sem lista de linhas = defeito de quem chamou (falha alto); lista vazia = nenhuma faixa retirada', async () => {
    await expect(readWithdrawnRanges(fake(undefined).q, 'fiscal_api', SCOPE)).rejects.toThrow(/não devolveu linhas/)
    expect(await readWithdrawnRanges(fake([]).q, 'fiscal_api', SCOPE)).toEqual([])
  })
})

describe('boot e superfície', () => {
  it('a conferência do boot pergunta `WHERE 1 = 0` à view publicada e falha ALTO com o diagnóstico da D-NE161', async () => {
    const { q, calls } = fake([])
    await assertWithdrawnRangesViewReadable(q, 'fiscal_api')
    expect(calls[0].sql).toMatch(/FROM `fiscal_api`\.vw_invoice_number_void v WHERE 1 = 0$/)
    const bad: any = { query: jest.fn(async () => { throw Object.assign(new Error('x'), { errno: 1142 }) }) }
    await expect(assertWithdrawnRangesViewReadable(bad, 'fiscal_api')).rejects.toThrow(/faixas retiradas.*1142.*D-NE161/)
  })
  it('D-NE161: NADA da numeração sai por `fiscal-api/reading` até o 1º leitor (NE-6) — e a peça não importa a voz nem o ERP', () => {
    for (const n of ['readWithdrawnRanges', 'withdrawnRangesQuery', 'withdrawnRangesSelect', 'assertWithdrawnRangesViewReadable', 'WITHDRAWN_RANGES_VIEW']) expect([n, n in reading]).toEqual([n, false])
    const code = fs.readFileSync(path.resolve(__dirname, '..', 'numbering', 'withdrawn-ranges.ts'), 'utf8')
    const imports = [...code.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort()
    expect(imports).toEqual(['../establishment/issuer-models', '../voice/family-reader', '../voice/kinds'])
    expect(code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')).not.toMatch(/\btb_invoice_number_void\b/)    // só a VIEW publicada, nunca a tabela
  })
})
