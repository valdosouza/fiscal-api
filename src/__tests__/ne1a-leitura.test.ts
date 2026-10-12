/// <reference types="jest" />
// NE-1a — parte 1 (Rodada 1 da NE-1a, Valdo 2026-10-11: D-NE56 registro como FATO da view · D-NE59 ordem: o que a F2a importa
// primeiro). Prompt: Infra-IA/prompts/prompt_onda_nfe_sefaz.md §12.9. Puro: sem banco, sem fisco.
import fs from 'fs'
import path from 'path'
import { KIND_CLASS, FINAL_TRANSMISSION_KINDS, AUTHORIZED_KINDS, TransmissionEventKind } from '../voice/kinds'
import {
  COMMON_TRANSMISSION_COLUMNS, TransmissionView, VoiceFamilyReading, blocksNewAttempt, currentOf, familyViewQuery, familyViewQueryMany, familyViewSelect,
  fiscalStateOf, isFiscalRecord, isLiveTransmission, localCancelPendingIn, mapCommonView,
} from '../voice/reading'
import { SERVICE_VOICE_READING, mapTransmissionView, localCancelPending } from '../voice/families/service'
import { VOICE_READINGS } from '../voice/families'
import { WEB_TERMINAL, invoiceRef, invoiceRefFilter } from '../ref/invoice-ref'
import { invoiceLife, invoiceLives, lockInvoice, orderInterface } from '../erp/facts'
import * as core from '../index'

const SRC = path.resolve(__dirname, '..')
const NFSE_MIGRATIONS = path.resolve(SRC, '..', '..', 'nfse-api', 'src', 'migrations', 'sql')

describe('D-NE14 — vocabulário com P/D e classificação TOTAL', () => {
  it('toda letra tem classe; autorizado implica final; os conjuntos DERIVAM da classe', () => {
    const kinds = Object.keys(KIND_CLASS) as TransmissionEventKind[]
    expect(kinds.sort()).toEqual(['A', 'C', 'D', 'F', 'K', 'N', 'P', 'R', 'S'])
    for (const k of kinds) if (KIND_CLASS[k].authorized) expect([k, KIND_CLASS[k].final]).toEqual([k, true])
    expect([...FINAL_TRANSMISSION_KINDS].sort()).toEqual(['A', 'C', 'D', 'F', 'N', 'R'])
    expect([...AUTHORIZED_KINDS].sort()).toEqual(['A', 'N'])
  })
  it('estado EXAUSTIVO: P → em processamento (viva), D → denegada (final); a NFS-e segue com os 7 estados dela', () => {
    expect(fiscalStateOf({ lastKind: 'P' })).toBe('processing')
    expect(fiscalStateOf({ lastKind: 'D' })).toBe('denied')
    expect([isLiveTransmission({ lastKind: 'P' }), isLiveTransmission({ lastKind: 'D' })]).toEqual([true, false])
    const service = ['A', 'R', 'C', 'K', 'F', 'N'].map(k => fiscalStateOf({ lastKind: k as TransmissionEventKind }))
    expect(service).toEqual(['authorized', 'rejected', 'cancelled', 'cancel_in_flight', 'failed', 'authorized'])
    expect([fiscalStateOf({ lastKind: null }), fiscalStateOf({ lastKind: 'S' }), fiscalStateOf(null)]).toEqual(['in_flight', 'in_flight', 'none'])
  })
  it('kind fora do vocabulário em execução (gravado por fora do código — D-F103) falha FECHADO como viva', () => {
    for (const k of ['f', 'Z', '', ' F']) expect([k, fiscalStateOf({ lastKind: k as any })]).toEqual([k, 'in_flight'])
  })
})

