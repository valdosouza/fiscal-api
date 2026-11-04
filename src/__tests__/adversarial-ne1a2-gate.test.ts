/// <reference types="jest" />
// GATE ADVERSARIAL — NE-1a PARTE 2, passos 1–6 (`prompt_onda_nfe_sefaz.md` §12.9.7.1) — NÚCLEO (fiscal-api). Revisor independente — NÃO
// fez a entrega (`Infra-IA/skills-genericas/testar-adversarial.md` §4-6). O delta é o working tree (nada commitado).
//
// Promessas atacadas aqui (as da nfse-api ficam no gate gêmeo `nfse-api/src/__tests__/adversarial-ne1a2-gate.test.ts`):
//  - D-NE74: a voz só se escreve com `InvoiceTx`, que só o `withInvoiceTx` do núcleo produz — sob a trava, na nota travada; vazado depois
//    da transação é recusado; referência congelada;
//  - D-F108/D-F106: o escritor genérico aceita só a lista da FAMÍLIA, no tipo e em EXECUÇÃO, antes de qualquer query;
//  - D-NE13/D-NE58: as POLÍTICAS (idempotência (kind, dh), C por kind, reserva K / liberação N) sobre o escritor;
//  - D-NE57: a cadeia do SERVIDOR decide pelo CÓDIGO → 409 FISCAL_AUTHORITY_CHAIN_UNTRUSTED, voz F, `ca` só quando dito;
//  - D-NE9: as vivas do emissor pelas VIEWS de todas as famílias (1146 nunca vira 0); D-NE10: a cerca por MODELO × ESTABELECIMENTO;
//  - D-F31: exceção nomeada só para `${table}` em `voice/event-table.ts`; D-NE12/D-NE69: terminal por parâmetro, listas derivadas.
//
//  * ACHADOS (`it.failing('[SEV NE1A2-xx] …')`) — o teste afirma o que a decisão promete e FALHA no código atual (prova do achado);
//    o corretor troca `it.failing` por `it` depois de corrigir (ou de decidida a questão). NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (regressão).
//  * CONTEXTO (`it('contexto: …')`) — fixa o comportamento atual que fundamenta um achado ou uma QUESTÃO (Q-NE80…).
//
// REGRAS DO GATE: nenhum socket, nenhum banco (conexões FALSAS em memória), nada no disco, nada que fale com o fisco.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import { withInvoiceTx, InvoiceTx } from '../erp/invoice-tx'
import { defineVoiceFamily } from '../voice/event-table'
import { SERVICE_VOICE_READING } from '../voice/families/service'
import { invoiceRef, InvoiceRef } from '../ref/invoice-ref'
import { LockedInvoice } from '../erp/facts'
import { recordVoiceOnce, recordKindOnce, reserveCancelRequest, releaseCancelRequest, CANCEL_REQUEST_IN_FLIGHT } from '../voice/policy'
import { classifyAuthorityError, OUTCOME_KIND, EMITTER_FAILURE_CODES } from '../voice/outcome'
import { authorityJson, transport, AuthorityHttpError } from '../transport/https-json'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'
import { logger } from '../log/logger'
import { countLiveTransmissions, clearCertificate } from '../emitter/emitter'
import { emissionStillInErp } from '../establishment/establishment'
import { assertIssuerWritable } from '../establishment/establishment.repository'
import { MasterKeyRing } from '../secret/cipher'
import { erpWritesIn } from './fence'
import { randomBytes } from 'crypto'

const SRC_ROOT = path.resolve(__dirname, '..')
const WORKSPACE = path.resolve(SRC_ROOT, '..', '..')
const read = (f: string) => fs.readFileSync(f, 'utf8')
const walk = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? (d.name === '__tests__' || d.name === 'node_modules' ? [] : walk(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []))
const tick = () => new Promise(r => setImmediate(r))

const SERVICE = defineVoiceFamily({ reading: SERVICE_VOICE_READING, eventTable: 'tb_invoice_service_transmission_event', writeKinds: ['A', 'R', 'C', 'K', 'F', 'N'] as const, label: 'NFS-e' })
const LOCKED: LockedInvoice = { alive: true, lifeEvent: 3, lastEvent: 3, lastKind: 'E' }
const REF = invoiceRef(1, 6200, 0)

