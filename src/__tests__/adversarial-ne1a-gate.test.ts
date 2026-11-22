/// <reference types="jest" />
// GATE ADVERSARIAL — NE-1a parte 1 (Rodada 1 da NE-1a, Valdo 2026-10-11: D-NE56 registro = FATO da view · D-NE59 parte 1 = projeção
// comum + registro, P/D com classificação total, `InvoiceRef` com terminal · D-NE14 P viva / D final · D-NE12 terminal por parâmetro)
// — NÚCLEO fiscal-api. Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6). Plano: prompt_onda_nfe_sefaz.md §12.9.
//
// Alvo do delta no núcleo: `voice/kinds.ts` (KIND_CLASS + P/D), `voice/reading.ts` (projeção comum, `authorityRecorded`, `currentOf` por
// registro, `fiscalStateOf` exaustivo, `isFiscalRecord`, `blocksNewAttempt`, `familyViewSelect`/`familyViewQuery`, `mapCommonView`),
// `voice/families/service.ts` (regras só da NFS-e), `voice/families/index.ts` (`VOICE_READINGS`), `ref/invoice-ref.ts`, `erp/facts.ts`,
// `index.ts`. A nfse-api (view 004, `SERVICE_AUTHORITY_RECORDED_SQL`, `webInvoice`) é atacada no gate irmão
// `nfse-api/src/__tests__/adversarial-ne1a-gate.test.ts`.
//
//  * ACHADOS (`it.failing('[SEV NE1A-xx] …')`) — o teste afirma o que a decisão promete e FALHA no código atual: é a prova do achado.
//    O corretor troca `it.failing` por `it` depois de corrigir (ou de decidida a questão). NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (ficam como regressão).
//  * CONTEXTO (`it('contexto: …')`) — fixa o comportamento atual que fundamenta um achado ou uma QUESTÃO (decisão do Valdo).
//
// REGRAS DO GATE: puro (sem banco, sem socket, sem fisco). Lê a nfse-api só como TEXTO. Nada escrito no disco.
import fs from 'fs'
import path from 'path'
import * as core from '../index'
import * as kindsMod from '../voice/kinds'
import * as readingMod from '../voice/reading'
import * as serviceMod from '../voice/families/service'
import * as familiesMod from '../voice/families'
import * as refMod from '../ref/invoice-ref'
import { KIND_CLASS, FINAL_TRANSMISSION_KINDS, AUTHORIZED_KINDS, TransmissionEventKind } from '../voice/kinds'
import {
  COMMON_TRANSMISSION_COLUMNS, TransmissionView, VoiceFamilyReading, ViewColumn, blocksNewAttempt, currentOf,
  familyViewSelect, fiscalStateOf, isAuthorized, isFiscalRecord, isLiveTransmission, mapCommonView,
} from '../voice/reading'
import { familyViewQuery } from '../voice/view-query'          // D-NE66 (b): o SQL cru é INTERNO desde a F2a
import {
  SERVICE_VOICE_READING, ServiceTransmissionView, mapTransmissionView, reconfirmationCandidate, transmissionViewSelect,
  HUMAN_EFFECT_CANCEL_CODES, CANCEL_EVENT_CODES,
} from '../voice/families/service'
import { VOICE_READINGS } from '../voice/families'
import { WEB_TERMINAL, invoiceRef, invoiceRefFilter } from '../ref/invoice-ref'
import { orderInterface } from '../erp/facts'

const SRC_ROOT = path.resolve(__dirname, '..')
const WORKSPACE = path.resolve(SRC_ROOT, '..', '..')
const read = (f: string) => fs.readFileSync(f, 'utf8')
const rel = (f: string) => path.relative(SRC_ROOT, f).replace(/\\/g, '/')
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? (d.name === '__tests__' ? [] : walk(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : [])
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
/** Resultado de uma chamada OU o fato de ela ter falhado ALTO (lançado) — achado aceita qualquer das duas correções. */
const outcome = <T>(f: () => T): T | 'lança' => { try { return f() } catch { return 'lança' } }

const KEY = '41069022123456780001990000000000123202609210000123'.slice(0, 50)
/** Linha CRUA da view da NFS-e como o mysql2 a entrega a partir do `familyViewSelect` (flag 'S'/'N', instantes já formatados). */
const RAW = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  institutionId: 1, invoiceId: 6200, terminal: 0, attempt: 1, lifeEvent: 1, environment: 'P',
  accessKey: null, authorityRecorded: 'N', lastQueriedAt: null, createdAt: '2026-10-01 09:59:00',
  lastEvent: 1, lastKind: 'A', lastCode: null, lastMessage: null, lastSource: 'P', lastDh: null, lastEventAt: '2026-10-01 10:00:00',
  serie: '1', dpsNumber: 42, dpsId: 'DPS1', nfseNumber: null, dhProc: null, nfseNotGeneratedAt: null,
  ...over,
})
/** Uma NFS-e REGISTRADA em produção (tentativa 1, A, chave do fisco) e uma tentativa posterior que fechou com F por consulta (sem chave). */
const REGISTERED_1 = RAW({ attempt: 1, lastKind: 'A', accessKey: KEY, authorityRecorded: 'S' })
const LATER_F_2 = RAW({ attempt: 2, lastKind: 'F', lastSource: 'Q', accessKey: null, authorityRecorded: 'N', lastEvent: 1 })

