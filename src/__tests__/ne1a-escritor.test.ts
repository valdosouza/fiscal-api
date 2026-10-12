/// <reference types="jest" />
// NE-1a parte 2 — passo 4: a ESTRUTURA do escritor da voz no núcleo (D-F108 = Q-F114 (a); D-NE74 = Q-NE74 (a);
// `prompt_onda_nfe_sefaz.md` §12.9.7). Peças: `erp/invoice-tx.ts` (`withInvoiceTx` → `InvoiceTx`, a ÚNICA porta do escritor) e
// `voice/event-table.ts` (`defineVoiceFamily` — o escritor GENÉRICO e os dois leitores de idempotência, ligados ao DESCRITOR da família).
//  - o descritor só aceita a tabela da voz por NOME SIMPLES (`tb_<…>_transmission_event` — a exceção nomeada da cerca D-F31 se apoia nisso);
//  - o FUNIL recusa kind fora da lista da FAMÍLIA antes de qualquer query (o tipo some no JS);
//  - o escritor EXIGE o `InvoiceTx` vivo: congelado, aberto (dentro da transação), referência congelada — nunca outra nota, nunca depois;
//  - a porta é PROPRIEDADE-FUNÇÃO: `VoiceFamily<estreita>` não vira `VoiceFamily<comum>` (o método bivariante deixaria gravar S).
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import { withInvoiceTx, assertInvoiceTx, InvoiceTx } from '../erp/invoice-tx'
import { defineVoiceFamily, VoiceFamily, WriteKindOf } from '../voice/event-table'
import { SERVICE_VOICE_READING } from '../voice/families/service'
import { TransmissionEventKind, TransmissionSource } from '../voice/kinds'
import { invoiceRef, InvoiceRef } from '../ref/invoice-ref'
import { LockedInvoice } from '../erp/facts'

const SERVICE = defineVoiceFamily({ reading: SERVICE_VOICE_READING, eventTable: 'tb_invoice_service_transmission_event', writeKinds: ['A', 'R', 'C', 'K', 'F', 'N'] as const, label: 'NFS-e' })
const LOCKED: LockedInvoice = { alive: true, lifeEvent: 3, lastEvent: 3, lastKind: 'E' }

/** Conexão FALSA: MAX+1 e INSERT; guarda os SQL na ordem. */
function fakeConn(next = 1) {
  const calls: { sql: string; p: any[] }[] = []
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    calls.push({ sql, p })
    if (/MAX\(event\)/.test(sql)) return [[{ next }]]
    if (/COUNT\(\*\) AS n/.test(sql)) return [[{ n: 1 }]]
    if (/ORDER BY event DESC LIMIT 1/.test(sql)) return [[{ attempt: '2', event: '5', kind: 'C', authorityCode: '101101', message: null, dh: null, source: 'Q', userId: '7', createdAt: null }]]
    return [{ affectedRows: 1 }]
  })
  const conn = { query, beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
  const pool = { getConnection: jest.fn(async () => conn) } as any
  return { conn, pool, query, calls }
}
/** Um `InvoiceTx` de verdade — pela ÚNICA porta (`withInvoiceTx`), com a trava simulada. */
async function underLock<T>(pool: any, ref: InvoiceRef, fn: (itx: InvoiceTx) => Promise<T>, locked: LockedInvoice | null = LOCKED) {
  const lock = jest.fn(async () => locked)
  const out = await withInvoiceTx(pool, { schemaName: 'setes_setes', institutionId: 1 }, ref, { label: 'teste', lock }, fn)
  return { out, lock }
}
const REF = invoiceRef(1, 6200, 0)