/** Conexão FALSA com LINHA DO TEMPO: cada query é registrada ao ser CHAMADA e responde num macrotick (como o mysql2 numa conexão real). */
function fakeConn(opts: { next?: number; has?: number; byKind?: any } = {}) {
  const log: string[] = []
  const calls: { sql: string; p: any[] }[] = []
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    const tag = /MAX\(event\)/.test(sql) ? 'MAX' : /^\s*INSERT/.test(sql) ? 'INSERT' : /COUNT\(\*\) AS n/.test(sql) ? 'HAS' : /ORDER BY event DESC LIMIT 1/.test(sql) ? 'FIND' : 'Q'
    log.push(tag)
    calls.push({ sql, p })
    await tick()
    if (tag === 'MAX') return [[{ next: opts.next ?? 1 }]]
    if (tag === 'HAS') return [[{ n: opts.has ?? 0 }]]
    if (tag === 'FIND') return [opts.byKind ? [opts.byKind] : []]
    return [{ affectedRows: 1 }]
  })
  const conn = {
    query,
    beginTransaction: jest.fn(async () => { log.push('BEGIN') }),
    commit: jest.fn(async () => { log.push('COMMIT') }),
    rollback: jest.fn(async () => { log.push('ROLLBACK') }),
    release: jest.fn(() => { log.push('RELEASE') }),
  }
  const pool = { query, getConnection: jest.fn(async () => conn) } as any
  return { conn, pool, query, calls, log, inserts: () => calls.filter(c => /^\s*INSERT/.test(c.sql)) }
}
/** Um `InvoiceTx` de verdade — pela ÚNICA porta (`withInvoiceTx`), com a trava simulada. */
const underLock = <T>(pool: any, ref: InvoiceRef, fn: (itx: InvoiceTx) => Promise<T>) =>
  withInvoiceTx(pool, { schemaName: 'setes_setes', institutionId: 1 }, ref, { label: 'gate', lock: async () => LOCKED }, fn)

// ===========================================================================
// A — D-NE74: o InvoiceTx (forjar, vazar, reusar, mutar, retentativa por deadlock)
// ===========================================================================