// ===========================================================================
// NE1A-01 — os predicados comuns leem `authorityRecorded === true`: a linha CRUA da view ('S') vira "não registrado" CALADO
// ===========================================================================

describe('NE1A-01 — D-NE56 pelo caminho natural da F2a: `familyViewQuery` → linha crua → predicados', () => {
  /** O leitor que a F2a escreve com as peças publicadas: o SELECT pronto + o `query` do driver (linhas `any`). */
  async function f2aNaturalRead(rows: Record<string, unknown>[]) {
    const q: core.Queryable = { query: async () => [rows, []] }
    const { sql, params } = familyViewQuery(SERVICE_VOICE_READING, 'fiscal_api', invoiceRef(1, 6200, WEB_TERMINAL))
    const [raw] = await q.query(sql, params)
    const life: ServiceTransmissionView[] = raw          // compila: o driver devolve `any` (Queryable do núcleo — `Promise<[any, any]>`)
    return { life, sql }
  }

  it('contexto: o SELECT público entrega a coluna como o banco a publica (`v.authority_recorded AS authorityRecorded` — \'S\'/\'N\') e NADA no caminho `familyViewQuery` → predicado obriga o `reading.map`; a linha crua compila como `ServiceTransmissionView[]`', async () => {
    const { life, sql } = await f2aNaturalRead([LATER_F_2, REGISTERED_1])
    expect(sql).toMatch(/v\.authority_recorded AS authorityRecorded/)
    expect(life.map(t => t.authorityRecorded)).toEqual(['N', 'S'])                        // string, não boolean
  })
  it('[CORRIGIDO na sessão — D-NE66 (a)] com a linha CRUA os predicados FALHAM ALTO (antes: NFS-e registrada em produção saía "não é registro", a vigente virava a F e a barreira abria para a nota cancelada); pelo mapa (o caminho certo) as três respostas são as da D-NE56', async () => {
    const { life } = await f2aNaturalRead([LATER_F_2, REGISTERED_1])
    expect(outcome(() => isFiscalRecord(life[1]))).toBe('lança')
    expect(outcome(() => currentOf(life)?.attempt)).toBe('lança')
    expect(outcome(() => blocksNewAttempt({ ...life[1], lastKind: 'C' }))).toBe('lança')
    const mapped = [LATER_F_2, REGISTERED_1].map(SERVICE_VOICE_READING.map)
    expect([isFiscalRecord(mapped[1]), currentOf(mapped)?.attempt, blocksNewAttempt({ ...mapped[1], lastKind: 'C' })]).toEqual([true, 1, true])
  })
  it('[CORRIGIDO na sessão] [MEDIUM NE1A-01] (latente — entra com a F2a) `currentOf`/`isFiscalRecord`/`blocksNewAttempt` liam `authorityRecorded === true`: o valor fora do domínio boolean — a flag CRUA \'S\' da view, que o SELECT público entrega — virava "não registrado" em silêncio; agora o PREDICADO confere o fato (`authorityRecordedOf`) e falha alto', () => {
    expect(outcome(() => isFiscalRecord(REGISTERED_1 as any))).not.toBe(false)
    expect(outcome(() => currentOf([LATER_F_2, REGISTERED_1] as any)?.attempt)).not.toBe(2)
    expect(outcome(() => blocksNewAttempt({ ...REGISTERED_1, lastKind: 'C' } as any))).not.toBe(false)
  })
  it('resistiu: o MAPA da projeção comum é estrito — toda forma torta de `authority_recorded` falha ALTO (minúscula, espaço, número, boolean, nulo, ausente, Buffer, palavra); só \'S\'/\'N\' passam', () => {
    for (const v of ['s', 'n', 'S ', ' S', 'SIM', 'Y', '', 1, 0, true, false, null, undefined, Buffer.from('S'), ['S'], { valueOf: () => 'S' }]) {
      expect([String(v), outcome(() => mapCommonView(RAW({ authorityRecorded: v })).authorityRecorded)]).toEqual([String(v), 'lança'])
      expect([String(v), outcome(() => mapTransmissionView(RAW({ authorityRecorded: v })).authorityRecorded)]).toEqual([String(v), 'lança'])
    }
    // D-F136: 'N' com a voz A (o padrão do RAW) é a autorizada sem registro — recusada; com uma voz não autorizada passa
    expect([mapCommonView(RAW({ authorityRecorded: 'S' })).authorityRecorded, mapCommonView(RAW({ authorityRecorded: 'N', lastKind: 'F' })).authorityRecorded]).toEqual([true, false])
  })
})

