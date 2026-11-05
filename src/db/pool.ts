import mysql, { Pool, PoolOptions } from 'mysql2/promise'
import { logger } from '../log/logger'

/**
 * Pool das APIs fiscais — UMA instância MySQL para o `fiscal_api` E o ERP (D-F9): a mesma conexão
 * lê `setes_central`/`setes_<cliente>` (fonte de fatos, só leitura + a trava da nota — D-F31) e
 * escreve no `fiscal_api`. Invariantes da casa (PADROES_BANCO §9/§10), fixados POR CONEXÃO e
 * conferidos no boot (`assertSessionInvariants`):
 *  - REPEATABLE READ (Q-G17) — os gap/range locks e a leitura travante dependem dele;
 *  - sessão em UTC (`timezone: 'Z'` do driver + `SET time_zone = '+00:00'` — Q-TZ1);
 *  - sessão ESTRITA (D-NE172, Valdo 2026-10-31 — `STRICT_ALL_TABLES` SOMADO ao modo do servidor): sem ele o MariaDB do dev TRUNCA o valor
 *    maior que a coluna ANTES do CHECK (`access_key` de 45 gravava os 44 primeiros; 'HX' virava 'H') e o domínio "que fecha o que passa
 *    por fora" valia só para o CONTEÚDO, nunca para o COMPRIMENTO — com ele, 1406 (ER_DATA_TOO_LONG). Os outros modos do servidor ficam
 *    como estão (o MySQL 8 da F3 traz os dele — D-NE165). ⚠️ CONHECIMENTO NEGATIVO: `INSERT IGNORE` segue rebaixando o erro a AVISO mesmo
 *    na sessão estrita (o `IGNORE` vence o STRICT) — quem precisa do domínio confere ANTES (PADROES_BANCO §11 regra 11 (a)).
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
    // gates da D-NE172 (LOW): a conexão que NÃO recebeu um invariante é DESTRUÍDA — nunca segue no pool fora da casa (o boot confere uma
    // conexão só; antes o SET que falhava só ia ao log). O comando seguinte nela falha ALTO e o pool abre outra.
    const raw = conn as unknown as { query: (sql: string, cb: (err: unknown, rows?: any) => void) => void; destroy?: () => void }
    let dead = false                                          // a 1ª falha mata a conexão; as seguintes (o que já estava na fila) não repetem
    const onFail = (what: string) => (err: unknown) => {
      if (dead) return
      dead = true
      logger.error(`Conexão nova sem ${what} — invariante da casa violada; conexão DESTRUÍDA`, { err })
      try { raw.destroy?.() } catch { /* já caiu */ }
    }
    // D-NE175 (Valdo 2026-11-05, Q-NE175 = (a)): o modo é conferido em TODA conexão nova, não só no boot — o servidor que muda o
    // `sql_mode` GLOBAL depois do boot, outro servidor atrás de um proxy, ou um script que nunca passa pelo boot herdariam o modo proibido
    // (provado: com NO_BACKSLASH_ESCAPES a quebra de linha do PEM grava como barra + 'n' SEM erro, e um texto montado injeta SQL).
    // ⚠️ CONHECIMENTO NEGATIVO (provado no motor real, mysql2 3.x): o retorno de um comando da conexão chega num `process.nextTick` DEPOIS
    // de o mysql2 já ter despachado o PRÓXIMO comando da fila — uma conferência ASSÍNCRONA (ler o modo e destruir) mata a conexão tarde
    // demais: o 1º comando de quem a pediu já foi ao servidor no modo errado. Por isso a defesa é do SERVIDOR, que executa em ordem:
    // (1) lê o modo HERDADO antes de qualquer SET — proibido nele = alarme + conexão DESTRUÍDA; (2) o SET da casa RETIRA da sessão os itens
    // proibidos (e os modos combinados que os trazem) e soma o estrito — o comando que escapar antes da destruição já roda seguro;
    // (3) confere o modo final da sessão. O boot e o executor conferem o modo GLOBAL do servidor (o servidor torto não sobe — D-NE174).
    raw.query('SELECT @@SESSION.sql_mode AS m', (err, rows) => {
      if (err) return onFail('a leitura do sql_mode herdado')(err)
      const bad = forbiddenSqlModesIn(String(rows?.[0]?.m ?? ''))
      if (bad.length) onFail(`o modo herdado limpo (o servidor entregou ${bad.join(' e ')} — D-NE175)`)(new Error(String(rows?.[0]?.m ?? '')))
    })
    raw.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ', err => { if (err) onFail('REPEATABLE READ')(err) })
    raw.query(`SET time_zone = '+00:00'`, err => { if (err) onFail("time_zone '+00:00'")(err) })
    raw.query(STRICT_SESSION_SQL, err => { if (err) onFail(REQUIRED_SQL_MODE)(err) })
    raw.query('SELECT @@SESSION.sql_mode AS m', (err, rows) => {
      if (err) return onFail('a leitura do sql_mode')(err)
      try { assertSqlModeOfHouse(String(rows?.[0]?.m ?? ''), 'da conexão nova do pool') } catch (e) { onFail('o modo da casa')(e) }
    })
  })
  return pool
}