describe('A — D-NE74: a voz só se escreve com o InvoiceTx que o withInvoiceTx produz', () => {
  it('[CORRIGIDO na sessão — D-NE81] [MEDIUM NE1A2-01] um InvoiceTx FORJADO (objeto congelado à mão com `open: true`, sem passar pelo `withInvoiceTx` — nenhuma trava, nota qualquer, conexão qualquer) é recusado em EXECUÇÃO', async () => {
    // A marca `[INVOICE_TX]` é só de TIPO (`declare const` — some no JS); `assertInvoiceTx` confere FORMA (congelado, open === true, conn com
    // query, ref congelada com inteiros, locked presente) — e a forma se monta à mão. Basta um `as any` (que a cerca de cast NÃO vê: ela só
    // procura `InvoiceTx` no texto do tipo) e o escritor grava na nota 999 sem FOR UPDATE nenhum, até pelo POOL (autocommit, fora de transação).
    // A própria peça de teste da nfse-api (`fixture-ref.ts` → `itxOf`) forja exatamente assim, e o escritor aceita.
    const { pool, query, inserts } = fakeConn()
    const forged: any = Object.freeze({ conn: pool, ref: Object.freeze({ institutionId: 1, invoiceId: 999, terminal: 0 }), locked: {}, open: true })
    let refused = false
    try { await SERVICE.insertTransmissionEvent(forged, 1, null, { kind: 'A', source: 'P' }) } catch (e: any) { refused = /^D-NE74/.test(e.message) }
    expect([refused, query.mock.calls.length, inserts().map(c => c.p[1])]).toEqual([true, 0, []])
  })

  it('[CORRIGIDO na sessão] [LOW NE1A2-02] a escrita COMEÇADA dentro do callback e não aguardada termina DEPOIS do COMMIT (e da devolução da conexão ao pool) — o `open` só é conferido na ENTRADA do escritor', async () => {
    // `void family.insertTransmissionEvent(itx, …)` (um `await` esquecido): o funil e o `assertInvoiceTx` passam síncronos, o MAX+1 sai, o
    // callback termina, a transação COMITA e a conexão volta ao pool — e o INSERT sai depois, em autocommit, sem a trava da nota (ou dentro da
    // transação de OUTRA requisição que pegou a mesma conexão). Uma 2ª conferência do `open` antes do INSERT recusaria.
    const { pool, log } = fakeConn()
    let floating: Promise<unknown> = Promise.resolve()
    await underLock(pool, REF, async itx => {
      floating = SERVICE.insertTransmissionEvent(itx, 1, null, { kind: 'F', source: 'P' }).catch(e => e)
    })
    await floating
    for (let i = 0; i < 5; i++) await tick()
    const ins = log.indexOf('INSERT'), commit = log.indexOf('COMMIT')
    expect({ log, insertBeforeCommitOrNone: ins === -1 || ins < commit }).toMatchObject({ insertBeforeCommitOrNone: true })
  })

  it('resistiu: InvoiceTx guardado do 1º ciclo de uma retentativa por DEADLOCK e usado DENTRO do 2º ciclo é recusado sem query (cada ciclo tem o seu)', async () => {
    const { pool, query } = fakeConn()
    let first: InvoiceTx | null = null
    let n = 0
    let refusal = ''
    await underLock(pool, REF, async itx => {
      if (++n === 1) { first = itx; throw Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 }) }
      query.mockClear()
      try { await SERVICE.insertTransmissionEvent(first!, 1, null, { kind: 'F', source: 'P' }) } catch (e: any) { refusal = e.message }
      await SERVICE.insertTransmissionEvent(itx, 1, null, { kind: 'F', source: 'P' })
    })
    expect(refusal).toMatch(/^D-NE74/)
    expect(query.mock.calls.filter(c => /^\s*INSERT/.test(c[0])).length).toBe(1)          // só a escrita do InvoiceTx VIVO
  })

  it('resistiu: referência com GETTERS que mudam a cada leitura (Proxy) — o withInvoiceTx lê UMA vez: a nota travada é a nota escrita', async () => {
    const { pool, inserts } = fakeConn()
    let reads = 0
    const shifty = new Proxy({}, { get: (_t, k) => (k === 'invoiceId' ? 6200 + (reads++) * 1000 : k === 'institutionId' ? 1 : k === 'terminal' ? 0 : undefined) }) as InvoiceRef
    const lock = jest.fn(async () => LOCKED)
    await withInvoiceTx(pool, { schemaName: 's', institutionId: 1 }, shifty, { label: 'gate', lock }, itx => SERVICE.insertTransmissionEvent(itx, 1, null, { kind: 'F', source: 'P' }))
    const locked = (lock.mock.calls[0] as any[])[2].invoiceId
    expect([locked, inserts()[0].p[1]]).toEqual([6200, 6200])
  })

  it('contexto (Q-NE80 → D-NE80: a cerca por AST nas famílias — `voice-kind-fence` da nfse-api): `opts.lock` aceita QUALQUER função — um "travante" que não trava produz um InvoiceTx válido e a voz é escrita sem FOR UPDATE nenhum; em produção só `erp.lockInvoice` é passado', async () => {
    const { pool, calls } = fakeConn()
    await withInvoiceTx(pool, { schemaName: 's', institutionId: 1 }, REF, { label: 'gate', lock: async () => LOCKED }, itx => SERVICE.insertTransmissionEvent(itx, 1, null, { kind: 'F', source: 'P' }))
    expect(calls.some(c => /FOR UPDATE/.test(c.sql))).toBe(false)
    expect(calls.filter(c => /^\s*INSERT/.test(c.sql))).toHaveLength(1)
    // produção: toda chamada do withInvoiceTx do núcleo que diz `lock:` diz `erp.lockInvoice` (AST — fiscal-api, nfse-api src/scripts, nfe-api)
    const locks: string[] = []
    for (const f of [...walk(path.join(WORKSPACE, 'fiscal-api', 'src')), ...walk(path.join(WORKSPACE, 'nfse-api', 'src')),
      ...walk(path.join(WORKSPACE, 'nfse-api', 'scripts')), ...walk(path.join(WORKSPACE, 'nfe-api', 'src'))]) {
      const sf = ts.createSourceFile(f, read(f), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const visit = (n: ts.Node): void => {
        if (ts.isPropertyAssignment(n) && n.name.getText(sf) === 'lock' && ts.isObjectLiteralExpression(n.parent)) locks.push(n.initializer.getText(sf))
        ts.forEachChild(n, visit)
      }
      visit(sf)
    }
    expect([...new Set(locks)]).toEqual(['erp.lockInvoice'])
  })
})

// ===========================================================================
// B — D-F108/D-F106: o FUNIL da família em execução, antes de qualquer query; o descritor
// ===========================================================================