describe('defineVoiceFamily — o DESCRITOR da família (a tabela por nome SIMPLES; a lista no vocabulário)', () => {
  it('recusa tabela qualificada, com crase, com substituição, fora do molde `tb_<…>_transmission_event` ou que não é texto (a exceção D-F31 do `${table}` depende disso)', () => {
    for (const eventTable of ['setes_x.tb_invoice_service_transmission_event', '`tb_invoice_service_transmission_event`', '${s}.tb_x_transmission_event',
      'tb_invoice_service_transmission', 'TB_INVOICE_SERVICE_TRANSMISSION_EVENT', 'tb_x_transmission_event; DROP TABLE tb_x', '', 42, null]) {
      expect(() => defineVoiceFamily({ reading: SERVICE_VOICE_READING, eventTable: eventTable as any, writeKinds: ['A'] as const, label: 'NFS-e' }))
        .toThrow(/tabela da voz inválida/)
    }
  })
  it('recusa lista de escrita vazia ou fora do vocabulário (sensível a caixa) e família sem a leitura publicada', () => {
    for (const writeKinds of [[], ['Z'], ['a'], ['A', 's'], 'A'] as any[]) {
      expect(() => defineVoiceFamily({ reading: SERVICE_VOICE_READING, eventTable: 'tb_invoice_service_transmission_event', writeKinds, label: 'NFS-e' }))
        .toThrow(/lista de escrita fora do vocabulário/)
    }
    expect(() => defineVoiceFamily({ reading: undefined as any, eventTable: 'tb_invoice_service_transmission_event', writeKinds: ['A'] as const, label: 'NFS-e' }))
      .toThrow(/leitura publicada/)
  })
  it('o descritor é IMUTÁVEL (família e lista congeladas) — a lista de escrita não cresce depois de declarada', () => {
    expect(Object.isFrozen(SERVICE)).toBe(true)
    expect(Object.isFrozen(SERVICE.writeKinds)).toBe(true)
    expect(() => (SERVICE.writeKinds as any).push('S')).toThrow(TypeError)
    expect(() => { (SERVICE as any).insertTransmissionEvent = async () => 1 }).toThrow(TypeError)
  })
  it('a lista do descritor é uma CÓPIA — mexer no array de quem declarou não muda o que o funil aceita', async () => {
    const kinds: TransmissionEventKind[] = ['A', 'F']
    const fam = defineVoiceFamily({ reading: SERVICE_VOICE_READING, eventTable: 'tb_invoice_service_transmission_event', writeKinds: kinds, label: 'NFS-e' })
    kinds.push('S')
    const { pool } = fakeConn()
    await underLock(pool, REF, async itx => {
      await expect(fam.insertTransmissionEvent(itx, 1, null, { kind: 'S', source: 'P' })).rejects.toThrow(/D-F106/)
    })
  })
})

describe('o FUNIL do escritor genérico (D-F106 → D-F108: a lista é a da FAMÍLIA)', () => {
  it('recusa EM EXECUÇÃO todo kind fora da lista — S, P, D, minúscula, vazio, ausente — ANTES de qualquer query, dizendo a família', async () => {
    const { pool, query } = fakeConn()
    await underLock(pool, REF, async itx => {
      query.mockClear()
      for (const k of ['S', 'P', 'D', 's', 'a', '', undefined, null]) {
        await expect(SERVICE.insertTransmissionEvent(itx, 1, null, { kind: k, source: 'P' } as any))
          .rejects.toThrow(/^D-F106: kind fora do vocabulário de escrita da NFS-e .* — nada gravado$/)
      }
      expect(query).not.toHaveBeenCalled()
    })
  })
  it('o funil vem ANTES da conferência do `InvoiceTx` (a recusa do kind não depende da transação) e nenhum dos dois toca o banco', async () => {
    const { conn, query } = fakeConn()
    await expect(SERVICE.insertTransmissionEvent({ conn } as any, 1, null, { kind: 'S', source: 'P' } as any)).rejects.toThrow(/D-F106/)
    await expect(SERVICE.insertTransmissionEvent({ conn } as any, 1, null, { kind: 'F', source: 'P' })).rejects.toThrow(/D-NE74/)
    expect(query).not.toHaveBeenCalled()
  })
  it('grava os seis da família com o TERMINAL da referência travada: MAX+1 e INSERT na tabela do descritor, kind no índice 5', async () => {
    const { pool, calls } = fakeConn(4)
    const { out } = await underLock(pool, invoiceRef(1, 6200, 3), async itx => {
      const events: number[] = []
      for (const k of ['A', 'R', 'C', 'K', 'F', 'N'] as const) events.push(await SERVICE.insertTransmissionEvent(itx, 2, 7, { kind: k, source: 'Q', authorityCode: '12345678901234', message: 'x'.repeat(300), dh: '2026-10-12 10:00:00' }))
      return events
    })
    expect(out).toEqual([4, 4, 4, 4, 4, 4])
    const max = calls.filter(c => /MAX\(event\)/.test(c.sql))
    const ins = calls.filter(c => /^\s*INSERT INTO tb_invoice_service_transmission_event/.test(c.sql))
    expect(max.map(c => c.p)).toEqual(Array(6).fill([1, 6200, 3, 2]))
    expect(max[0].sql).toMatch(/WHERE tb_institution_id = \? AND tb_invoice_id = \? AND terminal = \? AND attempt = \?/)
    expect(ins.map(c => c.p[5])).toEqual(['A', 'R', 'C', 'K', 'F', 'N'])
    expect(ins[0].p.slice(0, 5)).toEqual([1, 6200, 3, 2, 4])
    expect([ins[0].p[6], (ins[0].p[7] as string).length, ins[0].p[8], ins[0].p[9], ins[0].p[10]]).toEqual(['1234567890', 255, '2026-10-12 10:00:00', 'Q', 7])
  })
  it('os leitores de idempotência leem a MESMA tabela pela referência inteira (terminal como parâmetro) e mantêm a forma ANTIGA do dh até o corte (Q-TZ3)', async () => {
    const { conn, calls } = fakeConn()
    const ref = invoiceRef(1, 6200, 3)
    expect(await SERVICE.hasTransmissionEvent(conn as any, ref, 2, 'C', null)).toBe(true)
    expect(await SERVICE.hasTransmissionEvent(conn as any, ref, 2, 'C', '2026-10-12 13:00:00')).toBe(true)
    const row = await SERVICE.findTransmissionEventByKind(conn as any, ref, 2, 'C', true)
    expect(row).toMatchObject({ attempt: 2, event: 5, kind: 'C', userId: 7 })
    expect(calls.map(c => c.p.slice(0, 5))).toEqual([[1, 6200, 3, 2, 'C'], [1, 6200, 3, 2, 'C'], [1, 6200, 3, 2, 'C']])
    expect(calls[0].sql).toMatch(/dh IS NULL/)
    expect(calls[1].p.length).toBe(7)
    expect(calls[2].sql).toMatch(/FROM tb_invoice_service_transmission_event[\s\S]*FOR UPDATE$/)
  })
})

