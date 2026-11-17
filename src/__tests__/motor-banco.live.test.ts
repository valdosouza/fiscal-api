// fiscal-api:DEPLOY.E1.P2 — o NÚCLEO conferido no MOTOR do banco (D-NE165; P-DEP-1 = MariaDB 10.11.3 na SaveInCloud, §23.12 de
// prompt_apis_fiscais_isoladas.md). Suíte AO VIVO: só roda com FISCAL_ENGINE_LIVE=1 (o `npm test` e o pack-release a pulam).
//
// Credencial: a do DONO (cria banco e usuário descartáveis) — DB_HOST/DB_PORT/DB_USER/DB_PASSWORD do ambiente ou do arquivo apontado por
// FISCAL_ENGINE_ENV_FILE. Opcional: FISCAL_ENGINE_SERVICE_USER/FISCAL_ENGINE_SERVICE_PASSWORD (+ FISCAL_ENGINE_ERP_SCHEMA) conferem as
// views REAIS do ERP com o GRANT do serviço.
//
// Tudo é DESCARTÁVEL e apagado no fim: banco `fiscal_eng_<hex>`, "ERP" `fiscal_eng_<hex>_erp`, "central" `fiscal_eng_<hex>_central` e o
// usuário `fiscal_eng_<hex>`. Nunca `setes_*` (o SCHEMA_RE dos serviços varre esse prefixo) nem `fiscal_api_adv*` (a nfse-api apaga as
// sobras com esse prefixo). O usuário descartável tem o GRANT no FORMATO do serviço (nfse-api ops/grants.sql): ALL no banco fiscal, SÓ
// SELECT no "ERP" (`setes\_%`), SÓ SELECT na view da "central" (`setes_central.vw_user_link`).
//
// T2: as migrations 001–005 aplicam, a 2ª corrida não aplica nada, e apagado o registro em `_migrations` elas RE-EXECUTAM sem erro e o
//     schema sai igual (D-F123); o banco e as tabelas nascem utf8mb4 mesmo com o padrão utf8mb3 do servidor (§23.12).
// T1: o CHECK de model e environment é aplicado (as sondas do boot — D-F45/D-NE84/D-F120); as views respondem com o GRANT mínimo; a
//     leitura travante (FOR UPDATE da nota — D-F27/D-F31 — e a COMPARTILHADA da view de vida) funciona com SÓ SELECT e trava de verdade;
//     o servidor é primário único (não é réplica, não é Galera, read_only desligado, todas as conexões no MESMO servidor — D-F9).
// IBS.E1.P1 (fase IBS/CBS): sonda SEM tabela — `CAST(<DECIMAL(17,2)> AS CHAR)` chega pelo pool da casa como texto decimal canônico (a
//     suposição do leitor dos valores do fisco); roda sozinha com `-t "IBS.E1.P1"`, sem criar nada.
import fs from 'fs'
import crypto from 'crypto'
import mysql, { Connection, Pool } from 'mysql2/promise'
import { runMigrations, CORE_MIGRATIONS_DIR, CORE_MIGRATIONS_PROJECT } from '../db/migrations'
import { createFiscalPool, assertSessionInvariants, FiscalDbConfig } from '../db/pool'
import { assertIssuerModelDomainEnforced, assertIssuerEnvironmentDomainEnforced } from '../establishment/establishment.repository'
import { assertSessionViewReadable } from '../access/access'
import { mapServiceAuthorityIbscbs } from '../voice/families/service-authority-ibscbs'
import { invoiceRef } from '../ref/invoice-ref'

const LIVE = process.env.FISCAL_ENGINE_LIVE === '1'
const d = LIVE ? describe : describe.skip

