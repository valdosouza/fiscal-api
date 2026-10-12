/// <reference types="jest" />
// NE-1a parte 2 — passo 5: a POLÍTICA sobre o escritor da voz no núcleo (D-NE13/D-NE58; `prompt_onda_nfe_sefaz.md` §12.9.7). Vieram da
// nfse-api SEM mudar de comportamento — o roteiro (quando chamar) segue na família:
//  - `voice/outcome.ts`: desfecho de uma falha do fisco (R / F / F local / ambíguo), o mapa desfecho → voz (exaustivo pelo tipo, congelado) e
//    os erros do EMISSOR que param a passada do rodízio (conjunto imutável);
//  - `voice/policy.ts`: idempotência da voz do fisco (`recordVoiceOnce`), RESERVA do pedido de cancelamento (K) e LIBERAÇÃO (N só depois do K)
//    — recebem a PORTA da família; o tipo prova que a lista dela tem K/N (parâmetro contravariante).
import { AuthorityHttpError } from '../transport/https-json'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'
import { classifyAuthorityError, OUTCOME_KIND, EMITTER_FAILURE_CODES, AuthorityOutcome, unhandledOutcome } from '../voice/outcome'
import { recordVoiceOnce, recordKindOnce, reserveCancelRequest, releaseCancelRequest, VoiceWriter, CANCEL_REQUEST_IN_FLIGHT } from '../voice/policy'
import { defineVoiceFamily } from '../voice/event-table'
import { withInvoiceTx, InvoiceTx } from '../erp/invoice-tx'
import { SERVICE_VOICE_READING } from '../voice/families/service'
import { invoiceRef } from '../ref/invoice-ref'
import { TransmissionEventKind } from '../voice/kinds'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
const assertType = <T extends true>(): T => true as T
const authErr = (code: string) => new AuthorityHttpError(502, 'x', code, 400, '')