// ===========================================================================
// NE1A-02 — a regra da família que o setes-api consome (`reconfirmationCandidate`) ainda decide "registro" pela CHAVE
// ===========================================================================

describe('NE1A-02 — duas definições do registro no núcleo (fato × chave)', () => {
  /** Vida com a candidata F/Q/P (tentativa 1) e uma tentativa com chave que a view NÃO dá como registrada (linha incoerente). */
  // D-F136 (gates da A3 da F2a): a tentativa 2 era A — a AUTORIZADA sem registro agora é recusada pelo MAPA (falha alta, como a D-NE61); a
  // incoerência "chave sem registro" segue testada com uma voz NÃO autorizada (C), que o mapa ainda deixa passar
  const incoherent = (kind = 'C') => [
    RAW({ attempt: 1, lastKind: 'F', lastSource: 'Q', accessKey: null, authorityRecorded: 'N' }),
    RAW({ attempt: 2, lastKind: kind, accessKey: KEY, authorityRecorded: 'N' }),
  ]
  it('resistiu: com linhas COERENTES com a definição da view 004 (`authority_recorded` ⇔ chave), as duas regras coincidem em todas as combinações de 1–3 tentativas — por isso LOW', () => {
    const shapes = [null, KEY]
    let checked = 0
    for (const a of shapes) for (const b of [undefined, ...shapes]) for (const c of [undefined, ...shapes]) {
      const keys = [a, b, c].filter(k => k !== undefined) as (string | null)[]
      const life = keys.map((k, i) => mapTransmissionView(RAW({
        attempt: i + 1, accessKey: k, authorityRecorded: k ? 'S' : 'N', lastKind: k ? 'A' : 'F', lastSource: 'Q',
      })))
      const recordedByFact = life.some(t => t.authorityRecorded)
      expect(reconfirmationCandidate(life) === null).toBe(recordedByFact || !life.some(t => t.lastKind === 'F'))
      checked++
    }
    expect(checked).toBe(18)
  })
  it('[CORRIGIDO na sessão — D-NE68 (b)] [LOW NE1A-02] `reconfirmationCandidate` (regra da família, exportada para o setes-api) decidia "alguém registrou" por `!!accessKey` — a D-NE56 manda ler o FATO; numa linha incoerente (chave sem registro) o núcleo se contradiz: `currentOf`/`isFiscalRecord` dizem "não registrada, pendente" e a reconferência diz "nada a reconferir" (o cancelamento local passaria sem a prova da D-F29). Ou o mapa da família recusa a linha incoerente, ou as duas regras leem o mesmo fato', () => {
    let life: ServiceTransmissionView[]
    try { life = incoherent().map(mapTransmissionView) } catch { return }                   // falhar ALTO na linha incoerente também fecha
    const current = currentOf(life)
    expect(isFiscalRecord(current)).toBe(false)                                            // pelo fato: ninguém registrou
    expect(reconfirmationCandidate(life)?.attempt).toBe(1)                                 // … então a F/Q/P em P precisa da prova
  })
  it('[D-F136] a linha incoerente com voz AUTORIZADA (A/N) sem registro nem passa pelo mapa — falha ALTO, nunca chega a currentOf/veredito', () => {
    for (const k of ['A', 'N']) expect(() => incoherent(k).map(mapTransmissionView)).toThrow(/D-F136/)
  })
  it('[D-F154] a linha com voz que PRESSUPÕE a autorização (C cancelada, K cancelamento em voo) sem registro também falha ALTO no mapa', () => {
    for (const k of ['C', 'K']) expect(() => incoherent(k).map(mapTransmissionView)).toThrow(/D-F154/)
  })
  it('[CORRIGIDO na sessão — D-NE68 (b)] na linha incoerente o núcleo agora diz UMA coisa só: `currentOf` escolhe a ÚLTIMA (sem registro), não é registro fiscal e a F/Q/P em P precisa da prova (`reconfirmationCandidate` lê o mesmo FATO)', () => {
    // D-F154: a voz C/K sem registro nem passa pelo mapa — a incoerência "chave sem registro" da D-NE68 (b) segue provada com a R
    const life = incoherent('R').map(mapTransmissionView)
    expect([currentOf(life)?.attempt, isFiscalRecord(currentOf(life)), reconfirmationCandidate(life)?.attempt]).toEqual([2, false, 1])
  })
})

// ===========================================================================
// NE1A-03 — `blocksNewAttempt`: a NF-e DENEGADA só barra se a view disser "registrada"
// ===========================================================================