describe('B — o funil do escritor genérico e o descritor', () => {
  it('[CORRIGIDO na sessão] [LOW NE1A2-03] o funil lê `e.kind` UMA vez e o INSERT lê DE NOVO: um objeto com GETTER (`as any`, Proxy) passa o funil com A e grava S na tabela da NFS-e', async () => {
    // O funil existe justamente para o que apaga o tipo (cast, JSON, `as any`); conferir e gravar o MESMO valor (copiar `e.kind` para uma
    // constante antes do funil) fecha. Mesma classe do TOCTOU: o valor conferido não é o valor gravado.
    const { pool, inserts } = fakeConn()
    let reads = 0
    const evil: any = { get kind() { return reads++ === 0 ? 'A' : 'S' }, source: 'P' }
    await underLock(pool, REF, async itx => { await SERVICE.insertTransmissionEvent(itx, 1, null, evil).catch(() => undefined) })
    expect(inserts().map(c => c.p[5]).filter(k => !SERVICE.writeKinds.includes(k))).toEqual([])
  })

  it('resistiu: kind "parecido" — String objeto, espaço, minúscula, largura total, combinante, array, objeto com toString — recusado ANTES de qualquer query', async () => {
    const { pool, query } = fakeConn()
    await underLock(pool, REF, async itx => {
      query.mockClear()
      // eslint-disable-next-line no-new-wrappers
      for (const k of [new String('A'), 'A ', ' A', 'a', 'Ａ', 'À', ['A'], { toString: () => 'A' }, 'AA', 'A\u0000']) {
        await expect(SERVICE.insertTransmissionEvent(itx, 1, null, { kind: k, source: 'P' } as any)).rejects.toThrow(/^D-F106/)
      }
      expect(query).not.toHaveBeenCalled()
    })
  })

  it('resistiu: o descritor recusa nome de tabela com quebra de linha no fim, homóglifo cirílico, tabulação, espaço, comentário, String objeto e objeto com toString', () => {
    // eslint-disable-next-line no-new-wrappers
    for (const t of ['tb_x_transmission_event\n', 'tb_е_transmission_event', 'tb_x_transmission_event\t', 'tb_x_transmission_event ',
      'tb_x_transmission_event/**/', new String('tb_x_transmission_event'), { toString: () => 'tb_x_transmission_event' }, 'tb__transmission_event']) {
      expect(() => defineVoiceFamily({ reading: SERVICE_VOICE_READING, eventTable: t as any, writeKinds: ['A'] as const, label: 'NFS-e' })).toThrow(/tabela da voz inválida/)
    }
  })

  it('contexto (→ NE1A2-09 da nfse-api; D-NE82 (a) — a cerca da família endurecida; (c) REJEITADA pela D-NE167, NE-2 2026-10-20: a defesa em EXECUÇÃO é o CHECK BINÁRIO da tabela da família no banco — um registro no processo não cobre o outro serviço): o núcleo NÃO guarda registro de descritores — um 2º descritor da MESMA tabela com S na lista grava S nela; "um descritor só" por serviço é promessa da CERCA por AST da família (nfse-api e nfe-api)', async () => {
    const WIDE = defineVoiceFamily({ reading: SERVICE_VOICE_READING, eventTable: 'tb_invoice_service_transmission_event', writeKinds: ['A', 'S', 'P', 'D'] as const, label: 'NFS-e' })
    const { pool, inserts } = fakeConn()
    await underLock(pool, REF, async itx => {
      for (const k of ['S', 'P', 'D'] as const) await WIDE.insertTransmissionEvent(itx, 1, null, { kind: k, source: 'P' })
    })
    expect(inserts().map(c => [c.sql.match(/INSERT INTO (\S+)/)![1], c.p[5]])).toEqual([
      ['tb_invoice_service_transmission_event', 'S'], ['tb_invoice_service_transmission_event', 'P'], ['tb_invoice_service_transmission_event', 'D']])
  })
})

// ===========================================================================
// C — políticas (D-NE13/D-NE58): idempotência, C por kind, reserva K / liberação N
// ===========================================================================

