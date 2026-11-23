/// <reference types="jest" />
// fiscal-api:FAMILIA.E5.P5 — o último número da NF-e por estabelecimento × modelo × série × ambiente (D-NE255, D-NE257, D-NE263, D-NE265,
// Valdo 2026-11-23). Puro: o texto da migration 008 e as peças com conexão simulada; o motor fica em `motor-banco.live.test.ts`.
import fs from 'fs'
import path from 'path'
import { splitStatements } from '../db/migrations'
import {
  NUMBER_SEQUENCE_TABLE, NUMBER_SEQUENCE_MODELS, MAX_INVOICE_NUMBER, assertNumberSequenceDomainsEnforced, nextInvoiceNumber, lockNumberSequence,
  openNumberSequence,
} from '../numbering/number-sequence'
import { HttpError } from '../errors/http-error'
import { ErrorCodes, ErrorCatalog } from '../errors/error-codes'
import { modelsOf } from '../establishment/issuer-models'
import * as reading from '../reading'
import * as barrel from '../index'

const SQL_008 = fs.readFileSync(path.resolve(__dirname, '..', 'migrations', 'sql', '008_invoice_number_sequence.sql'), 'utf8')

describe('008 — a tabela do último número', () => {
  it('um CREATE TABLE re-executável, com a PK do eixo como único índice único', () => {
    const statements = splitStatements(SQL_008)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS `tb_invoice_number_sequence` \(/)
    expect(NUMBER_SEQUENCE_TABLE).toBe('tb_invoice_number_sequence')
    expect(SQL_008).toContain('PRIMARY KEY (`tb_institution_id`, `model`, `serie`, `environment`)')
    expect(SQL_008).not.toMatch(/UNIQUE KEY/)
    expect(SQL_008).toMatch(/ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\s*$/)
  })
  it('os cinco CHECKs de nome próprio: modelo 55/65 e ambiente H/P e deleted N/S binários; série 0–999 e número 0–999999999 (RF-NFE-44)', () => {
    expect(SQL_008).toContain("CONSTRAINT `ck_invoice_number_sequence_model_bin` CHECK (`model` COLLATE utf8mb4_bin IN ('55', '65'))")
    expect(SQL_008).toContain("CONSTRAINT `ck_invoice_number_sequence_environment_bin` CHECK (`environment` COLLATE utf8mb4_bin IN ('H', 'P'))")
    expect(SQL_008).toContain('CONSTRAINT `ck_invoice_number_sequence_serie` CHECK (`serie` BETWEEN 0 AND 999)')
    expect(SQL_008).toContain('CONSTRAINT `ck_invoice_number_sequence_last_number` CHECK (`last_number` BETWEEN 0 AND 999999999)')
    expect(SQL_008).toContain("CONSTRAINT `ck_invoice_number_sequence_deleted_bin` CHECK (`deleted` COLLATE utf8mb4_bin IN ('N', 'S'))")
    expect(SQL_008.match(/CONSTRAINT `ck_/g)).toHaveLength(5)
  })
  it('nenhum COMMENT de coluna leva `;` nem `--` (o executor corta por statement)', () => {
    for (const m of SQL_008.matchAll(/COMMENT '([^']*)'/g)) expect(m[1]).not.toMatch(/;|--/)
  })
})

describe('a sonda do boot', () => {
  const pool = (refuse: (params: unknown[]) => string | null) => {
    const seen: unknown[][] = []
    const conn: any = {
      beginTransaction: jest.fn(async () => undefined), rollback: jest.fn(async () => undefined), release: jest.fn(),
      query: jest.fn(async (_sql: string, params: unknown[]) => {
        seen.push(params)
        const ck = refuse(params)
        if (ck) throw Object.assign(new Error(`CONSTRAINT \`${ck}\` failed for \`fiscal_api\`.\`tb_invoice_number_sequence\``), { errno: 4025 })
        return [{ affectedRows: 1 }]
      }),
    }
    return { pool: { getConnection: async () => conn } as any, conn, seen }
  }
  const byDomain = ([model, serie, environment, lastNumber, deleted]: any[]): string | null =>
    model !== '55' && model !== '65' ? 'ck_invoice_number_sequence_model_bin'
      : environment !== 'H' && environment !== 'P' ? 'ck_invoice_number_sequence_environment_bin'
        : serie > 999 ? 'ck_invoice_number_sequence_serie'
          : lastNumber > 999_999_999 ? 'ck_invoice_number_sequence_last_number'
            : deleted !== 'N' && deleted !== 'S' ? 'ck_invoice_number_sequence_deleted_bin' : null

  it('seis sondas, cada uma recusada pelo CHECK do nome certo, numa transação sempre desfeita', async () => {
    const p = pool(byDomain)
    await assertNumberSequenceDomainsEnforced(p.pool)
    expect(p.seen).toEqual([
      ['SE', 1, 'H', 0, 'N'], ['5', 2, 'H', 0, 'N'], ['55', 3, 'h', 0, 'N'], ['55', 1000, 'H', 0, 'N'], ['55', 5, 'H', 1_000_000_000, 'N'], ['55', 6, 'H', 0, 's'],
    ])
    expect(p.conn.rollback).toHaveBeenCalledTimes(1)
  })
  it('motor que aceita uma sonda (CHECK ausente ou em colação _ci) derruba o boot', async () => {
    await expect(assertNumberSequenceDomainsEnforced(pool(() => null).pool)).rejects.toThrow(/ACEITOU o domínio do último número da NF-e fora do domínio/)
    const ci = pool(params => (params[2] === 'h' || params[4] === 's') ? null : byDomain(params))
    await expect(assertNumberSequenceDomainsEnforced(ci.pool)).rejects.toThrow(/ambiente h, deleted s/)
  })
})

