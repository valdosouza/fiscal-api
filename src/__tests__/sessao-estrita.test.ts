/**
 * D-NE172 (Valdo 2026-10-31, Q-NE172 = (a)): a sessão do pool do núcleo é ESTRITA — `STRICT_ALL_TABLES` somado ao modo do servidor em
 * TODA conexão nova (molde do REPEATABLE READ e do UTC), conferido no boot (`assertSessionInvariants`), e a sonda de COMPRIMENTO prova
 * que o motor recusa o texto maior que a coluna (1406) em vez de truncar calado antes do CHECK.
 */
jest.mock('mysql2/promise', () => {
  const handlers: Record<string, (conn: unknown) => void> = {}
  const pool = { on: (ev: string, fn: (conn: unknown) => void) => { handlers[ev] = fn; return pool } }
  const conn = { sqlMode: '', log: [] as string[], query: jest.fn(), end: jest.fn(async () => undefined) }
  return { __esModule: true, default: { createPool: jest.fn(() => pool), createConnection: jest.fn(async () => conn) }, __handlers: handlers, __conn: conn }
})

import mysql, { Pool } from 'mysql2/promise'
import {
  createFiscalPool, assertSessionInvariants, sqlModeIsStrict, STRICT_SESSION_SQL, REQUIRED_SQL_MODE,
} from '../db/pool'
import { assertLengthRefused, assertCheckRefuses, isDataTooLong, LengthProbe } from '../db/check'

const handlers = (jest.requireMock('mysql2/promise') as { __handlers: Record<string, (conn: unknown) => void> }).__handlers