describe('C — políticas sobre o escritor', () => {
  it('[CORRIGIDO na sessão — D-NE83] [LOW NE1A2-04] `releaseCancelRequest` grava N com o `current` de OUTRA tentativa (ou montado à mão): o "N só depois do K" não está amarrado à tentativa escrita', async () => {
    // `current` só tem `lastKind` no tipo — `{ lastKind: 'K' }` literal compila SEM cast, e o `current` lido de outra tentativa também. Com a
    // tentativa 1 já CANCELADA (C) e a 2 em K, liberar "a 1" com o `current` da 2 grava N na 1 → a NFS-e cancelada volta a "autorizada".
    const { pool, inserts } = fakeConn()
    const currentOfAttempt2 = { attempt: 2, lastKind: 'K' as const }
    await underLock(pool, REF, async itx => {
      await releaseCancelRequest(SERVICE.insertTransmissionEvent, itx, 1, null, 'pedido não enviado', currentOfAttempt2).catch(() => undefined)
    })
    expect(inserts().map(c => [c.p[3], c.p[5]])).toEqual([])
  })

  it('[CORRIGIDO na sessão] [LOW NE1A2-05] as POLÍTICAS leem ANTES de conferir o InvoiceTx: com um InvoiceTx VAZADO, `recordVoiceOnce`/`recordKindOnce` consultam a conexão já devolvida ao pool e devolvem "já estava" CALADAS', async () => {
    // O escritor recusa o vazado (D-NE74), mas a política só chega nele quando a fala é NOVA. Quando a fala já existe, ela lê pela conexão
    // devolvida (fora da trava, talvez dentro da transação de outra requisição) e responde sucesso — o uso indevido não aparece.
    const { pool, query } = fakeConn({ has: 1, byKind: { attempt: 1, event: 4, kind: 'C', authorityCode: '101101', message: null, dh: null, source: 'Q', userId: null, createdAt: null } })
    let leaked: InvoiceTx | null = null
    await underLock(pool, REF, async itx => { leaked = itx })
    query.mockClear()
    const outcomes: string[] = []
    for (const run of [
      () => recordVoiceOnce(SERVICE, leaked!, 1, null, { kind: 'A', source: 'Q', dh: '2026-10-12 10:00:00' }),
      () => recordKindOnce(SERVICE, leaked!, 1, null, { kind: 'C', source: 'Q', dh: null }),
    ]) outcomes.push(await run().then(() => 'ok', (e: any) => (/^D-NE74/.test(e.message) ? 'refused' : e.message)))
    expect([outcomes, query.mock.calls.length]).toEqual([['refused', 'refused'], 0])
  })

  it('resistiu: reserva K e liberação N passam pelo funil e pela conferência do InvoiceTx (vazado = recusado, sem query); a liberação com o K da MESMA tentativa grava N com dh NULL', async () => {
    const { pool, query, inserts } = fakeConn()
    let leaked: InvoiceTx | null = null
    await underLock(pool, REF, async itx => {
      leaked = itx
      await reserveCancelRequest(SERVICE.insertTransmissionEvent, itx, 3, 7)
      expect(await releaseCancelRequest(SERVICE.insertTransmissionEvent, itx, 3, 7, 'x'.repeat(300), { attempt: 3, lastKind: 'K' })).toBe(true)   // D-NE83: a tentativa entra
      expect(await releaseCancelRequest(SERVICE.insertTransmissionEvent, itx, 3, 7, 'y', { attempt: 3, lastKind: 'N' })).toBe(false)
    })
    expect(inserts().map(c => [c.p[3], c.p[5], c.p[8], (c.p[7] as string).length])).toEqual([[3, 'K', null, CANCEL_REQUEST_IN_FLIGHT.length], [3, 'N', null, 255]])
    query.mockClear()
    await expect(reserveCancelRequest(SERVICE.insertTransmissionEvent, leaked!, 3, 7)).rejects.toThrow(/^D-NE74/)
    expect(query).not.toHaveBeenCalled()
  })

  it('resistiu: desfecho → voz — `OUTCOME_KIND` congelado (só R/F), `EMITTER_FAILURE_CODES` sem `add` nem pelo `Set.prototype` (não é um Set), classificação pelo CÓDIGO', () => {
    expect(() => Object.assign(OUTCOME_KIND, { chain_untrusted: 'S' })).toThrow(TypeError)
    expect(Reflect.set(OUTCOME_KIND, 'local', 'S')).toBe(false)
    expect(new Set(Object.values(OUTCOME_KIND))).toEqual(new Set(['R', 'F']))
    expect(() => Set.prototype.add.call(EMITTER_FAILURE_CODES as any, 'FISCAL_DPS_REJECTED')).toThrow(TypeError)
    expect(() => { (EMITTER_FAILURE_CODES as any).add = () => undefined }).toThrow(TypeError)
    expect(EMITTER_FAILURE_CODES.has(ErrorCodes.FISCAL_AUTHORITY_CHAIN_UNTRUSTED)).toBe(true)
    const chain = new AuthorityHttpError(409, 'x', ErrorCodes.FISCAL_AUTHORITY_CHAIN_UNTRUSTED, 0, 'CERT_HAS_EXPIRED')
    expect([classifyAuthorityError(chain), OUTCOME_KIND[classifyAuthorityError(chain) as 'chain_untrusted']]).toEqual(['chain_untrusted', 'F'])
  })

  it('contexto: o MESMO código CHAIN_UNTRUSTED num `HttpError` comum (não `AuthorityHttpError`) é AMBÍGUO (fica em voo, nada grava) — a classificação exige a classe do transporte', () => {
    expect(classifyAuthorityError(new HttpError(409, 'x', undefined, ErrorCodes.FISCAL_AUTHORITY_CHAIN_UNTRUSTED))).toBe('ambiguous')
  })
})

