/// <reference types="jest" />
// NE-1a parte 2 — passo 2: o EMITTER no núcleo (D-NE9 = Q-NE9 (c); `prompt_onda_nfe_sefaz.md` §12.9.7).
//  - `countLiveTransmissions` soma as LEITURAS PUBLICADAS das famílias (views do catálogo `VOICE_READINGS`), com os finais DERIVADOS;
//  - o DELETE do A1 soma TODAS as famílias (a guarda injetada pela família morreu — a nfse-api apagaria o A1 com uma NF-e viva);
//  - a habilitação de M olha só a família de M; erro do banco (1146 — view ausente) NUNCA vira 0.
import { FINAL_TRANSMISSION_KINDS } from '../voice/kinds'
import { MasterKeyRing } from '../secret/cipher'
import { randomBytes } from 'crypto'
import * as emitter from '../emitter/emitter'

const FINALS = [...FINAL_TRANSMISSION_KINDS].map(k => `'${k}'`).join(',')
const ring = MasterKeyRing.of({ 1: randomBytes(32) })

/** Conexão FALSA: [live] = vivas por view; guarda a ordem dos SQL. */
function fakeConn(live: Record<string, number>, opts: { rows?: any[]; issuer?: any; failView?: string; catalog?: string[]; failWith?: unknown } = {}) {
  const calls: { sql: string; p: any[] }[] = []
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    calls.push({ sql, p })
    const view = /COUNT\(\*\) AS n FROM (vw_[a-z0-9_]+) t/.exec(sql)?.[1]
    if (view) {
      if (view === opts.failView) throw opts.failWith ?? Object.assign(new Error(`Table 'fiscal_api.${view}' doesn't exist`), { errno: 1146, code: 'ER_NO_SUCH_TABLE' })
      return [[{ n: live[view] ?? 0 }]]
    }
    if (/information_schema\.TABLES/.test(sql)) return [(opts.catalog ?? []).filter(n => p.includes(n)).map(name => ({ name }))]
    if (/SELECT model, cutover_at AS c FROM tb_establishment_issuer[\s\S]*FOR UPDATE/.test(sql)) return [opts.rows ?? [{ model: 'SE', c: '2026-10-12 10:00:00' }]]
    if (/FROM tb_establishment_issuer WHERE tb_institution_id = \? AND model = \? AND deleted = 'N'/.test(sql)) return [opts.issuer ? [opts.issuer] : []]
    if (/FROM tb_establishment_issuer WHERE tb_institution_id = \? AND deleted = 'N' ORDER BY model/.test(sql)) return [opts.issuer ? [opts.issuer] : []]
    if (/^\s*UPDATE tb_establishment_certificate/.test(sql)) return [{ affectedRows: 1 }]
    if (/^\s*(INSERT|UPDATE)/.test(sql)) return [{ affectedRows: 1 }]
    return [[]]
  })
  const conn = { query, beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
  const pool = { query, getConnection: jest.fn(async () => conn) } as any
  return { pool, conn, calls }
}
const ACTOR = { institutionId: 1, userId: 7, schemaName: 'setes_setes' }
const ISSUER_SE_H = { institutionId: 1, model: 'SE', environment: 'H', serie: '1', userId: null, cutoverAt: '2026-10-12 10:00:00' }

