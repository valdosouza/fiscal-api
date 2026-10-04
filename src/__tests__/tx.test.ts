/// <reference types="jest" />
// fiscal-api — peça `runShortCommand` (D-F41, Valdo 2026-10-04): COMANDO CURTO numa linha disputada (o aluguel do rodízio).
import { runShortCommand, SHORT_COMMAND_LOCK_WAIT_SECONDS } from '../db/tx'
import { logger } from '../log/logger'

jest.mock('../log/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

const dbErr = (code: string, errno: number) => Object.assign(new Error(code), { code, errno })

/** Conexão falsa com a espera da SESSÃO e a variável de sessão que guarda a anterior (como no servidor). */
function fakePool(previous = 50, opts: { saveFails?: boolean; restoreFails?: boolean } = {}) {
  const conns: any[] = []
  const pool = {
    getConnection: jest.fn(async () => {
      const session = { t: previous, prev: null as number | null }
      const conn = {
        session,
        query: jest.fn(async (sql: string, p?: any[]) => {
          if (sql.startsWith('SET @fiscal_short_prev_lw = @@session.innodb_lock_wait_timeout')) {
            if (opts.saveFails) throw new Error('sem conexão')
            session.prev = session.t
            return [[]]
          }
          if (sql === 'SET SESSION innodb_lock_wait_timeout = @fiscal_short_prev_lw') {
            if (opts.restoreFails) throw new Error('caiu')
            session.t = session.prev as number
            return [[]]
          }
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

beforeEach(() => jest.clearAllMocks())

describe('runShortCommand (D-F41) — espera curta só no comando, nunca vazando para o pool', () => {
  it('espera curta DURANTE o comando e devolve a sessão ao valor que a conexão TINHA (não ao global)', async () => {
    const { pool, conns } = fakePool(7)                                          // um pool com espera própria
    let during = -1
    const out = await runShortCommand(pool, 'teste', {}, async q => {
      during = conns[0].session.t
      return q.query('UPDATE t SET x = 1')
    })
    expect(during).toBe(SHORT_COMMAND_LOCK_WAIT_SECONDS)
    expect(conns[0].session.t).toBe(7)
    expect(conns[0].release).toHaveBeenCalledTimes(1)
    expect(conns[0].destroy).not.toHaveBeenCalled()
    expect((out as any)[0].affectedRows).toBe(1)
  })

  it('a devolução da espera falha → a conexão é DESCARTADA (nunca volta ao pool com a espera curta)', async () => {
    const { pool, conns } = fakePool(50, { restoreFails: true })
    await runShortCommand(pool, 'teste', {}, async q => q.query('UPDATE t SET x = 1'))
    expect(conns[0].destroy).toHaveBeenCalledTimes(1)
    expect(conns[0].release).not.toHaveBeenCalled()
  })

  it('não conseguiu nem GUARDAR a espera atual → o erro sobe; a sessão não mudou, a conexão volta ao pool', async () => {
    const { pool, conns } = fakePool(50, { saveFails: true })
    await expect(runShortCommand(pool, 'teste', {}, async q => q.query('UPDATE t SET x = 1'))).rejects.toThrow('sem conexão')
    expect(conns[0].session.t).toBe(50)
    expect(conns[0].release).toHaveBeenCalledTimes(1)
    expect(conns[0].destroy).not.toHaveBeenCalled()
  })

  it('DEADLOCK reexecuta 1× (o 1213 já desfez o comando em autocommit) com aviso no log; cada tentativa devolve a sua conexão', async () => {
    const { pool, conns } = fakePool()
    let n = 0
    const out = await runShortCommand(pool, 'aluguel', { institutionId: 1 }, async () => { if (++n === 1) throw dbErr('ER_LOCK_DEADLOCK', 1213); return 'tomou' })
    expect(out).toBe('tomou')
    expect(conns).toHaveLength(2)
    expect(conns.every(c => c.release.mock.calls.length === 1 && c.session.t === 50)).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Deadlock no comando curto aluguel/), expect.objectContaining({ institutionId: 1, attempt: 1 }))
  })

  it('o que SOBRA (deadlock de novo / lock wait) = 409 RESOURCE_BUSY — lock wait NÃO reexecuta', async () => {
    const twice = fakePool()
    await expect(runShortCommand(twice.pool, 'x', {}, async () => { throw dbErr('ER_LOCK_DEADLOCK', 1213) }))
      .rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_BUSY' })
    expect(twice.conns).toHaveLength(2)
    const wait = fakePool()
    await expect(runShortCommand(wait.pool, 'x', {}, async () => { throw dbErr('ER_LOCK_WAIT_TIMEOUT', 1205) }))
      .rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_BUSY' })
    expect(wait.conns).toHaveLength(1)
    expect(wait.conns[0].session.t).toBe(50)                                    // restaurada mesmo no erro
  })

  it('erro que não é contenção sobe CRU (é erro técnico — a borda dá 500 com ref)', async () => {
    const { pool } = fakePool()
    await expect(runShortCommand(pool, 'x', {}, async () => { throw dbErr('ER_BAD_FIELD_ERROR', 1054) })).rejects.toMatchObject({ code: 'ER_BAD_FIELD_ERROR' })
  })
})