describe('withInvoiceTx → InvoiceTx (D-NE74: a voz só se escreve SOB A TRAVA e na nota TRAVADA)', () => {
  it('quem pede é obrigatório e a referência é DELE (gates da parte 2): outra institution, id/terminal fora do domínio ou referência nula falham ALTO antes de qualquer conexão', async () => {
    const { pool } = fakeConn()
    const fn = jest.fn(async () => 1)
    for (const ref of [invoiceRef(2, 6200, 0), invoiceRef(1, 0, 0), invoiceRef(1, 6200, -1), invoiceRef(1, 1.5, 0), { institutionId: 1, invoiceId: 6200, terminal: '0' } as any, null as any]) {
      await expect(withInvoiceTx(pool, { schemaName: 's', institutionId: 1 }, ref, { label: 't', lock: async () => LOCKED }, fn)).rejects.toThrow(/Referência da nota inválida/)
    }
    for (const who of [null, { schemaName: 's' }, { schemaName: 's', institutionId: 0 }, { institutionId: 1 }] as any[]) {
      await expect(withInvoiceTx(pool, who, REF, { label: 't', lock: async () => LOCKED }, fn)).rejects.toThrow(/quem pede é obrigatório/)
    }
    expect([fn.mock.calls.length, pool.getConnection.mock.calls.length]).toEqual([0, 0])
  })
  it('a 1ª coisa da transação é a trava da nota, com a referência inteira; nota inexistente ou (requireAlive) morta = 404 INVOICE_NOT_FOUND, sem callback', async () => {
    const { pool } = fakeConn()
    const fn = jest.fn(async () => 1)
    const { lock } = await underLock(pool, REF, fn)
    expect(lock).toHaveBeenCalledWith(expect.anything(), 'setes_setes', { institutionId: 1, invoiceId: 6200, terminal: 0 })
    fn.mockClear()
    await expect(underLock(pool, REF, fn, null)).rejects.toMatchObject({ statusCode: 404, code: 'INVOICE_NOT_FOUND' })
    await expect(withInvoiceTx(pool, { schemaName: 's', institutionId: 1 }, REF, { label: 't', requireAlive: true, lock: async () => ({ ...LOCKED, alive: false }) }, fn))
      .rejects.toMatchObject({ statusCode: 404, code: 'INVOICE_NOT_FOUND' })
    expect(fn).not.toHaveBeenCalled()
  })
  it('o InvoiceTx é congelado, com CÓPIAS congeladas da referência e da vida: mexer na referência do chamador depois da trava não troca a nota escrita', async () => {
    const { pool, calls } = fakeConn()
    const mutable = { institutionId: 1, invoiceId: 6200, terminal: 0 }
    await withInvoiceTx(pool, { schemaName: 's', institutionId: 1 }, mutable, { label: 't', lock: async () => LOCKED }, async itx => {
      expect([Object.isFrozen(itx), Object.isFrozen(itx.ref), Object.isFrozen(itx.locked), itx.ref === mutable]).toEqual([true, true, true, false])
      mutable.invoiceId = 9999
      expect(() => { (itx.ref as any).invoiceId = 9999 }).toThrow(TypeError)
      await SERVICE.insertTransmissionEvent(itx, 1, null, { kind: 'F', source: 'P' })
    })
    expect(calls.filter(c => /^\s*INSERT/.test(c.sql)).map(c => c.p[1])).toEqual([6200])
  })
  it('o InvoiceTx só vale DENTRO da transação: guardado e usado depois do fim (conexão de volta ao pool, trava solta) é recusado sem query', async () => {
    const { pool, query } = fakeConn()
    let leaked: InvoiceTx | null = null
    await underLock(pool, REF, async itx => { leaked = itx; expect(itx.open).toBe(true) })
    expect(leaked!.open).toBe(false)
    query.mockClear()
    await expect(SERVICE.insertTransmissionEvent(leaked!, 1, null, { kind: 'F', source: 'P' })).rejects.toThrow(/^D-NE74/)
    expect(query).not.toHaveBeenCalled()
  })
  it('também fecha quando o callback LANÇA (a transação desfaz) — e cada retentativa por deadlock ganha o SEU InvoiceTx', async () => {
    const { pool } = fakeConn()
    let leaked: InvoiceTx | null = null
    await expect(underLock(pool, REF, async itx => { leaked = itx; throw new Error('boom') })).rejects.toThrow('boom')
    expect(leaked!.open).toBe(false)
    const seen: InvoiceTx[] = []
    let n = 0
    await underLock(pool, REF, async itx => {
      seen.push(itx)
      if (++n === 1) throw Object.assign(new Error('Deadlock found'), { errno: 1213, code: 'ER_LOCK_DEADLOCK' })
    })
    expect([seen.length, seen[0] === seen[1], seen[0].open, seen[1].open]).toEqual([2, false, false, false])
  })
  it('assertInvoiceTx confere IDENTIDADE (D-NE81 — gates da parte 2): só o InvoiceTx EMITIDO e aberto passa; TODO forjado é recusado — inclusive a cópia exata de um verdadeiro', async () => {
    const conn = { query: async () => [[]] }
    const ok = { conn, ref: Object.freeze({ institutionId: 1, invoiceId: 2, terminal: 0 }), locked: LOCKED, open: true }
    const { pool } = fakeConn()
    await underLock(pool, REF, async itx => {
      expect(() => assertInvoiceTx(itx)).not.toThrow()
      const copy = Object.freeze({ conn: itx.conn, ref: itx.ref, locked: itx.locked, get open() { return true } })   // a FORMA inteira de um verdadeiro
      expect(() => assertInvoiceTx(copy)).toThrow(/^D-NE74/)
    })
    for (const bad of [Object.freeze({ ...ok }), 
      { ...ok }, Object.freeze({ ...ok, open: false }), Object.freeze({ ...ok, open: 'yes' }), Object.freeze({ ...ok, ref: { institutionId: 1, invoiceId: 2, terminal: 0 } }),
      Object.freeze({ ...ok, locked: null }), Object.freeze({ ...ok, conn: {} }), Object.freeze({ ...ok, ref: Object.freeze({ institutionId: 1, invoiceId: 2, terminal: '0' }) }),
      null, undefined, 'itx',
    ]) expect(() => assertInvoiceTx(bad)).toThrow(/^D-NE74/)
  })
})

