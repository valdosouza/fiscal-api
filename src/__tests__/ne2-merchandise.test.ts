/// <reference types="jest" />
// NE-2 — a leitura publicada da família de MERCADORIA no núcleo (Rodada 15 da nfe-api, Valdo 2026-10-20 — `Infra-IA/prompts/
// prompt_onda_nfe_sefaz.md` §15.8): D-NE158 (fora do catálogo e da superfície até a NE-6), D-NE159 (`humanEffectCancel` = false, conhecimento
// negativo), D-NE160 (só `dh_emission` própria; `voiceView` fora do contrato; a view de vozes não nasce), D-NE56/D-NE61 (registro pelo
// protocolo; D sempre registrada). Puro: sem banco, sem fisco.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import { COMMON_TRANSMISSION_COLUMNS, familyViewSelect, localCancelPendingIn, VoiceFamilyReading, TransmissionView } from '../voice/reading'
import { MERCHANDISE_VOICE_READING, mapMerchandiseTransmissionView, isMerchandiseHumanEffectCancel } from '../voice/families/merchandise'
import { SERVICE_VOICE_READING } from '../voice/families/service'
import { VOICE_READINGS } from '../voice/families'
import { assertFamilyViewsReadable } from '../voice/family-reader'
import { countLiveTransmissions } from '../emitter/emitter'
import * as reading from '../reading'
import * as barrel from '../index'

const SRC = path.resolve(__dirname, '..')
const NFE_MIGRATIONS = path.resolve(SRC, '..', '..', 'nfe-api', 'src', 'migrations', 'sql')
const row = (over: Record<string, unknown> = {}) => ({
  institutionId: 1, invoiceId: 6200, terminal: 0, attempt: 1, lifeEvent: 1, environment: 'H', accessKey: '4'.repeat(44), authorityRecorded: 'N',
  lastQueriedAt: null, createdAt: null, lastEvent: null, lastKind: null, lastCode: null, lastMessage: null, lastSource: null, lastDh: null,
  lastEventAt: null, dhEmission: '2026-10-20 12:00:00', ...over,
})