/** D-NE172: o modo que a sessão da casa EXIGE (somado ao do servidor — nunca substitui os outros). */
export const REQUIRED_SQL_MODE = 'STRICT_ALL_TABLES'
/**
 * D-NE175: o que o SET da sessão RETIRA do modo herdado — os dois proibidos (D-NE174) e os modos COMBINADOS do MariaDB que os trazem de volta
 * (o motor expande `ANSI`, `ORACLE`, `MSSQL`, `POSTGRESQL`, `DB2`, `MAXDB` com o `ANSI_QUOTES` e mantém o nome do combinado na lista — tirar
 * só o `ANSI_QUOTES` e deixar o `ANSI` o reativaria). Os itens individuais que o combinado trouxe (ex.: `PIPES_AS_CONCAT`) ficam.
 */
export const SQL_MODES_STRIPPED_FROM_SESSION = Object.freeze([
  'NO_BACKSLASH_ESCAPES', 'ANSI_QUOTES', 'ANSI', 'ORACLE', 'MSSQL', 'POSTGRESQL', 'DB2', 'MAXDB',
] as const)

const strippedInheritedMode = SQL_MODES_STRIPPED_FROM_SESSION.reduce(
  (expr, item) => `REPLACE(${expr}, ',${item},', ',')`, `CONCAT(',', @@SESSION.sql_mode, ',')`)

/**
 * O comando que cada conexão nova roda (e o executor de migrations): o modo herdado do servidor SEM os itens proibidos (D-NE174/D-NE175),
 * SOMADO ao estrito (D-NE172) — os outros modos do servidor ficam (vazio → só o estrito).
 */
export const STRICT_SESSION_SQL =
  `SET SESSION sql_mode = CONCAT_WS(',', NULLIF(TRIM(BOTH ',' FROM ${strippedInheritedMode}), ''), '${REQUIRED_SQL_MODE}')`

/** O modo da sessão contém o exigido (a lista do motor é separada por vírgula, em maiúsculas — comparação por item, nunca por pedaço). */
export function sqlModeIsStrict(sqlMode: string): boolean {
  return String(sqlMode).split(',').map(m => m.trim().toUpperCase()).includes(REQUIRED_SQL_MODE)
}

/**
 * D-NE174 (Valdo 2026-11-05, Q-NE174 = (a)): o modo estrito SOMA ao do servidor, e a casa RECUSA herdar os modos que quebram o escape
 * feito pelo DRIVER nos `?` (o mysql2 escapa no CLIENTE com barra invertida e aspas simples): `NO_BACKSLASH_ESCAPES` faz a barra virar
 * literal — o `'` escapado como `\'` FECHA o texto e o resto vira SQL (um texto do fisco ou o motivo digitado pelo usuário rompe o
 * comando) — e `ANSI_QUOTES` muda o sentido das aspas duplas. O modo `ANSI` do servidor inclui o `ANSI_QUOTES` (o motor expande).
 * O SERVIDOR que o traz é recusado no boot das APIs e no executor de migrations (modo GLOBAL — `assertServerSqlModeClean`); a CONEXÃO nova
 * que o herda depois do boot é destruída com alarme, e a sessão da casa o RETIRA no SET (D-NE175 — a defesa que o servidor executa em ordem).
 * Nunca "corrigido" calado: retirar da sessão é a cinta; o alarme e a recusa do servidor são a regra.
 */
