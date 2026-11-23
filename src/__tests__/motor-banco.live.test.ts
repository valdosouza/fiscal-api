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
// T2: as migrations 001–008 aplicam, a 2ª corrida não aplica nada, e apagado o registro em `_migrations` elas RE-EXECUTAM sem erro e o
//     schema sai igual (D-F123); o banco e as tabelas nascem utf8mb4 mesmo com o padrão utf8mb3 do servidor (§23.12).
// T1: o CHECK de model e environment é aplicado (as sondas do boot — D-F45/D-NE84/D-F120); as views respondem com o GRANT mínimo; a
//     leitura travante (FOR UPDATE da nota — D-F27/D-F31 — e a COMPARTILHADA da view de vida) funciona com SÓ SELECT e trava de verdade;
//     o servidor é primário único (não é réplica, não é Galera, read_only desligado, todas as conexões no MESMO servidor — D-F9).
// FAMILIA.E5.P4.T4: a 006 (configuração fiscal por UF) — sondas dos CHECKs binários, semente, FK composta do dono, 1062 da PK, o boot que
//     recusa sem o CSRT exigido e passa com uma credencial FICTÍCIA, e o script de cadastro (D-NE226) — tudo pelo usuário no FORMATO do serviço.
// FAMILIA.E5.P3.T1: a view da habilitação (007 — D-NE170) é FUNDÍVEL (ALGORITHM ≠ TEMPTABLE; EXPLAIN pela PK = const sobre PRIMARY, sem
//     DERIVED) e EQUIVALENTE à tabela (as linhas vivas, as quatro colunas), lida pelo usuário no FORMATO do serviço com o leitor publicado.
// IBS.E1.P1 (fase IBS/CBS): sonda SEM tabela — `CAST(<DECIMAL(17,2)> AS CHAR)` chega pelo pool da casa como texto decimal canônico (a
//     suposição do leitor dos valores do fisco); roda sozinha com `-t "IBS.E1.P1"`, sem criar nada.
import fs from 'fs'
import crypto from 'crypto'
import mysql, { Connection, Pool } from 'mysql2/promise'
import { runMigrations, CORE_MIGRATIONS_DIR, CORE_MIGRATIONS_PROJECT } from '../db/migrations'
import { createFiscalPool, assertSessionInvariants, FiscalDbConfig } from '../db/pool'
import { assertIssuerModelDomainEnforced, assertIssuerEnvironmentDomainEnforced } from '../establishment/establishment.repository'
import { assertSessionViewReadable } from '../access/access'
import { ISSUER_VIEW, issuerViewQuery, readIssuerView, assertIssuerViewReadable } from '../establishment/issuer-view'
import { mapServiceAuthorityIbscbs } from '../voice/families/service-authority-ibscbs'
import { invoiceRef } from '../ref/invoice-ref'
import { assertNumberSequenceDomainsEnforced, nextInvoiceNumber, lockNumberSequence, openNumberSequence } from '../numbering/number-sequence'
import { ErrorCodes } from '../errors/error-codes'
import type { PoolConnection } from 'mysql2/promise'
import {
  assertFiscalCodeDomainsEnforced, assertRequiredProviderCodesPresent, providerFiscalCredentialOf, saveProviderFiscalCredential,
  fiscalCodeRequirementsOf, FiscalCodeConflictError, FiscalCodeMissingError, establishmentFiscalCredentialOf, listProviderFiscalCredentials,
  endProviderFiscalCredential,
} from '../fiscal-code/fiscal-code'
import { execFileSync } from 'child_process'
import os from 'os'
import path from 'path'

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
    for (const t of ['tb_establishment_certificate', 'tb_establishment_issuer', 'tb_fiscal_code_type', 'tb_fiscal_code_requirement',
      'tb_provider_fiscal_credential', 'tb_establishment_fiscal_credential', 'tb_fiscal_number_sequence']) {
      const [rows] = await root.query<any[]>(`SHOW CREATE TABLE \`${DB}\`.\`${t}\``)
      out.push(String(rows[0]['Create Table']))
      if (t === 'tb_fiscal_code_type' || t === 'tb_fiscal_code_requirement') {
        const [seed] = await root.query<any[]>(`SELECT * FROM \`${DB}\`.\`${t}\``)
        out.push(JSON.stringify(seed.map(r => Object.values(r).map(String)).sort()))
      }
    }
    // FAMILIA.E5.P3: a view da 007 entra no retrato (CREATE OR REPLACE reaplica igual)
    const [view] = await root.query<any[]>(`SELECT VIEW_DEFINITION AS d, ALGORITHM AS a, CHARACTER_SET_CLIENT AS cs, COLLATION_CONNECTION AS co
      FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [DB])
    out.push(JSON.stringify(view))
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
  describe('T2 — as migrations 001–008 aplicam e re-executam', () => {
    let first = ''

    it('aplicam todas, na ordem, num banco novo (o executor confere a sessão estrita e o modo global antes)', async () => {
      const applied = await runMigrations(ownerCfg, [{ project: CORE_MIGRATIONS_PROJECT, dir: CORE_MIGRATIONS_DIR }])
      expect(applied).toEqual([
        'fiscal-api/001_core_baseline', 'fiscal-api/002_issuer_refresh_lease', 'fiscal-api/003_issuer_cutover',
        'fiscal-api/004_issuer_model_domain', 'fiscal-api/005_issuer_domains_binary', 'fiscal-api/006_fiscal_code',
        'fiscal-api/007_issuer_view', 'fiscal-api/008_fiscal_number_sequence',
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

    it('apagado o registro, as 001–008 RE-EXECUTAM sem erro e o schema sai igual — a semente da 006 sem duplicar (D-F123 — processo morto entre o ALTER e o registro)', async () => {
      await root.query(`DELETE FROM \`${DB}\`.\`_migrations\` WHERE project = ?`, [CORE_MIGRATIONS_PROJECT])
      const again = await runMigrations(ownerCfg, [{ project: CORE_MIGRATIONS_PROJECT, dir: CORE_MIGRATIONS_DIR }])
      expect(again).toHaveLength(8)
      expect(await schemaSnapshot()).toBe(first)
      report.migrationsReexecuted = again.length
    })

    it('o banco e as tabelas nascem utf8mb4 declarado, qualquer que seja o padrão do servidor (§23.12: utf8mb3 na SaveInCloud)', async () => {
      const [db] = await root.query<any[]>(`SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS co
        FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`, [DB])
      expect(db[0]).toEqual({ cs: 'utf8mb4', co: 'utf8mb4_unicode_ci' })
      const [tabs] = await root.query<any[]>(`SELECT TABLE_NAME AS t, TABLE_COLLATION AS co FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`, [DB])
      expect(tabs.map(r => String(r.t)).sort()).toEqual(['_migrations', 'tb_establishment_certificate', 'tb_establishment_fiscal_credential',
        'tb_establishment_issuer', 'tb_fiscal_code_requirement', 'tb_fiscal_code_type', 'tb_fiscal_number_sequence', 'tb_provider_fiscal_credential'])
      for (const r of tabs) expect(r.co).toBe('utf8mb4_unicode_ci')
      const [cols] = await root.query<any[]>(`SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND CHARACTER_SET_NAME IS NOT NULL AND CHARACTER_SET_NAME <> 'utf8mb4'`, [DB])
      expect(Number(cols[0].n)).toBe(0)
    })

    it('FAMILIA.E5.P5 — a 008: o motor aplica os cinco CHECKs do último número (sonda do boot, transação desfeita, nada fica gravado)', async () => {
      const pool = createFiscalPool(ownerCfg); pools.push(pool)
      await assertNumberSequenceDomainsEnforced(pool)
      const [left] = await root.query<any[]>(`SELECT COUNT(*) AS n FROM \`${DB}\`.tb_fiscal_number_sequence`)
      expect(Number(left[0].n)).toBe(0)
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

  // ---------------------------------------------------------------- FAMILIA.E5.P4.T4
  describe('FAMILIA.E5.P4.T4 — a 006 no motor, pelo usuário no FORMATO do serviço (ALL só no banco fiscal)', () => {
    // valor de TESTE inventado — nunca o da Setes (D-NE223/D-NE226: o valor real só pela entrada padrão do script, no dev, pelo Valdo)
    const FAKE = 'FICTICIODETESTE0123456789ABCDEF'
    let pool: Pool
    beforeAll(() => { pool = createFiscalPool(probeCfg); pools.push(pool) })

    it('a semente está lá: catálogo CSRT/provider e CSC/taxpayer; PR·55 exige CSRT em H desde 19/01/2026 e em P desde 23/02/2026 (03:00 UTC)', async () => {
      const [types] = await pool.query<any[]>(`SELECT id, owner, code_id_pattern AS p FROM tb_fiscal_code_type ORDER BY id`)
      expect(types).toEqual([{ id: 'CSC', owner: 'taxpayer', p: '^[0-9]{1,6}$' }, { id: 'CSRT', owner: 'provider', p: '^[0-9]{2}$' }])
      expect(await fiscalCodeRequirementsOf(pool, { state: 'PR', model: '55', environment: 'H', at: new Date('2026-01-19T02:59:59Z') })).toEqual([])
      expect(await fiscalCodeRequirementsOf(pool, { state: 'PR', model: '55', environment: 'H', at: new Date('2026-01-19T03:00:00Z') }))
        .toEqual([{ type: 'CSRT', owner: 'provider' }])
      expect(await fiscalCodeRequirementsOf(pool, { state: 'PR', model: '55', environment: 'P', at: new Date('2026-02-23T03:00:00Z') }))
        .toEqual([{ type: 'CSRT', owner: 'provider' }])
      expect(await fiscalCodeRequirementsOf(pool, { state: 'PR', model: '65', environment: 'P', at: new Date() })).toEqual([])
    })

    it('cada domínio fechado é recusado pelo CHECK BINÁRIO de nome certo (fora do domínio e minúscula), e a sessão é estrita no valor', async () => {
      await expect(assertFiscalCodeDomainsEnforced(pool)).resolves.toBeUndefined()
      report.fiscalCodeChecks = true
    })

    it('12 e 13 pelo motor: a FK composta (tipo, dono) recusa CSC na tabela do fornecedor e CSRT na do contribuinte; a minúscula não passa pela FK', async () => {
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        await conn.query(`INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment) VALUES (7, '65', 'H')`)
        await expect(conn.query(`INSERT INTO tb_provider_fiscal_credential (state, model, environment, tb_fiscal_code_type_id, valid_from, code_id, code_value)
          VALUES ('SC', '65', 'H', 'CSC', '2026-01-01 00:00:00', '1', ?)`, [FAKE])).rejects.toMatchObject({ errno: 1452 })
        await expect(conn.query(`INSERT INTO tb_establishment_fiscal_credential (tb_institution_id, model, environment, tb_fiscal_code_type_id, valid_from, code_id, code_value)
          VALUES (7, '65', 'H', 'CSRT', '2026-01-01 00:00:00', '01', ?)`, [FAKE])).rejects.toMatchObject({ errno: 1452 })
        await expect(conn.query(`INSERT INTO tb_provider_fiscal_credential (state, model, environment, tb_fiscal_code_type_id, valid_from, code_id, code_value)
          VALUES ('PR', '55', 'H', 'csrt', '2026-01-01 00:00:00', '01', ?)`, [FAKE])).rejects.toMatchObject({ errno: 4025 })
        // o caminho certo passa (as sondas não são "o motor recusa tudo")
        await conn.query(`INSERT INTO tb_establishment_fiscal_credential (tb_institution_id, model, environment, tb_fiscal_code_type_id, valid_from, code_id, code_value)
          VALUES (7, '65', 'H', 'CSC', '2026-01-01 00:00:00', '1', ?)`, [FAKE])
      } finally { await conn.rollback(); conn.release() }
    })

    it('o boot RECUSA com uma habilitação 55/H viva e sem o CSRT de H; 14: mesmo início = FiscalCodeConflictError; com a credencial fictícia, SOBE', async () => {
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        await conn.query(`INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment) VALUES (7, '55', 'H')`)
        const e = await assertRequiredProviderCodesPresent(conn).catch(x => x)
        expect(e).toBeInstanceOf(FiscalCodeMissingError)
        expect(e.missing).toEqual([{ state: 'PR', type: 'CSRT', model: '55', environment: 'H', owner: 'provider' }])
        const input = { state: 'PR', model: '55', environment: 'H', type: 'CSRT', codeId: '01', codeValue: FAKE, validFrom: new Date('2026-01-01T03:00:00Z') }
        await saveProviderFiscalCredential(conn, input)
        await expect(saveProviderFiscalCredential(conn, input)).rejects.toBeInstanceOf(FiscalCodeConflictError)
        await expect(assertRequiredProviderCodesPresent(conn)).resolves.toBeUndefined()
        expect((await providerFiscalCredentialOf(conn, { state: 'PR', model: '55', environment: 'H', type: 'CSRT', at: new Date() }))?.codeValue).toBe(FAKE)
      } finally { await conn.rollback(); conn.release() }
      report.fiscalCodeBoot = true
    })

    it('no motor: a credencial do contribuinte, a listagem SEM o valor, a nova que encerra a anterior, o encerrar e o tipo apagado que NÃO desliga a regra', async () => {
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        // contribuinte (CSC, regra fictícia de teste): só a do estabelecimento, do ambiente certo
        await conn.query(`INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment) VALUES (7, '65', 'P'), (8, '65', 'P')`)
        await conn.query(`INSERT INTO tb_establishment_fiscal_credential (tb_institution_id, model, environment, tb_fiscal_code_type_id, valid_from, code_id, code_value)
          VALUES (7, '65', 'P', 'CSC', '2026-01-01 00:00:00', '1', ?)`, [FAKE])
        const at = new Date()
        expect((await establishmentFiscalCredentialOf(conn, { institutionId: 7, model: '65', environment: 'P', type: 'CSC', at }))?.codeId).toBe('1')
        expect(await establishmentFiscalCredentialOf(conn, { institutionId: 8, model: '65', environment: 'P', type: 'CSC', at })).toBeNull()
        expect(await establishmentFiscalCredentialOf(conn, { institutionId: 7, model: '65', environment: 'H', type: 'CSC', at })).toBeNull()
        // fornecedor: a 2ª gravação encerra a 1ª no início dela; a listagem não traz o valor; encerrar a vigente
        const base = { state: 'PR', model: '55', environment: 'H', type: 'CSRT', codeValue: FAKE }
        await saveProviderFiscalCredential(conn, { ...base, codeId: '01', validFrom: new Date('2026-01-01T03:00:00Z') })
        await saveProviderFiscalCredential(conn, { ...base, codeId: '02', validFrom: new Date('2026-06-01T03:00:00Z') })
        const list = await listProviderFiscalCredentials(conn)
        expect(list.map(r => [r.codeId, r.validFrom, r.validUntil])).toEqual([
          ['01', '2026-01-01 03:00:00', '2026-06-01 03:00:00'], ['02', '2026-06-01 03:00:00', null]])
        expect(JSON.stringify(list)).not.toContain(FAKE)
        expect(await endProviderFiscalCredential(conn, { state: 'PR', model: '55', environment: 'H', type: 'CSRT', validFrom: new Date('2026-06-01T03:00:00Z') }, at))
          .toBe(true)
        expect(await providerFiscalCredentialOf(conn, { state: 'PR', model: '55', environment: 'H', type: 'CSRT', at: new Date(at.getTime() + 1000) })).toBeNull()
        // apagar o TIPO no catálogo não desliga a regra viva
        await conn.query(`UPDATE tb_fiscal_code_type SET deleted = 'S' WHERE id = 'CSRT'`)
        expect(await fiscalCodeRequirementsOf(conn, { state: 'PR', model: '55', environment: 'H', at })).toEqual([{ type: 'CSRT', owner: 'provider' }])
      } finally { await conn.rollback(); conn.release() }
    })

    it('D-NE226: o script grava pela ENTRADA PADRÃO (o valor não é argumento) e imprime só o que gravou, sem o valor', () => {
      const root_ = path.resolve(__dirname, '..', '..')
      const dist = path.join(root_, 'dist', 'fiscal-code', 'fiscal-code.js')
      if (!fs.existsSync(dist)) throw new Error('rode `npm run build` antes: o script importa do dist/')
      const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fiscal-cred-')), '.env')
      fs.writeFileSync(envFile, [`DB_HOST=${owner.host}`, `DB_PORT=${owner.port}`, `DB_USER=${PROBE_USER}`, `DB_PASSWORD=${PROBE_PASSWORD}`,
        `FISCAL_DB_NAME=${DB}`].join('\n'))
      try {
        const out = execFileSync(process.execPath, [path.join(root_, 'scripts', 'fiscal-credential.mjs'), '--env-file', envFile, '--state', 'PR',
          '--model', '55', '--environment', 'P', '--type', 'CSRT', '--code-id', '02', '--valid-from', '2026-02-23T00:00:00-03:00'],
          { input: `${FAKE}\n`, encoding: 'utf8' })
        expect(out.trim()).toBe('gravado: PR CSRT 55 P code_id=02 desde 2026-02-23 03:00:00 (UTC)')
        expect(out).not.toContain(FAKE)
      } finally { fs.rmSync(path.dirname(envFile), { recursive: true, force: true }) }
    })

    it('a linha do script está no banco (e sai pela leitura do núcleo); limpeza', async () => {
      expect((await providerFiscalCredentialOf(pool, { state: 'PR', model: '55', environment: 'P', type: 'CSRT', at: new Date() }))?.codeId).toBe('02')
      await pool.query(`DELETE FROM tb_provider_fiscal_credential WHERE code_value = ?`, [FAKE])
    })
  })

  // ---------------------------------------------------------------- FAMILIA.E5.P3.T1
  describe('FAMILIA.E5.P3.T1 — a view da habilitação (007) é fundível e equivale à tabela', () => {
    let pool: Pool
    // linhas semeadas: os três modelos, H e P, virada NULL (réplica) e preenchida, e uma APAGADA (some da view)
    const SEED: [institution: number, model: string, environment: string, cutoverAt: string | null, deleted: string][] = [
      [9101, 'SE', 'P', '2026-10-04 12:00:00', 'N'], [9101, '55', 'H', '2026-11-22 03:00:00', 'N'], [9101, '65', 'P', null, 'N'],
      [9102, '55', 'P', '2026-11-01 00:00:00', 'N'], [9102, 'SE', 'H', null, 'S'],
    ]
    beforeAll(async () => {
      pool = createFiscalPool(probeCfg); pools.push(pool)
      for (const [i, m, e, c, del] of SEED) {
        await root.query(`INSERT INTO \`${DB}\`.tb_establishment_issuer (tb_institution_id, model, environment, cutover_at, deleted, created_at)
          VALUES (?, ?, ?, ?, ?, '2026-11-22 00:00:00')`, [i, m, e, c, del])
      }
    })
    afterAll(async () => {
      await root.query(`DELETE FROM \`${DB}\`.tb_establishment_issuer WHERE tb_institution_id IN (9101, 9102)`)
    })

    it('a view existe e o motor a FUNDE (ALGORITHM ≠ TEMPTABLE), nasce utf8mb4 pela conexão do executor (padrão utf8mb3 da SaveInCloud — §23.12) e é DEFINER; o usuário do serviço a lê pelo boot', async () => {
      const [v] = await root.query<any[]>(`SELECT ALGORITHM AS a, SECURITY_TYPE AS s, CHARACTER_SET_CLIENT AS cs, COLLATION_CONNECTION AS co
        FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [DB, ISSUER_VIEW])
      expect(v).toHaveLength(1)
      expect(['UNDEFINED', 'MERGE']).toContain(String(v[0].a))
      expect([v[0].s, v[0].cs, String(v[0].co).startsWith('utf8mb4_')]).toEqual(['DEFINER', 'utf8mb4', true])
      await assertIssuerViewReadable(pool, DB)
      report.issuerViewAlgorithm = v[0].a
    })

    it('EXPLAIN da leitura publicada numa PK VIVA: const sobre PRIMARY, sem tabela derivada (a view foi fundida)', async () => {
      const { sql, params } = issuerViewQuery(DB, { institutionId: 9101, model: '55' })
      const [plan] = await pool.query<any[]>(`EXPLAIN ${sql}`, params)
      expect(plan.map(r => String(r.select_type))).not.toContain('DERIVED')
      expect(plan.map(r => String(r.table)).some(t => t.startsWith('<derived'))).toBe(false)
      expect(plan).toHaveLength(1)
      expect([plan[0].type, plan[0].key]).toEqual(['const', 'PRIMARY'])
      report.issuerViewExplain = plan.map(r => ({ select_type: r.select_type, table: r.table, type: r.type, key: r.key }))
    })

    it('EQUIVALE à tabela: o conjunto da view = as linhas vivas da tabela (as quatro colunas); o leitor devolve cada PK certa e null na apagada', async () => {
      const cols = `tb_institution_id AS institutionId, model, environment, DATE_FORMAT(cutover_at, '%Y-%m-%d %H:%i:%s') AS cutoverAt`
      const [fromView] = await root.query<any[]>(`SELECT ${cols} FROM \`${DB}\`.${ISSUER_VIEW} ORDER BY tb_institution_id, model`)
      const [fromTable] = await root.query<any[]>(`SELECT ${cols} FROM \`${DB}\`.tb_establishment_issuer WHERE deleted = 'N' ORDER BY tb_institution_id, model`)
      expect(fromView).toEqual(fromTable)
      expect(fromView.filter(r => [9101, 9102].includes(Number(r.institutionId)))).toHaveLength(4)
      // nenhuma coluna interna escapa pela view
      const [vcols] = await root.query<any[]>(`SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [DB, ISSUER_VIEW])
      expect(vcols.map(r => String(r.c))).toEqual(['tb_institution_id', 'model', 'environment', 'cutover_at'])
      for (const [i, m, e, c, del] of SEED) {
        const got = await readIssuerView(pool, DB, { institutionId: i, model: m as any })
        expect([i, m, got]).toEqual([i, m, del === 'S' ? null : { institutionId: i, model: m, environment: e, cutoverAt: c }])
      }
      expect(await readIssuerView(pool, DB, { institutionId: 9103, model: '55' })).toBeNull()      // sem linha = não habilitado
      report.issuerViewEquivalent = fromView.length
    })

    it('GRANT MÍNIMO de fato (forma do `setes_api` — o GRANT real é passo do consumidor, PM-9): SELECT só na view lê pelo leitor publicado e é RECUSADO na tabela', async () => {
      const reader = `${TAG}r`
      const password = crypto.randomBytes(18).toString('base64url')
      try {
        await root.query(`CREATE USER ?@? IDENTIFIED BY ?`, [reader, probeHost, password])
        await root.query(`GRANT SELECT ON \`${DB}\`.\`${ISSUER_VIEW}\` TO ?@?`, [reader, probeHost])
        const conn = await mysql.createConnection({ host: owner.host, port: owner.port, user: reader, password, database: DB, timezone: 'Z' })
        try {
          await assertIssuerViewReadable(conn, DB)
          expect(await readIssuerView(conn, DB, { institutionId: 9101, model: '55' })).toEqual({ institutionId: 9101, model: '55', environment: 'H', cutoverAt: '2026-11-22 03:00:00' })
          await expect(conn.query(`SELECT * FROM \`${DB}\`.tb_establishment_issuer`)).rejects.toMatchObject({ code: 'ER_TABLEACCESS_DENIED_ERROR' })
          await expect(conn.query(`SELECT * FROM \`${DB}\`.vw_invoice_merchandise_transmission`)).rejects.toBeTruthy()
        } finally { await conn.end() }
        report.issuerViewSelectOnly = true
      } finally {
        await root.query(`DROP USER IF EXISTS ?@?`, [reader, probeHost])
      }
    })
  })

  // ---------------------------------------------------------------- FAMILIA.E5.P5 (o último número da NF-e — migration 008)
  // T1: o gerador sob a trava nunca repete nem volta, homologação começa do 1 e produção só anda depois de aberta (D-NE257, D-NE265).
  // T2: gerar × travar para a inutilização se serializam na mesma linha (D-NE263). Pelo usuário no FORMATO do serviço (ALL só no fiscal).
  describe('FAMILIA.E5.P5 — o último número da NF-e por estabelecimento × modelo × série × ambiente', () => {
    let pool: Pool
    const A = 9201, B = 9202, C = 9203, D = 9204                       // estabelecimentos só deste bloco
    const scope = (institutionId: number, serie = 1) => ({ institutionId, model: '55' as const, serie })
    const setEnvironment = (institutionId: number, environment: 'H' | 'P') =>
      root.query(`UPDATE \`${DB}\`.tb_establishment_issuer SET environment = ? WHERE tb_institution_id = ? AND model = '55'`, [environment, institutionId])
    const rowsOf = async (institutionId: number) => {
      const [rows] = await root.query<any[]>(`SELECT serie, environment, last_number AS n FROM \`${DB}\`.tb_fiscal_number_sequence
        WHERE tb_institution_id = ? ORDER BY serie, environment`, [institutionId])
      return rows.map(r => `${r.serie}/${r.environment}=${r.n}`)
    }
    /** Uma geração na sua própria transação (como a reserva da transmissão). */
    async function generate(institutionId: number, serie = 1): Promise<number> {
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        const out = await nextInvoiceNumber(conn, scope(institutionId, serie))
        await conn.commit()
        return out.number
      } catch (err) { await conn.rollback().catch(() => undefined); throw err } finally { conn.release() }
    }
    async function inTx<T>(body: (conn: PoolConnection) => Promise<T>): Promise<T> {
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        const out = await body(conn)
        await conn.commit()
        return out
      } catch (err) { await conn.rollback().catch(() => undefined); throw err } finally { conn.release() }
    }

    beforeAll(async () => {
      pool = createFiscalPool(probeCfg); pools.push(pool)
      for (const [i, e] of [[A, 'H'], [B, 'P'], [C, 'H'], [D, 'H']] as [number, string][]) {
        await root.query(`INSERT INTO \`${DB}\`.tb_establishment_issuer (tb_institution_id, model, environment, cutover_at, deleted, created_at)
          VALUES (?, '55', ?, '2026-11-22 03:00:00', 'N', '2026-11-22 00:00:00')`, [i, e])
      }
    })

    it('(a) homologação: a linha nasce sozinha e o primeiro número é o 1; cada série tem a sua sequência', async () => {
      expect([await generate(A), await generate(A), await generate(A)]).toEqual([1, 2, 3])
      expect(await generate(A, 2)).toBe(1)
      expect(await rowsOf(A)).toEqual(['1/H=3', '2/H=1'])
    })

    it('(b) produção: sem a sequência aberta é 409 e NADA é gravado; aberta com 3138, o próximo é 3138; abrir de novo é 409', async () => {
      // o 409 e, depois dele, COMMIT (não rollback): se a peça tivesse gravado algo antes de recusar, a linha ficaria
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        await expect(nextInvoiceNumber(conn, scope(B))).rejects.toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_NUMBER_SEQUENCE_NOT_OPEN })
        await conn.commit()
      } finally { conn.release() }
      expect(await rowsOf(B)).toEqual([])
      await inTx(conn => openNumberSequence(conn, scope(B), 3138, null))
      expect(await rowsOf(B)).toEqual(['1/P=3137'])
      expect([await generate(B), await generate(B)]).toEqual([3138, 3139])
      await expect(inTx(conn => openNumberSequence(conn, scope(B), 1, null))).rejects.toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_NUMBER_SEQUENCE_ALREADY_OPEN })
      expect(await rowsOf(B)).toEqual(['1/P=3139'])
    })

    it('(c) virar o ambiente não toca a sequência: cada ambiente continua do seu último (abre-se a de produção ainda em homologação)', async () => {
      await inTx(conn => openNumberSequence(conn, scope(A), 500, null))   // a habilitação de A ainda está em H
      await setEnvironment(A, 'P')
      expect(await generate(A)).toBe(500)
      await setEnvironment(A, 'H')
      expect(await generate(A)).toBe(4)
      await setEnvironment(A, 'P')
      expect(await generate(A)).toBe(501)
      await setEnvironment(A, 'H')
      expect(await rowsOf(A)).toEqual(['1/H=4', '1/P=501', '2/H=1'])
    })

    it('(d) duas conexões gerando 50 números cada, em paralelo: os 100 números são exatamente 1 a 100, sem repetição', async () => {
      let deadlocks = 0
      const worker = async (): Promise<number[]> => {
        const out: number[] = []
        for (let i = 0; i < 50; i++) {
          for (let attempt = 1; ; attempt++) {
            try { out.push(await generate(C)); break } catch (err: any) {
              if (err?.errno !== 1213 || attempt === 3) throw err      // deadlock repete até 3 vezes; o que sobrar é falha
              deadlocks++
            }
          }
        }
        return out
      }
      const [x, y] = await Promise.all([worker(), worker()])
      const all = [...x, ...y].sort((p, q) => p - q)
      expect(all).toEqual(Array.from({ length: 100 }, (_, i) => i + 1))
      // dentro de cada conexão a sequência é crescente (nunca volta)
      for (const w of [x, y]) expect(w.every((n, i) => i === 0 || n > w[i - 1])).toBe(true)
      expect(await rowsOf(C)).toEqual(['1/H=100'])
      expect(deadlocks).toBe(0)                                         // a habilitação serializa: deadlock aqui seria defeito, não azar
      report.numberSequenceParallel = { generated: all.length, deadlocksRetried: deadlocks }
    }, 60_000)

    it('(e) gerar × travar para a inutilização: enquanto a trava está aberta a geração ESPERA; solta, sai o último lido + 1', async () => {
      await generate(D); await generate(D)                              // último = 2
      const locker = await pool.getConnection()
      const waiter = await pool.getConnection()
      try {
        await locker.beginTransaction()
        expect(await lockNumberSequence(locker, scope(D))).toEqual({ environment: 'H', lastNumber: 2 })
        await waiter.beginTransaction()
        let settled = false
        const pending = nextInvoiceNumber(waiter, scope(D)).finally(() => { settled = true })
        pending.catch(() => undefined)
        // a LINHA da sequência também está travada (o cinto): uma escrita direta nela, sem passar pela habilitação, espera igual
        const direct = await pool.getConnection()
        let directSettled = false
        const directWrite = direct.query(`UPDATE tb_fiscal_number_sequence SET updated_at = updated_at
          WHERE tb_institution_id = ? AND model = '55' AND serie = 1 AND environment = 'H'`, [D]).finally(() => { directSettled = true; direct.release() })
        directWrite.catch(() => undefined)
        await new Promise(r => setTimeout(r, 300))
        expect(settled).toBe(false)                                     // a geração concorrente não andou (espera na habilitação)
        expect(directSettled).toBe(false)                               // nem a escrita direta na linha (espera na própria linha)
        expect(await lockNumberSequence(locker, scope(D))).toEqual({ environment: 'H', lastNumber: 2 })   // e o último não mudou para quem trava
        await locker.commit()
        await directWrite
        expect(await pending).toEqual({ number: 3, environment: 'H' })
        await waiter.commit()
      } finally {
        await locker.rollback().catch(() => undefined); await waiter.rollback().catch(() => undefined)
        locker.release(); waiter.release()
      }
      // sem linha ainda (série nunca usada): a trava devolve null e nada nasce
      expect(await inTx(conn => lockNumberSequence(conn, scope(D, 7)))).toEqual({ environment: 'H', lastNumber: null })
      expect(await rowsOf(D)).toEqual(['1/H=3'])
    })

    it('réplica do ERP e habilitação apagada nunca geram número (D-F39)', async () => {
      await root.query(`INSERT INTO \`${DB}\`.tb_establishment_issuer (tb_institution_id, model, environment, cutover_at, deleted) VALUES (9205, '55', 'H', NULL, 'N'), (9206, '55', 'H', '2026-11-22 03:00:00', 'S')`)
      await expect(generate(9205)).rejects.toMatchObject({ statusCode: 409, code: ErrorCodes.FISCAL_CUTOVER_PENDING })
      await expect(generate(9206)).rejects.toThrow(/sem habilitação viva do modelo 55/)
      expect([...await rowsOf(9205), ...await rowsOf(9206)]).toEqual([])
    })

    it('o teto do nNF (999.999.999 — RF-NFE-44) no motor: o último número possível sai, o seguinte é "numeração esgotada" e nada avança, em H e em P', async () => {
      // H pelo upsert: a linha da série 9 de A é posta no penúltimo número
      await generate(A, 9)
      await root.query(`UPDATE \`${DB}\`.tb_fiscal_number_sequence SET last_number = 999999998 WHERE tb_institution_id = ? AND serie = 9 AND environment = 'H'`, [A])
      expect(await generate(A, 9)).toBe(999_999_999)
      await expect(generate(A, 9)).rejects.toThrow(/numeração esgotada/)
      // P pelo UPDATE: aberta já no último número
      await inTx(conn => openNumberSequence(conn, scope(B, 9), 999_999_999, null))
      expect(await generate(B, 9)).toBe(999_999_999)
      await expect(generate(B, 9)).rejects.toThrow(/numeração esgotada/)
      expect((await rowsOf(A)).filter(r => r.startsWith('9/'))).toEqual(['9/H=999999999'])
      expect((await rowsOf(B)).filter(r => r.startsWith('9/'))).toEqual(['9/P=999999999'])
    })

    it('linha marcada como excluída (só por mão no banco): gerar, travar e abrir falham ALTO e o número não anda', async () => {
      await generate(A, 5)                                              // 5/H=1
      await inTx(conn => openNumberSequence(conn, scope(A, 5), 70, null))   // 5/P=69
      await root.query(`UPDATE \`${DB}\`.tb_fiscal_number_sequence SET deleted = 'S' WHERE tb_institution_id = ? AND serie = 5`, [A])
      await expect(generate(A, 5)).rejects.toThrow(/marcada como excluída/)
      await expect(inTx(conn => lockNumberSequence(conn, scope(A, 5)))).rejects.toThrow(/marcada como excluída/)
      await expect(inTx(conn => openNumberSequence(conn, scope(A, 5), 70, null))).rejects.toThrow(/marcada como excluída/)
      await setEnvironment(A, 'P')
      await expect(generate(A, 5)).rejects.toThrow(/marcada como excluída/)
      await setEnvironment(A, 'H')
      expect((await rowsOf(A)).filter(r => r.startsWith('5/'))).toEqual(['5/H=1', '5/P=69'])
    })

    it('estabelecimentos VIZINHOS abrindo a produção e travando série nunca usada ao mesmo tempo: sem deadlock nem espera (linha ausente não leva trava de intervalo)', async () => {
      const ids = [9211, 9212, 9213, 9214]
      for (const i of ids) {
        await root.query(`INSERT INTO \`${DB}\`.tb_establishment_issuer (tb_institution_id, model, environment, cutover_at, deleted)
          VALUES (?, '55', 'H', '2026-11-22 03:00:00', 'N')`, [i])
      }
      // um vizinho segura a transação com a trava de uma série AUSENTE; os outros abrem P e geram a 1ª de H nesse meio-tempo
      const holder = await pool.getConnection()
      try {
        await holder.beginTransaction()
        expect(await lockNumberSequence(holder, scope(9212, 3))).toEqual({ environment: 'H', lastNumber: null })
        for (let round = 1; round <= 5; round++) {
          await Promise.all([9211, 9213, 9214].map(i => inTx(conn => openNumberSequence(conn, scope(i, round), 10, null))))
          expect(await Promise.all([9211, 9213, 9214].map(i => generate(i, round)))).toEqual([1, 1, 1])
        }
        await holder.commit()
      } finally { await holder.rollback().catch(() => undefined); holder.release() }
      expect(await rowsOf(9212)).toEqual([])
    }, 30_000)

    it('retrato aberto ANTES da trava: linha marcada excluída depois dele — o gerador RECUSA (a leitura de volta é corrente) e o número não anda', async () => {
      expect(await generate(A, 6)).toBe(1)                              // 6/H=1
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        await conn.query('SELECT COUNT(*) AS n FROM tb_fiscal_number_sequence')     // leitura comum: o retrato da transação nasce aqui, com a linha 'N'
        await root.query(`UPDATE \`${DB}\`.tb_fiscal_number_sequence SET deleted = 'S' WHERE tb_institution_id = ? AND serie = 6`, [A])
        // com a leitura de volta comum, o IF não avançaria e o retrato devolveria o 1 de novo como "gerado" — número repetido
        await expect(nextInvoiceNumber(conn, scope(A, 6))).rejects.toThrow(/marcada como excluída/)
        await conn.rollback()
      } finally { await conn.rollback().catch(() => undefined); conn.release() }
      expect((await rowsOf(A)).filter(r => r.startsWith('6/'))).toEqual(['6/H=1'])
    })

    it('retrato aberto ANTES da trava: linha que nasce depois dele — `lockNumberSequence` falha FECHADO (null = nada a inutilizar); em transação limpa lê o último', async () => {
      await root.query(`INSERT INTO \`${DB}\`.tb_establishment_issuer (tb_institution_id, model, environment, cutover_at, deleted)
        VALUES (9221, '55', 'H', '2026-11-22 03:00:00', 'N')`)
      const stale = await pool.getConnection()
      try {
        await stale.beginTransaction()
        await stale.query('SELECT COUNT(*) AS n FROM tb_fiscal_number_sequence')    // quem chama violou o contrato: leu antes de travar
        expect(await generate(9221)).toBe(1)                            // a linha nasce em outra transação, já confirmada
        expect(await lockNumberSequence(stale, scope(9221))).toEqual({ environment: 'H', lastNumber: null })
        await stale.commit()
      } finally { await stale.rollback().catch(() => undefined); stale.release() }
      expect(await inTx(conn => lockNumberSequence(conn, scope(9221)))).toEqual({ environment: 'H', lastNumber: 1 })
    })
  })
})