// ---------------------------------------------------------------- as três peças, com conexão simulada
type Call = { sql: string; params: unknown[] }
interface Fake { issuer?: { environment?: string; cutoverAt?: string | null } | null; row?: { n: unknown; d?: string } | null; affected?: number; writeError?: unknown }

/** Conexão simulada: responde pela FORMA do comando (habilitação · leitura da sequência · escrita da sequência). */
function fake(f: Fake) {
  const calls: Call[] = []
  const conn: any = { query: jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
    if (/FROM tb_establishment_issuer/.test(sql)) {
      return [f.issuer === null ? [] : [{ institutionId: 7, model: '55', environment: f.issuer?.environment ?? 'H', serie: null, userId: null,
        cutoverAt: f.issuer && 'cutoverAt' in f.issuer ? f.issuer.cutoverAt : '2026-11-22 03:00:00' }]]
    }
    if (/^\s*SELECT last_number/.test(sql)) return [f.row == null ? [] : [{ n: f.row.n, d: f.row.d ?? 'N' }]]
    if (f.writeError) throw f.writeError
    return [{ affectedRows: f.affected ?? 1 }]
  }) }
  return { conn, calls }
}
const SCOPE = { institutionId: 7, model: '55' as const, serie: 1 }
const httpError = async (p: Promise<unknown>): Promise<HttpError> => { try { await p } catch (e) { if (e instanceof HttpError) return e; throw e } throw new Error('não recusou') }