function readEnvFile(file: string | undefined): Record<string, string> {
  if (!file) return {}
  const out: Record<string, string> = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

const fileEnv = readEnvFile(process.env.FISCAL_ENGINE_ENV_FILE)
const env = (k: string): string | undefined => process.env[k] ?? fileEnv[k]

const TAG = `fiscal_eng_${crypto.randomBytes(4).toString('hex')}`
const DB = TAG
const ERP = `${TAG}_erp`
const CENTRAL = `${TAG}_central`
const PROBE_USER = TAG
const PROBE_PASSWORD = crypto.randomBytes(18).toString('base64url')

const owner = {
  host: env('DB_HOST') ?? 'localhost', port: Number(env('DB_PORT') ?? 3306),
  user: env('DB_USER') ?? '', password: env('DB_PASSWORD') ?? '',
}

/** O relatório do motor — a prova da tarefa (sem segredo). */
const report: Record<string, unknown> = {}

d('DEPLOY.E1.P2 — o núcleo no motor real do banco', () => {
  let root: Connection
  let probeHost = '%'
  let ownerCfg: FiscalDbConfig
  let probeCfg: FiscalDbConfig
  const pools: Pool[] = []
  const probeConn = (database = DB) => mysql.createConnection({ host: owner.host, port: owner.port, user: PROBE_USER, password: PROBE_PASSWORD,
    database, timezone: 'Z' })

  beforeAll(async () => {
    if (!owner.user) throw new Error('FISCAL_ENGINE_LIVE=1 sem DB_USER do dono (ambiente ou FISCAL_ENGINE_ENV_FILE)')
    root = await mysql.createConnection({ ...owner, timezone: 'Z' })
    const [who] = await root.query<any[]>(`SELECT USER() AS u, VERSION() AS v, @@version_comment AS c, @@hostname AS h, @@server_id AS sid,
      @@character_set_server AS cs, @@collation_server AS co, @@GLOBAL.sql_mode AS gm`)
    // o usuário descartável nasce no HOST de onde o dono chega (evita o anônimo ''@localhost vencer o '%')
    probeHost = String(who[0].u).split('@')[1] || '%'
    Object.assign(report, { version: who[0].v, versionComment: who[0].c, hostname: who[0].h, serverId: who[0].sid,
      charsetServer: who[0].cs, collationServer: who[0].co, globalSqlMode: who[0].gm })
    ownerCfg = { ...owner, database: DB, connectionLimit: 8 }
    probeCfg = { host: owner.host, port: owner.port, user: PROBE_USER, password: PROBE_PASSWORD, database: DB, connectionLimit: 8 }
  })

  afterAll(async () => {
    for (const p of pools) await p.end().catch(() => undefined)
    if (root) {
      await root.query(`DROP USER IF EXISTS ?@?`, [PROBE_USER, probeHost]).catch(() => undefined)
      for (const db of [DB, ERP, CENTRAL]) await root.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => undefined)
      const [left] = await root.query<any[]>(`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE ?`, [`${TAG}%`])
      await root.end()
      if (left.length) throw new Error(`Sobrou banco descartável: ${left.map(r => r.SCHEMA_NAME).join(', ')}`)
    }
    // eslint-disable-next-line no-console
    console.log(`Relatório do motor (DEPLOY.E1.P2): ${JSON.stringify(report, null, 2)}`)
  })

  async function schemaSnapshot(): Promise<string> {
    const out: string[] = []
    for (const t of ['tb_establishment_certificate', 'tb_establishment_issuer']) {
      const [rows] = await root.query<any[]>(`SHOW CREATE TABLE \`${DB}\`.\`${t}\``)
      out.push(String(rows[0]['Create Table']))
    }
    const [ck] = await root.query<any[]>(`SELECT CONSTRAINT_NAME AS n, CHECK_CLAUSE AS c FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = ? ORDER BY CONSTRAINT_NAME`, [DB])
    out.push(JSON.stringify(ck))
    return out.join('\n')
  }

  // ---------------------------------------------------------------- IBS.E1.P1 (sonda SEM tabela nem view — só expressão)
  // O leitor dos valores do fisco (`voice/families/service-authority-ibscbs.ts`) supõe que `CAST(<DECIMAL(17,2)> AS CHAR)` chega pelo pool
  // da casa (`decimalNumbers: true`) como TEXTO decimal canônico — 2 casas, sem zero à esquerda, charset não binário (senão viria Buffer).
  // Aqui se prova a suposição no motor, com a FORMA do SELECT publicado e o mapa estrito da peça; a leitura pela view REAL é da família
  // (`nfse-api:IBS.E4.P1`). Roda sozinha com `-t "IBS.E1.P1"`: não cria banco, tabela, view nem usuário.
  describe('IBS.E1.P1 — o texto de um DECIMAL(17,2) pelo pool da casa', () => {
    it('CAST(… AS CHAR) chega como texto decimal canônico e passa pelo mapa estrito; SEM o CAST o pool entrega número (e perde o centavo no topo)', async () => {
      const pool = createFiscalPool({ ...owner, database: 'information_schema', connectionLimit: 2 }); pools.push(pool)
      const asked = { ref: invoiceRef(1, 8014, 0), lifeEvent: 3 }
      const seen: Record<string, unknown> = {}
      for (const [given, text] of [['0', '0.00'], ['0.01', '0.01'], ['0.09', '0.09'], ['10', '10.00'], ['1234567.8', '1234567.80'], ['999999999999999.99', '999999999999999.99']]) {
        const [rows] = await pool.query<any[]>(
          `SELECT 1 AS institutionId, 8014 AS invoiceId, 0 AS terminal, 2 AS attempt, 3 AS lifeEvent,
                  CAST(CAST(? AS DECIMAL(17,2)) AS CHAR) AS totalInvoiceValue, CAST(CAST(? AS DECIMAL(17,2)) AS CHAR) AS ibsTotalValue,
                  CAST(CAST(? AS DECIMAL(17,2)) AS CHAR) AS cbsValue, CAST(? AS DECIMAL(17,2)) AS semCast`, [given, given, given, given])
        expect(rows).toHaveLength(1)
        expect([given, typeof rows[0].totalInvoiceValue, rows[0].totalInvoiceValue]).toEqual([given, 'string', text])
        const { semCast, ...row } = rows[0]
        expect(mapServiceAuthorityIbscbs(row, asked)).toMatchObject({ totalInvoiceValue: text, ibsTotalValue: text, cbsValue: text, attempt: 2, lifeEvent: 3 })
        expect([given, typeof semCast]).toEqual([given, 'number'])            // o motivo do CAST: sem ele o valor já chegou número
        seen[given] = { comCast: rows[0].totalInvoiceValue, semCast }
      }
      expect(String((seen['999999999999999.99'] as any).semCast)).not.toBe('999999999999999.99')   // DECIMAL(17,2) não cabe em número do JS
      report.decimalAsText = seen
    })
  })

  // ---------------------------------------------------------------- T2
  describe('T2 — as migrations 001–005 aplicam e re-executam', () => {
    let first = ''

    it('aplicam todas, na ordem, num banco novo (o executor confere a sessão estrita e o modo global antes)', async () => {
      const applied = await runMigrations(ownerCfg, [{ project: CORE_MIGRATIONS_PROJECT, dir: CORE_MIGRATIONS_DIR }])
      expect(applied).toEqual([
        'fiscal-api/001_core_baseline', 'fiscal-api/002_issuer_refresh_lease', 'fiscal-api/003_issuer_cutover',
        'fiscal-api/004_issuer_model_domain', 'fiscal-api/005_issuer_domains_binary',
      ])
      first = await schemaSnapshot()
      // 005: sai o CHECK _ci da 004, ficam os dois binários de nome próprio
      expect(first).toContain('ck_establishment_issuer_model_bin')
      expect(first).toContain('ck_establishment_issuer_environment_bin')
      expect(first).not.toMatch(/"n":"ck_establishment_issuer_model"/)
      report.migrationsApplied = applied.length
    })

    it('a 2ª corrida não aplica nada (registro em _migrations)', async () => {
      expect(await runMigrations(ownerCfg, [{ project: CORE_MIGRATIONS_PROJECT, dir: CORE_MIGRATIONS_DIR }])).toEqual([])
    })

    it('apagado o registro, as 001–005 RE-EXECUTAM sem erro e o schema sai igual (D-F123 — processo morto entre o ALTER e o registro)', async () => {
      await root.query(`DELETE FROM \`${DB}\`.\`_migrations\` WHERE project = ?`, [CORE_MIGRATIONS_PROJECT])
      const again = await runMigrations(ownerCfg, [{ project: CORE_MIGRATIONS_PROJECT, dir: CORE_MIGRATIONS_DIR }])
      expect(again).toHaveLength(5)
      expect(await schemaSnapshot()).toBe(first)
      report.migrationsReexecuted = again.length
    })

    it('o banco e as tabelas nascem utf8mb4 declarado, qualquer que seja o padrão do servidor (§23.12: utf8mb3 na SaveInCloud)', async () => {
      const [db] = await root.query<any[]>(`SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS co
        FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`, [DB])
      expect(db[0]).toEqual({ cs: 'utf8mb4', co: 'utf8mb4_unicode_ci' })
      const [tabs] = await root.query<any[]>(`SELECT TABLE_NAME AS t, TABLE_COLLATION AS co FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [DB])
      expect(tabs.map(r => String(r.t)).sort()).toEqual(['_migrations', 'tb_establishment_certificate', 'tb_establishment_issuer'])
      for (const r of tabs) expect(r.co).toBe('utf8mb4_unicode_ci')
      const [cols] = await root.query<any[]>(`SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND CHARACTER_SET_NAME IS NOT NULL AND CHARACTER_SET_NAME <> 'utf8mb4'`, [DB])
      expect(Number(cols[0].n)).toBe(0)
    })
  })

  // ---------------------------------------------------------------- T1
  describe('T1 — CHECK, views, leitura travante com GRANT mínimo e primário único', () => {
    beforeAll(async () => {
      // "ERP" e "central" descartáveis, com a FORMA das tabelas que o núcleo trava e lê
      await root.query(`CREATE DATABASE \`${ERP}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
      await root.query(`CREATE TABLE \`${ERP}\`.tb_invoice (id INT NOT NULL, tb_institution_id INT NOT NULL, terminal INT NOT NULL,
        deleted CHAR(1) NOT NULL DEFAULT 'N', PRIMARY KEY (id, tb_institution_id, terminal)) ENGINE=InnoDB`)
      await root.query(`INSERT INTO \`${ERP}\`.tb_invoice VALUES (1, 7, 3, 'N'), (2, 7, 3, 'N')`)
      await root.query(`CREATE VIEW \`${ERP}\`.vw_invoice_life AS
        SELECT id AS tb_invoice_id, tb_institution_id, terminal, deleted AS invoice_deleted FROM \`${ERP}\`.tb_invoice`)
      await root.query(`CREATE DATABASE \`${CENTRAL}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
      await root.query(`CREATE TABLE \`${CENTRAL}\`.tb_user (id INT PRIMARY KEY, secret VARCHAR(20)) ENGINE=InnoDB`)
      await root.query(`INSERT INTO \`${CENTRAL}\`.tb_user VALUES (1, 'x')`)
      await root.query(`CREATE VIEW \`${CENTRAL}\`.vw_user_link AS SELECT id AS tb_user_id FROM \`${CENTRAL}\`.tb_user`)
      // GRANT no formato do serviço (nfse-api ops/grants.sql): ALL no fiscal, SÓ SELECT no ERP, SÓ SELECT na view da central
      await root.query(`CREATE USER ?@? IDENTIFIED BY ?`, [PROBE_USER, probeHost, PROBE_PASSWORD])
      await root.query(`GRANT ALL PRIVILEGES ON \`${DB}\`.* TO ?@?`, [PROBE_USER, probeHost])
      await root.query(`GRANT SELECT ON \`${ERP}\`.* TO ?@?`, [PROBE_USER, probeHost])
      await root.query(`GRANT SELECT ON \`${CENTRAL}\`.\`vw_user_link\` TO ?@?`, [PROBE_USER, probeHost])
      const [g] = await root.query<any[]>(`SHOW GRANTS FOR ?@?`, [PROBE_USER, probeHost])
      report.probeGrants = g.map(r => String(Object.values(r)[0]).replace(/IDENTIFIED BY PASSWORD '[^']*'/, 'IDENTIFIED BY PASSWORD <…>'))
    })

    it('o pool do núcleo sobe com os invariantes da casa (REPEATABLE READ, UTC, sessão estrita) com o usuário de GRANT mínimo', async () => {
      const pool = createFiscalPool(probeCfg); pools.push(pool)
      const inv = await assertSessionInvariants(pool)
      expect(inv.isolation).toBe('REPEATABLE-READ')
      report.sessionSqlMode = inv.sqlMode
    })

    it('o CHECK de model e environment é APLICADO pelo motor (as sondas do boot: ZZ e se; X e h — cada uma pelo CHECK de nome certo)', async () => {
      const pool = createFiscalPool(probeCfg); pools.push(pool)
      await expect(assertIssuerModelDomainEnforced(pool)).resolves.toBeUndefined()
      await expect(assertIssuerEnvironmentDomainEnforced(pool)).resolves.toBeUndefined()
      // e um valor do domínio passa (a sonda não é "o motor recusa tudo")
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        await conn.query(`INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment) VALUES (0, 'SE', 'H'), (0, '55', 'P')`)
      } finally { await conn.rollback(); conn.release() }
      report.checkEnforced = true
    })

    it('as views respondem com o GRANT mínimo: SELECT só na view (forma da vw_user_link) lê a view e NÃO a tabela de baixo', async () => {
      const c = await probeConn()
      try {
        const [rows] = await c.query<any[]>(`SELECT tb_user_id FROM \`${CENTRAL}\`.vw_user_link`)
        expect(rows).toEqual([{ tb_user_id: 1 }])
        await expect(c.query(`SELECT secret FROM \`${CENTRAL}\`.tb_user`)).rejects.toMatchObject({ errno: 1142 })
        const [life] = await c.query<any[]>(`SELECT tb_invoice_id, invoice_deleted FROM \`${ERP}\`.vw_invoice_life
          WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ?`, [7, 1, 3])
        expect(life).toEqual([{ tb_invoice_id: 1, invoice_deleted: 'N' }])
      } finally { await c.end() }
      report.viewsRespond = true
    })

    it('a leitura TRAVANTE funciona com SÓ SELECT no ERP (a instrução da lockInvoice) e trava de verdade; escrever no ERP é recusado', async () => {
      const a = await probeConn(), b = await probeConn()
      try {
        await b.query(`SET SESSION innodb_lock_wait_timeout = 1`)
        await a.beginTransaction()
        const [locked] = await a.query<any[]>(
          `SELECT deleted FROM \`${ERP}\`.tb_invoice WHERE id = ? AND tb_institution_id = ? AND terminal = ? FOR UPDATE`, [1, 7, 3])
        expect(locked).toEqual([{ deleted: 'N' }])
        // a leitura travante COMPARTILHADA da view de vida (lockInvoice, D-F32) também passa com SÓ SELECT
        const [shared] = await a.query<any[]>(`SELECT invoice_deleted FROM \`${ERP}\`.vw_invoice_life
          WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ? LOCK IN SHARE MODE`, [7, 1, 3])
        expect(shared).toEqual([{ invoice_deleted: 'N' }])
        // a trava é REAL: outra sessão espera e cai no 1205 — a outra nota segue livre
        await b.beginTransaction()
        await expect(b.query(`SELECT deleted FROM \`${ERP}\`.tb_invoice WHERE id = 1 AND tb_institution_id = 7 AND terminal = 3 FOR UPDATE`))
          .rejects.toMatchObject({ errno: 1205 })
        const [free] = await b.query<any[]>(
          `SELECT deleted FROM \`${ERP}\`.tb_invoice WHERE id = 2 AND tb_institution_id = 7 AND terminal = 3 FOR UPDATE`)
        expect(free).toHaveLength(1)
        await b.rollback()
        // o GRANT é MÍNIMO de fato: o serviço não escreve no ERP
        await expect(a.query(`UPDATE \`${ERP}\`.tb_invoice SET deleted = 'S' WHERE id = 1`)).rejects.toMatchObject({ errno: 1142 })
        await a.rollback()
      } finally { await a.end(); await b.end() }
      report.lockingReadWithSelectOnly = true
    })

    it('o servidor é PRIMÁRIO ÚNICO: não é réplica, não é Galera, read_only desligado, e toda conexão cai no MESMO servidor', async () => {
      const [vars] = await root.query<any[]>(`SHOW GLOBAL VARIABLES WHERE Variable_name IN ('read_only', 'wsrep_on', 'log_bin', 'server_id')`)
      const v = Object.fromEntries(vars.map(r => [r.Variable_name, String(r.Value)]))
      expect(v.read_only).toBe('OFF')
      expect(v.wsrep_on ?? 'OFF').toBe('OFF')
      let replica: any[]
      try { [replica] = await root.query<any[]>(`SHOW SLAVE STATUS`) } catch (err: any) {
        throw new Error(`SHOW SLAVE STATUS recusado ao dono (${err?.code}) — sem ele não se prova "não é réplica"; rode com um dono que tenha `
          + 'REPLICATION CLIENT/SLAVE MONITOR')
      }
      expect(replica).toHaveLength(0)
      let replicasAttached: number | string = 'sem privilégio para listar'
      try { const [h] = await root.query<any[]>(`SHOW SLAVE HOSTS`); replicasAttached = h.length } catch { /* só informativo */ }
      // um proxy que reparte conexões entre servidores apareceria aqui: N conexões do pool do núcleo, um servidor só
      const pool = createFiscalPool(probeCfg); pools.push(pool)
      const held = await Promise.all(Array.from({ length: 6 }, () => pool.getConnection()))
      const seen = new Set<string>()
      try {
        for (const c of held) {
          const [r] = await c.query<any[]>(`SELECT @@server_id AS s, @@hostname AS h`)
          seen.add(`${r[0].s}@${r[0].h}`)
        }
      } finally { held.forEach(c => c.release()) }
      expect(seen.size).toBe(1)
      Object.assign(report, { readOnly: v.read_only, wsrep: v.wsrep_on ?? 'ausente', logBin: v.log_bin, isReplica: false,
        replicasAttached, connectionsOnOneServer: [...seen][0] })
    })

    const svcUser = env('FISCAL_ENGINE_SERVICE_USER')
    const erpSchema = env('FISCAL_ENGINE_ERP_SCHEMA')
    ;(svcUser ? it : it.skip)('views REAIS do ERP respondem com o usuário do serviço (opcional: FISCAL_ENGINE_SERVICE_* e _ERP_SCHEMA)', async () => {
      const c = await mysql.createConnection({ host: owner.host, port: owner.port, user: svcUser, password: env('FISCAL_ENGINE_SERVICE_PASSWORD') ?? '' })
      try {
        await expect(assertSessionViewReadable(c)).resolves.toBe('ok')
        if (erpSchema) {
          if (!/^setes_[a-z0-9_]+$/.test(erpSchema)) throw new Error(`FISCAL_ENGINE_ERP_SCHEMA inválido: ${erpSchema}`)
          await c.query(`SELECT tb_invoice_id, invoice_deleted, life_event, last_event, last_kind FROM \`${erpSchema}\`.vw_invoice_life LIMIT 0`)
          await c.query(`SELECT interface_key FROM \`${erpSchema}\`.vw_order_interface LIMIT 0`)
        }
      } finally { await c.end() }
      report.realViews = erpSchema ? `vw_user_link + ${erpSchema}.vw_invoice_life/vw_order_interface` : 'vw_user_link'
    })
  })
})