describe('D-NE172 — a conexão nova do pool nasce ESTRITA', () => {
  it('toda conexão roda o REPEATABLE READ, o UTC e o modo estrito somado ao do servidor (nunca substitui os outros modos)', () => {
    createFiscalPool({ host: 'h', port: 1, user: 'u', password: 'p', database: 'fiscal_api' })
    expect((mysql.createPool as jest.Mock)).toHaveBeenCalled()
    const ran: string[] = []
    const destroy = jest.fn()
    handlers.connection({ destroy, query: (sql: string, cb: (e: unknown, rows?: any) => void) => { ran.push(sql); cb(null, [{ m: 'NO_ENGINE_SUBSTITUTION,STRICT_ALL_TABLES' }]) } })
    expect(ran).toEqual([
      'SELECT @@SESSION.sql_mode AS m',                       // D-NE175: o modo HERDADO, antes de qualquer SET (proibido nele = alarme + destruir)
      'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      `SET time_zone = '+00:00'`,
      STRICT_SESSION_SQL,                                     // retira os proibidos e soma o estrito — a defesa que o SERVIDOR executa em ordem
      'SELECT @@SESSION.sql_mode AS m',                       // o modo final conferido
    ])
    expect(destroy).not.toHaveBeenCalled()
    expect(REQUIRED_SQL_MODE).toBe('STRICT_ALL_TABLES')
  })

  it('D-NE175: o SET da sessão RETIRA os proibidos e os combinados que os trazem (o resultado no motor real está em strict-writers-db da nfse-api)', () => {
    const { SQL_MODES_STRIPPED_FROM_SESSION } = require('../db/pool') as typeof import('../db/pool')
    expect([...SQL_MODES_STRIPPED_FROM_SESSION]).toEqual(['NO_BACKSLASH_ESCAPES', 'ANSI_QUOTES', 'ANSI', 'ORACLE', 'MSSQL', 'POSTGRESQL', 'DB2', 'MAXDB'])
    expect(STRICT_SESSION_SQL).toMatch(/^SET SESSION sql_mode = CONCAT_WS\(',', NULLIF\(TRIM\(BOTH ',' FROM .*\), ''\), 'STRICT_ALL_TABLES'\)$/)
    for (const item of SQL_MODES_STRIPPED_FROM_SESSION) expect([item, STRICT_SESSION_SQL.includes(`',${item},', ','`)]).toEqual([item, true])
  })

  it('D-NE175: a conexão que HERDA um modo proibido é DESTRUÍDA na 1ª leitura (alarme), mesmo que o SET da casa a deixe limpa', () => {
    createFiscalPool({ host: 'h', port: 1, user: 'u', password: 'p', database: 'fiscal_api' })
    const destroy = jest.fn()
    let reads = 0
    handlers.connection({ destroy, query: (sql: string, cb: (e: unknown, rows?: any) => void) => {
      if (/sql_mode AS m$/.test(sql)) return cb(null, [{ m: reads++ === 0 ? 'NO_BACKSLASH_ESCAPES,NO_ENGINE_SUBSTITUTION' : 'NO_ENGINE_SUBSTITUTION,STRICT_ALL_TABLES' }])
      cb(null)
    } })
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('gates (LOW): a conexão em que um invariante FALHA é DESTRUÍDA — nunca segue no pool fora da casa', () => {
    createFiscalPool({ host: 'h', port: 1, user: 'u', password: 'p', database: 'fiscal_api' })
    const destroy = jest.fn()
    handlers.connection({
      destroy,
      query: (sql: string, cb: (e: unknown) => void) => cb(sql === STRICT_SESSION_SQL ? new Error('sem privilégio') : null),
    })
    expect(destroy).toHaveBeenCalledTimes(1)
    const ok = jest.fn()
    handlers.connection({ destroy: ok, query: (_: string, cb: (e: unknown, rows?: any) => void) => cb(null, [{ m: 'STRICT_ALL_TABLES' }]) })
    expect(ok).not.toHaveBeenCalled()
  })

  it.each([
    ['NO_BACKSLASH_ESCAPES,STRICT_ALL_TABLES'],                                     // o servidor mudou o GLOBAL depois do boot
    ['REAL_AS_FLOAT,PIPES_AS_CONCAT,ANSI_QUOTES,IGNORE_SPACE,ANSI,STRICT_ALL_TABLES'], // outro servidor atrás do proxy, em ANSI
    ['NO_ENGINE_SUBSTITUTION'],                                                     // o SET do estrito "passou" mas a sessão não ficou estrita
    [''],
  ])('D-NE175: a conexão nova que nasce com o modo %j é DESTRUÍDA (a conferência é por conexão, não só no boot)', mode => {
    createFiscalPool({ host: 'h', port: 1, user: 'u', password: 'p', database: 'fiscal_api' })
    const destroy = jest.fn()
    handlers.connection({ destroy, query: (_: string, cb: (e: unknown, rows?: any) => void) => cb(null, [{ m: mode }]) })
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('D-NE175: a leitura do modo que FALHA também destrói a conexão (nunca "sem resposta = está certo")', () => {
    createFiscalPool({ host: 'h', port: 1, user: 'u', password: 'p', database: 'fiscal_api' })
    const destroy = jest.fn()
    handlers.connection({ destroy, query: (sql: string, cb: (e: unknown, rows?: any) => void) => cb(/sql_mode AS m/.test(sql) ? new Error('caiu') : null) })
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION,STRICT_ALL_TABLES', true],   // o modo do dev somado
    ['STRICT_ALL_TABLES', true],                                                                     // servidor com modo vazio
    ['STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION', false],     // o estrito SÓ das tabelas transacionais não é o decidido
    ['NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION', false],                                  // o modo do dev sem a soma
    ['', false],
    ['XSTRICT_ALL_TABLES', false],                                                                   // por ITEM, nunca por pedaço
    ['STRICT_ALL_TABLESX,NO_ENGINE_SUBSTITUTION', false],
  ])('sqlModeIsStrict(%j) = %s', (mode, expected) => expect(sqlModeIsStrict(mode)).toBe(expected))
})

describe('D-NE172 — assertSessionInvariants confere o modo estrito no boot', () => {
  const poolWith = (sqlMode: string) => ({
    query: jest.fn(async (sql: string) => {
      if (/tx_isolation/.test(sql)) return [[{ Value: 'REPEATABLE-READ' }]]
      if (/time_zone/.test(sql)) return [[{ tz: '+00:00' }]]
      if (/sql_mode/.test(sql)) return [[{ m: sqlMode }]]
      throw new Error(`consulta inesperada: ${sql}`)
    }),
  })
  it('sessão estrita: passa e devolve o modo', async () => {
    const mode = 'NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION,STRICT_ALL_TABLES'
    await expect(assertSessionInvariants(poolWith(mode) as any)).resolves.toEqual({ isolation: 'REPEATABLE-READ', timeZone: '+00:00', sqlMode: mode })
  })
  it.each([['NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION'], ['STRICT_TRANS_TABLES'], ['']])('sessão %j: o boot FALHA ALTO', async mode => {
    await expect(assertSessionInvariants(poolWith(mode) as any)).rejects.toThrow(/a casa exige STRICT_ALL_TABLES/)
  })
})

/** Conexão simulada que registra o que a sonda faz e responde cada INSERT com `onInsert`. */
function fakePool(onInsert: (sql: string, params: unknown[]) => void, opts: { rollbackFails?: boolean } = {}) {
  const log: string[] = []
  const conn = {
    beginTransaction: jest.fn(async () => { log.push('BEGIN') }),
    rollback: jest.fn(async () => { log.push('ROLLBACK'); if (opts.rollbackFails) throw new Error('caiu') }),
    release: jest.fn(() => log.push('release')),
    destroy: jest.fn(() => log.push('destroy')),
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (/^SELECT @@SESSION.foreign_key_checks/.test(sql)) { log.push('FK?'); return [[{ v: 1 }]] }
      if (/^SET SESSION foreign_key_checks/.test(sql)) { log.push(sql); return [[]] }
      log.push('INSERT')
      onInsert(sql, params)
      return [{ affectedRows: 1 }]
    }),
  }
  return { pool: { getConnection: jest.fn(async () => conn) } as unknown as Pick<Pool, 'getConnection'>, conn, log }
}

const tooLong = Object.assign(new Error("Data too long for column 'access_key' at row 1"), { errno: 1406, code: 'ER_DATA_TOO_LONG' })
const probe = (value: string): LengthProbe => ({ value, column: 't.access_key', sql: 'INSERT INTO t (access_key) VALUES (?)', params: [value] })

describe('D-NE172 — assertLengthRefused: o motor recusa o texto maior que a coluna', () => {
  it('isDataTooLong reconhece o 1406 pelo número e pelo código', () => {
    expect(isDataTooLong(tooLong)).toBe(true)
    expect(isDataTooLong({ code: 'ER_DATA_TOO_LONG' })).toBe(true)
    expect(isDataTooLong({ errno: 1265 })).toBe(false)        // o AVISO do corte calado não é a recusa
    expect(isDataTooLong(new Error('x'))).toBe(false)
  })

  it('sessão estrita (1406): passa, numa transação SEMPRE desfeita, com a FK da sessão restaurada', async () => {
    const { pool, log } = fakePool(() => { throw tooLong })
    await expect(assertLengthRefused(pool, 'a chave', [probe('1'.repeat(45))], { withoutForeignKeys: true })).resolves.toBeUndefined()
    expect(log).toEqual(['BEGIN', 'FK?', 'SET SESSION foreign_key_checks = 0', 'INSERT', 'ROLLBACK', 'SET SESSION foreign_key_checks = 1', 'release'])
  })

  it('sessão SEM o modo estrito (o motor truncou e aceitou): o boot FALHA ALTO e a sonda é desfeita', async () => {
    const { pool, log } = fakePool(() => undefined)
    await expect(assertLengthRefused(pool, 'a chave de acesso da NF-e', [probe('1'.repeat(45))]))
      .rejects.toThrow(/ACEITOU a chave de acesso da NF-e maior que a coluna \(t\.access_key com 45 posições\) — a sessão NÃO é estrita/)
    expect(log).toEqual(['BEGIN', 'INSERT', 'ROLLBACK', 'release'])
  })

  it('outro erro (sem GRANT, CHECK, coluna) sobe COMO ESTÁ — nunca vira "a sessão é estrita"', async () => {
    const grant = Object.assign(new Error('INSERT command denied'), { errno: 1142 })
    const { pool } = fakePool(() => { throw grant })
    await expect(assertLengthRefused(pool, 'a chave', [probe('x')])).rejects.toBe(grant)
    const check = Object.assign(new Error('CONSTRAINT `ck` failed'), { errno: 4025 })
    await expect(assertLengthRefused(fakePool(() => { throw check }).pool, 'a chave', [probe('x')])).rejects.toBe(check)
  })

  it('ROLLBACK que falha: a conexão é DESTRUÍDA, nunca devolvida ao pool', async () => {
    const { pool, log } = fakePool(() => { throw tooLong }, { rollbackFails: true })
    await assertLengthRefused(pool, 'a chave', [probe('1'.repeat(45))])
    expect(log.slice(-2)).toEqual(['ROLLBACK', 'destroy'])
  })

  it('sem sonda é erro de quem chama', async () => {
    await expect(assertLengthRefused(fakePool(() => undefined).pool, 'x', [])).rejects.toThrow(/nenhuma sonda/)
  })

  it('a refatoração da transação comum não muda assertCheckRefuses (aceitou tudo = sem CHECK; desfeita e devolvida)', async () => {
    const { pool, log } = fakePool(() => undefined)
    await expect(assertCheckRefuses(pool, 'o kind', [{ value: 'S', constraint: 'ck_x', sql: 'INSERT', params: [] }]))
      .rejects.toThrow(/ACEITOU o kind fora do domínio \(S\)/)
    expect(log).toEqual(['BEGIN', 'INSERT', 'ROLLBACK', 'release'])
  })
})

describe('D-NE172 — cerca: nenhum código do núcleo mexe no sql_mode fora do pool', () => {
  it('só `db/pool.ts` e `db/migrations.ts` citam sql_mode no código (comentário não conta) — `SET [SESSION] sql_mode` ou `SET STATEMENT sql_mode=… FOR` desligaria o modo estrito sem o boot perceber', () => {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const root = path.resolve(__dirname, '..')
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? (e.name === '__tests__' ? [] : walk(path.join(dir, e.name))) : /\.[cm]?ts$/.test(e.name) ? [path.join(dir, e.name)] : [])
    const hits = walk(root)
      // as DUAS portas da sessão da casa: o pool (D-NE172) e o executor de migrations (D-NE173 — usa a constante do pool)
      .filter(f => !['db/pool.ts', 'db/migrations.ts'].includes(path.relative(root, f).split(path.sep).join('/')))
      .filter(f => /sql_mode/i.test(fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')))
      .map(f => path.relative(root, f))
    expect(hits).toEqual([])
  })
})

describe('D-NE172 (gate adversarial, BORDA_DE_DATA) — a data do fisco fora do intervalo do DATETIME vira null, nunca o 1292 que derruba a voz', () => {
  // import tardio: o mock do mysql2 acima não interfere na peça do fuso
  const { toUtcDb } = require('../time/zone') as typeof import('../time/zone')
  it.each([
    ['9999-12-31T23:59:59-03:00', null],                    // vira o ano 10000 em UTC
    ['9999-12-31T20:59:59-03:00', '9999-12-31 23:59:59'],   // o último instante que cabe
    ['1000-01-01T00:00:00+03:00', null],                    // vira o ano 999 em UTC
    ['1000-01-01T03:00:00+03:00', '1000-01-01 00:00:00'],
    ['2026-11-04T09:00:00-03:00', '2026-11-04 12:00:00'],
  ])('toUtcDb(%j) = %j', (v, expected) => expect(toUtcDb(v)).toBe(expected))
})

describe('D-NE173 (Valdo 2026-11-05) — o executor de migrations abre a conexão no MESMO modo estrito e confere ANTES de aplicar', () => {
  const { runMigrations } = require('../db/migrations') as typeof import('../db/migrations')
  const conn = (jest.requireMock('mysql2/promise') as { __conn: { sqlMode: string; log: string[]; query: jest.Mock } }).__conn
  const cfg = { host: 'h', port: 1, user: 'u', password: 'p', database: 'fiscal_api_adv_x' }
  beforeEach(() => {
    conn.log = []
    conn.query.mockImplementation(async (sql: string) => {
      conn.log.push(sql.split('\n')[0].trim())
      if (/@@SESSION\.sql_mode/.test(sql)) return [[{ m: conn.sqlMode }]]
      if (/GET_LOCK/.test(sql)) return [[{ ok: 1 }]]
      if (/SELECT version FROM/.test(sql)) return [[]]
      return [[]]
    })
  })
  it('sessão estrita: o executor soma o modo logo depois do UTC e segue (cria o banco, trava, aplica)', async () => {
    conn.sqlMode = 'NO_ENGINE_SUBSTITUTION,STRICT_ALL_TABLES'
    await expect(runMigrations(cfg, [])).resolves.toEqual([])
    expect(conn.log.slice(0, 3)).toEqual([`SET time_zone = '+00:00'`, STRICT_SESSION_SQL, 'SELECT @@SESSION.sql_mode AS m, @@GLOBAL.sql_mode AS g'])
    expect(conn.log.some(s => s.startsWith('CREATE DATABASE IF NOT EXISTS'))).toBe(true)
  })
  it('D-NE174/D-NE175: servidor com NO_BACKSLASH_ESCAPES no GLOBAL — o executor não migra (a sessão sairia limpa, o servidor é que é recusado)', async () => {
    conn.sqlMode = 'NO_ENGINE_SUBSTITUTION,STRICT_ALL_TABLES'
    const base = conn.query.getMockImplementation()!
    conn.query.mockImplementation(async (sql: string, p?: unknown) =>
      /@@GLOBAL\.sql_mode/.test(sql) ? [[{ m: conn.sqlMode, g: 'NO_BACKSLASH_ESCAPES,NO_ENGINE_SUBSTITUTION' }]] : base(sql, p))
    await expect(runMigrations(cfg, [])).rejects.toThrow(/O sql_mode GLOBAL do servidor \(no executor de migrations — nada aplicado\) é 'NO_BACKSLASH_ESCAPES,NO_ENGINE_SUBSTITUTION': traz NO_BACKSLASH_ESCAPES/)
    expect(conn.log.some(s => s.startsWith('CREATE DATABASE') || /GET_LOCK/.test(s))).toBe(false)
  })
  it('o SET não pegou (sessão sem o modo): FALHA ALTO antes de criar o banco ou aplicar qualquer migration — e a conexão é fechada', async () => {
    conn.sqlMode = 'NO_ENGINE_SUBSTITUTION'
    const end = (jest.requireMock('mysql2/promise') as any).__conn.end as jest.Mock
    end.mockClear()                                         // gate socrático L2: mede o fechamento DESTE caminho, não o do teste anterior
    await expect(runMigrations(cfg, [])).rejects.toThrow(/do executor de migrations \(nada aplicado — D-NE173\) é 'NO_ENGINE_SUBSTITUTION': a casa exige STRICT_ALL_TABLES/)
    expect(conn.log.some(s => s.startsWith('CREATE DATABASE') || s.startsWith('USE') || /GET_LOCK/.test(s))).toBe(false)
    expect(end).toHaveBeenCalledTimes(1)
  })
  it('gates do delta: a migration que DESLIGA o estrito (SET SESSION sql_mode) é pega DEPOIS do arquivo — não é registrada e a seguinte não roda', async () => {
    const fs = require('fs') as typeof import('fs'), os = require('os') as typeof import('os'), path = require('path') as typeof import('path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-mode-'))
    try {
      fs.writeFileSync(path.join(dir, '001_desliga.sql'), "SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION';\n")
      fs.writeFileSync(path.join(dir, '002_seguinte.sql'), 'CREATE TABLE IF NOT EXISTS `t` (`k` VARCHAR(5));\n')
      conn.sqlMode = 'NO_ENGINE_SUBSTITUTION,STRICT_ALL_TABLES'
      const base = conn.query.getMockImplementation()!
      conn.query.mockImplementation(async (sql: string, p?: unknown) => {
        if (/^SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION'/.test(sql)) conn.sqlMode = 'NO_ENGINE_SUBSTITUTION'
        return base(sql, p)
      })
      await expect(runMigrations(cfg, [{ project: 'p', dir }])).rejects.toThrow(/depois de p\/001_desliga\.sql \(não registrada — D-NE173\) é 'NO_ENGINE_SUBSTITUTION': a casa exige STRICT_ALL_TABLES/)
      expect(conn.log.some(s => s.startsWith('INSERT INTO `_migrations`'))).toBe(false)
      expect(conn.log.some(s => s.startsWith('CREATE TABLE IF NOT EXISTS `t`'))).toBe(false)
      expect(conn.log.some(s => /RELEASE_LOCK/.test(s))).toBe(true)                        // a trava nomeada é solta mesmo na falha
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('D-NE174: servidor com NO_BACKSLASH_ESCAPES — o executor FALHA ALTO antes de criar o banco (nada aplicado)', async () => {
    conn.sqlMode = 'NO_BACKSLASH_ESCAPES,NO_ENGINE_SUBSTITUTION,STRICT_ALL_TABLES'
    await expect(runMigrations(cfg, [])).rejects.toThrow(/do executor de migrations .* traz NO_BACKSLASH_ESCAPES herdado do servidor — a casa o recusa \(D-NE174/)
    expect(conn.log.some(s => s.startsWith('CREATE DATABASE') || /GET_LOCK/.test(s))).toBe(false)
  })
})

describe('D-NE174 (Valdo 2026-11-05) — somar o estrito e RECUSAR os modos que quebram o escape do driver', () => {
  const { forbiddenSqlModesIn, FORBIDDEN_SQL_MODES, assertSessionInvariants: inv } = require('../db/pool') as typeof import('../db/pool')
  const poolWith = (sqlMode: string) => ({
    query: jest.fn(async (sql: string) => {
      if (/tx_isolation/.test(sql)) return [[{ Value: 'REPEATABLE-READ' }]]
      if (/time_zone/.test(sql)) return [[{ tz: '+00:00' }]]
      return [[{ m: sqlMode }]]
    }),
  })
  it('a lista proibida é EXATAMENTE as duas do escape e das aspas', () => {
    expect([...FORBIDDEN_SQL_MODES]).toEqual(['NO_BACKSLASH_ESCAPES', 'ANSI_QUOTES'])
  })
  it.each([
    ['NO_BACKSLASH_ESCAPES,STRICT_ALL_TABLES', ['NO_BACKSLASH_ESCAPES']],
    // o modo ANSI do servidor: o motor o EXPANDE e o ANSI_QUOTES vem junto
    ['REAL_AS_FLOAT,PIPES_AS_CONCAT,ANSI_QUOTES,IGNORE_SPACE,ANSI,STRICT_ALL_TABLES', ['ANSI_QUOTES']],
    ['ansi_quotes,no_backslash_escapes,STRICT_ALL_TABLES', ['NO_BACKSLASH_ESCAPES', 'ANSI_QUOTES']],
    ['IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION,STRICT_ALL_TABLES', []],     // o modo do dev somado — limpo
    ['NO_BACKSLASH_ESCAPESX,XANSI_QUOTES,STRICT_ALL_TABLES', []],                                     // por ITEM, nunca por pedaço
  ])('forbiddenSqlModesIn(%j) = %j', (mode, bad) => expect(forbiddenSqlModesIn(mode)).toEqual(bad))
  it('o boot FALHA ALTO com o modo proibido herdado, mesmo com o estrito presente', async () => {
    await expect(inv(poolWith('NO_BACKSLASH_ESCAPES,STRICT_ALL_TABLES') as any)).rejects.toThrow(/do pool é '[^']*': traz NO_BACKSLASH_ESCAPES herdado do servidor — a casa o recusa \(D-NE174/)
    await expect(inv(poolWith('ANSI_QUOTES,NO_BACKSLASH_ESCAPES,STRICT_ALL_TABLES') as any)).rejects.toThrow(/traz NO_BACKSLASH_ESCAPES e ANSI_QUOTES herdado/)
  })
  it('D-NE175: o boot confere o modo GLOBAL do servidor — a sessão sai limpa (o SET retira), mas o servidor torto NÃO sobe', async () => {
    const pool = { query: jest.fn(async (sql: string) => {
      if (/tx_isolation/.test(sql)) return [[{ Value: 'REPEATABLE-READ' }]]
      if (/time_zone/.test(sql)) return [[{ tz: '+00:00' }]]
      return [[{ m: 'NO_ENGINE_SUBSTITUTION,STRICT_ALL_TABLES', g: 'ANSI_QUOTES,NO_ENGINE_SUBSTITUTION' }]]
    }) }
    await expect(inv(pool as any)).rejects.toThrow(/O sql_mode GLOBAL do servidor \(no boot do pool\) é 'ANSI_QUOTES,NO_ENGINE_SUBSTITUTION': traz ANSI_QUOTES/)
  })
  it('gate socrático L6: sem o estrito E com modo proibido, os DOIS problemas saem numa mensagem só', async () => {
    await expect(inv(poolWith('NO_BACKSLASH_ESCAPES') as any)).rejects.toThrow(/a casa exige STRICT_ALL_TABLES .*; traz NO_BACKSLASH_ESCAPES herdado/)
  })
})

describe('gates do delta — cerca dos .sql: nenhuma migration do núcleo cita sql_mode nem usa INSERT IGNORE', () => {
  it('as migrations do núcleo (o executor confere o EFEITO depois de cada arquivo; esta cerca impede o TEXTO)', () => {
    const fs = require('fs') as typeof import('fs'), path = require('path') as typeof import('path')
    const { CORE_MIGRATIONS_DIR } = require('../db/migrations') as typeof import('../db/migrations')
    const hits = fs.readdirSync(CORE_MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).filter(f => {
      const sql = fs.readFileSync(path.join(CORE_MIGRATIONS_DIR, f), 'utf8').replace(/--[^\n]*/g, '')   // comentário de linha não conta; /*!…*/ do mysqldump CONTA
      return /sql_mode/i.test(sql) || /INSERT\s+IGNORE/i.test(sql)
    })
    expect(hits).toEqual([])
  })
})