describe('countLiveTransmissions — leituras PUBLICADAS de cada família, finais derivados', () => {
  it('lê a VIEW da família (nunca a tabela), conta "sem voz ou última voz não final", ambiente opcional, sem terminal', async () => {
    const { pool, calls } = fakeConn({ vw_invoice_service_transmission: 3 })
    expect(await emitter.countLiveTransmissions(pool, 1, { branches: 'all' })).toBe(3)
    expect(calls[0].sql).toMatch(/FROM vw_invoice_service_transmission t/)
    expect(calls[0].sql).toContain(`AND (t.last_kind IS NULL OR t.last_kind NOT IN (${FINALS}))`)
    expect(calls[0].sql).not.toMatch(/terminal|tb_invoice_service/)
    expect(calls[0].p).toEqual([1, null, null])
    await emitter.countLiveTransmissions(pool, 1, { branches: ['service'], environment: 'P' })
    expect(calls[1].p).toEqual([1, 'P', 'P'])
  })
  it('ramo sem leitura no catálogo (a família ainda não existe) = nenhuma tentativa possível — sem SQL', async () => {
    const { pool, calls } = fakeConn({})
    expect(await emitter.countLiveTransmissions(pool, 1, { branches: ['merchandise'] })).toBe(0)
    expect(calls).toHaveLength(0)
  })
  it('CONHECIMENTO NEGATIVO [convertido — D-NE76]: view ausente (1146) com a família INSTALADA (a view ou a tabela de tentativas dela existe) NUNCA vira 0 — o erro sobe; a família NÃO instalada neste banco (nem view nem tabela — a outra API ainda não subiu aqui) conta 0', async () => {
    for (const present of [['vw_invoice_service_transmission'], ['tb_invoice_service_transmission']]) {
      const { pool, calls } = fakeConn({}, { failView: 'vw_invoice_service_transmission', catalog: present })
      await expect(emitter.countLiveTransmissions(pool, 1, { branches: 'all' })).rejects.toMatchObject({ errno: 1146 })
      const cat = calls.find(c => /information_schema\.TABLES/.test(c.sql))!
      expect(cat.p).toEqual(['vw_invoice_service_transmission', 'tb_invoice_service_transmission'])   // a tabela pela convenção vw_<x> ↔ tb_<x>
    }
    const { pool } = fakeConn({}, { failView: 'vw_invoice_service_transmission', catalog: [] })
    await expect(emitter.countLiveTransmissions(pool, 1, { branches: 'all' })).resolves.toBe(0)
    // outro erro (não 1146) nem pergunta ao catálogo
    const lost = fakeConn({}, { failView: 'vw_invoice_service_transmission', failWith: Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' }) })
    await expect(emitter.countLiveTransmissions(lost.pool, 1, { branches: 'all' })).rejects.toMatchObject({ code: 'PROTOCOL_CONNECTION_LOST' })
    expect(lost.calls.some(c => /information_schema/.test(c.sql))).toBe(false)
  })
  it('[gates da parte 2 — NE1A2-06] ramos vazios, que não são lista, ou fora do domínio falham ALTO sem SQL (a guarda do A1 não falha aberto)', async () => {
    const { pool, calls } = fakeConn({ vw_invoice_service_transmission: 5 })
    for (const branches of [[], 'ALL', ['servico'], undefined, null, ['service', 'x']] as any[]) {
      await expect(emitter.countLiveTransmissions(pool, 1, { branches })).rejects.toThrow(/ramos inválidos/)
    }
    expect(calls).toEqual([])
    await expect(emitter.countLiveTransmissions(pool, 1, { branches: ['merchandise'] })).resolves.toBe(0)   // ramo do domínio sem leitura ainda (NE-2)
  })
})

describe('D-NE9 — o DELETE do A1 soma TODAS as famílias (catálogo com a NF-e simulada)', () => {
  // o catálogo real só tem a família de serviço (a NF-e entra na NE-2); aqui uma 2ª leitura é injetada para provar a SOMA
  const withMerchandise = () => {
    let mod!: typeof import('../emitter/emitter')
    jest.isolateModules(() => {
      jest.doMock('../voice/families', () => {
        const actual = jest.requireActual('../voice/families')
        return { ...actual, VOICE_READINGS: Object.freeze({ ...actual.VOICE_READINGS,
          merchandise: { ...actual.VOICE_READINGS.service, branch: 'merchandise', transmissionView: 'vw_invoice_merchandise_transmission' } }) }
      })
      mod = require('../emitter/emitter')
    })
    return mod
  }
  afterEach(() => jest.dontMock('../voice/families'))

  it('NF-e viva e nenhuma NFS-e viva → o A1 NÃO se apaga (409); a habilitação SE (família de serviço) segue livre para trocar de ambiente', async () => {
    const mod = withMerchandise()
    const db = fakeConn({ vw_invoice_service_transmission: 0, vw_invoice_merchandise_transmission: 1 }, { issuer: ISSUER_SE_H })
    expect(await mod.countLiveTransmissions(db.pool, 1, { branches: 'all' })).toBe(1)
    await expect(mod.clearCertificate({ pool: db.pool, keyring: ring }, 1, 7, { schemaName: 'setes_setes' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS' })
    expect(db.calls.some(c => /UPDATE tb_establishment_certificate/.test(c.sql))).toBe(false)
    expect(db.conn.rollback).toHaveBeenCalled()
    // a habilitação SE olha só a família de SERVIÇO (as vivas da NF-e não barram o ambiente da SE)
    await expect(mod.writeIssuer({ pool: db.pool, keyring: ring }, ACTOR, 'SE', { environment: 'P', serie: '1' })).resolves.toBeUndefined()
    expect(db.calls.filter(c => /COUNT\(\*\) AS n FROM vw_/.test(c.sql)).slice(-1)[0].sql).toMatch(/vw_invoice_service_transmission/)
  })
  it('55 e 65 dividem a família de mercadoria — as vivas de um barram o ambiente do outro (sobre-bloqueio, falha FECHADO)', async () => {
    const mod = withMerchandise()
    const db = fakeConn({ vw_invoice_merchandise_transmission: 2 }, { rows: [{ model: '65', c: '2026-10-12 10:00:00' }],
      issuer: { ...ISSUER_SE_H, model: '65' } })
    await expect(mod.writeIssuer({ pool: db.pool, keyring: ring }, ACTOR, '65', { environment: 'P', serie: '1' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS' })
  })
})

describe('composição do emitter (catálogo real — só a família de serviço)', () => {
  it('apagar o A1: 1ª instrução = TRAVA das linhas da habilitação, depois as vivas (view), depois apaga — sem vivas apaga', async () => {
    const db = fakeConn({ vw_invoice_service_transmission: 0 })
    await emitter.clearCertificate({ pool: db.pool, keyring: ring }, 1, 7, { schemaName: 'setes_setes' })
    const order = db.calls.map(c => (/FOR UPDATE/.test(c.sql) ? 'trava' : /FROM vw_/.test(c.sql) ? 'vivas' : /UPDATE tb_establishment_certificate/.test(c.sql) ? 'apaga' : null)).filter(Boolean)
    expect(order).toEqual(['trava', 'vivas', 'apaga'])
  })
  it('trocar o ambiente da habilitação com viva no ambiente ATUAL → 409 (contando só o ambiente atual); mesmo ambiente não conta', async () => {
    const db = fakeConn({ vw_invoice_service_transmission: 1 }, { issuer: ISSUER_SE_H })
    await expect(emitter.writeIssuer({ pool: db.pool, keyring: ring }, ACTOR, 'SE', { environment: 'P', serie: '1' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS' })
    expect(db.calls.find(c => /FROM vw_/.test(c.sql))!.p).toEqual([1, 'H', 'H'])
    const same = fakeConn({ vw_invoice_service_transmission: 1 }, { issuer: ISSUER_SE_H })
    await expect(emitter.writeIssuer({ pool: same.pool, keyring: ring }, ACTOR, 'SE', { environment: 'H', serie: '2' })).resolves.toBeUndefined()
    expect(same.calls.some(c => /FROM vw_/.test(c.sql))).toBe(false)
    expect(same.calls[0].sql).toMatch(/FOR UPDATE/)                                   // a cerca é a 1ª instrução
  })
  it('excluir a habilitação: sem linha → 404; com viva em QUALQUER ambiente → 409', async () => {
    const none = fakeConn({})
    await expect(emitter.deleteIssuer({ pool: none.pool, keyring: ring }, ACTOR, 'SE')).rejects.toMatchObject({ statusCode: 404, code: 'FISCAL_ISSUER_MISSING' })
    const live = fakeConn({ vw_invoice_service_transmission: 1 }, { issuer: ISSUER_SE_H })
    await expect(emitter.deleteIssuer({ pool: live.pool, keyring: ring }, ACTOR, 'SE')).rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS' })
    expect(live.calls.find(c => /FROM vw_/.test(c.sql))!.p).toEqual([1, null, null])
  })
  it('a visão do emissor por família mostra só os modelos DELA (o A1 é comum)', async () => {
    const rows = [{ ...ISSUER_SE_H }, { ...ISSUER_SE_H, model: '55' }]
    const q = jest.fn(async (sql: string) => (/ORDER BY model/.test(sql) ? [rows] : [[]]))
    const pool = { query: q } as any
    const service = await emitter.emitterView({ pool, keyring: ring }, 1, 'service')
    const merch = await emitter.emitterView({ pool, keyring: ring }, 1, 'merchandise')
    expect([service.issuers.map(i => [i.model, i.authority]), merch.issuers.map(i => [i.model, i.authority])]).toEqual([[['SE', 'ADN']], [['55', 'SEFAZ']]])
  })
  it('modelo fora do domínio falha antes do banco; upload sem base64 → 400 antes de abrir o PKCS#12', async () => {
    const db = fakeConn({})
    await expect(emitter.writeIssuer({ pool: db.pool, keyring: ring }, ACTOR, 'ZZ' as any, { environment: 'H', serie: '1' })).rejects.toThrow(/fora do domínio/)
    await expect(emitter.uploadCertificate({ pool: db.pool, keyring: ring }, ACTOR, { pfxBase64: '***', password: '' }, { expectedCnpj: '12345678000199' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'FISCAL_CERT_INVALID' })
    expect(db.calls).toHaveLength(0)
  })
})