describe('D-NE160 — o que a família publica', () => {
  it('coluna PRÓPRIA só `dh_emission` (instante); projeção comum + ela no SELECT publicado; leitura congelada em profundidade', () => {
    expect(MERCHANDISE_VOICE_READING.branch).toBe('merchandise')
    expect(MERCHANDISE_VOICE_READING.transmissionView).toBe('vw_invoice_merchandise_transmission')
    expect(MERCHANDISE_VOICE_READING.ownColumns).toEqual([['dh_emission', 'dhEmission', true]])
    expect(Object.isFrozen(MERCHANDISE_VOICE_READING) && Object.isFrozen(MERCHANDISE_VOICE_READING.ownColumns) && Object.isFrozen(MERCHANDISE_VOICE_READING.ownColumns[0])).toBe(true)
    const sql = familyViewSelect(MERCHANDISE_VOICE_READING, 'fiscal_api')
    for (const [column, field] of COMMON_TRANSMISSION_COLUMNS) { expect(sql).toContain(`v.${column}`); expect(sql).toContain(`AS ${field}`) }
    expect(sql).toMatch(/DATE_FORMAT\(v\.dh_emission, '%Y-%m-%d %H:%i:%s'\) AS dhEmission/)
    expect(sql).toMatch(/FROM `fiscal_api`\.vw_invoice_merchandise_transmission v$/)
    for (const internal of ['protocol', 'authorizer', 'receipt', 'dh_recbto', 'digest_value', 'model']) expect([internal, sql.includes(internal)]).toEqual([internal, false])
  })
  it('`voiceView` SAIU do contrato comum (`VoiceFamilyReading` não o declara); a NF-e não o tem; a NFS-e o mantém como fato só dela (sem DROP)', () => {
    const sf = ts.createSourceFile('reading.ts', fs.readFileSync(path.join(SRC, 'voice', 'reading.ts'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const members: string[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isInterfaceDeclaration(n) && n.name.text === 'VoiceFamilyReading') for (const m of n.members) members.push(m.name?.getText(sf) ?? '?')
      ts.forEachChild(n, visit)
    }
    visit(sf)
    expect(members.sort()).toEqual(['branch', 'humanEffectCancel', 'map', 'ownColumns', 'transmissionView'])
    expect('voiceView' in MERCHANDISE_VOICE_READING).toBe(false)
    expect(SERVICE_VOICE_READING.voiceView).toBe('vw_invoice_service_transmission_event')
  })
})

describe('D-NE158 — fora do catálogo e fora de `fiscal-api/reading`, só no barrel', () => {
  it('o catálogo segue só com `service`; a leitura e a numeração existem no barrel e NÃO na superfície de leitura', () => {
    expect(Object.keys(VOICE_READINGS)).toEqual(['service'])
    for (const n of ['MERCHANDISE_VOICE_READING', 'mapMerchandiseTransmissionView', 'isMerchandiseHumanEffectCancel', 'readWithdrawnRanges', 'withdrawnRangesQuery',
      'assertWithdrawnRangesViewReadable', 'WITHDRAWN_RANGES_VIEW']) {
      expect([n, n in barrel, n in reading]).toEqual([n, true, false])
    }
  })
  it('o emitter conta 0 para o ramo de mercadoria SEM consultar o banco (família sem leitura no catálogo = nenhuma tentativa possível) e `all` percorre só a NFS-e', async () => {
    const calls: string[] = []
    const q: any = { query: jest.fn(async (sql: string) => { calls.push(sql); return [[{ n: 3 }]] }) }
    expect(await countLiveTransmissions(q, 1, { branches: ['merchandise'] })).toBe(0)
    expect(calls).toEqual([])
    expect(await countLiveTransmissions(q, 1, { branches: 'all' })).toBe(3)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('vw_invoice_service_transmission ')
    expect(calls[0]).not.toContain('merchandise')
  })
  it('a nfe-api confere a PRÓPRIA view passando a leitura; o padrão (catálogo) segue conferindo só as do catálogo', async () => {
    const calls: string[] = []
    const q: any = { query: jest.fn(async (sql: string) => { calls.push(sql); return [[]] }) }
    await assertFamilyViewsReadable(q, 'fiscal_api', [MERCHANDISE_VOICE_READING])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/FROM `fiscal_api`\.vw_invoice_merchandise_transmission v WHERE 1 = 0$/)
    await assertFamilyViewsReadable(q, 'fiscal_api')
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('vw_invoice_service_transmission')
    const bad: any = { query: jest.fn(async () => { throw Object.assign(new Error('no view'), { code: 'ER_NO_SUCH_TABLE' }) }) }
    await expect(assertFamilyViewsReadable(bad, 'fiscal_api', [MERCHANDISE_VOICE_READING])).rejects.toThrow(/família "merchandise".*ER_NO_SUCH_TABLE.*D-F113/)
  })
  it('CERCA da janela da NE-6 (gate socrático L3): enquanto o catálogo tiver UMA família o padrão "catálogo inteiro" pode ficar; no dia em que crescer, o 3º parâmetro de `assertFamilyViewsReadable` tem de ter PERDIDO o valor padrão (cada chamador diz o que confere — D-NE158)', () => {
    const sf = ts.createSourceFile('family-reader.ts', fs.readFileSync(path.join(SRC, 'voice', 'family-reader.ts'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    let hasDefault: boolean | null = null
    const visit = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'assertFamilyViewsReadable') hasDefault = !!n.parameters[2]?.initializer
      ts.forEachChild(n, visit)
    }
    visit(sf)
    expect(hasDefault).not.toBeNull()
    if (Object.keys(VOICE_READINGS).length > 1) expect([Object.keys(VOICE_READINGS), hasDefault]).toEqual([Object.keys(VOICE_READINGS), false])
    else expect(hasDefault).toBe(true)
  })
})

describe('D-NE56/D-NE61/D-NE7 — o mapa da família', () => {
  it('mapeia a linha com `dhEmission`; o registro é o FATO da view, nunca a chave (a chave existe desde a reserva)', () => {
    const t = mapMerchandiseTransmissionView(row())
    expect([t.authorityRecorded, t.accessKey, t.dhEmission, t.lastKind]).toEqual([false, '4'.repeat(44), '2026-10-20 12:00:00', null])
    expect(mapMerchandiseTransmissionView(row({ authorityRecorded: 'S', lastKind: 'A', lastCode: '100' })).authorityRecorded).toBe(true)
  })
  it('linha SEM chave é família inconsistente (D-NE7) — falha ALTO dentro da porta do leitor', () => {
    for (const accessKey of [null, undefined, '', '  ']) expect(() => mapMerchandiseTransmissionView(row({ accessKey }))).toThrow(/SEM chave de acesso.*D-NE7/)
  })
  it('D-NE61/D-F136/D-F154 herdadas do mapa comum: D, A/N, C/K sem registro falham ALTO; R sem registro passa (rejeitada não registra)', () => {
    for (const [lastKind, rule] of [['D', 'D-NE61'], ['A', 'D-F136'], ['N', 'D-F136'], ['C', 'D-F154'], ['K', 'D-F154']]) {
      expect(() => mapMerchandiseTransmissionView(row({ lastKind, lastCode: '100' }))).toThrow(new RegExp(rule))
    }
    expect(mapMerchandiseTransmissionView(row({ lastKind: 'R', lastCode: '225' })).lastKind).toBe('R')
    expect(mapMerchandiseTransmissionView(row({ lastKind: 'P', lastCode: '103' })).lastKind).toBe('P')
  })
})

describe('D-NE159 — `humanEffectCancel` da NF-e é SEMPRE false (conhecimento negativo)', () => {
  it('nenhum código de evento vira efeito humano — nem o 110111, nem os da NFS-e, nem o 110112 da F5, nem C sem código', () => {
    for (const current of [null, { lastKind: 'C' as const, lastCode: '110111' }, { lastKind: 'C' as const, lastCode: '105102' }, { lastKind: 'C' as const, lastCode: '305101' },
      { lastKind: 'C' as const, lastCode: '110112' }, { lastKind: 'C' as const, lastCode: null }, { lastKind: 'A' as const, lastCode: '100' }]) {
      expect([JSON.stringify(current), isMerchandiseHumanEffectCancel(current)]).toEqual([JSON.stringify(current), false])
      expect(MERCHANDISE_VOICE_READING.humanEffectCancel(current)).toBe(false)
    }
  })
  it('logo a pendência do efeito (D-F28) é AUTOMÁTICA em todo cancelamento da NF-e: voz C no fisco × nota ainda não-C no ERP = pendente', () => {
    expect(localCancelPendingIn(MERCHANDISE_VOICE_READING, { lastKind: 'C', lastCode: '110111' }, 'E')).toBe(true)
    expect(localCancelPendingIn(MERCHANDISE_VOICE_READING, { lastKind: 'C', lastCode: '110111' }, 'C')).toBe(false)
    expect(localCancelPendingIn(MERCHANDISE_VOICE_READING, { lastKind: 'A', lastCode: '100' }, 'E')).toBe(false)
  })
  it('não há conjunto de códigos "para a F5" exportado pela família (criar um vazio seria maquete — D-NE159)', () => {
    // o predicado existe (`isMerchandiseHumanEffectCancel`); CONJUNTO de códigos (constante `*_CODES`/`*_CODE`) da família, não
    expect(Object.keys(barrel).filter(k => /^[A-Z0-9_]+$/.test(k) && /MERCHANDISE|NFE/.test(k) && /CANCEL|HUMAN_EFFECT/.test(k))).toEqual([])
  })
})

describe('o DDL da família (migration 001 da nfe-api, quando o workspace o tem) × a leitura publicada', () => {
  const sql = () => fs.readdirSync(NFE_MIGRATIONS).filter(f => f.endsWith('.sql')).sort().map(f => fs.readFileSync(path.join(NFE_MIGRATIONS, f), 'utf8')).join('\n')
  const skip = () => !fs.existsSync(NFE_MIGRATIONS)
  it('a view publica TODAS as colunas da projeção comum + `dh_emission`, e NADA interno (protocol/authorizer/receipt/dh_recbto/digest_value)', () => {
    if (skip()) return
    const view = sql().match(/CREATE OR REPLACE VIEW `vw_invoice_merchandise_transmission` AS([\s\S]*?)\bFROM\b/)![1]
    for (const [column] of [...COMMON_TRANSMISSION_COLUMNS, ...MERCHANDISE_VOICE_READING.ownColumns]) expect([column, new RegExp(`\`${column}\``).test(view)]).toEqual([column, true])
    for (const internal of ['`protocol`', '`authorizer`', '`receipt`', '`dh_recbto`', '`digest_value`']) {
      // o protocolo aparece SÓ dentro do IF do registro (D-NE56) — nunca como coluna publicada
      const asColumn = new RegExp(`t\\.${internal.replace(/`/g, '`')}\\s*(,|$|AS)`, 'm').test(view) && internal !== '`protocol`'
      expect([internal, asColumn]).toEqual([internal, false])
    }
    expect(view).toMatch(/IF\(t\.`protocol` IS NULL, 'N', 'S'\) COLLATE utf8mb4_bin AS `authority_recorded`/)
  })
  it('a view de VOZES não nasce (D-NE160) e a convenção `vw_<x>` sobre `tb_<x>` vale (D-NE76)', () => {
    if (skip()) return
    expect(sql()).not.toMatch(/CREATE OR REPLACE VIEW `vw_invoice_merchandise_transmission_event`/)
    expect(sql()).toMatch(/CREATE TABLE IF NOT EXISTS `tb_invoice_merchandise_transmission` \(/)
    expect(sql()).toMatch(/FROM `tb_invoice_merchandise_transmission` t/)
  })
})

/** Tipo: a leitura é uma `VoiceFamilyReading` do contrato comum (compila) — e o mapa devolve a projeção comum + `dhEmission`. */
const _typeCheck: VoiceFamilyReading<TransmissionView> = MERCHANDISE_VOICE_READING
void _typeCheck