// ===========================================================================
// D — D-NE57: a cadeia do SERVIDOR pelo CÓDIGO; `ca` só quando dito
// ===========================================================================

describe('D — D-NE57 no transporte', () => {
  const real = transport.request
  afterEach(() => { transport.request = real; jest.restoreAllMocks() })
  const outcomeOf = async (err: unknown) => {
    transport.request = async () => { throw err }
    return authorityJson({ url: 'https://exemplo.invalid/x', method: 'GET' }, 'gate').then(() => null, (e: any) => ({ status: e.statusCode, code: e.code, message: String(e.message) }))
  }
  const errOf = (code: string | undefined, message: string, afterHandshake?: boolean) =>
    Object.assign(new Error(message), code === undefined ? {} : { code }, afterHandshake === undefined ? {} : { afterHandshake })

  it('resistiu: matriz código × aperto de mão — cadeia ANTES = 409 próprio (sem mandar renovar o A1); DEPOIS = 503 ambíguo; credencial do LADO de cá e alertas do servidor seguem AUTH_FAILED; PEM local segue CERT_INVALID', async () => {
    jest.spyOn(logger, 'error').mockImplementation(() => undefined)
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined)
    for (const code of ['CERT_HAS_EXPIRED', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_REVOKED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'HOSTNAME_MISMATCH', 'CERT_NOT_YET_VALID']) {
      for (const before of [false, undefined]) {
        const o = await outcomeOf(errOf(code, 'qualquer coisa', before))
        expect([code, before, o?.status, o?.code]).toEqual([code, before, 409, 'FISCAL_AUTHORITY_CHAIN_UNTRUSTED'])
        expect(o!.message).not.toMatch(/confira o A1|renove|aba Emissor/i)
      }
      const after = await outcomeOf(errOf(code, 'qualquer coisa', true))
      expect([code, after?.status, after?.code]).toEqual([code, 503, 'FISCAL_AUTHORITY_UNAVAILABLE'])
    }
    for (const [code, msg] of [['ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE', 'sslv3 alert bad certificate'], ['EPROTO', 'x'],
      ['ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED', 'sslv3 alert certificate expired'], [undefined, 'unable to get local issuer certificate']] as const) {
      const o = await outcomeOf(errOf(code, msg, false))
      expect([code, o?.code]).toEqual([code, 'FISCAL_AUTHORITY_AUTH_FAILED'])
    }
    expect((await outcomeOf(errOf('ERR_OSSL_PEM_NO_START_LINE', 'x', false)))?.code).toBe('FISCAL_CERT_INVALID')
  })

  it('contexto: a regra "o código decide, nunca a mensagem" tem UMA exceção de ORDEM — a credencial LOCAL é decidida antes e também pela MENSAGEM: código de cadeia + texto "PEM routines" vira FISCAL_CERT_INVALID (caso sem produtor real no Node)', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined)
    expect((await outcomeOf(errOf('CERT_HAS_EXPIRED', 'error:0909006C:PEM routines:get_name:no start line', false)))?.code).toBe('FISCAL_CERT_INVALID')
  })
})

// ===========================================================================
// E — D-NE9: o emitter conta as vivas pelas VIEWS de todas as famílias
// ===========================================================================