describe('NE1A-03 — D (denegada) × barreira de nova tentativa', () => {
  it('contexto: D é FINAL e NÃO autorizada — a fórmula da barreira da NFS-e (`isLive || isAuthorized`, nfse-api `transmission.ts`) deixaria retransmitir; a barreira comum barra D só pelo FATO do registro', () => {
    const d = { lastKind: 'D' as TransmissionEventKind, authorityRecorded: true }
    expect([isLiveTransmission(d), isAuthorized(d)]).toEqual([false, false])
    expect(blocksNewAttempt(d)).toBe(true)
    expect(blocksNewAttempt({ ...d, authorityRecorded: false })).toBe(false)
    const nfse = path.join(WORKSPACE, 'nfse-api', 'src', 'nfse', 'transmission.ts')
    if (fs.existsSync(nfse)) expect(read(nfse)).toMatch(/if \(latest && \(isLiveTransmission\(latest\) \|\| isAuthorized\(latest\)\)\) throw liveTransmissionError\(latest\)/)
  })
  // DECIDIDO (Valdo 2026-10-12): D-NE61 (= Q-NE61 (a) do socrático) — invariante da FAMÍLIA; a Q-NE67 (a) do adversarial (barrar pela CLASSE
  // da letra) foi REJEITADA. A garantia mora no MAPA (a linha D sem registro falha alto), não num 2º critério do predicado.
  it('[DECIDIDO — D-NE61] [LOW NE1A-03] (NE-2) a NF-e DENEGADA barra porque a família a publica SEMPRE registrada: a linha D sem registro (consulta sem `nProt`, view torta) falha ALTO no mapa — nunca chega à barreira para liberar o número queimado; com registro, barra', () => {
    expect(outcome(() => mapCommonView(RAW({ lastKind: 'D', authorityRecorded: 'N' })))).toBe('lança')
    const denied = mapCommonView(RAW({ lastKind: 'D', authorityRecorded: 'S' }))
    expect(blocksNewAttempt(denied)).toBe(true)
    // limite conhecido: objeto montado À MÃO (sem o mapa) com D sem registro passa — o caminho público da F2a é o leitor que já mapeia (D-NE66 (b))
    expect(blocksNewAttempt({ lastKind: 'D', authorityRecorded: false })).toBe(false)
  })
})

// ===========================================================================
// NE1A-04 — o terminal da web escondido no MAPA do núcleo
// ===========================================================================

