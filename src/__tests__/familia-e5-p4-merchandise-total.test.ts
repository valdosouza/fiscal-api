// fiscal-api:FAMILIA.E5.P4.T2 — a fórmula do vNF (W16-10) como peça pura, datada pelo fato, no subpath `fiscal-api/merchandise-total`
// (D-NE215; D-NE225 para a desoneração). Ficha: projetos/fiscal-api/GERAL/ficha-familia-e5-p4-pecas-ne4.md §5 T2 e §6 ordem 3.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import * as subpath from '../merchandise-total'
import * as barrel from '../index'
import * as reading from '../reading'
import {
  MERCHANDISE_TOTAL_CENT_FIELDS, MERCHANDISE_TOTAL_FORMULAS, MerchandiseTotalError, MerchandiseTotalsCents, merchandiseInvoiceTotal,
  merchandiseTotalFormulaAt, pickMerchandiseTotalFormula, MerchandiseTotalFormula,
} from '../merchandise-total/merchandise-total'

const SRC = path.resolve(__dirname, '..')
const vector = JSON.parse(fs.readFileSync(path.join(SRC, 'merchandise-total', 'merchandise-total.vector.json'), 'utf8'))

const CASES: [string, any][] = vector.casos.map((c: any) => [c.id, c])
const ZERO: MerchandiseTotalsCents = Object.freeze({
  vProd: 0, vDesc: 0, vICMSDesonDeducted: 0, vST: 0, vFCPST: 0, vICMSMonoReten: 0, vFrete: 0, vSeg: 0, vOutro: 0, vII: 0, vIPI: 0,
  vIPIDevol: 0, vServ: 0, vPISSTSummed: 0, vCOFINSSTSummed: 0, newVehicleSale: false,
})
const totals = (e: Partial<MerchandiseTotalsCents>): MerchandiseTotalsCents => ({ ...ZERO, ...e })
const field = (fn: () => unknown): string => {
  try { fn(); return 'calculou' } catch (e) { return e instanceof MerchandiseTotalError ? e.field : `OUTRO: ${(e as Error).message}` }
}

function specifiers(file: string): string[] {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text)
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))
      && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) out.push(n.arguments[0].text)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