describe('E — emitter: vivas pelas leituras publicadas', () => {
  function viewConn(live: number, opts: { fail?: any } = {}) {
    const calls: string[] = []
    const query = jest.fn(async (sql: string) => {
      calls.push(sql)
      if (/COUNT\(\*\) AS n FROM vw_/.test(sql)) { if (opts.fail) throw opts.fail; return [[{ n: live }]] }
      if (/information_schema\.TABLES/.test(sql)) return [[{ name: 'vw_invoice_service_transmission' }]]   // D-NE76: a família está INSTALADA aqui
      if (/SELECT model, cutover_at AS c FROM tb_establishment_issuer[\s\S]*FOR UPDATE/.test(sql)) return [[{ model: 'SE', c: '2026-10-12 10:00:00' }]]
      if (/^\s*UPDATE tb_establishment_certificate/.test(sql)) return [{ affectedRows: 1 }]
      return [[]]
    })
    const conn = { query, beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
    return { pool: { query, getConnection: jest.fn(async () => conn) } as any, calls }
  }

  it('[CORRIGIDO na sessão] [LOW NE1A2-06] `countLiveTransmissions` com `branches: []` (ou um ramo fora do domínio por cast — `\'ALL\'`) devolve 0 SEM SQL: a guarda do A1/habilitação falha ABERTO, ao contrário do "1146 nunca vira 0"', async () => {
    // `opts.branches.includes(r.branch)` — com a STRING 'ALL' vira `String.prototype.includes` ("ALL".includes("service") = false) e com []
    // nada é lido. A peça é pública (o setes-api/nfe-api importam o núcleo); uma lista de ramos vazia/estranha deveria falhar ALTO.
    const { pool, calls } = viewConn(5)
    const out: string[] = []
    for (const branches of [[], 'ALL', ['servico']] as any[]) {
      out.push(await countLiveTransmissions(pool, 1, { branches }).then(n => `contou ${n}`, () => 'recusou'))
    }
    expect([out, calls.length]).toEqual([['recusou', 'recusou', 'recusou'], 0])
  })

  it('resistiu [convertido — D-NE76: o 1146 decide pela família INSTALADA]: erro do banco em QUALQUER coluna/view (1146 com a família instalada, 1054, conexão caída) sobe — nunca vira 0; o DELETE do A1 com vivas = 409 e nada apagado', async () => {
    for (const fail of [
      Object.assign(new Error("Table 'fiscal_api.vw_invoice_service_transmission' doesn't exist"), { errno: 1146, code: 'ER_NO_SUCH_TABLE' }),
      Object.assign(new Error("Unknown column 't.last_kind'"), { errno: 1054, code: 'ER_BAD_FIELD_ERROR' }),
      Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' }),
    ]) {
      const { pool } = viewConn(0, { fail })
      await expect(countLiveTransmissions(pool, 1, { branches: 'all' })).rejects.toBe(fail)
    }
    const { pool, calls } = viewConn(2)
    await expect(clearCertificate({ pool, keyring: MasterKeyRing.of({ 1: randomBytes(32) }) }, 1, 7, { schemaName: 'setes_setes' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS' })
    expect(calls[0]).toMatch(/FOR UPDATE/)
    expect(calls.some(s => /tb_establishment_certificate/.test(s) && /^\s*UPDATE/.test(s))).toBe(false)
  })
})

// ===========================================================================
// F — D-NE10: cerca por MODELO × ESTABELECIMENTO em estado misto / dado por fora
// ===========================================================================

describe('F — cerca por modelo', () => {
  /**
   * Banco FALSO que reproduz a COLAÇÃO da tabela (`tb_establishment_issuer` — utf8mb4_unicode_ci, migration 001 do núcleo): `model IN (?)`
   * e `model = ?` NÃO distinguem caixa no SQL. O CHECK da 004 (`model IN ('SE','55','65')`) é avaliado na mesma colação — 'se' passa nele.
   */
  function ciDb(rows: { model: string; c: string | null }[], erpHasSe: boolean) {
    const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
    const query = jest.fn(async (sql: string, p: any[] = []) => {
      if (/SELECT model, cutover_at AS c FROM tb_establishment_issuer[\s\S]*FOR UPDATE/.test(sql)) {
        return [rows.filter(r => p.slice(1).some((m: string) => eq(m, r.model)))]
      }
      if (/SELECT COUNT\(\*\) AS n, SUM\(cutover_at IS NULL\) AS r, SUM\(model = \?\) AS s FROM tb_establishment_issuer/.test(sql)) {
        const mine = rows.filter(r => p.slice(2).some((m: string) => eq(m, r.model)))
        return [[{ n: mine.length, r: mine.filter(r => r.c == null).length, s: mine.filter(r => eq(r.model, p[0])).length }]]
      }
      if (/`setes_x`\.tb_establishment_issuer/.test(sql)) return [erpHasSe ? [{ x: 1 }] : []]
      throw new Error(`SQL inesperado: ${sql.slice(0, 60)}`)
    })
    return { query } as any
  }

  it('[CORRIGIDO na sessão — D-NE84] [LOW NE1A2-07] linha da habilitação com o modelo em OUTRA CAIXA (\'se\' — o CHECK _ci da 004 aceita; só nasce por fora do código, como o "f" da D-F103): a LEITURA diz "ainda do ERP" e a GUARDA DE ESCRITA deixa gravar — "a MESMA regra para a trava e para a leitura" quebra', async () => {
    // `issuerRowsState` decide no SQL (_ci: 'se' = 'SE'); `assertIssuerWritable` filtra em JS (`r.model === model`, sensível a caixa) e
    // a réplica 'se' some → cai na lacuna (b) — com o ERP sem SE, a habilitação SE é gravável com uma RÉPLICA na tabela. Antes da parte 2
    // a guarda contava a réplica em QUALQUER linha (sem filtro em JS) e as duas concordavam.
    const rows = [{ model: 'se', c: null }]
    const still = await emissionStillInErp(ciDb(rows, false), 'setes_x', 1, 'SE')
    const writable = await assertIssuerWritable(ciDb(rows, false), 'setes_x', 1, 'SE').then(() => true, (e: any) => (e?.code === 'FISCAL_CUTOVER_PENDING' ? false : e))
    expect({ still, writable }).toEqual({ still: true, writable: false })
  })

  it('resistiu: modelo ausente, vazio, em outra caixa ou fora do domínio na CHAMADA falha alto antes do banco (prova de segurança sem padrão)', async () => {
    const db = ciDb([], true)
    for (const m of [undefined, '', 'se', 'XX', 'SE ', null]) {
      await expect(emissionStillInErp(db, 'setes_x', 1, m as any)).rejects.toThrow(/fora do domínio/)
      await expect(assertIssuerWritable(db, 'setes_x', 1, m as any)).rejects.toThrow(/fora do domínio/)
    }
    expect(db.query).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// G — cerca D-F31: a exceção nomeada `${table}` em `voice/event-table.ts`
// ===========================================================================

describe('G — exceção nomeada da cerca D-F31', () => {
  it('[CORRIGIDO na sessão] [LOW NE1A2-08] a exceção é TEXTUAL: qualquer escrita com alvo `${table}` em `voice/event-table.ts` passa — inclusive de OUTRA ligação chamada `table` (parâmetro) que pode ser `setes_x.tb_invoice` (escrita no ERP)', () => {
    // A garantia "nome simples validado" vale para a `const table = d.eventTable` do `defineVoiceFamily`; a cerca não confere QUAL ligação
    // é o `table` da escrita. Um utilitário novo no mesmo arquivo com `(q, table) => DELETE FROM ${table}` passa calado.
    const added = 'export const wipe = (q: any, table: string) => q.query(`DELETE FROM ${table} WHERE tb_institution_id = ?`, [1])'
    expect(erpWritesIn('voice/event-table.ts', added)).toHaveLength(1)
  })

  it('resistiu: a exceção é do ARQUIVO e do ALVO exatos — `${table}` em outro arquivo, `${tbl}` no mesmo, qualificado (`${s}.x`) ou com crase seguem violação; e o código REAL do núcleo não tem outra', () => {
    expect(erpWritesIn('voice/reading.ts', 'q.query(`INSERT INTO ${table} (a) VALUES (1)`)')).toHaveLength(1)
    expect(erpWritesIn('voice/event-table.ts', 'q.query(`INSERT INTO ${tbl} (a) VALUES (1)`)')).toHaveLength(1)
    expect(erpWritesIn('voice/event-table.ts', 'q.query(`UPDATE `+"`"+`${s}`+"`"+`.tb_invoice SET a = 1`)')).toHaveLength(1)
    const real = walk(SRC_ROOT).flatMap(f => erpWritesIn(path.relative(SRC_ROOT, f).replace(/\\/g, '/'), read(f)))
    expect(real).toEqual([])
  })
})

// ===========================================================================
// H — D-NE12: nenhum terminal literal no SQL do núcleo
// ===========================================================================

describe('H — D-NE12 no núcleo', () => {
  it('resistiu: nenhum `terminal = 0` / `terminal IN (0)` / `terminal: 0` / `, 0,` como terminal nos SQL e objetos do núcleo (o WEB_TERMINAL só é DEFINIDO aqui); escritor, leitores e trava levam o terminal da referência', async () => {
    const offenders = walk(SRC_ROOT).filter(f => {
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      return /\bterminal\s*(?:=|<>|!=|IN\s*\()\s*'?0\b|\bterminal:\s*0\b/i.test(code)   // \b: o `WEB_TERMINAL = 0` (a DEFINIÇÃO da borda) não conta
    }).map(f => path.relative(SRC_ROOT, f))
    expect(offenders).toEqual([])
    const { pool, calls } = fakeConn()
    await underLock(pool, invoiceRef(1, 6200, 7), async itx => {
      await SERVICE.insertTransmissionEvent(itx, 2, null, { kind: 'F', source: 'P' })
      await SERVICE.hasTransmissionEvent(itx.conn, itx.ref, 2, 'F', null)
      await SERVICE.findTransmissionEventByKind(itx.conn, itx.ref, 2, 'F')
    })
    expect(calls.map(c => c.p[2])).toEqual([7, 7, 7, 7])
  })
})
