import mysql, { Pool, PoolOptions } from 'mysql2/promise'
import { logger } from '../log/logger'

/**
 * Pool das APIs fiscais — UMA instância MySQL para o `fiscal_api` E o ERP (D-F9): a mesma conexão
 * lê `setes_central`/`setes_<cliente>` (fonte de fatos, só leitura + a trava da nota — D-F31) e
 * escreve no `fiscal_api`. Invariantes da casa (PADROES_BANCO §9/§10), fixados POR CONEXÃO e
 * conferidos no boot (`assertSessionInvariants`):
 *  - REPEATABLE READ (Q-G17) — os gap/range locks e a leitura travante dependem dele;
 *  - sessão em UTC (`timezone: 'Z'` do driver + `SET time_zone = '+00:00'` — Q-TZ1).
 * O banco DEFAULT é o `fiscal_api` (tabelas da casa sem qualificador); todo SQL sobre o ERP
 * qualifica o schema (`setes_x`.…).
 */

export interface FiscalDbConfig {
  host:     string
  port:     number
  user:     string
  password: string
  /** Nome do banco da casa — D-F7: `fiscal_api` (nunca `setes_*`). */
  database: string
  connectionLimit?: number
  /** Teto da fila de espera por conexão (0 = sem teto). Fila cheia = erro na hora, nunca espera infinita. */
  queueLimit?: number
}

export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FiscalDbConfig {
  return {
    host:     env.DB_HOST ?? 'localhost',
    port:     Number(env.DB_PORT ?? 3306),
    user:     env.DB_USER ?? '',
    password: env.DB_PASSWORD ?? '',
    database: env.FISCAL_DB_NAME ?? 'fiscal_api',
    connectionLimit: env.DB_POOL_SIZE ? Number(env.DB_POOL_SIZE) : undefined,
    queueLimit: env.DB_POOL_QUEUE_LIMIT ? Number(env.DB_POOL_QUEUE_LIMIT) : undefined,
  }
}

export function createFiscalPool(cfg: FiscalDbConfig): Pool {
  if (/^setes_/.test(cfg.database)) {
    throw new Error(`Banco das APIs fiscais não pode se chamar ${cfg.database} — casaria com o SCHEMA_RE dos schemas de cliente (D-F7)`)
  }
  const options: PoolOptions = {
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
    waitForConnections: true,
    connectionLimit: cfg.connectionLimit ?? 20,
    queueLimit: cfg.queueLimit ?? 200,
    decimalNumbers: true,
    timezone: 'Z',
  }
  const pool = mysql.createPool(options)
  pool.on('connection', conn => {
    const onFail = (what: string) => (err: unknown) =>
      logger.error(`Conexão nova sem ${what} — invariante da casa violada`, { err })
    const raw = conn as unknown as { query: (sql: string, cb: (err: unknown) => void) => void }
    raw.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ', err => { if (err) onFail('REPEATABLE READ')(err) })
    raw.query(`SET time_zone = '+00:00'`, err => { if (err) onFail("time_zone '+00:00'")(err) })
  })
  return pool
}

/** Boot: confere REPEATABLE READ e UTC na sessão (falha alto — nunca roda fora dos invariantes). */
export async function assertSessionInvariants(pool: Pool): Promise<{ isolation: string; timeZone: string }> {
  const [iso] = await pool.query<any[]>(`SHOW VARIABLES WHERE Variable_name IN ('tx_isolation', 'transaction_isolation')`)
  const isolation = String(iso[0]?.Value ?? '')
  if (isolation !== 'REPEATABLE-READ') {
    throw new Error(`Isolamento da conexão é ${isolation || 'desconhecido'} — a casa exige REPEATABLE-READ`)
  }
  const [tz] = await pool.query<any[]>(`SELECT @@session.time_zone AS tz`)
  const timeZone = String(tz[0]?.tz ?? '')
  if (timeZone !== '+00:00') throw new Error(`Fuso da sessão é ${timeZone || 'desconhecido'} — a casa exige '+00:00'`)
  return { isolation, timeZone }
}