describe('NE1A-04 — D-NE12: `mapCommonView` assume `terminal ?? 0`', () => {
  it('[CORRIGIDO na sessão — D-NE70 (a)] a cerca da entrega (`/\\bterminal\\s*=\\s*0\\b/` em SQL do núcleo) não via `terminal ?? 0` — e o único 0-padrão de terminal no núcleo (o do mapa) SAIU: nenhum padrão `?? 0`/`|| 0` de terminal sobrou e a linha sem terminal falha alto', () => {
    const fence = /\bterminal\s*=\s*0\b/
    expect([fence.test('terminal: Number(r.terminal ?? 0)'), fence.test('AND v.terminal = ${WEB_TERMINAL}')]).toEqual([false, false])
    const defaults = walk(SRC_ROOT).filter(f => /terminal\s*\?\?\s*0\b|terminal\s*\|\|\s*0\b/.test(stripComments(read(f)))).map(rel)
    expect(defaults).toEqual([])
    expect(outcome(() => mapCommonView(RAW({ terminal: undefined })).terminal)).toBe('lança')
  })
  it('[CORRIGIDO na sessão — D-NE70 (a)] [LOW NE1A-04] (latente — F5/NFC-e) linha SEM `terminal` (projeção à mão, coluna esquecida) vira, calada, a nota do TERMINAL DA WEB — a mesma classe que o mapa já recusa para `authority_recorded`; a D-NE12 põe o 0 só na BORDA', () => {
    for (const t of [undefined, null]) {
      expect([String(t), outcome(() => mapCommonView(RAW({ terminal: t })).terminal)]).not.toEqual([String(t), 0])
    }
  })
  it('resistiu: nenhum `terminal = 0` em SQL do núcleo, o `WEB_TERMINAL` só é DEFINIDO (nenhum uso no núcleo) e os leitores do ERP levam o terminal da referência até o SQL (5 → 5)', async () => {
    const files = walk(SRC_ROOT)
    expect(files.filter(f => /\bterminal\s*(?:=|<=>|IN\s*\()\s*'?0'?\b/i.test(stripComments(read(f)))).map(rel)).toEqual([])
    expect(files.filter(f => /\bWEB_TERMINAL\b/.test(stripComments(read(f)))).map(rel)).toEqual(['ref/invoice-ref.ts'])
    const calls: unknown[][] = []
    const q: any = { query: jest.fn(async (_sql: string, p: unknown[]) => { calls.push(p); return [[]] }) }
    expect(await orderInterface(q, 'setes_x', invoiceRef(1, 6200, 5))).toBe('orders')
    expect(calls).toEqual([[1, 6200, 5]])
  })
  it('contexto: `invoiceRef` não valida (por desenho — "a borda já conferiu"): NaN/negativo/string seguem crus até o parâmetro; `orderInterface` só confere o id da NOTA — terminal torto cai no padrão "orders" (sem linha), nunca num erro de terminal', async () => {
    expect(invoiceRefFilter(invoiceRef(Number.NaN, -1, '3' as any), 'v').params).toEqual([Number.NaN, -1, '3'])
    const q: any = { query: jest.fn(async () => [[]]) }
    expect(await orderInterface(q, 'setes_x', invoiceRef(1, 6200, 99))).toBe('orders')
    expect(await orderInterface(q, 'setes_x', invoiceRef(1, Number.NaN, 0))).toBe('orders')
    expect(q.query).toHaveBeenCalledTimes(1)                                                // o id torto nem chega ao SQL
    expect(Object.isFrozen(invoiceRef(1, 2, 3))).toBe(true)
  })
})

// ===========================================================================
// NE1A-05 — o SELECT da família interpola coluna/campo sem validar e deixa a família SOMBREAR a projeção comum
// ===========================================================================

describe('NE1A-05 — `familyViewSelect`: identificadores e integridade da projeção comum', () => {
  const withOwn = (ownColumns: readonly ViewColumn[]): VoiceFamilyReading<TransmissionView> =>
    ({ ...SERVICE_VOICE_READING, ownColumns }) as VoiceFamilyReading<TransmissionView>
  it('resistiu: banco, alias e nome da view fora do padrão são recusados (maiúscula, crase, espaço, quebra de linha, acento, vazio, número na frente, `;`)', () => {
    for (const a of ['V', 'v`', 'v v', 'v\n', 'vé', '', '1v', 'v;', 'v--', 'v)']) {
      expect([a, outcome(() => familyViewSelect(SERVICE_VOICE_READING, 'fiscal_api', a))]).toEqual([a, 'lança'])
      expect([a, outcome(() => invoiceRefFilter(invoiceRef(1, 1, 0), a))]).toEqual([a, 'lança'])
    }
    for (const db of ['Fiscal', 'fiscal-api', 'a`b', '', 'a b', 'a;b']) expect([db, outcome(() => familyViewSelect(SERVICE_VOICE_READING, db))]).toEqual([db, 'lança'])
    for (const v of ['vw_X', 'tb_x', 'vw_x;', 'vw_x v2', 'vw_', '`vw_x`']) {
      expect([v, outcome(() => familyViewSelect({ ...SERVICE_VOICE_READING, transmissionView: v } as any, 'fiscal_api'))]).toEqual([v, 'lança'])
    }
  })
  it('[CORRIGIDO na sessão] [LOW NE1A-05] a função validava banco, alias e view mas interpolava a COLUNA e o CAMPO da projeção sem conferir — uma leitura de família (dado do núcleo, mas montado à mão na NE-2) com identificador torto vira SQL arbitrário no SELECT que o setes-api roda', () => {
    for (const own of [
      [['x, (SELECT password FROM mysql.user LIMIT 1)', 'y']],
      [['dps_id', 'dpsId FROM dual; --']],
      [['dps id', 'dpsId']],
    ] as ViewColumn[][]) {
      expect([own[0][0], outcome(() => familyViewSelect(withOwn(own), 'fiscal_api'))]).toEqual([own[0][0], 'lança'])
    }
  })
  it('[CORRIGIDO na sessão] [LOW NE1A-05] a família podia REDECLARAR um campo da projeção comum (`[\'protocol\', \'authorityRecorded\']`): o SELECT sai com dois `AS authorityRecorded`, o driver monta o objeto na ordem das colunas (a ÚLTIMA vence) e o "mesmo nome, mesmo significado" da projeção comum quebra calado — a coluna da família substitui o FATO da D-NE56', () => {
    const shadow = withOwn([...SERVICE_VOICE_READING.ownColumns, ['protocol', 'authorityRecorded']])
    expect(outcome(() => familyViewSelect(shadow, 'fiscal_api'))).toBe('lança')
  })
  it('[CORRIGIDO na sessão] o sombreamento que passava (alias duplicado — a coluna da família vencia o FATO comum na linha montada) agora é recusado, por campo E por coluna', () => {
    expect(outcome(() => familyViewSelect(withOwn([['protocol', 'authorityRecorded']]), 'fiscal_api'))).toBe('lança')
    expect(outcome(() => familyViewSelect(withOwn([['authority_recorded', 'recorded']]), 'fiscal_api'))).toBe('lança')
    expect(outcome(() => familyViewSelect(withOwn([['protocol', 'protocol']]), 'fiscal_api'))).not.toBe('lança')
  })
  it('resistiu: o SELECT da NFS-e (`transmissionViewSelect`) é SUPERCONJUNTO do de antes da NE-1a — os 22 campos com o MESMO formato de instante + `authorityRecorded`', () => {
    const sql = transmissionViewSelect('fiscal_api')
    const plain = ['institutionId', 'invoiceId', 'terminal', 'attempt', 'lifeEvent', 'environment', 'serie', 'dpsNumber', 'dpsId', 'accessKey',
      'nfseNumber', 'lastEvent', 'lastKind', 'lastCode', 'lastMessage', 'lastSource', 'authorityRecorded']
    const instants: [string, string][] = [['dh_proc', 'dhProc'], ['last_queried_at', 'lastQueriedAt'], ['nfse_not_generated_at', 'nfseNotGeneratedAt'],
      ['created_at', 'createdAt'], ['last_dh', 'lastDh'], ['last_event_at', 'lastEventAt']]
    for (const f of plain) expect([f, new RegExp(`v\\.\\w+ AS ${f}\\b`).test(sql)]).toEqual([f, true])
    for (const [c, f] of instants) expect(sql).toContain(`DATE_FORMAT(v.${c}, '%Y-%m-%d %H:%i:%s') AS ${f}`)
    expect(sql.match(/ AS \w+/g)).toHaveLength(plain.length + instants.length)
    // nenhum campo duplicado entre a projeção comum e a da família de serviço (hoje)
    const fields = [...COMMON_TRANSMISSION_COLUMNS, ...SERVICE_VOICE_READING.ownColumns].map(([, f]) => f)
    expect(new Set(fields).size).toBe(fields.length)
  })
})

// ===========================================================================
// NE1A-06 — vocabulário e projeção comuns MUTÁVEIS em execução (classe do R22-02)
// ===========================================================================

describe('NE1A-06 — imutabilidade em execução do que o núcleo publica', () => {
  it('[CORRIGIDO na sessão] [LOW NE1A-06] objetos NOVOS da NE-1a: `KIND_CLASS` não era congelado (`as const` é só tipo) e as tuplas de `COMMON_TRANSMISSION_COLUMNS`/`ownColumns` têm congelamento RASO — um módulo do processo troca a coluna do SELECT que o setes-api roda (o `familyViewSelect` não valida coluna — NE1A-05)', () => {
    expect(Object.isFrozen(KIND_CLASS)).toBe(true)
    for (const k of Object.keys(KIND_CLASS) as TransmissionEventKind[]) expect([k, Object.isFrozen(KIND_CLASS[k])]).toEqual([k, true])
    for (const t of [...COMMON_TRANSMISSION_COLUMNS, ...SERVICE_VOICE_READING.ownColumns]) expect([t[0], Object.isFrozen(t)]).toEqual([t[0], true])
  })
  it('[CORRIGIDO na sessão — peça `util/readonly-set.ts`] [LOW NE1A-06] os conjuntos DERIVADOS (`FINAL_TRANSMISSION_KINDS`, `AUTHORIZED_KINDS`) e os códigos da família eram `Set` comuns (o `ReadonlySet` é só tipo): `.add` muda a classificação do processo inteiro — e a nfse-api INTERPOLA o `FINAL_TRANSMISSION_KINDS` no texto do SQL (`countLiveTransmissions`). Pré-existente nos Sets antigos; a NE-1a manteve a forma', () => {
    for (const s of [FINAL_TRANSMISSION_KINDS, AUTHORIZED_KINDS, HUMAN_EFFECT_CANCEL_CODES, CANCEL_EVENT_CODES]) {
      const set = s as Set<string>
      const probe = "Z') OR ('1'='1"
      let mutated = false
      try { set.add(probe); mutated = set.has(probe) } catch { mutated = false } finally { try { set.delete(probe) } catch { /* imutável */ } }
      expect(mutated).toBe(false)
    }
  })
  // parte 2 da NE-1a (D-NE9): a contagem das vivas saiu da nfse-api para o EMITTER do núcleo — o mesmo SQL montado com o conteúdo do Set
  it('contexto: o EMITTER do núcleo monta o SQL das vivas com o conteúdo do Set (`\'${k}\'`), sem placeholder', () => {
    const repo = path.join(WORKSPACE, 'fiscal-api', 'src', 'emitter', 'emitter.ts')
    expect(read(repo)).toMatch(/const finals = \[\.\.\.FINAL_TRANSMISSION_KINDS\]\.map\(k => `'\$\{k\}'`\)\.join\(','\)/)
    expect(Object.isFrozen(COMMON_TRANSMISSION_COLUMNS) && Object.isFrozen(SERVICE_VOICE_READING) && Object.isFrozen(VOICE_READINGS)).toBe(true)
  })
})

// ===========================================================================
// NE1A-07 — a cerca do Map/Set de controle (`contrato.test.ts`) só vê o genérico EXPLÍCITO
// ===========================================================================

describe('NE1A-07 — cercas existentes × a mudança', () => {
  const contrato = read(path.join(SRC_ROOT, '__tests__', 'contrato.test.ts'))
  const literal = /\/new (?:\(\?:Weak\)\?)?\(Map\|Set\)[^/\n]*\//.exec(contrato)?.[0] ?? ''
  const fence = new RegExp(literal.slice(1, -1))
  it('[CORRIGIDO na sessão] a cerca era `/new (Map|Set)\\s*</` (cega a `new Set(…)` sem genérico); agora pega as duas formas, com LISTA BRANCA nomeada dos detentores de DADO — o vocabulário e os códigos da família não usam mais `new Set` (vêm da peça do conjunto imutável)', () => {
    expect(literal).toBe('/new (?:Weak)?(Map|Set)\\s*[<(]/')                     // gates da parte 2 (D-NE81): também WeakMap/WeakSet
    const users = walk(SRC_ROOT).filter(f => /new (?:Map|Set)\s*[<(]/.test(stripComments(read(f)))).map(rel)
    expect(users).not.toEqual(expect.arrayContaining(['voice/kinds.ts']))
    expect(users).not.toEqual(expect.arrayContaining(['voice/families/service.ts']))
    expect(contrato).toContain("'util/readonly-set.ts'")
  })
  it('[CORRIGIDO na sessão] [LOW NE1A-07] (pré-existente — evidenciado pela NE-1a) um `Map`/`Set` de CONTROLE no nível do módulo sem genérico explícito (`const inflight = new Map()`) escapa da cerca da regra 3 do núcleo (nenhum Map/Set de controle em memória de processo)', () => {
    expect(fence.test('const inflight = new Map()')).toBe(true)
    expect(fence.test("const seen = new Set(['x'])")).toBe(true)
  })
  it('resistiu: a cerca do ERP (`tb_invoice*` fora de `src/erp/`) segue cega SÓ para a coluna de referência — `ref/invoice-ref.ts` e `families/` não citam tabela do ERP', () => {
    const ERP_TABLE = /\btb_(invoice|order|entity)(?!_id\b)\w*/
    expect(contrato).toContain(String(ERP_TABLE))
    for (const f of ['ref/invoice-ref.ts', 'voice/families/service.ts', 'voice/families/index.ts', 'voice/reading.ts', 'voice/kinds.ts']) {
      expect([f, ERP_TABLE.test(stripComments(read(path.join(SRC_ROOT, f))))]).toEqual([f, false])
    }
  })
})

// ===========================================================================
// RESISTIU — vocabulário, estado derivado, vigente
// ===========================================================================

describe('RESISTIU — D-NE14: classificação total × estado derivado × predicados', () => {
  it('resistiu: para CADA kind o estado derivado concorda com a classe — autorizado ⇔ "authorized"; vivo ⇔ estado de voo (in_flight/processing/cancel_in_flight); `isLive`/`isAuthorized` derivam da MESMA classe', () => {
    const live = new Set(['in_flight', 'processing', 'cancel_in_flight'])
    for (const k of Object.keys(KIND_CLASS) as TransmissionEventKind[]) {
      const st = fiscalStateOf({ lastKind: k })
      expect([k, st === 'authorized']).toEqual([k, KIND_CLASS[k].authorized])
      expect([k, live.has(st)]).toEqual([k, !KIND_CLASS[k].final])
      expect([k, isLiveTransmission({ lastKind: k }), isAuthorized({ lastKind: k })]).toEqual([k, !KIND_CLASS[k].final, KIND_CLASS[k].authorized])
    }
  })
  it('resistiu: kind FORA do vocabulário (gravado por fora do código — D-F103) falha FECHADO e de forma COERENTE nos três predicados — viva, não autorizada, "em voo" (inclusive chaves do protótipo e minúsculas)', () => {
    for (const k of ['a', 'n', 'p', 'd', 'AA', ' A', 'A ', '', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '0']) {
      expect([k, fiscalStateOf({ lastKind: k as any }), isLiveTransmission({ lastKind: k as any }), isAuthorized({ lastKind: k as any })])
        .toEqual([k, 'in_flight', true, false])
    }
  })
  it('resistiu: `currentOf` — invariante à ORDEM (todas as permutações), não muta a entrada, maior registrada vence, "registro sem chave" vence (NF-e com protocolo), "chave sem registro" não (NF-e: a chave é nossa), empate de tentativa', () => {
    const t = (attempt: number, authorityRecorded: boolean, accessKey: string | null = null) => ({ attempt, authorityRecorded, accessKey })
    const base = [t(1, false, 'K1'), t(2, true, null), t(3, false, 'K3'), t(4, false, 'K4')]
    const perms = (xs: typeof base): (typeof base)[] => xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p]))
    for (const p of perms(base)) {
      const before = JSON.stringify(p)
      expect(currentOf(p)?.attempt).toBe(2)
      expect(JSON.stringify(p)).toBe(before)
    }
    expect(currentOf([t(1, true), t(5, true), t(3, true)])?.attempt).toBe(5)
    expect(currentOf([t(1, false, 'K'), t(2, false, 'K')])?.attempt).toBe(2)            // NF-e: todas com a NOSSA chave, nenhuma registrada
    const tie = [t(7, false), { ...t(7, true), mark: 'rec' }]
    expect((currentOf(tie) as any)?.mark).toBe('rec')
    expect(currentOf([])).toBeNull()
  })
  it('[CORRIGIDO na sessão — D-NE71 (a)] `currentOf` recusa lista que mistura nota, estabelecimento, terminal ou vida; a FAMÍLIA não está na linha (projeção comum) — misturar famílias segue possível e é contrato da composição (uma leitura de `VOICE_READINGS` por vez)', () => {
    expect(outcome(() => currentOf([{ attempt: 1, authorityRecorded: false, invoiceId: 1 }, { attempt: 2, authorityRecorded: false, invoiceId: 2 }]))).toBe('lança')
    expect(outcome(() => currentOf([{ attempt: 1, authorityRecorded: false, lifeEvent: 1 }, { attempt: 2, authorityRecorded: false, lifeEvent: 3 }]))).toBe('lança')
    expect(outcome(() => currentOf([{ attempt: 1, authorityRecorded: false, terminal: 0 }, { attempt: 2, authorityRecorded: false }]))).toBe('lança')
    const service = [{ attempt: 1, authorityRecorded: true, invoiceId: 6200, family: 'service' }]
    const goods = [{ attempt: 3, authorityRecorded: true, invoiceId: 6200, family: 'merchandise' }]
    expect(currentOf([...service, ...goods])?.family).toBe('merchandise')                 // limite conhecido (D-NE71)
  })
})

