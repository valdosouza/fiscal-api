/// <reference types="jest" />
// GATE ADVERSARIAL r8 — delta da Rodada 6 (D-F41/D-F45) no NÚCLEO (testar-adversarial.md, 2026-10-04).
// `it` normal = ataque que o código RESISTIU; `it.failing('[r8-…]')` = achado confirmado (passa enquanto o bug existe).
// Neste arquivo nenhum achado novo: os ataques ao `runShortCommand` e ao boot do domínio do modelo resistiram.
// (A espera de METADADOS — `lock_wait_timeout`, ALTER TABLE concorrente — não é coberta pela espera curta; isso é
// limitação analisada no relatório do gate, não provável sem banco.)
import { runShortCommand, SHORT_COMMAND_LOCK_WAIT_SECONDS } from '../db/tx'
import { assertIssuerModelDomainEnforced } from '../establishment/establishment.repository'
import { HttpError } from '../errors/http-error'

jest.mock('../log/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

const dbErr = (code: string, errno: number) => Object.assign(new Error(code), { code, errno })

/** Conexão falsa com a espera da SESSÃO; `failOn` faz um SQL específico falhar (por tentativa). */
function fakePool(previous = 50, failOn: (sql: string, attempt: number) => Error | null = () => null) {
  const conns: any[] = []
  const pool = {
    getConnection: jest.fn(async () => {
      const attempt = conns.length + 1
      const session = { t: previous, prev: null as number | null }
      const conn = {
        session,
        query: jest.fn(async (sql: string, p?: any[]) => {
          const e = failOn(sql, attempt)
          if (e) throw e
          if (sql.startsWith('SET @fiscal_short_prev_lw')) { session.prev = session.t; return [[]] }
          if (sql === 'SET SESSION innodb_lock_wait_timeout = @fiscal_short_prev_lw') { session.t = session.prev as number; return [[]] }
          if (sql === 'SET SESSION innodb_lock_wait_timeout = ?') { session.t = Number(p?.[0]); return [[]] }
          return [{ affectedRows: 1 }]
        }),
        release: jest.fn(), destroy: jest.fn(),
      }
      conns.push(conn)
      return conn
    }),
  } as any
  return { pool, conns }
}

describe('r8 — runShortCommand (D-F41): ataques à restauração da espera e à reexecução', () => {
  it('a 2ª instrução (encurtar) cai com a conexão → a devolução também falha → conexão DESCARTADA, erro sobe cru', async () => {
    const lost = dbErr('PROTOCOL_CONNECTION_LOST', 0)
    const { pool, conns } = fakePool(50, sql => (sql === 'SET SESSION innodb_lock_wait_timeout = ?' || sql.endsWith('@fiscal_short_prev_lw')) ? lost : null)
    await expect(runShortCommand(pool, 'x', {}, async q => q.query('UPDATE t SET x = 1'))).rejects.toBe(lost)
    expect(conns[0].destroy).toHaveBeenCalledTimes(1)
    expect(conns[0].release).not.toHaveBeenCalled()
  })

  it('a 2ª instrução falha SEM derrubar a conexão → a devolução roda e a conexão volta ao pool com a espera ORIGINAL', async () => {
    const { pool, conns } = fakePool(17, sql => (sql === 'SET SESSION innodb_lock_wait_timeout = ?' ? dbErr('ER_WRONG_VALUE_FOR_VAR', 1231) : null))
    await expect(runShortCommand(pool, 'x', {}, async q => q.query('UPDATE t SET x = 1'))).rejects.toMatchObject({ code: 'ER_WRONG_VALUE_FOR_VAR' })
    expect(conns[0].session.t).toBe(17)
    expect(conns[0].release).toHaveBeenCalledTimes(1)
    expect(conns[0].destroy).not.toHaveBeenCalled()
  })

  it('deadlock na 1ª tentativa COM a devolução falhando → a 1ª conexão é descartada e a 2ª tentativa roda com espera curta e devolve a sua', async () => {
    let fnCalls = 0
    const { pool, conns } = fakePool(50, (sql, attempt) => (attempt === 1 && sql.endsWith('= @fiscal_short_prev_lw') ? dbErr('PROTOCOL_CONNECTION_LOST', 0) : null))
    let during = -1
    const out = await runShortCommand(pool, 'aluguel', {}, async () => {
      fnCalls++
      during = conns[conns.length - 1].session.t
      if (fnCalls === 1) throw dbErr('ER_LOCK_DEADLOCK', 1213)
      return 'tomou'
    })
    expect(out).toBe('tomou')
    expect(fnCalls).toBe(2)
    expect(during).toBe(SHORT_COMMAND_LOCK_WAIT_SECONDS)
    expect(conns[0].destroy).toHaveBeenCalledTimes(1)
    expect(conns[0].release).not.toHaveBeenCalled()
    expect(conns[1].release).toHaveBeenCalledTimes(1)
    expect(conns[1].session.t).toBe(50)
  })

  it('HttpError de NEGÓCIO de dentro do comando (ex.: 409 da cerca no aluguel) passa INTACTO e não reexecuta', async () => {
    const biz = new HttpError(409, 'réplica', undefined, 'FISCAL_CUTOVER_PENDING' as any)
    let n = 0
    const { pool, conns } = fakePool()
    await expect(runShortCommand(pool, 'x', {}, async () => { n++; throw biz })).rejects.toBe(biz)
    expect(n).toBe(1)
    expect(conns[0].session.t).toBe(50)
    expect(conns[0].release).toHaveBeenCalledTimes(1)
  })

  it('espera parametrizada: o valor pedido vai como PARÂMETRO (nunca interpolado) e a anterior é a da SESSÃO, não um número do processo', async () => {
    const { pool, conns } = fakePool(9)
    await runShortCommand(pool, 'x', {}, async q => q.query('UPDATE t SET x = 1'), 1)
    const sqls = conns[0].query.mock.calls.map((c: any[]) => c[0])
    expect(sqls[0]).toBe('SET @fiscal_short_prev_lw = @@session.innodb_lock_wait_timeout')
    expect(conns[0].query.mock.calls[1]).toEqual(['SET SESSION innodb_lock_wait_timeout = ?', [1]])
    expect(sqls[sqls.length - 1]).toBe('SET SESSION innodb_lock_wait_timeout = @fiscal_short_prev_lw')
    expect(conns[0].session.t).toBe(9)
  })
})

describe('r8 — assertIssuerModelDomainEnforced (D-F45): o boot só passa se o MOTOR recusar o modelo fora do domínio', () => {
  const poolWith = (insert: () => Promise<any>) => {
    const conn = { beginTransaction: jest.fn(), rollback: jest.fn(), release: jest.fn(), query: jest.fn(async () => insert()) }
    return { pool: { getConnection: jest.fn(async () => conn) } as any, conn }
  }

  it('motor ACEITA (CHECK ignorado) → o boot falha E a transação é desfeita (nenhum resíduo (0,ZZ) fica no banco)', async () => {
    const { pool, conn } = poolWith(async () => [{ affectedRows: 1 }])
    await expect(assertIssuerModelDomainEnforced(pool)).rejects.toThrow(/não aplica CHECK/)
    expect(conn.rollback).toHaveBeenCalledTimes(1)
    expect(conn.release).toHaveBeenCalledTimes(1)
  })

  it('falha que NÃO é o CHECK (coluna sem default, FK, sem GRANT) → o boot falha alto (nunca "passou" por engano)', async () => {
    for (const e of [dbErr('ER_NO_DEFAULT_FOR_FIELD', 1364), dbErr('ER_NO_REFERENCED_ROW_2', 1452), dbErr('ER_TABLEACCESS_DENIED_ERROR', 1142)]) {
      const { pool, conn } = poolWith(async () => { throw e })
      await expect(assertIssuerModelDomainEnforced(pool)).rejects.toBe(e)
      expect(conn.rollback).toHaveBeenCalledTimes(1)
    }
  })

  it('recusa pelo CHECK (MariaDB 4025 / MySQL 3819) → passa, e a conexão volta ao pool', async () => {
    for (const e of [dbErr('ER_CONSTRAINT_FAILED', 4025), dbErr('ER_CHECK_CONSTRAINT_VIOLATED', 3819)]) {
      const { pool, conn } = poolWith(async () => { throw e })
      await expect(assertIssuerModelDomainEnforced(pool)).resolves.toBeUndefined()
      expect(conn.release).toHaveBeenCalledTimes(1)
    }
  })
})