describe('nextInvoiceNumber — o próximo número nasce do último, sob a trava da habilitação', () => {
  it('homologação: habilitação com FOR UPDATE antes de tudo, UM comando de escrita (nasce com 1 ou soma 1) e a leitura de volta', async () => {
    const { conn, calls } = fake({ row: { n: 4 } })
    expect(await nextInvoiceNumber(conn, SCOPE)).toEqual({ number: 4, environment: 'H' })
    expect(calls).toHaveLength(3)
    expect(calls[0].sql).toMatch(/FROM tb_establishment_issuer WHERE tb_institution_id = \? AND model = \? AND deleted = 'N' FOR UPDATE$/)
    expect(calls[0].params).toEqual([7, '55'])
    expect(calls[1].sql).toMatch(/^INSERT INTO tb_invoice_number_sequence \(tb_institution_id, model, serie, environment, last_number, created_at, updated_at, deleted\) VALUES \(\?, \?, \?, \?, 1, NOW\(\), NOW\(\), 'N'\) ON DUPLICATE KEY UPDATE /)
    expect(calls[1].sql).toContain("last_number = IF(deleted = 'N', last_number + 1, last_number)")
    expect(calls[1].params).toEqual([7, '55', 1, 'H'])
    expect(calls[2].sql).toBe('SELECT last_number AS n, deleted AS d FROM tb_invoice_number_sequence WHERE tb_institution_id = ? AND model = ? AND serie = ? AND environment = ?')
    expect(calls[2].params).toEqual([7, '55', 1, 'H'])
  })
  it('produção: só UPDATE (a linha nunca nasce sozinha — D-NE265); o ambiente sai da habilitação, não de quem chama', async () => {
    const { conn, calls } = fake({ issuer: { environment: 'P' }, row: { n: '3138' } })
    expect(await nextInvoiceNumber(conn, SCOPE)).toEqual({ number: 3138, environment: 'P' })
    expect(calls[1].sql).toBe("UPDATE tb_invoice_number_sequence SET last_number = last_number + 1, updated_at = NOW() WHERE tb_institution_id = ? AND model = ? AND serie = ? AND environment = ? AND deleted = 'N'")
    expect(calls[1].params).toEqual([7, '55', 1, 'P'])
    expect(calls.some(c => /^INSERT/.test(c.sql))).toBe(false)
  })
  it('produção sem a sequência aberta: 409 FISCAL_NUMBER_SEQUENCE_NOT_OPEN e nenhuma escrita além do UPDATE que não achou linha', async () => {
    const { conn, calls } = fake({ issuer: { environment: 'P' }, row: null, affected: 0 })
    const err = await httpError(nextInvoiceNumber(conn, SCOPE))
    expect([err.statusCode, err.code]).toEqual([409, ErrorCodes.FISCAL_NUMBER_SEQUENCE_NOT_OPEN])
    expect(calls.filter(c => /^INSERT/.test(c.sql))).toEqual([])
    expect(ErrorCatalog.FISCAL_NUMBER_SEQUENCE_NOT_OPEN).toMatch(/PRODUÇÃO/)
  })
  it('réplica do ERP (cutover_at NULL) = 409 FISCAL_CUTOVER_PENDING; sem habilitação viva = erro simples — nos dois, nada toca a sequência', async () => {
    const replica = fake({ issuer: { cutoverAt: null } })
    const err = await httpError(nextInvoiceNumber(replica.conn, SCOPE))
    expect([err.statusCode, err.code]).toEqual([409, ErrorCodes.FISCAL_CUTOVER_PENDING])
    expect(replica.calls).toHaveLength(1)
    const none = fake({ issuer: null })
    await expect(nextInvoiceNumber(none.conn, SCOPE)).rejects.toThrow(/sem habilitação viva do modelo 55/)
    await expect(nextInvoiceNumber(none.conn, SCOPE)).rejects.not.toBeInstanceOf(HttpError)
    expect(none.calls.every(c => /tb_establishment_issuer/.test(c.sql))).toBe(true)
  })
  it('o CHECK do último número recusando (teto do nNF — RF-NFE-44) vira "numeração esgotada"; outro erro do banco sobe como veio', async () => {
    const full = Object.assign(new Error('CONSTRAINT `ck_invoice_number_sequence_last_number` failed for `fiscal_api`.`tb_invoice_number_sequence`'), { errno: 4025 })
    await expect(nextInvoiceNumber(fake({ writeError: full }).conn, SCOPE)).rejects.toThrow(/numeração esgotada.*999999999/)
    const other = Object.assign(new Error('Lock wait timeout'), { errno: 1205 })
    await expect(nextInvoiceNumber(fake({ writeError: other }).conn, SCOPE)).rejects.toBe(other)
    expect(MAX_INVOICE_NUMBER).toBe(999_999_999)
  })
  it('linha marcada como excluída falha ALTO (nunca recomeça do 1), em H e em P', async () => {
    await expect(nextInvoiceNumber(fake({ row: { n: 9, d: 'S' } }).conn, SCOPE)).rejects.toThrow(/marcada como excluída/)
    await expect(nextInvoiceNumber(fake({ issuer: { environment: 'P' }, row: { n: 9, d: 'S' }, affected: 0 }).conn, SCOPE)).rejects.toThrow(/marcada como excluída/)
  })
  it('escopo torto é erro de quem chama, ANTES de qualquer SQL', async () => {
    for (const [scope, re] of [
      [{ ...SCOPE, model: 'SE' }, /modelo fora da numeração NOSSA/], [{ ...SCOPE, model: undefined }, /modelo/], [{ ...SCOPE, serie: 1000 }, /série inválido/],
      [{ ...SCOPE, serie: 1.5 }, /série inválido/], [{ ...SCOPE, serie: '1' }, /série inválido/], [{ ...SCOPE, institutionId: 0 }, /estabelecimento inválido/],
    ] as [any, RegExp][]) {
      const { conn, calls } = fake({})
      await expect(nextInvoiceNumber(conn, scope)).rejects.toThrow(re)
      await expect(lockNumberSequence(conn, scope)).rejects.toThrow(re)
      await expect(openNumberSequence(conn, scope, 1, null)).rejects.toThrow(re)
      expect(calls).toEqual([])
    }
    expect(NUMBER_SEQUENCE_MODELS).toEqual(modelsOf('merchandise'))
    expect((await nextInvoiceNumber(fake({ row: { n: 1 } }).conn, { ...SCOPE, model: '65', serie: 0 })).number).toBe(1)   // série 0 e o 65 existem no domínio
  })
})