describe('FAMILIA.E5.P4.T2 — merchandiseInvoiceTotal (W16-10, D-NE215)', () => {
  it.each(CASES)('%s do vetor', (_id, c) => {
    const r = merchandiseInvoiceTotal(totals(c.entrada), vector.dataDoFato)
    expect(r).toEqual({ cents: c.vNF, formula: vector.formula })
  })

  it('o vetor cobre os casos VNF-001…006 da ficha (anexo B.2) e as chaves de entrada são campos da peça', () => {
    expect(vector.casos.map((c: any) => c.id)).toEqual(['VNF-001', 'VNF-002', 'VNF-003', 'VNF-004a', 'VNF-004b', 'VNF-005', 'VNF-006', 'VNF-007'])
    for (const c of vector.casos) for (const k of Object.keys(c.entrada)) expect([k, k in ZERO]).toEqual([k, true])
  })

  it('D-NE225: o desonerado entra só pelo campo já filtrado (vICMSDesonDeducted) e é SUBTRAÍDO', () => {
    expect(merchandiseInvoiceTotal(totals({ vProd: 10000, vICMSDesonDeducted: 1200 }), '2026-11-22').cents).toBe(8800)
  })

  it('Exceção 1 (tpOp=2): vST, vFCPST e vIPIDevol saem; vICMSMonoReten e PIS/COFINS-ST continuam', () => {
    const t = totals({ vProd: 10000, vST: 500, vFCPST: 100, vIPIDevol: 200, vICMSMonoReten: 70, vPISSTSummed: 10, vCOFINSSTSummed: 20 })
    expect(merchandiseInvoiceTotal(t, '2026-11-22').cents).toBe(10000 + 500 + 100 + 200 + 70 + 10 + 20)
    expect(merchandiseInvoiceTotal({ ...t, newVehicleSale: true }, '2026-11-22').cents).toBe(10000 + 70 + 10 + 20)
  })

  it('datada pelo fato: a vigente desde 2024-07-01; antes, data impossível ou fora da forma = recusa (nunca "a atual")', () => {
    expect(merchandiseTotalFormulaAt('2024-07-01').formula).toBe('NT2023.004')
    expect(merchandiseTotalFormulaAt('2027-01-01').formula).toBe('NT2023.004')
    for (const d of ['2024-06-30', '2024-02-30', '2024-7-1', '2024-07-01T00:00:00Z', '', 'x']) {
      expect([d, field(() => merchandiseInvoiceTotal(totals({ vProd: 1 }), d))]).toEqual([d, 'factDate'])
    }
    expect(Object.isFrozen(MERCHANDISE_TOTAL_FORMULAS)).toBe(true)
    expect(MERCHANDISE_TOTAL_FORMULAS.map(f => f.validFrom)).toEqual([...MERCHANDISE_TOTAL_FORMULAS.map(f => f.validFrom)].sort())
  })

  it('cada campo: fracionário, negativo, acima do inteiro seguro, texto ou ausente = recusa com o NOME do campo', () => {
    for (const k of MERCHANDISE_TOTAL_CENT_FIELDS) {
      for (const bad of [0.5, -1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '100', undefined, null]) {
        expect([k, bad, field(() => merchandiseInvoiceTotal({ ...ZERO, [k]: bad } as any, '2026-11-22'))]).toEqual([k, bad, k])
      }
    }
    expect(field(() => merchandiseInvoiceTotal({ ...ZERO, newVehicleSale: 'true' } as any, '2026-11-22'))).toBe('newVehicleSale')
    expect(field(() => merchandiseInvoiceTotal(null as any, '2026-11-22'))).toBe('totals')
  })

  it('vNF negativo ou acima do inteiro seguro = recusa', () => {
    expect(field(() => merchandiseInvoiceTotal(totals({ vProd: 100, vDesc: 101 }), '2026-11-22'))).toBe('vNF')
    expect(field(() => merchandiseInvoiceTotal(totals({ vProd: Number.MAX_SAFE_INTEGER, vFrete: 1 }), '2026-11-22'))).toBe('vNF')
    expect(merchandiseInvoiceTotal(totals({ vProd: 100, vDesc: 100 }), '2026-11-22').cents).toBe(0)
  })

  it('a ESCOLHA pela data com mais de uma versão (tabela fictícia, fora de ordem): a de maior início ≤ data; antes de todas, recusa', () => {
    const v = (validFrom: string, formula: string): MerchandiseTotalFormula => ({ validFrom, formula, compute: () => 0n })
    const table = [v('2030-01-01', 'C'), v('2024-07-01', 'A'), v('2027-01-01', 'B')]
    expect(pickMerchandiseTotalFormula(table, '2026-12-31').formula).toBe('A')
    expect(pickMerchandiseTotalFormula(table, '2027-01-01').formula).toBe('B')
    expect(pickMerchandiseTotalFormula(table, '2029-12-31').formula).toBe('B')
    expect(pickMerchandiseTotalFormula(table, '2031-05-05').formula).toBe('C')
    expect(field(() => pickMerchandiseTotalFormula(table, '2024-06-30'))).toBe('factDate')
  })

  it('soma EXATA mesmo com parciais acima do inteiro seguro (gate LOW-2): o resultado 1 sai 1', () => {
    const M = Number.MAX_SAFE_INTEGER
    expect(merchandiseInvoiceTotal(totals({ vProd: 0, vDesc: M, vICMSDesonDeducted: M - 1, vST: M, vFrete: M }), '2026-11-22').cents).toBe(1)
  })

  it('soma em inteiros: 0,1 + 0,2 em centavos dá 30 exato', () => {
    expect(merchandiseInvoiceTotal(totals({ vProd: 10, vFrete: 20 }), '2026-11-22').cents).toBe(30)
  })

  it('sai pelo subpath e pelo barrel — NÃO pelo `fiscal-api/reading`', () => {
    expect(subpath.merchandiseInvoiceTotal).toBe(merchandiseInvoiceTotal)
    expect(barrel.merchandiseInvoiceTotal).toBe(merchandiseInvoiceTotal)
    expect('merchandiseInvoiceTotal' in reading).toBe(false)
  })

  it('o subpath é PURO: o grafo de `merchandise-total.ts` não sai da pasta da peça nem importa pacote externo (nada de banco, nada de I/O)', () => {
    const seen = new Set<string>()
    const stack = [path.join(SRC, 'merchandise-total.ts')]
    const external: string[] = []
    while (stack.length) {
      const f = stack.pop()!
      if (seen.has(f)) continue
      seen.add(f)
      for (const s of specifiers(f)) {
        if (!s.startsWith('.')) { external.push(s); continue }
        stack.push(path.resolve(path.dirname(f), s) + '.ts')
      }
    }
    expect(external).toEqual([])
    expect([...seen].map(f => path.relative(SRC, f).replace(/\\/g, '/')).sort()).toEqual(['merchandise-total.ts', 'merchandise-total/merchandise-total.ts'])
  })
})
