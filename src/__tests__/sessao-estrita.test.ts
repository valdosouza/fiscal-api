/**
 * D-NE172 (Valdo 2026-10-31, Q-NE172 = (a)): a sessão do pool do núcleo é ESTRITA — `STRICT_ALL_TABLES` somado ao modo do servidor em
 * TODA conexão nova (molde do REPEATABLE READ e do UTC), conferido no boot (`assertSessionInvariants`), e a sonda de COMPRIMENTO prova
 * que o motor recusa o texto maior que a coluna (1406) em vez de truncar calado antes do CHECK.
 */
jest.mock('mysql2/promise', () => {
  const handlers: Record<string, (conn: unknown) => void> = {}
  const pool = { on: (ev: string, fn: (conn: unknown) => void) => { handlers[ev] = fn; return pool } }
  return { __esModule: true, default: { createPool: jest.fn(() => pool) }, __handlers: handlers }
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
    handlers.connection({ query: (sql: string, cb: (e: unknown) => void) => { ran.push(sql); cb(null) } })
    expect(ran).toEqual([
      'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      `SET time_zone = '+00:00'`,
      STRICT_SESSION_SQL,
    ])
    expect(STRICT_SESSION_SQL).toBe(`SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_ALL_TABLES')`)
    expect(REQUIRED_SQL_MODE).toBe('STRICT_ALL_TABLES')
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
    handlers.connection({ destroy: ok, query: (_: string, cb: (e: unknown) => void) => cb(null) })
    expect(ok).not.toHaveBeenCalled()
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
  it('só `db/pool.ts` cita sql_mode no código (comentário não conta) — `SET [SESSION] sql_mode` ou `SET STATEMENT sql_mode=… FOR` desligaria o modo estrito sem o boot perceber', () => {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const root = path.resolve(__dirname, '..')
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? (e.name === '__tests__' ? [] : walk(path.join(dir, e.name))) : /\.[cm]?ts$/.test(e.name) ? [path.join(dir, e.name)] : [])
    const hits = walk(root)
      .filter(f => path.relative(root, f).split(path.sep).join('/') !== 'db/pool.ts')
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
