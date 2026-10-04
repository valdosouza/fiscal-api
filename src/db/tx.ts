import { Pool, PoolConnection } from 'mysql2/promise'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'
import { logger } from '../log/logger'

/**
 * Qualquer coisa que execute SQL: o pool ou a CONEXÃO da transação em curso (dentro de transação,
 * SEMPRE a conexão dela — nunca uma 2ª conexão do pool com locks seguros; C1 da onda TZ-1).
 */
export interface Queryable {
  query(sql: string, values?: unknown): Promise<[any, any]>
}

export function isLockWaitTimeout(err: unknown): boolean {
  return (err as any)?.code === 'ER_LOCK_WAIT_TIMEOUT'
}

export function isDeadlock(err: unknown): boolean {
  return (err as any)?.code === 'ER_LOCK_DEADLOCK'
}

/** Contenção que chega à borda HTTP é 409 RESOURCE_BUSY (Q-A3 do produto), nunca 500. */
export function contentionToHttpError(err: unknown): HttpError | null {
  if (!isLockWaitTimeout(err) && !isDeadlock(err)) return null
  return new HttpError(409, 'Registro em uso por outra operação — tente novamente', undefined, ErrorCodes.RESOURCE_BUSY)
}

/** D-F41: quanto um COMANDO CURTO (o aluguel do rodízio) espera a linha antes de desistir com 1205 → 409. */
export const SHORT_COMMAND_LOCK_WAIT_SECONDS = 3

/**
 * D-F41 (Valdo, 2026-10-04) — COMANDO CURTO numa linha disputada (ex.: UPDATE do aluguel na linha da habilitação):
 *  - roda em AUTOCOMMIT numa conexão própria, só durante o comando — condição para reexecutar SÓ o comando (o 1213 já o
 *    desfez); nunca chamar com a conexão de uma transação aberta;
 *  - espera no máximo [waitSeconds] pela linha (`innodb_lock_wait_timeout` na SESSÃO, devolvido ao valor que a conexão
 *    TINHA — não ao global: o pool pode ter a sua — UPDATE não aceita `WAIT n`; vale em MariaDB e MySQL); se a devolução
 *    falha, a conexão é DESCARTADA (nunca volta ao pool com a espera curta);
 *  - deadlock reexecuta 1× com aviso no log (um ciclo novo aparece no log, não some); o que sobra (deadlock de novo, lock
 *    wait) = 409 RESOURCE_BUSY — também para quem chama a peça direto, não só na borda HTTP.
 */
export async function runShortCommand<T>(
  pool: Pool, label: string, meta: Record<string, unknown>, fn: (q: Queryable) => Promise<T>,
  waitSeconds = SHORT_COMMAND_LOCK_WAIT_SECONDS,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const conn = await pool.getConnection()
    // a espera anterior fica numa variável DA SESSÃO (no próprio servidor) e volta dela — nada a interpretar no processo
    let shortened = false
    let restored = false
    try {
      await conn.query('SET @fiscal_short_prev_lw = @@session.innodb_lock_wait_timeout')
      shortened = true                                   // daqui em diante só volta ao pool se a espera for restaurada
      await conn.query('SET SESSION innodb_lock_wait_timeout = ?', [waitSeconds])
      return await fn(conn)
    } catch (err) {
      if (isDeadlock(err) && attempt < 2) {
        logger.warn(`Deadlock no comando curto ${label} — reexecutando`, { ...meta, attempt })
        continue
      }
      throw contentionToHttpError(err) ?? err
    } finally {
      if (shortened) {
        try {
          await conn.query('SET SESSION innodb_lock_wait_timeout = @fiscal_short_prev_lw')
          restored = true
        } catch { /* descartada abaixo */ }
      }
      if (!shortened || restored) conn.release()
      else conn.destroy()
    }
  }
}

/**
 * Transação com reexecução em DEADLOCK (1213 — o InnoDB desfez tudo; reexecutar do zero é seguro;
 * PADROES §9 regra 4). Lock wait (1205) NÃO reexecuta: sobe e vira 409 na borda.
 */
export async function withTransaction<T>(
  pool: Pool, label: string, meta: Record<string, unknown>, fn: (conn: PoolConnection) => Promise<T>, attempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const out = await fn(conn)
      await conn.commit()
      return out
    } catch (err) {
      try { await conn.rollback() } catch { /* conexão pode ter caído — o release resolve */ }
      if (!isDeadlock(err) || attempt >= attempts) throw err
      logger.warn(`Deadlock em ${label} — reexecutando a transação`, { ...meta, attempt })
      await new Promise(r => setTimeout(r, 50 * attempt))
    } finally {
      conn.release()
    }
  }
}
