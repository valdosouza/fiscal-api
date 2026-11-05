import fs from 'fs'
import path from 'path'
import mysql, { Connection, ConnectionOptions } from 'mysql2/promise'
import { logger } from '../log/logger'
import { FiscalDbConfig, STRICT_SESSION_SQL, assertSqlModeOfHouse, assertServerSqlModeClean } from './pool'

/**
 * EXECUTOR de migrations do banco `fiscal_api` (D-F35): o núcleo cria o executor e as suas
 * tabelas comuns; cada família (nfse-api, nfe-api) aplica as SUAS migrations com namespace
 * próprio em `_migrations (project, version)`. Duas instâncias sobem juntas (D-F9): a trava
 * nomeada `fiscal_api:migrations` serializa quem aplica.
 * Regra de corte de comando = a do setes-api (`src/migrations/runner.ts`): tira comentários de
 * linha e corta em linha que TERMINA com ';' (';' dentro de COMMENT não quebra nada).
 */

export const CORE_MIGRATIONS_PROJECT = 'fiscal-api'
/** Pasta das migrations do núcleo — resolve igual a partir de src/db (ts) e dist/db (js). */
export const CORE_MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'src', 'migrations', 'sql')

export interface MigrationSet {
  project: string
  dir:     string
}

export function splitStatements(sql: string): string[] {
  sql = sql.replace(/--[^\n]*\n/g, '\n')
  const out: string[] = []
  let cur = ''
  let inBlock = false
  for (const line of sql.split('\n')) {
    const t = line.trim().toUpperCase()
    if (t === 'BEGIN') inBlock = true
    if (t === 'END;') inBlock = false
    cur += line + '\n'
    if (!inBlock && line.trim().endsWith(';')) {
      const s = cur.trim().replace(/;$/, '').trim()
      if (s) out.push(s)
      cur = ''
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

function filesOf(set: MigrationSet): { version: string; name: string; file: string }[] {
  if (!fs.existsSync(set.dir)) throw new Error(`Pasta de migrations inexistente: ${set.dir}`)
  return fs.readdirSync(set.dir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(file => {
      const [version, ...rest] = file.replace(/\.sql$/, '').split('_')
      return { version, name: rest.join('_'), file }
    })
}

/**
 * Cria o banco se faltar (utf8mb4_unicode_ci), garante `_migrations` e aplica, NA ORDEM dos sets
 * recebidos (o núcleo primeiro), o que falta de cada projeto. Devolve o que aplicou.
 */
export async function runMigrations(cfg: FiscalDbConfig, sets: MigrationSet[]): Promise<string[]> {
  if (/^setes_/.test(cfg.database) || !/^[a-z0-9_]+$/.test(cfg.database)) throw new Error(`Nome de banco inválido: ${cfg.database}`)
  const options: ConnectionOptions = { host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, timezone: 'Z' }
  const conn: Connection = await mysql.createConnection(options)
  const applied: string[] = []
  try {
    await conn.query(`SET time_zone = '+00:00'`)
    // D-NE173 (Valdo 2026-11-05, Q-NE173 = (a)): o executor escreve DDL e backfill no `fiscal_api` por conexão PRÓPRIA — nasce no MESMO modo
    // estrito do pool (D-NE172), conferido ANTES de aplicar qualquer coisa: uma migration que encurta coluna ou grava dado fora do tamanho
    // FALHA ALTO (antes cortava calada — provado: 'abcdefgh' num VARCHAR(5) gravava 'abcde')
    await conn.query(STRICT_SESSION_SQL)
    // D-NE174: a mesma conferência do pool — estrito presente e nenhum modo que quebre o escape do driver; falhou = nada aplicado
    const [mode] = await conn.query<any[]>(`SELECT @@SESSION.sql_mode AS m, @@GLOBAL.sql_mode AS g`)
    assertSqlModeOfHouse(String(mode[0]?.m ?? ''), 'do executor de migrations (nada aplicado — D-NE173)')
    // D-NE174/D-NE175: a sessão RETIRA os itens proibidos — quem acusa o servidor torto é o modo GLOBAL: ele não migra
    assertServerSqlModeClean(String(mode[0]?.g ?? ''), 'no executor de migrations — nada aplicado')
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    await conn.query(`USE \`${cfg.database}\``)
    const [got] = await conn.query<any[]>(`SELECT GET_LOCK(?, 60) AS ok`, [`${cfg.database}:migrations`])
    if (Number(got[0]?.ok) !== 1) throw new Error('Outra instância está aplicando migrations há mais de 60 s — abortado')
    try {
      await conn.query(
        `CREATE TABLE IF NOT EXISTS \`_migrations\` (
           \`project\`    VARCHAR(40) NOT NULL COMMENT 'Namespace: fiscal-api (núcleo), nfse-api, nfe-api (D-F35)',
           \`version\`    VARCHAR(10) NOT NULL,
           \`name\`       VARCHAR(255) NOT NULL,
           \`applied_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
           PRIMARY KEY (\`project\`, \`version\`)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
      for (const set of sets) {
        const [rows] = await conn.query<any[]>(`SELECT version FROM \`_migrations\` WHERE project = ?`, [set.project])
        const done = new Set(rows.map(r => String(r.version)))
        for (const m of filesOf(set)) {
          if (done.has(m.version)) continue
          const sql = fs.readFileSync(path.join(set.dir, m.file), 'utf8')
          for (const st of splitStatements(sql)) await conn.query(st)
          // gates do delta D-NE173/D-NE174: a migration que mexeu no modo (`SET SESSION sql_mode`, o cabeçalho `/*!40101 SET SQL_MODE … */` do
          // mysqldump) desligaria o estrito para TODAS as seguintes, inclusive de outra família — confere de novo DEPOIS de cada arquivo e,
          // falhou, a migration NÃO é registrada (e o resto não roda). A cerca dos `.sql` impede o texto; esta conferência pega o efeito.
          const [after] = await conn.query<any[]>(`SELECT @@SESSION.sql_mode AS m`)
          assertSqlModeOfHouse(String(after[0]?.m ?? ''), `do executor de migrations depois de ${set.project}/${m.file} (não registrada — D-NE173)`)
          await conn.query(`INSERT INTO \`_migrations\` (project, version, name) VALUES (?, ?, ?)`, [set.project, m.version, m.name])
          applied.push(`${set.project}/${m.version}_${m.name}`)
          logger.info(`Migration aplicada: ${set.project} ${m.version} - ${m.name}`, { database: cfg.database })
        }
      }
    } finally {
      await conn.query(`SELECT RELEASE_LOCK(?)`, [`${cfg.database}:migrations`])
    }
  } finally {
    await conn.end()
  }
  return applied
}