describe('D-NE56 — o REGISTRO pelo fisco é FATO da view, nunca a presença da chave', () => {
  const tx = (attempt: number, over: Partial<TransmissionView> = {}) =>
    ({ attempt, lastKind: 'R', accessKey: null, authorityRecorded: false, environment: 'P', ...over }) as Pick<TransmissionView, 'attempt' | 'lastKind' | 'accessKey' | 'authorityRecorded' | 'environment'>

  it('NF-e: a chave é NOSSA desde a reserva — a tentativa REJEITADA com chave não é a vigente nem registro fiscal', () => {
    const rejectedWithOurKey = tx(2, { lastKind: 'R', accessKey: '41260912345678000199550010000000011000000011' })
    const earlier = tx(1, { lastKind: 'F', accessKey: '41260912345678000199550010000000011000000022' })
    expect(currentOf([earlier, rejectedWithOurKey])?.attempt).toBe(2)            // sem registro: a última
    expect(isFiscalRecord(rejectedWithOurKey)).toBe(false)
  })
  it('a vigente é a REGISTRADA (a de maior attempt, se mais de uma), mesmo com tentativa posterior rejeitada', () => {
    expect(currentOf([tx(3, { lastKind: 'R' }), tx(1, { lastKind: 'A', authorityRecorded: true })])?.attempt).toBe(1)
    expect(currentOf([tx(1, { authorityRecorded: true, lastKind: 'C' }), tx(2, { authorityRecorded: true, lastKind: 'A' })])?.attempt).toBe(2)
    expect(currentOf([])).toBeNull()
  })
  it('registro FISCAL = registrado E em produção (Q-CA5): homologação não tem valor jurídico', () => {
    expect(isFiscalRecord(tx(1, { authorityRecorded: true, environment: 'P' }))).toBe(true)
    expect(isFiscalRecord(tx(1, { authorityRecorded: true, environment: 'H' }))).toBe(false)
    expect(isFiscalRecord(null)).toBe(false)
  })
  it('barreira de NOVA tentativa: viva OU registrada — a NF-e denegada (D, registrada pela SEFAZ) barra; rejeitada sem registro não', () => {
    expect(blocksNewAttempt(tx(1, { lastKind: 'D', authorityRecorded: true }))).toBe(true)
    expect(blocksNewAttempt(tx(1, { lastKind: 'P' }))).toBe(true)
    expect(blocksNewAttempt(tx(1, { lastKind: null }))).toBe(true)
    expect(blocksNewAttempt(tx(1, { lastKind: 'R', accessKey: 'NOSSA' }))).toBe(false)
    expect(blocksNewAttempt(null)).toBe(false)
  })
  it('a linha da view SEM `authority_recorded` (migration da família não aplicada) falha ALTO — nunca vira "não registrado" calado', () => {
    expect(() => mapCommonView({ attempt: 1, accessKey: 'K', environment: 'P', terminal: 0 })).toThrow(/authority_recorded/)
    expect(() => mapTransmissionView({ attempt: 1, authorityRecorded: 's', environment: 'P', terminal: 0 })).toThrow(/authority_recorded/)   // só 'S'/'N'
    expect(mapTransmissionView({ attempt: 1, authorityRecorded: 'S', accessKey: 'K', environment: 'P', terminal: 0 }).authorityRecorded).toBe(true)
    // gates da parte 1 (M4 / D-NE70): ambiente e terminal também decidem — falham alto, nunca um padrão calado
    expect(() => mapCommonView({ attempt: 1, authorityRecorded: 'S', terminal: 0 })).toThrow(/environment/)
    expect(() => mapCommonView({ attempt: 1, authorityRecorded: 'S', environment: 'P' })).toThrow(/terminal/)
    expect(() => mapCommonView({ attempt: 1, authorityRecorded: 'S', environment: 'P', terminal: -1 })).toThrow(/terminal/)
    expect(mapCommonView({ attempt: 1, authorityRecorded: 'N', environment: 'H', terminal: '3' }).terminal).toBe(3)
  })
})