export const FORBIDDEN_SQL_MODES = Object.freeze(['NO_BACKSLASH_ESCAPES', 'ANSI_QUOTES'] as const)

/** Os modos proibidos presentes no modo da sessão (comparação por ITEM, maiúsculas). */
export function forbiddenSqlModesIn(sqlMode: string): string[] {
  const items = String(sqlMode).split(',').map(m => m.trim().toUpperCase())
  return FORBIDDEN_SQL_MODES.filter(f => items.includes(f))
}

/** A conferência ÚNICA do modo da sessão da casa (pool e executor de migrations): estrito presente E nenhum modo proibido. */
export function assertSqlModeOfHouse(sqlMode: string, who: string): void {
  // os DOIS problemas numa mensagem só (gate socrático L6: o operador não corrige um e bate no outro no boot seguinte)
  const problems: string[] = []
  if (!sqlModeIsStrict(sqlMode)) {
    problems.push(`a casa exige ${REQUIRED_SQL_MODE} (D-NE172: sem ele o motor trunca o texto maior que a coluna antes do CHECK)`)
  }
  const bad = forbiddenSqlModesIn(sqlMode)
  if (bad.length) {
    problems.push(`traz ${bad.join(' e ')} herdado do servidor — a casa o recusa (D-NE174: quebra o escape do driver nos parâmetros `
      + 'e o sentido das aspas; tire do sql_mode do servidor antes de subir)')
  }
  if (problems.length) throw new Error(`Modo da sessão ${who} é '${sqlMode || 'vazio'}': ${problems.join('; ')}`)
}

/** Boot: confere REPEATABLE READ, UTC e a sessão ESTRITA sem modo proibido (falha alto — nunca roda fora dos invariantes). */
export async function assertSessionInvariants(pool: Pool): Promise<{ isolation: string; timeZone: string; sqlMode: string }> {
  const [iso] = await pool.query<any[]>(`SHOW VARIABLES WHERE Variable_name IN ('tx_isolation', 'transaction_isolation')`)
  const isolation = String(iso[0]?.Value ?? '')
  if (isolation !== 'REPEATABLE-READ') {
    throw new Error(`Isolamento da conexão é ${isolation || 'desconhecido'} — a casa exige REPEATABLE-READ`)
  }
  const [tz] = await pool.query<any[]>(`SELECT @@session.time_zone AS tz`)
  const timeZone = String(tz[0]?.tz ?? '')
  if (timeZone !== '+00:00') throw new Error(`Fuso da sessão é ${timeZone || 'desconhecido'} — a casa exige '+00:00'`)
  const [mode] = await pool.query<any[]>(`SELECT @@SESSION.sql_mode AS m, @@GLOBAL.sql_mode AS g`)
  const sqlMode = String(mode[0]?.m ?? '')
  assertSqlModeOfHouse(sqlMode, 'do pool')
  assertServerSqlModeClean(String(mode[0]?.g ?? ''), 'no boot do pool')
  return { isolation, timeZone, sqlMode }
}

/**
 * D-NE174 depois da D-NE175: a sessão da casa RETIRA os itens proibidos, então ela sempre sai limpa — quem acusa o SERVIDOR torto é o modo
 * GLOBAL dele, conferido no boot das APIs e no executor de migrations: o servidor que traz o modo proibido NÃO sobe (decisão do Valdo).
 */
export function assertServerSqlModeClean(globalMode: string, who: string): void {
  const bad = forbiddenSqlModesIn(globalMode)
  if (bad.length) {
    throw new Error(`O sql_mode GLOBAL do servidor (${who}) é '${globalMode}': traz ${bad.join(' e ')} — a casa o recusa (D-NE174: quebra o escape `
      + 'do driver nos parâmetros e o sentido das aspas; tire do sql_mode do servidor antes de subir)')
  }
}
