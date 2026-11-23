/// <reference types="jest" />
// fiscal-api:FAMILIA.E5.P5 — o último número da NF-e por estabelecimento × modelo × série × ambiente (D-NE255, D-NE257, D-NE263, D-NE265,
// Valdo 2026-11-23). Puro: o texto da migration 008 e as peças com conexão simulada; o motor fica em `motor-banco.live.test.ts`.
import fs from 'fs'
import path from 'path'
import { splitStatements } from '../db/migrations'
import { NUMBER_SEQUENCE_TABLE, assertNumberSequenceDomainsEnforced } from '../numbering/number-sequence'

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