describe('leitura PUBLICADA por família (VoiceFamilyReading) — views por família com a projeção comum', () => {
  it('o catálogo tem só a família de serviço (a de mercadoria entra na NE-2) e é imutável', () => {
    expect(Object.keys(VOICE_READINGS)).toEqual(['service'])
    expect(VOICE_READINGS.service).toBe(SERVICE_VOICE_READING)
    expect(Object.isFrozen(VOICE_READINGS) && Object.isFrozen(SERVICE_VOICE_READING)).toBe(true)
  })
  it('o SELECT da família = projeção comum + colunas dela, com `authority_recorded`; nome de view fora do padrão é recusado', () => {
    const sql = familyViewSelect(SERVICE_VOICE_READING, 'fiscal_api')
    for (const [column, field] of COMMON_TRANSMISSION_COLUMNS) {
      expect(sql).toContain(`v.${column}`)
      expect(sql).toContain(`AS ${field}`)
    }
    expect(sql).toMatch(/v\.authority_recorded AS authorityRecorded/)
    expect(sql).toMatch(/FROM `fiscal_api`\.vw_invoice_service_transmission v$/)
    const bad = { ...SERVICE_VOICE_READING, transmissionView: 'tb_x; DROP' } as VoiceFamilyReading<TransmissionView>
    expect(() => familyViewSelect(bad, 'fiscal_api')).toThrow(/inválida/)
    expect(() => familyViewSelect(SERVICE_VOICE_READING, 'fiscal_api', 'v; --')).toThrow(/Alias/)
  })
  it('a consulta de UMA nota leva o TERMINAL como parâmetro (D-NE12) — nunca literal', () => {
    const q = familyViewQuery(SERVICE_VOICE_READING, 'fiscal_api', invoiceRef(1, 6200, 3))
    expect(q.sql).toMatch(/WHERE v\.tb_institution_id = \? AND v\.tb_invoice_id = \? AND v\.terminal = \? ORDER BY v\.attempt$/)
    expect(q.params).toEqual([1, 6200, 3])
  })
  it('leitura em LOTE (gate socrático M3 — o selo da lista de OS na F2a): várias notas do MESMO estabelecimento e terminal, tudo por parâmetro; lista vazia é erro de quem chama', () => {
    const q = familyViewQueryMany(SERVICE_VOICE_READING, 'fiscal_api', { institutionId: 1, terminal: 0 }, [6200, 6201])
    expect(q.sql).toMatch(/WHERE v\.tb_institution_id = \? AND v\.tb_invoice_id IN \(\?\) AND v\.terminal = \? ORDER BY v\.tb_invoice_id, v\.attempt$/)
    expect(q.params).toEqual([1, [6200, 6201], 0])
    expect(q.sql).not.toMatch(/terminal\s*=\s*\d/)
    expect(() => familyViewQueryMany(SERVICE_VOICE_READING, 'fiscal_api', { institutionId: 1, terminal: 0 }, [])).toThrow(/vazia/)
  })
  it('a pendência do efeito usa a regra de efeito HUMANO da família (a NF-e define a dela) — a da NFS-e é a de sempre', () => {
    const anyCancelIsHuman = { humanEffectCancel: () => true }
    expect(localCancelPendingIn(anyCancelIsHuman, { lastKind: 'C', lastCode: '101101' }, 'E')).toBe(false)
    expect(localCancelPending({ lastKind: 'C', lastCode: '101101' }, 'E')).toBe(true)
    expect(localCancelPending({ lastKind: 'C', lastCode: '105102' }, 'E')).toBe(false)
  })
  it('a view da NFS-e (migration da nfse-api) publica TODAS as colunas da projeção comum + as da família', () => {
    if (!fs.existsSync(NFSE_MIGRATIONS)) return                             // núcleo isolado (sem o workspace)
    const files = fs.readdirSync(NFSE_MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    const lastView = files.map(f => fs.readFileSync(path.join(NFSE_MIGRATIONS, f), 'utf8'))
      .map(s => s.match(/CREATE OR REPLACE VIEW `vw_invoice_service_transmission` AS[\s\S]*?;/)?.[0]).filter(Boolean).pop()!
    expect(lastView).toBeTruthy()
    for (const [column] of [...COMMON_TRANSMISSION_COLUMNS, ...SERVICE_VOICE_READING.ownColumns]) {
      expect([column, new RegExp(`\`${column}\``).test(lastView)]).toEqual([column, true])
    }
  })
})

describe('D-NE12 — referência da nota com TERMINAL: nenhum `terminal = 0` literal em SQL do núcleo', () => {
  const fake = () => {
    const calls: { sql: string; params: unknown[] }[] = []
    const q: any = { query: jest.fn(async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return [[]] }) }
    return { q, calls }
  }
  it('lockInvoice / invoiceLife / invoiceLives / orderInterface levam o terminal como PARÂMETRO', async () => {
    const ref = invoiceRef(1, 6200, 7)
    const a = fake(); await lockInvoice(a.q, 'setes_x', ref)
    expect(a.calls[0].params).toEqual([6200, 1, 7])
    const b = fake(); await invoiceLife(b.q, 'setes_x', ref)
    expect(b.calls[0].params).toEqual([1, 6200, 7])
    const c = fake(); await invoiceLives(c.q, 'setes_x', { institutionId: 1, terminal: 7 }, [6200, 6201])
    expect(c.calls[0].params).toEqual([1, [6200, 6201], 7])
    const d = fake(); await orderInterface(d.q, 'setes_x', ref)
    expect(d.calls[0].params).toEqual([1, 6200, 7])
    for (const x of [a, b, c, d]) for (const call of x.calls) expect(call.sql).toMatch(/terminal = \?/)
  })
  it('cerca: nenhum `terminal = 0` (ou `= 0` de terminal) em SQL do núcleo — o 0 só existe como `WEB_TERMINAL`, para a BORDA', () => {
    const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
      d.isDirectory() ? (d.name === '__tests__' ? [] : files(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : [])
    const offenders = files(SRC).filter(f => /\bterminal\s*=\s*0\b/.test(fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')))
    expect(offenders.map(f => path.relative(SRC, f))).toEqual([])
    expect(WEB_TERMINAL).toBe(0)
    expect((core as any).WEB_TERMINAL).toBe(0)
  })
  it('o filtro recusa alias fora do padrão (nunca SQL montado com texto livre)', () => {
    expect(() => invoiceRefFilter(invoiceRef(1, 1, 0), 'v; DROP')).toThrow(/Alias/)
    expect(invoiceRefFilter(invoiceRef(1, 2, 3), 'v')).toEqual({ sql: 'v.tb_institution_id = ? AND v.tb_invoice_id = ? AND v.terminal = ?', params: [1, 2, 3] })
  })
})
