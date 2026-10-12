/// <reference types="jest" />
// NE-1a parte 2 — passo 1: CERCA DA VIRADA POR MODELO (D-NE10 (a), D-NE73; `prompt_onda_nfe_sefaz.md` §12.9.7).
//  - catálogo `ISSUER_MODEL_FACTS` (código, congelado) = domínio do CHECK da migration 004;
//  - `emissionStillInErp(…, model)` × `assertIssuerWritable(…, model)` decidem pelas linhas DO MODELO, com a trava de TODAS as linhas;
//  - `anyEmissionStillInErp` × `assertCertificateWritable` = grão do ESTABELECIMENTO (o predicado de antes) = a disjunção sobre o catálogo.
import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import {
  ISSUER_MODELS, ISSUER_MODEL_FACTS, IssuerModel, authorityOf, branchOf, modelsOf, erpTransmitted, isIssuerModel, SERVICE_ISSUER_MODEL,
} from '../establishment/issuer-models'
import { emissionStillInErp, anyEmissionStillInErp, openIssuer } from '../establishment/establishment'
import { assertIssuerWritable, assertCertificateWritable, lockIssuerRows, issuerRowsState } from '../establishment/establishment.repository'
import { MasterKeyRing } from '../secret/cipher'

describe('catálogo ISSUER_MODEL_FACTS (D-NE10/D-NE73)', () => {
  it('o domínio é o do CHECK BINÁRIO da migration 005 (D-NE84 — mesma lista e ordem da 004, que ela substitui) e o catálogo cobre EXATAMENTE o domínio', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../migrations/sql/005_issuer_domains_binary.sql'), 'utf8')
    const m = /CHECK \(`model` COLLATE utf8mb4_bin IN \(([^)]*)\)\)/.exec(sql)
    expect(m).not.toBeNull()
    expect(m![1].split(',').map(s => s.trim().replace(/'/g, ''))).toEqual([...ISSUER_MODELS])
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS `ck_establishment_issuer_model`,/)          // a 004 (_ci) sai no MESMO ALTER (re-executável — D-F123)
    const old = fs.readFileSync(path.resolve(__dirname, '../migrations/sql/004_issuer_model_domain.sql'), 'utf8')
    expect(/CHECK \(`model` IN \(([^)]*)\)\)/.exec(old)![1]).toBe(m![1])
    expect(Object.keys(ISSUER_MODEL_FACTS).sort()).toEqual([...ISSUER_MODELS].sort())
  })
  it('autoridade, ramo e "o ERP transmitia" por modelo — só a SE é transmitida pelo ERP (D-F42) e é a habilitação de serviço', () => {
    expect(ISSUER_MODELS.map(m => [m, authorityOf(m), branchOf(m), erpTransmitted(m)])).toEqual([
      ['SE', 'ADN', 'service', true], ['55', 'SEFAZ', 'merchandise', false], ['65', 'SEFAZ', 'merchandise', false],
    ])
    expect([modelsOf('service'), modelsOf('merchandise')]).toEqual([['SE'], ['55', '65']])
    expect(ISSUER_MODELS.filter(erpTransmitted)).toEqual([SERVICE_ISSUER_MODEL])
  })
  it('imutável em execução (lista, catálogo e cada entrada); modelo fora do domínio falha alto', () => {
    expect([Object.isFrozen(ISSUER_MODELS), Object.isFrozen(ISSUER_MODEL_FACTS), ...ISSUER_MODELS.map(m => Object.isFrozen(ISSUER_MODEL_FACTS[m]))]).toEqual([true, true, true, true, true])
    expect(() => { (ISSUER_MODEL_FACTS as any).SE.erpTransmitted = false }).toThrow(TypeError)
    expect([isIssuerModel('SE'), isIssuerModel('55'), isIssuerModel('ZZ'), isIssuerModel('se'), isIssuerModel(55)]).toEqual([true, true, false, false, false])
    expect(() => authorityOf('ZZ' as IssuerModel)).toThrow(/fora do domínio/)
  })
  it('[tipo] o predicado por modelo NÃO tem padrão — sem o modelo não compila (prova de segurança não tem default — R18-04)', () => {
    const neverRuns = async () => {
      // @ts-expect-error — `model` obrigatório
      await emissionStillInErp({} as any, 'setes_x', 1)
      // @ts-expect-error — `model` obrigatório
      await assertIssuerWritable({} as any, 'setes_x', 1)
    }
    expect(typeof neverRuns).toBe('function')
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Banco FALSO que INTERPRETA os SQL da peça (molde do r8): trava das linhas, contagem por modelos, leitura da linha e o ERP
// ---------------------------------------------------------------------------------------------------------------------
type Row = { model: IssuerModel; cutoverAt: string | null; deleted: 'N' | 'S' }
function fakeDb(rows: Row[], erpHasSe: boolean) {
  const calls: { sql: string; p: any[] }[] = []
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    calls.push({ sql, p })
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
    if (/FROM tb_establishment_issuer WHERE tb_institution_id = \? AND model = \? AND deleted = 'N'/.test(sql)) {
      return [rows.filter(r => r.model === p[1] && r.deleted === 'N')
        .map(r => ({ institutionId: 1, model: r.model, environment: 'H', serie: '1', userId: null, cutoverAt: r.cutoverAt }))]
    }
    throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`)
  })
  return { query, calls } as any
}
const T = '2026-10-12 10:00:00'
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
  'só 55 réplica (versão antiga do script)': [{ model: '55', cutoverAt: null, deleted: 'N' }],
  '65 réplica + SE virada': [{ model: '65', cutoverAt: null, deleted: 'N' }, { model: 'SE', cutoverAt: T, deleted: 'N' }],
}
// D-NE10 (a): réplica DO MODELO → ERP; o modelo que o ERP transmitia (SE), sem linha, → a habilitação do ERP decide; 55/65 nunca
const EXPECTED_MODEL = (rows: Row[], erpHasSe: boolean, model: IssuerModel) => {
  const mine = rows.filter(r => r.model === model)
  if (mine.some(r => r.cutoverAt == null)) return true
  if (!ISSUER_MODEL_FACTS[model].erpTransmitted) return false
  return mine.length > 0 ? false : erpHasSe
}
// o predicado de ANTES (D-F57) = grão do estabelecimento
const EXPECTED_ANY = (rows: Row[], erpHasSe: boolean) =>
  rows.some(r => r.cutoverAt == null) ? true : rows.some(r => r.model === 'SE') ? false : erpHasSe

describe('D-NE10 — predicado e guarda POR MODELO × grão do ESTABELECIMENTO, em TODOS os estados', () => {
  for (const erpHasSe of [true, false]) {
    for (const [name, rows] of Object.entries(STATES)) {
      it(`${name} | ERP ${erpHasSe ? 'COM' : 'sem'} SE`, async () => {
        const perModel: boolean[] = []
        for (const model of ISSUER_MODELS) {
          const still = await emissionStillInErp(fakeDb(rows, erpHasSe), 'setes_x', 1, model)
          expect([model, still]).toEqual([model, EXPECTED_MODEL(rows, erpHasSe, model)])
          const db = fakeDb(rows, erpHasSe)
          const writable = await assertIssuerWritable(db, 'setes_x', 1, model).then(() => true, (e: any) => (e?.code === 'FISCAL_CUTOVER_PENDING' ? false : e))
          expect([model, writable]).toEqual([model, !still])                          // a guarda de escrita é o MESMO predicado
          // a TRAVA é sempre de TODAS as linhas do estabelecimento (por PK), 1ª instrução — só a decisão é por modelo
          expect(db.calls[0].sql).toMatch(/FOR UPDATE/)
          expect(db.calls[0].p).toEqual([1, ...ISSUER_MODELS])
          perModel.push(still)
        }
        const any = await anyEmissionStillInErp(fakeDb(rows, erpHasSe), 'setes_x', 1)
        expect(any).toBe(EXPECTED_ANY(rows, erpHasSe))                                // o predicado de antes, intacto
        expect(any).toBe(perModel.some(Boolean))                                      // = a disjunção sobre o catálogo
        const cert = await assertCertificateWritable(fakeDb(rows, erpHasSe), 'setes_x', 1).then(() => true, (e: any) => (e?.code === 'FISCAL_CUTOVER_PENDING' ? false : e))
        expect(cert).toBe(!any)                                                       // A1 = grão do estabelecimento
        const db = fakeDb(rows, erpHasSe)
        expect(await lockIssuerRows(db, 1)).toEqual(await issuerRowsState(db, 1))     // travante = não travante (domínio inteiro)
      })
    }
  }
  it('D-NE10 (a): 55/65 NÃO dependem da SE — com a SE ainda réplica, a habilitação 55 é gravável; o A1 (comum) segue barrado', async () => {
    const rows = STATES['55 virada + SE réplica']
    expect(await assertIssuerWritable(fakeDb(rows, true), 'setes_x', 1, '55').then(() => 'ok', (e: any) => e.code)).toBe('ok')
    expect(await assertIssuerWritable(fakeDb([], true), 'setes_x', 1, '65').then(() => 'ok', (e: any) => e.code)).toBe('ok')   // nasce virada
    expect(await assertIssuerWritable(fakeDb(rows, true), 'setes_x', 1, 'SE').then(() => 'ok', (e: any) => e.code)).toBe('FISCAL_CUTOVER_PENDING')
    expect(await assertCertificateWritable(fakeDb(rows, true), 'setes_x', 1).then(() => 'ok', (e: any) => e.code)).toBe('FISCAL_CUTOVER_PENDING')
  })
  it('a contagem por modelo pede SÓ as linhas do modelo (mesmo SQL da contagem do estabelecimento); modelo fora do domínio falha antes do banco', async () => {
    const db = fakeDb([], false)
    await emissionStillInErp(db, 'setes_x', 1, '55')
    expect(db.calls[0].p).toEqual(['SE', 1, '55'])
    await expect(issuerRowsState(db, 1, ['ZZ' as IssuerModel])).rejects.toThrow(/fora do domínio/)
    await expect(issuerRowsState(db, 1, [])).rejects.toThrow(/fora do domínio/)
    await expect(assertIssuerWritable(db, 'setes_x', 1, 'ZZ' as IssuerModel)).rejects.toThrow(/fora do domínio/)
    expect(db.calls).toHaveLength(1)
  })
  it('openIssuer sem linha do modelo: o predicado é o DO MODELO — 55 ausente com a SE réplica = "configure a habilitação" (não "ainda do ERP"); SE réplica excluída = ainda do ERP', async () => {
    const deps = { pool: fakeDb(STATES['SE réplica viva'], true), keyring: MasterKeyRing.of({ 1: randomBytes(32) }) }
    await expect(openIssuer(deps, 1, '55', { schemaName: 'setes_x' })).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_ISSUER_MISSING' })
    const excluded = { pool: fakeDb(STATES['SE réplica excluída'], false), keyring: deps.keyring }
    await expect(openIssuer(excluded, 1, 'SE', { schemaName: 'setes_x' })).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CUTOVER_PENDING' })
    await expect(openIssuer(excluded, 1, 'SE')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_CUTOVER_PENDING' })     // sem schema: a réplica do modelo
  })
})