/** Um `InvoiceTx` de verdade (pela única porta), com conexão falsa — o callback recebe a transação e os SQL feitos. */
async function underLock<T>(fn: (itx: InvoiceTx, calls: { sql: string; p: any[] }[]) => Promise<T>): Promise<T> {
  const calls: { sql: string; p: any[] }[] = []
  const query = jest.fn(async (sql: string, p: any[] = []) => { calls.push({ sql, p }); return /MAX\(event\)/.test(sql) ? [[{ next: 9 }]] : [{ affectedRows: 1 }] })
  const conn = { query, beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
  const pool = { getConnection: jest.fn(async () => conn) } as any
  return withInvoiceTx(pool, { schemaName: 'setes_setes', institutionId: 1 }, invoiceRef(1, 6200, 0), { label: 't', lock: async () => ({ alive: true, lifeEvent: 1, lastEvent: 1, lastKind: 'E' }) },
    itx => fn(itx, calls))
}
const SERVICE = defineVoiceFamily({ reading: SERVICE_VOICE_READING, eventTable: 'tb_invoice_service_transmission_event', writeKinds: ['A', 'R', 'C', 'K', 'F', 'N'] as const, label: 'NFS-e' })

describe('desfecho → voz (`voice/outcome.ts`)', () => {
  it('classifica como antes: recusa de regra → rejected; credencial recusada → auth_failed; credencial LOCAL → local; o resto (outro código, erro que não é do fisco) → ambiguous — e (D-NE57) a cadeia do SERVIDOR → chain_untrusted, EXPLÍCITO', () => {
    expect(classifyAuthorityError(authErr(ErrorCodes.FISCAL_DPS_REJECTED))).toBe('rejected')
    expect(classifyAuthorityError(authErr(ErrorCodes.FISCAL_AUTHORITY_CHAIN_UNTRUSTED))).toBe('chain_untrusted')
    expect(classifyAuthorityError(authErr(ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED))).toBe('auth_failed')
    expect(classifyAuthorityError(authErr(ErrorCodes.FISCAL_CERT_INVALID))).toBe('local')
    for (const e of [authErr(ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE), authErr('QUALQUER'), new HttpError(409, 'x', undefined, ErrorCodes.FISCAL_DPS_REJECTED),
      new Error('ECONNRESET'), null, undefined, 'x']) expect(classifyAuthorityError(e)).toBe('ambiguous')
  })
  it('o mapa desfecho → voz dá só R/F, é CONGELADO (Object.assign/Reflect.set não mudam o processo) e exaustivo pelo tipo', () => {
    expect(OUTCOME_KIND).toEqual({ rejected: 'R', auth_failed: 'F', chain_untrusted: 'F', local: 'F' })     // D-NE57: a cadeia do servidor grava F (inalterada)
    expect(Object.isFrozen(OUTCOME_KIND)).toBe(true)
    expect(() => Object.assign(OUTCOME_KIND, { local: 'S' })).toThrow(TypeError)
    expect(Reflect.set(OUTCOME_KIND, 'auth_failed', 'S')).toBe(false)
    const values: Equal<typeof OUTCOME_KIND[keyof typeof OUTCOME_KIND], 'R' | 'F'> = assertType()
    const keys: Equal<keyof typeof OUTCOME_KIND, Exclude<AuthorityOutcome, 'ambiguous'>> = assertType()
    // @ts-expect-error — um desfecho que grava sem dizer a voz não compila (o Record é sobre TODOS os desfechos que gravam)
    const partial: Readonly<Record<Exclude<AuthorityOutcome, 'ambiguous'>, TransmissionEventKind>> = { rejected: 'R', auth_failed: 'F' }
    expect([values, keys, Object.keys(partial).length]).toEqual([true, true, 2])
  })
  it('o fecho do switch EXAUSTIVO: um roteiro que esquece um desfecho não compila; em execução (só com cast) falha alto', () => {
    const route = (o: AuthorityOutcome): string => {
      switch (o) {
        case 'rejected': return 'R'
        case 'auth_failed': case 'chain_untrusted': case 'local': return 'F'
        case 'ambiguous': return 'em voo'
        default: return unhandledOutcome(o)
      }
    }
    const forgot = (o: AuthorityOutcome): string => {
      switch (o) {
        case 'rejected': return 'R'
        case 'ambiguous': return 'em voo'
        // @ts-expect-error — auth_failed/chain_untrusted/local sem caso: o fecho recusa
        default: return unhandledOutcome(o)
      }
    }
    expect([route('local'), forgot('rejected')]).toEqual(['F', 'R'])
    expect(() => route('novo' as any)).toThrow(/sem tratamento no roteiro: novo/)
  })
  it('os erros do EMISSOR (param a passada do rodízio) são os 7 de antes + a cadeia do servidor (D-NE57) e o conjunto é IMUTÁVEL em execução (NE1A-06)', () => {
    expect([...EMITTER_FAILURE_CODES].sort()).toEqual([
      ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED, ErrorCodes.FISCAL_AUTHORITY_CHAIN_UNTRUSTED, ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE, ErrorCodes.FISCAL_CERT_EXPIRED, ErrorCodes.FISCAL_CERT_INVALID,
      ErrorCodes.FISCAL_CERT_MISSING, ErrorCodes.FISCAL_ISSUER_MISSING, ErrorCodes.FISCAL_MASTER_KEY_UNAVAILABLE,
    ].sort())
    expect(Object.isFrozen(EMITTER_FAILURE_CODES)).toBe(true)
    expect((EMITTER_FAILURE_CODES as any).add).toBeUndefined()
    expect(EMITTER_FAILURE_CODES.has(ErrorCodes.FISCAL_DPS_REJECTED)).toBe(false)
  })
})

describe('política sobre o escritor (`voice/policy.ts`)', () => {
  it('recordVoiceOnce: a fala (kind, dh) que já está não entra de novo (null, sem escrita); a nova entra — conferida e escrita sob a MESMA transação', async () => {
    await underLock(async itx => {
      const write = jest.fn(async () => 4)
      const said = jest.fn(async () => true)
      expect(await recordVoiceOnce({ insertTransmissionEvent: write, hasTransmissionEvent: said }, itx, 2, 7, { kind: 'A', source: 'Q', dh: '2026-10-12 10:00:00' })).toBeNull()
      expect(write).not.toHaveBeenCalled()
      said.mockResolvedValue(false)
      expect(await recordVoiceOnce({ insertTransmissionEvent: write, hasTransmissionEvent: said }, itx, 2, 7, { kind: 'A', source: 'Q', dh: '2026-10-12 10:00:00' })).toBe(4)
      expect(said).toHaveBeenLastCalledWith(itx.conn, itx.ref, 2, 'A', '2026-10-12 10:00:00')
      expect(write).toHaveBeenCalledWith(itx, 2, 7, { kind: 'A', source: 'Q', dh: '2026-10-12 10:00:00' })
    })
  })
  it('recordKindOnce: o kind entra UMA vez por tentativa, QUALQUER dh (um C por tentativa — HIGH-3a); já havendo, devolve o que está e nada escreve', async () => {
    await underLock(async itx => {
      const write = jest.fn(async () => 6)
      const existing = { attempt: 2, event: 3, kind: 'C' as const, authorityCode: '105102', message: null, dh: '2026-10-12 09:00:00', source: 'Q' as const, userId: null, createdAt: null }
      const find = jest.fn(async () => existing)
      expect(await recordKindOnce({ insertTransmissionEvent: write, findTransmissionEventByKind: find }, itx, 2, 7, { kind: 'C', source: 'P', dh: '2026-10-12 10:00:00' }))
        .toEqual({ event: 3, inserted: false, existing })
      expect(write).not.toHaveBeenCalled()
      expect(find).toHaveBeenCalledWith(itx.conn, itx.ref, 2, 'C')
      find.mockResolvedValue(null as any)
      expect(await recordKindOnce({ insertTransmissionEvent: write, findTransmissionEventByKind: find }, itx, 2, 7, { kind: 'C', source: 'P', dh: '2026-10-12 10:00:00' }))
        .toEqual({ event: 6, inserted: true })
    })
  })
  it('reserva: K, fato NOSSO (dh NULL, source P), pelo escritor da família — com o escritor REAL passa o funil e grava na tabela do descritor', async () => {
    await underLock(async (itx, calls) => {
      expect(await reserveCancelRequest(SERVICE.insertTransmissionEvent, itx, 3, 7)).toBe(9)
      const ins = calls.find(c => /^\s*INSERT INTO tb_invoice_service_transmission_event/.test(c.sql))!
      expect([ins.p[5], ins.p[7], ins.p[8], ins.p[9]]).toEqual(['K', CANCEL_REQUEST_IN_FLIGHT, null, 'P'])
    })
  })
  it('liberação: N só quando a última voz da tentativa (lida pela família sob a mesma trava) ainda é o K; senão nada (false, sem escrita); mensagem cortada em 255; o `current` de OUTRA tentativa falha alto (D-NE83)', async () => {
    await underLock(async itx => {
      const write = jest.fn(async () => 5)
      for (const cur of [null, { attempt: 3, lastKind: null }, { attempt: 3, lastKind: 'A' as const }, { attempt: 3, lastKind: 'C' as const }, { attempt: 3, lastKind: 'N' as const }]) {
        expect(await releaseCancelRequest(write, itx, 3, 7, 'x', cur)).toBe(false)
      }
      await expect(releaseCancelRequest(write, itx, 3, 7, 'x', { attempt: 2, lastKind: 'K' })).rejects.toThrow(/D-NE83/)
      expect(write).not.toHaveBeenCalled()
      expect(await releaseCancelRequest(write, itx, 3, 7, 'y'.repeat(400), { attempt: 3, lastKind: 'K' })).toBe(true)
      expect(write).toHaveBeenCalledWith(itx, 3, 7, { kind: 'N', source: 'P', dh: null, message: 'y'.repeat(255) })
    })
  })
  it('testemunhas de COMPILAÇÃO: o escritor de uma família SEM K/N não cabe na reserva/liberação (contravariância); o da NFS-e cabe; e em execução o funil da família recusa mesmo assim', async () => {
    const noCancel = defineVoiceFamily({ reading: SERVICE_VOICE_READING, eventTable: 'tb_invoice_service_transmission_event', writeKinds: ['A', 'F'] as const, label: 'NFS-e' })
    const fits: VoiceWriter<'K'> = SERVICE.insertTransmissionEvent
    // @ts-expect-error — a lista A/F não tem K: reservar nela não compila
    const noK: VoiceWriter<'K'> = noCancel.insertTransmissionEvent
    // @ts-expect-error — nem N: liberar nela não compila
    const noN: VoiceWriter<'N'> = noCancel.insertTransmissionEvent
    expect([typeof fits, typeof noK, typeof noN]).toEqual(['function', 'function', 'function'])
    await underLock(async itx => {
      await expect(reserveCancelRequest(noCancel.insertTransmissionEvent as any, itx, 1, null)).rejects.toThrow(/^D-F106/)
    })
  })
})