// ===========================================================================
// RESISTIU — a biblioteca: nomes, catálogo, referência
// ===========================================================================

describe('RESISTIU — índice da biblioteca (D-F33: o setes-api só importa o núcleo)', () => {
  it('resistiu: nenhum nome de VALOR é exportado por dois módulos re-exportados (kinds · reading · families/service · families · ref) — sem ambiguidade no `export *`', () => {
    const mods: [string, Record<string, unknown>][] = [['kinds', kindsMod], ['reading', readingMod], ['service', serviceMod], ['families', familiesMod], ['ref', refMod]]
    const owner = new Map<string, string[]>()
    for (const [name, m] of mods) for (const k of Object.keys(m)) owner.set(k, [...(owner.get(k) ?? []), name])
    expect([...owner].filter(([, o]) => o.length > 1)).toEqual([])
    for (const [k] of owner) expect([k, k in core]).toEqual([k, true])
  })
  it('resistiu: os nomes PÚBLICOS de antes da NE-1a seguem no índice (a mudança de arquivo não quebra a nfse-api nem a F2a) e o catálogo (serviço e, desde a FAMILIA.E5.P3, mercadoria) é imutável', () => {
    const before = ['currentOf', 'fiscalStateOf', 'inLife', 'isLiveTransmission', 'isAuthorized', 'localCancelPending', 'isSubstitutionCancel',
      'isHumanEffectCancel', 'reconfirmationCandidate', 'reconfirmationProven', 'transmissionViewSelect', 'mapTransmissionView',
      'FINAL_TRANSMISSION_KINDS', 'AUTHORIZED_KINDS', 'CANCEL_EVENT_CODES', 'SUBSTITUTION_CANCEL_CODE', 'EX_OFFICIO_CANCEL_CODE', 'HUMAN_EFFECT_CANCEL_CODES']
    expect(before.filter(k => !(k in core))).toEqual([])
    expect(Object.keys(VOICE_READINGS)).toEqual(['service', 'merchandise'])
    expect(() => { (VOICE_READINGS as any).merchandise = SERVICE_VOICE_READING }).toThrow(TypeError)
    expect(() => { (VOICE_READINGS as any).other = SERVICE_VOICE_READING }).toThrow(TypeError)
    expect(() => { (SERVICE_VOICE_READING as any).transmissionView = 'vw_x' }).toThrow(TypeError)
  })
  it('resistiu: `familyViewQuery` — a nota pela referência INTEIRA (terminal como parâmetro, nunca literal) e ordenada pela tentativa, para qualquer terminal', () => {
    for (const term of [0, 1, 7, 99]) {
      const q = familyViewQuery(SERVICE_VOICE_READING, 'fiscal_api', invoiceRef(3, 6200, term), 'w')
      expect(q.params).toEqual([3, 6200, term])
      expect(q.sql).toMatch(/FROM `fiscal_api`\.vw_invoice_service_transmission w WHERE w\.tb_institution_id = \? AND w\.tb_invoice_id = \? AND w\.terminal = \? ORDER BY w\.attempt$/)
      expect(q.sql).not.toMatch(/terminal\s*=\s*\d/)
    }
  })
})