describe('lockNumberSequence — a leitura travante para a inutilização (D-NE263)', () => {
  it('trava a habilitação e depois a linha (FOR UPDATE) e devolve o último número do ambiente vigente', async () => {
    const { conn, calls } = fake({ issuer: { environment: 'P' }, row: { n: 3140 } })
    expect(await lockNumberSequence(conn, SCOPE)).toEqual({ environment: 'P', lastNumber: 3140 })
    expect(calls.map(c => c.sql)).toEqual([
      expect.stringMatching(/FROM tb_establishment_issuer .* FOR UPDATE$/),
      'SELECT last_number AS n, deleted AS d FROM tb_invoice_number_sequence WHERE tb_institution_id = ? AND model = ? AND serie = ? AND environment = ? FOR UPDATE',
    ])
    expect(calls[1].params).toEqual([7, '55', 1, 'P'])
  })
  it('sem linha = lastNumber null (nada foi gerado: nada a inutilizar); réplica, sem habilitação e linha excluída como no gerador', async () => {
    expect(await lockNumberSequence(fake({ row: null }).conn, SCOPE)).toEqual({ environment: 'H', lastNumber: null })
    expect((await httpError(lockNumberSequence(fake({ issuer: { cutoverAt: null } }).conn, SCOPE))).code).toBe(ErrorCodes.FISCAL_CUTOVER_PENDING)
    await expect(lockNumberSequence(fake({ issuer: null }).conn, SCOPE)).rejects.toThrow(/sem habilitação viva/)
    await expect(lockNumberSequence(fake({ row: { n: 2, d: 'S' } }).conn, SCOPE)).rejects.toThrow(/marcada como excluída/)
    await expect(lockNumberSequence(fake({ row: { n: -1 } }).conn, SCOPE)).rejects.toThrow(/valor torto/)
  })
})

