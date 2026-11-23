import type { Pool } from 'mysql2/promise'
import { assertCheckRefuses, CheckProbe } from '../db/check'

/**
 * O ÚLTIMO NÚMERO da NF-e/NFC-e — peça do núcleo (fiscal-api:FAMILIA.E5.P5; D-NE255, D-NE257, D-NE263 e D-NE265, Valdo 2026-11-23): o nNF
 * do 55 nasce na TRANSMISSÃO, na nfe-api, do último número guardado em `tb_invoice_number_sequence` (migration 008 do núcleo) — uma linha
 * por estabelecimento × modelo × série × AMBIENTE. A D-NE257 troca a D-F21 no ponto do número (a série segue do ERP).
 */

/** A tabela do último número (migration 008 do núcleo). */
export const NUMBER_SEQUENCE_TABLE = 'tb_invoice_number_sequence'

/**
 * Boot de quem gera número (a nfe-api): os cinco domínios da tabela são FATO do banco e o MOTOR os aplica — cada sonda, numa transação
 * SEMPRE desfeita, tem de ser recusada pelo CHECK de NOME certo (molde `assertIssuerModelDomainEnforced`, D-F45). Cada sonda tem PK própria
 * e todo o resto válido (um motor sem CHECK não colide a 2ª na 1ª — F2A1-07).
 */
export async function assertNumberSequenceDomainsEnforced(pool: Pick<Pool, 'getConnection'>): Promise<void> {
  const probe = (value: string, constraint: string, row: { model?: string; serie?: number; environment?: string; lastNumber?: number; deleted?: string }, serie: number): CheckProbe => ({
    value, constraint,
    params: [row.model ?? '55', row.serie ?? serie, row.environment ?? 'H', row.lastNumber ?? 0, row.deleted ?? 'N'],
    sql: `INSERT INTO ${NUMBER_SEQUENCE_TABLE} (tb_institution_id, model, serie, environment, last_number, deleted) VALUES (0, ?, ?, ?, ?, ?)`,
  })
  await assertCheckRefuses(pool, 'o domínio do último número da NF-e', [
    probe('modelo SE', 'ck_invoice_number_sequence_model_bin', { model: 'SE' }, 1),
    probe('modelo 5', 'ck_invoice_number_sequence_model_bin', { model: '5' }, 2),
    probe('ambiente h', 'ck_invoice_number_sequence_environment_bin', { environment: 'h' }, 3),
    probe('série 1000', 'ck_invoice_number_sequence_serie', { serie: 1000 }, 4),
    probe('número 1000000000', 'ck_invoice_number_sequence_last_number', { lastNumber: 1_000_000_000 }, 5),
    probe('deleted s', 'ck_invoice_number_sequence_deleted_bin', { deleted: 's' }, 6),
  ])
}