describe('testemunhas de COMPILAÇÃO (o ts-jest confere tipos)', () => {
  it('o tipo do kind é a lista da família; o InvoiceTx não se monta sem cast; `VoiceFamily<estreita>` não vira `<comum>` (propriedade-função — invariante)', () => {
    type ServiceWrite = WriteKindOf<typeof SERVICE>
    const six: ServiceWrite[] = ['A', 'R', 'C', 'K', 'F', 'N']
    // @ts-expect-error — S fora da família (D-F102/D-F106)
    const s: ServiceWrite = 'S'
    const write = (itx: InvoiceTx) => {
      // @ts-expect-error — o kind da família recusa S no escritor
      void SERVICE.insertTransmissionEvent(itx, 1, null, { kind: 'S', source: 'P' })
      // @ts-expect-error — P (da NF-e) idem
      void SERVICE.insertTransmissionEvent(itx, 1, null, { kind: 'P', source: 'Q' })
    }
    const conn = {} as any
    // @ts-expect-error — um objeto qualquer não é InvoiceTx (a marca é um símbolo que não sai do módulo)
    const forged: InvoiceTx = { conn, ref: REF, locked: LOCKED, open: true }
    // @ts-expect-error — a família estreita NÃO alarga (com MÉTODO no lugar da propriedade-função, isto compilaria e o S passaria)
    const widened: VoiceFamily<TransmissionEventKind> = SERVICE
    // o contraexemplo, para registro: com MÉTODO a mesma atribuição compila (bivariância) — por isso a porta é propriedade-função
    interface MethodFamily<K extends TransmissionEventKind> { insert(e: { kind: K; source: TransmissionSource }): void }
    const narrowM: MethodFamily<'A'> = { insert: () => undefined }
    const widenedM: MethodFamily<TransmissionEventKind> = narrowM
    expect([six.length, s, typeof write, forged.open, widened === SERVICE, widenedM === narrowM]).toEqual([6, 'S', 'function', true, true, true])
  })
})