describe('openNumberSequence — abre a sequência de PRODUÇÃO com o número inicial (D-NE265)', () => {
  it('grava firstNumber - 1 em P, com quem abriu, depois de travar a habilitação e de ver que a linha não existe', async () => {
    const { conn, calls } = fake({ row: null })                        // habilitação ainda em H: abre-se antes de virar o ambiente
    await openNumberSequence(conn, SCOPE, 3138, 12)
    expect(calls).toHaveLength(3)
    expect(calls[0].sql).toMatch(/tb_establishment_issuer .* FOR UPDATE$/)
    expect(calls[1].sql).toMatch(/^SELECT last_number .* FOR UPDATE$/)
    expect(calls[1].params).toEqual([7, '55', 1, 'P'])
    expect(calls[2].sql).toBe("INSERT INTO tb_invoice_number_sequence (tb_institution_id, model, serie, environment, last_number, tb_user_id, created_at, updated_at, deleted) VALUES (?, ?, ?, 'P', ?, ?, NOW(), NOW(), 'N')")
    expect(calls[2].params).toEqual([7, '55', 1, 3137, 12])
  })
  it('sequência que já existe = 409 FISCAL_NUMBER_SEQUENCE_ALREADY_OPEN sem escrever (e o 1062 de uma corrida vira o mesmo 409)', async () => {
    const open = fake({ row: { n: 10 } })
    const err = await httpError(openNumberSequence(open.conn, SCOPE, 500, null))
    expect([err.statusCode, err.code]).toEqual([409, ErrorCodes.FISCAL_NUMBER_SEQUENCE_ALREADY_OPEN])
    expect(open.calls.some(c => /^INSERT/.test(c.sql))).toBe(false)
    const race = fake({ row: null, writeError: Object.assign(new Error('Duplicate entry'), { errno: 1062 }) })
    expect((await httpError(openNumberSequence(race.conn, SCOPE, 500, null))).code).toBe(ErrorCodes.FISCAL_NUMBER_SEQUENCE_ALREADY_OPEN)
  })
  it('número inicial fora de 1–999999999 e usuário torto são erro ANTES do SQL; réplica, sem habilitação e linha excluída recusam', async () => {
    for (const n of [0, 1_000_000_000, 1.5, '5', undefined]) {
      const { conn, calls } = fake({ row: null })
      await expect(openNumberSequence(conn, SCOPE, n as any, null)).rejects.toThrow(/número inicial inválido/)
      expect(calls).toEqual([])
    }
    await expect(openNumberSequence(fake({ row: null }).conn, SCOPE, 1, 0)).rejects.toThrow(/usuário inválido/)
    expect((await httpError(openNumberSequence(fake({ issuer: { cutoverAt: null } }).conn, SCOPE, 1, null))).code).toBe(ErrorCodes.FISCAL_CUTOVER_PENDING)
    await expect(openNumberSequence(fake({ issuer: null }).conn, SCOPE, 1, null)).rejects.toThrow(/sem habilitação viva/)
    await expect(openNumberSequence(fake({ row: { n: 0, d: 'S' } }).conn, SCOPE, 1, null)).rejects.toThrow(/marcada como excluída/)
  })
})

describe('superfície — lado de escrita só no barrel', () => {
  it('as peças estão no barrel e FORA de `fiscal-api/reading` (o ERP web não gera número — D-NE255/D-NE257)', () => {
    for (const n of ['nextInvoiceNumber', 'lockNumberSequence', 'openNumberSequence', 'assertNumberSequenceDomainsEnforced', 'NUMBER_SEQUENCE_TABLE',
      'NUMBER_SEQUENCE_MODELS', 'MAX_INVOICE_NUMBER']) {
      expect([n, n in barrel, n in reading]).toEqual([n, true, false])
    }
  })
})
// ---------------------------------------------------------------- T2: os textos antigos deixam de dizer que o ERP web cunha o número
describe('cerca de texto — a D-NE257 trocou a D-F21 no ponto do número', () => {
  const SRC = path.resolve(__dirname, '..')
  const FILES = ['numbering/withdrawn-ranges.ts', 'establishment/issuer-view.ts', 'reading.ts', 'establishment/establishment.ts', 'index.ts']
  const lines = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').split(/\r?\n/)

  it('nenhuma linha liga "cunhar" ao ERP/setes-api sem citar a D-NE257, e ninguém diz que o número do 55/65 é do ERP', () => {
    const bad: string[] = []
    for (const rel of FILES) {
      lines(rel).forEach((line, i) => {
        const minting = /cunh/i.test(line) && /\b(ERP|setes-api)\b/i.test(line) && !/D-NE257/.test(line)
        const numberOfErp = /s[ée]rie\s*\/\s*n[úu]mero deles [ée] do ERP/i.test(line) || /n[úu]mero do 55(\/65)? (s[ãa]o|[ée]) (cunhad[oa]s? )?(pel|d)o ERP/i.test(line)
        if (minting || numberOfErp) bad.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(bad).toEqual([])
  })
  it('as duas peças de leitura dizem quem lê agora (D-NE257) e a superfície diz que a escrita fica fora', () => {
    for (const rel of ['numbering/withdrawn-ranges.ts', 'establishment/issuer-view.ts', 'reading.ts']) {
      expect([rel, lines(rel).some(l => /D-NE257/.test(l))]).toEqual([rel, true])
    }
    expect(lines('reading.ts').join('\n')).toMatch(/numbering\/number-sequence`\) NÃO entra aqui/)
  })
})