describe('cerca — o InvoiceTx só nasce no núcleo (nenhum cast para `InvoiceTx` em produção)', () => {
  const WORKSPACE = path.resolve(__dirname, '..', '..', '..')
  const walk = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? (d.name === '__tests__' || d.name === 'node_modules' ? [] : walk(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []))
  /** Asserções de tipo (`as X`, `<X>`) cujo tipo cita `InvoiceTx`, por AST (comentário fora pelo compilador). */
  const casts = (code: string): string[] => {
    const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const out: string[] = []
    const visit = (n: ts.Node): void => {
      if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && /\bInvoiceTx\b/.test(n.type.getText(sf))) out.push(n.type.getText(sf) + ' @ ' + n.getText(sf).slice(0, 60))
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return out
  }
  it('a cerca não é cega (pega `as InvoiceTx`, `as unknown as InvoiceTx` e `<InvoiceTx>`) e o código REAL só tem o cast da PRÓPRIA peça', () => {
    expect(casts('const a = x as InvoiceTx; const b = y as unknown as InvoiceTx; const c = <InvoiceTx>z').length).toBe(3)
    expect(casts('// x as InvoiceTx\nconst a: InvoiceTx | null = null')).toEqual([])
    const files = [
      ...walk(path.join(WORKSPACE, 'fiscal-api', 'src')),
      ...walk(path.join(WORKSPACE, 'nfse-api', 'src')), ...walk(path.join(WORKSPACE, 'nfse-api', 'scripts')),
      ...walk(path.join(WORKSPACE, 'nfe-api', 'src')),
    ]
    expect(files.length).toBeGreaterThan(30)
    const hits = files.flatMap(f => casts(fs.readFileSync(f, 'utf8')).map(c => `${path.relative(WORKSPACE, f).replace(/\\/g, '/')}: ${c}`))
    // só a peça: o que FABRICA (`… as InvoiceTx` no `withInvoiceTx`) e o que LÊ o `open` depois de conferir a identidade (`assertInvoiceTx`)
    expect(hits.map(h => h.split(':')[0])).toEqual(['fiscal-api/src/erp/invoice-tx.ts', 'fiscal-api/src/erp/invoice-tx.ts'])
    expect(hits.map(h => h.split(': ')[1].split(' @ ')[0])).toEqual(['InvoiceTx', 'InvoiceTx'])
  })
})
