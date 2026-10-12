/// <reference types="jest" />
// GATE ADVERSARIAL — DELTA da etapa A1 da F2a (Rodada 1 da F2a, Valdo 2026-10-12 — `Infra-IA/prompts/prompt_apis_fiscais_isoladas.md` §22;
// D-F109 veredito com motivo · D-NE66 (b) leitor que já mapeia · D-NE84/D-F107 sonda do CHECK binário). NÚCLEO, PURO: sem banco, sem fisco
// (o que pede banco está no gate da nfse-api, atrás de NFSE_ADV_LIVE=1). Revisor: o gate (não fez a entrega).
//
// Achados (`it.failing` = afirma o que a spec promete e FALHA no código do delta):
//  - [MEDIUM F2A1-01] `reconfirmationVerdict` aceita lista que MISTURA vidas (ou notas) e responde `nao-exigida` (FALHA ABERTO): o registro
//    de uma vida ANTERIOR (ex.: NFS-e AUTORIZADA em HOMOLOGAÇÃO — registro em qualquer ambiente, D-NE56 — cancelada localmente e a nota
//    refaturada: nova vida) mascara o F por consulta em PRODUÇÃO sem E2404 da vida vigente. O leitor novo (`readFamilyTransmissions`)
//    devolve TODAS as vidas por contrato; o `currentOf` recusa a mistura (D-NE71), o veredito não.
//  - [LOW F2A1-02] `irma-viva` SEM tentativa viva e COM candidata: irmã da mesma identidade com voz FINAL e sem o instante da voz
//    (`created_at` da voz é `DATETIME DEFAULT NULL` na 001 da nfse-api) — a regra devolve a barreira de "transmissão em andamento" que o
//    contrato reserva a `isLiveTransmission` (e diz candidata nula); na nfse-api isso vira 500 (gate de lá).
//  - [LOW F2A1-03] `reconfirmationProven` NÃO é `verdict === 'provada'` (texto da D-F109): com tentativa VIVA de outra identidade (outro
//    ambiente) o booleano diz `true` e o veredito `irma-viva` — duas respostas públicas para a mesma pergunta; o booleano pula a barreira.
//  - [LOW F2A1-04] a superfície `fiscal-api/reading` segue entregando o SELECT CRU da view (`familyViewSelect`/`transmissionViewSelect`) —
//    o consumidor monta o próprio WHERE (o que a D-NE12/M3 proibiu) e recebe a linha crua ('S'/'N'); o comentário do `view-query.ts` diz
//    que "o par SELECT + linha crua deixou de ser o caminho PÚBLICO".
//  - [LOW F2A1-05] `assertCheckRefuses` aceita como prova a violação de QUALQUER CHECK (4025/3819), não a do CHECK do domínio sondado: uma
//    sonda recusada por outro CHECK (as linhas da sonda usam institution 0 / tentativa 0 — sentinelas que um CHECK futuro recusaria) passa
//    vazia, sem provar o domínio.
// Resistiu: ver os `it('resistiu: …')`. Contexto (fundamenta questões): `it('contexto: …')`.
//
// CONVERSÃO (2026-10-12, mesma sessão — Valdo: Q-F124 "tirar da superfície", Q-F125 "leitor pela vida", Q-F131/Q-F130/Q-F132/Q-F133
// pelas recomendações → D-F118…D-F123): F2A1-01/01b [CORRIGIDO — D-F119] · F2A1-02 [CORRIGIDO na sessão] · F2A1-03 [DECIDIDO — D-F118] ·
// F2A1-04 [CORRIGIDO na sessão] · F2A1-05 [CORRIGIDO na sessão] · contextos Q-F130/Q-F131 [DECIDIDO — D-F121/D-F120].
// Uso: npx jest src/__tests__/adversarial-f2a-a1-gate.test.ts
import { format as sqlFormat } from 'mysql2'
import * as readingSurface from '../reading'
import * as barrel from '../index'
import {
  ReconfirmReason, ServiceTransmissionView, SERVICE_VOICE_READING, mapTransmissionView, reconfirmationCandidate, reconfirmationProven, reconfirmationVerdict,
} from '../voice/families/service'
import { ReadQueryable, readFamilyTransmissions, readFamilyTransmissionsMany } from '../voice/family-reader'
import fs from 'fs'
import path from 'path'
import {
  VoiceFamilyReading, blocksNewAttempt, currentOf, fiscalStateOf, inLife, isFiscalRecord, isLiveTransmission, TransmissionView,
} from '../voice/reading'
import { invoiceRef, WEB_TERMINAL } from '../ref/invoice-ref'
import { assertCheckRefuses, CheckProbe } from '../db/check'

const DPS = 'DPS410690221234567800019900001000000000000042'
const KEY = '4'.repeat(50)
/** Linha da vida já MAPEADA (forma de `ServiceTransmissionView` — a que `readFamilyTransmissions` entrega). */
const row = (over: Partial<ServiceTransmissionView> = {}): ServiceTransmissionView => ({
  institutionId: 1, invoiceId: 8011, terminal: 0, attempt: 1, lifeEvent: 9, environment: 'P', accessKey: null, authorityRecorded: false,
  lastQueriedAt: null, createdAt: '2026-10-01 10:00:00', lastEvent: 1, lastKind: 'F', lastCode: null, lastMessage: null, lastSource: 'Q',
  lastDh: null, lastEventAt: '2026-10-01 10:05:00', serie: '1', dpsNumber: 42, dpsId: DPS, nfseNumber: null, dhProc: null,
  nfseNotGeneratedAt: null, ...over,
})
/** A linha CRUA do driver para o SELECT da view (o registro em 'S'/'N'). */
const RAW = (over: Record<string, unknown> = {}) => ({
  institutionId: 1, invoiceId: 8011, terminal: 0, attempt: 1, lifeEvent: 9, environment: 'P', accessKey: null, authorityRecorded: 'N',
  lastQueriedAt: null, createdAt: '2026-10-01 10:00:00', lastEvent: 1, lastKind: 'F', lastCode: null, lastMessage: null,
  lastSource: 'Q', lastDh: null, lastEventAt: '2026-10-01 10:05:00', serie: '1', dpsNumber: '42', dpsId: DPS, nfseNumber: null, dhProc: null,
  nfseNotGeneratedAt: null, ...over,
})
const driver = (rows: unknown) => {
  const calls: { sql: string; params: unknown }[] = []
  const q: ReadQueryable = { query: async (sql: string, params?: unknown) => { calls.push({ sql, params }); return [rows, []] } }
  return { q, calls }
}
const REF = invoiceRef(1, 8011, WEB_TERMINAL)
const reasonOrRefusal = (life: readonly ServiceTransmissionView[]): ReconfirmReason | 'recusou' => {
  try { return reconfirmationVerdict(life).reason } catch { return 'recusou' }
}

// ---------------------------------------------------------------------------
// F2A1-01 — vidas misturadas
// ---------------------------------------------------------------------------
/**
 * Cenário REAL da Setes (a origem tem 14 tentativas em H e 6 em P): a nota foi autorizada em HOMOLOGAÇÃO (registro pelo fisco em
 * qualquer ambiente — D-NE56), cancelada LOCALMENTE (homologação não prende — Q-CA5b: soft-delete + revive = nova vida) e refaturada; na
 * vida nova a transmissão em PRODUÇÃO caiu e fechou com F por consulta (D-F51) — sem E2404 posterior: a D-F29 EXIGE a reconferência.
 */
const OLD_LIFE_H_AUTHORIZED = RAW({ attempt: 1, lifeEvent: 3, environment: 'H', accessKey: KEY, authorityRecorded: 'S', lastKind: 'A', lastSource: 'P',
  createdAt: '2026-09-20 10:00:00', lastEventAt: '2026-09-20 10:00:05' })
const NEW_LIFE_P_F = RAW({ attempt: 2, lifeEvent: 9, environment: 'P', lastKind: 'F', lastSource: 'Q' })

describe('[F2A1-01] reconfirmationVerdict × lista que mistura vidas (o leitor novo devolve TODAS as vidas)', () => {
  it('[CORRIGIDO — D-F119 + correção de sessão] [MEDIUM F2A1-01] a vida ANTERIOR registrada (H autorizada, cancelada local, nota refaturada) NÃO pode tornar `nao-exigida` a reconferência da vida vigente — o leitor só entrega a vida PEDIDA (linha de outra vida = falha alta) e o veredito RECUSA a mistura (como o `currentOf`, D-NE71)', async () => {
    // o leitor pela vida: uma linha de outra vida vinda do driver (filtro perdido, view torta) derruba a leitura
    await expect(readFamilyTransmissions(driver([OLD_LIFE_H_AUTHORIZED, NEW_LIFE_P_F]).q, SERVICE_VOICE_READING, 'fiscal_api', REF, 9)).rejects.toThrow(/não foi pedida/)
    const vigente = await readFamilyTransmissions(driver([NEW_LIFE_P_F]).q, SERVICE_VOICE_READING, 'fiscal_api', REF, 9)
    expect(reconfirmationVerdict(vigente).reason).toBe('sem-e2404')             // a resposta certa, com a vida vigente
    // a lista mista montada à mão (sem o leitor): o veredito RECUSA — nunca "nada a reconferir" porque a vida de ANTES teve registro
    const all = [OLD_LIFE_H_AUTHORIZED, NEW_LIFE_P_F].map(mapTransmissionView)
    expect(() => currentOf(all)).toThrow(/mistura lifeEvent/)
    expect(() => reconfirmationVerdict(all)).toThrow(/reconfirmationVerdict: lista mistura lifeEvent/)
    expect(reasonOrRefusal(all)).toBe('recusou')
  })
  it('[CORRIGIDO — D-F119 + correção de sessão] [MEDIUM F2A1-01b] idem com NOTAS misturadas (o lote do selo — `readFamilyTransmissionsMany`, por pares nota × vida — passado inteiro): o veredito RECUSA; por nota, a resposta certa', async () => {
    const lot = await readFamilyTransmissionsMany(driver([
      RAW({ invoiceId: 8010, attempt: 1, accessKey: KEY, authorityRecorded: 'S', lastKind: 'A', lastSource: 'P' }),
      RAW({ invoiceId: 8011, attempt: 1 }),
    ]).q, SERVICE_VOICE_READING, 'fiscal_api', { institutionId: 1, terminal: 0 }, [{ invoiceId: 8010, lifeEvent: 9 }, { invoiceId: 8011, lifeEvent: 9 }])
    expect(reconfirmationVerdict(lot.filter(t => t.invoiceId === 8011)).reason).toBe('sem-e2404')
    expect(reasonOrRefusal(lot)).toBe('recusou')
  })
})

// ---------------------------------------------------------------------------
// F2A1-02 — irma-viva sem tentativa viva
// ---------------------------------------------------------------------------
describe('[F2A1-02] `irma-viva` é a barreira de tentativa VIVA (`isLiveTransmission`) e a candidata é nula nela', () => {
  // a irmã R (rejeitada direto — FINAL) da MESMA identidade, gravada sem `created_at` (coluna `DEFAULT NULL` na 001 da nfse-api; SQL por
  // fora / cópia futura): a view entrega `last_event_at` NULL com `last_kind` 'R'
  const life = [
    row({ attempt: 1, lastKind: 'R', lastSource: 'P', lastEventAt: null }),
    row({ attempt: 2, createdAt: '2026-10-01 10:10:00', lastEventAt: '2026-10-01 10:15:00', nfseNotGeneratedAt: '2026-10-01 11:00:00' }),
  ]
  it('contexto: nenhuma tentativa da vida está VIVA (R e F são finais) e a candidata existe (a F por consulta em P)', () => {
    expect(life.some(t => isLiveTransmission(t))).toBe(false)
    expect(reconfirmationCandidate(life)?.attempt).toBe(2)
  })
  it('[CORRIGIDO na sessão] [LOW F2A1-02] o veredito NÃO diz `irma-viva` sem tentativa viva e, quando diz, a candidata é nula (contrato do `ReconfirmVerdict`) — irmã FINAL sem o instante da voz é projeção incompleta (`instante-invalido`)', () => {
    const v = reconfirmationVerdict(life)
    expect(v.reason === 'irma-viva' && !life.some(t => isLiveTransmission(t))).toBe(false)
    expect(v.reason === 'irma-viva' && v.candidate !== null).toBe(false)
  })
  it('contexto: a mesma vida em OUTRA ordem com uma irmã sem Id do DPS muda o motivo (`sem-identidade` × `instante-invalido`) — entre projeções INCOMPLETAS o motivo depende da ordem; as duas falham FECHADO (nenhuma é `irma-viva` sem tentativa viva)', () => {
    const noId = row({ attempt: 3, dpsId: null, lastKind: 'R', lastSource: 'P', createdAt: '2026-10-01 09:00:00', lastEventAt: '2026-10-01 09:01:00' })
    const a = reconfirmationVerdict([life[0], noId, life[1]]).reason
    const b = reconfirmationVerdict([noId, life[0], life[1]]).reason
    expect([a, b]).toEqual(['instante-invalido', 'sem-identidade'])
  })
})

// ---------------------------------------------------------------------------
// F2A1-03 — o booleano e o veredito
// ---------------------------------------------------------------------------
describe('[F2A1-03] D-F109: "`reconfirmationProven` passa a ser `verdict === \'provada\'`"', () => {
  const PROVEN = row({ attempt: 1, nfseNotGeneratedAt: '2026-10-01 11:00:00' })
  // tentativa VIVA (reserva sem voz) em HOMOLOGAÇÃO na mesma vida — outra identidade (o Id é o mesmo; o ambiente não)
  const liveH = row({ attempt: 2, environment: 'H', lastKind: null, lastEvent: null, lastSource: null, lastEventAt: null, createdAt: '2026-10-01 12:00:00' })
  it('[DECIDIDO — D-F118 (= Q-F124, Valdo 2026-10-12: "tirar da superfície")] [LOW F2A1-03] o booleano segue a prova de UMA candidata (sem a barreira da vida — diverge do veredito com tentativa viva de outra identidade, como os gates R18–R21 o fixaram) e por isso NÃO sai pela superfície `fiscal-api/reading`: quem decide o cancelamento só enxerga o VEREDITO', () => {
    const life = [PROVEN, liveH]
    const cand = reconfirmationCandidate(life)!
    expect(reconfirmationVerdict(life).reason).toBe('irma-viva')
    expect(reconfirmationProven(cand, life)).toBe(true)                            // a prova de UMA candidata (a viva é de OUTRA identidade)
    expect(['reconfirmationProven' in readingSurface, 'reconfirmationProven' in barrel]).toEqual([false, true])
  })
  it('resistiu: com a candidata do seletor e SEM tentativa viva na vida, `provada` ⟺ `reconfirmationProven` (varredura abaixo)', () => {
    expect(reconfirmationProven(PROVEN, [PROVEN])).toBe(true)
    expect(reconfirmationVerdict([PROVEN]).reason).toBe('provada')
  })
})

// ---------------------------------------------------------------------------
// Varredura do veredito (vidas incoerentes) — o que RESISTIU
// ---------------------------------------------------------------------------
describe('resistiu: varredura do veredito — vidas incoerentes (kinds minúsculos/ausentes/P/D/S, ordem, instantes, identidade, ambiente)', () => {
  const KINDS: (string | null | undefined)[] = ['F', 'R', 'A', 'C', 'N', 'K', 'S', 'P', 'D', 'f', 'r', 'a', null, undefined]
  const INSTANTS: (string | null)[] = ['2026-10-01 10:00:00', '2026-10-01 10:05:00', '2026-10-01 11:00:00', '2026-10-01T11:00:00Z', null]
  const lives: ServiceTransmissionView[][] = []
  for (const k2 of KINDS) for (const e of INSTANTS) for (const c2 of INSTANTS) for (const env2 of ['P', 'H'] as const) for (const id2 of [DPS, 'DPSoutro', null]) {
    const final2 = k2 != null && /^[ARCNFD]$/.test(k2)
    const sib = row({ attempt: 2, lastKind: k2 as any, environment: env2, dpsId: id2, createdAt: c2, lastSource: k2 === 'F' ? 'Q' : 'P',
      // F2A1-02 fora da varredura: voz FINAL sempre com instante (o que o escritor real grava)
      lastEventAt: final2 ? '2026-10-01 10:30:00' : (k2 == null ? null : '2026-10-01 10:30:00'),
      ...((k2 === 'A' || k2 === 'N' || k2 === 'C') ? { accessKey: KEY, authorityRecorded: true } : {}) })
    lives.push([row({ nfseNotGeneratedAt: e }), sib])
  }
  it(`${lives.length} vidas: candidata nula ⟺ (irma-viva | nao-exigida); irma-viva ⟹ há tentativa viva; provada ⟹ booleano; sem viva: provada ⟺ booleano; ordem não muda o motivo`, () => {
    let provadas = 0
    for (const life of lives) {
      const v = reconfirmationVerdict(life)
      const live = life.some(t => isLiveTransmission(t))
      expect([life, v.candidate === null]).toEqual([life, v.reason === 'irma-viva' || v.reason === 'nao-exigida'])
      if (v.reason === 'irma-viva') expect([life, live]).toEqual([life, true])
      if (v.reason === 'provada') { provadas++; expect(reconfirmationProven(v.candidate!, life)).toBe(true) }
      const cand = reconfirmationCandidate(life)
      if (!live && cand) expect([life, v.reason === 'provada']).toEqual([life, reconfirmationProven(cand, life)])
      expect([life, reconfirmationVerdict([...life].reverse()).reason]).toEqual([life, v.reason])
      // kind minúsculo/ausente/S/P = viva → nunca prova (falha FECHADO)
      if (life.some(t => t.lastKind == null || !/^[ARCKFNDSP]$/.test(t.lastKind))) expect(v.reason).not.toBe('provada')
    }
    expect(provadas).toBeGreaterThan(10)
  })
  it('linha CRUA (registro \'S\'/\'N\' sem o mapa) nunca prova nem dispensa: sem viva o seletor LANÇA (D-NE66 (a)); com viva a barreira responde antes', () => {
    expect(() => reconfirmationVerdict([RAW() as any])).toThrow(/authorityRecorded fora do domínio boolean/)
    expect(reconfirmationVerdict([RAW({ lastKind: 'K' }) as any]).reason).toBe('irma-viva')
  })
  it('o veredito é imutável e a lista de entrada não é alterada', () => {
    const life = [row({ attempt: 2 }), row({ attempt: 1, lastKind: 'R', lastSource: 'P' })]
    const before = JSON.stringify(life)
    const v = reconfirmationVerdict(life)
    expect([Object.isFrozen(v), JSON.stringify(life)]).toEqual([true, before])
  })
})

// ---------------------------------------------------------------------------
// Leitor que já mapeia (D-NE66 (b)) — superfície
// ---------------------------------------------------------------------------
describe('readFamilyTransmissions(…Many) — entradas tortas', () => {
  it('resistiu: banco, view e colunas são conferidos ANTES de perguntar ao driver (nenhuma query sai)', async () => {
    for (const db of ['fiscal_api`; DROP DATABASE x; --', 'Fiscal', '', 'a.b']) {
      const d = driver([])
      await expect(readFamilyTransmissions(d.q, SERVICE_VOICE_READING, db, REF, 9)).rejects.toThrow(/Banco fiscal inválido/)
      expect(d.calls).toHaveLength(0)
    }
    const forged = { ...SERVICE_VOICE_READING, transmissionView: 'vw_x v; DELETE FROM t' } as VoiceFamilyReading<TransmissionView>
    await expect(readFamilyTransmissions(driver([]).q, forged, 'fiscal_api', REF, 9)).rejects.toThrow(/View de tentativas inválida/)
  })
  it('resistiu [D-F119 — mais estrito]: o lote é de PARES nota × vida conferidos ANTES do driver — negativo, fração, texto ou NaN recusados (nenhuma query sai); duplicados passam como literais', async () => {
    for (const bad of [-1, 1.5, '1) OR (1=1' as any, NaN, 0]) {
      const d = driver([])
      await expect(readFamilyTransmissionsMany(d.q, SERVICE_VOICE_READING, 'fiscal_api', { institutionId: 1, terminal: 0 }, [{ invoiceId: bad, lifeEvent: 9 }])).rejects.toThrow(/inválido/)
      await expect(readFamilyTransmissionsMany(d.q, SERVICE_VOICE_READING, 'fiscal_api', { institutionId: 1, terminal: 0 }, [{ invoiceId: 8011, lifeEvent: bad }])).rejects.toThrow(/inválido/)
      expect(d.calls).toHaveLength(0)
    }
    const d = driver([])
    await readFamilyTransmissionsMany(d.q, SERVICE_VOICE_READING, 'fiscal_api', { institutionId: 1, terminal: 0 }, [{ invoiceId: 8011, lifeEvent: 9 }, { invoiceId: 8011, lifeEvent: 9 }])
    expect(sqlFormat(d.calls[0].sql, d.calls[0].params as any[])).toMatch(/\(v\.tb_invoice_id, v\.life_event\) IN \(\(8011, 9\), \(8011, 9\)\)/)
  })
  it('resistiu: o mapa da família que LANÇA (linha torta) derruba a leitura inteira — nunca devolve parte das linhas', async () => {
    const rows = [RAW(), RAW({ attempt: 2, environment: 'p' })]
    await expect(readFamilyTransmissions(driver(rows).q, SERVICE_VOICE_READING, 'fiscal_api', REF, 9)).rejects.toThrow(/sem environment/)
    await expect(readFamilyTransmissions(driver([RAW(), null]).q, SERVICE_VOICE_READING, 'fiscal_api', REF, 9)).rejects.toThrow()
  })
  it('[CORRIGIDO na sessão] (era o contexto: o escopo do lote não era conferido — terminal ausente virava `terminal = NULL` e o lote voltava VAZIO, calado) — estabelecimento e terminal do lote são conferidos antes do driver', async () => {
    const d = driver([])
    await expect(readFamilyTransmissionsMany(d.q, SERVICE_VOICE_READING, 'fiscal_api', { institutionId: 1 } as any, [{ invoiceId: 8011, lifeEvent: 9 }])).rejects.toThrow(/Terminal do lote inválido/)
    await expect(readFamilyTransmissionsMany(d.q, SERVICE_VOICE_READING, 'fiscal_api', { terminal: 0 } as any, [{ invoiceId: 8011, lifeEvent: 9 }])).rejects.toThrow(/Estabelecimento do lote inválido/)
    expect(d.calls).toHaveLength(0)
  })
  it('[DECIDIDO — D-F121 (= Q-F130 (a))] contexto: o leitor NÃO trava — o SELECT não tem FOR UPDATE/LOCK IN SHARE MODE nem opção para isso: sob REPEATABLE READ ele lê o SNAPSHOT da transação de quem chama (tirado na 1ª leitura consistente dela, que pode ser ANTES da trava da nota)', async () => {
    const d = driver([])
    await readFamilyTransmissions(d.q, SERVICE_VOICE_READING, 'fiscal_api', REF, 9)
    expect(d.calls[0].sql).not.toMatch(/FOR UPDATE|LOCK IN SHARE MODE|FOR SHARE/i)
    expect(readFamilyTransmissions.length).toBe(5)                               // (q, reading, db, ref, vida) — sem opção de trava (D-F121: a
    // REGRA é do plano — o FOR UPDATE da nota é o 1º comando da transação; cerca na A3)
  })
  it('[DECIDIDO — D-F120 (= Q-F131 (a))] contexto: o seletor da candidata decide por `lastSource === \'Q\'` e `environment === \'P\'` EXATOS — `source` e `environment` seguem CHAR(1) _ci sem CHECK (a 005 fecha só `kind`): \'q\' (o SQL do rodízio lê como Q) some do seletor → `nao-exigida`; \'p\' derruba o mapa da view (500 no leitor da F2a)', async () => {
    expect(reconfirmationVerdict([row({ lastSource: 'q' as any })]).reason).toBe('nao-exigida')
    expect(reconfirmationVerdict([row({ lastSource: 'Q' })]).reason).toBe('sem-e2404')
    await expect(readFamilyTransmissions(driver([RAW({ environment: 'p' })]).q, SERVICE_VOICE_READING, 'fiscal_api', REF, 9)).rejects.toThrow(/sem environment/)
    // D-F120: o código segue exato; quem fecha é o BANCO — a 005 da nfse-api põe CHECK binário em `source` (P/Q) e `environment` (H/P)
    const m005 = path.resolve(__dirname, '..', '..', '..', 'nfse-api', 'src', 'migrations', 'sql', '005_service_transmission_domains.sql')
    if (fs.existsSync(m005)) {
      const sql = fs.readFileSync(m005, 'utf8')
      expect(sql).toMatch(/CHECK \(`source` COLLATE utf8mb4_bin IN \('P', 'Q'\)\)/)
      expect(sql).toMatch(/CHECK \(`environment` COLLATE utf8mb4_bin IN \('H', 'P'\)\)/)
    }
  })
})

describe('[F2A1-04] a superfície `fiscal-api/reading` e a linha crua', () => {
  it('[CORRIGIDO na sessão] [LOW F2A1-04] a superfície de leitura NÃO entrega construtor do SELECT CRU da view (o caminho público é o leitor que já mapeia — D-NE66 (b); o WHERE próprio do consumidor é o que a D-NE12/M3 proibiu)', () => {
    expect(['familyViewSelect', 'transmissionViewSelect'].filter(n => n in readingSurface)).toEqual([])
  })
  it('contexto: o SELECT cru segue no BARREL (famílias e testes — fora da superfície desde a correção F2A1-04) e, com um WHERE próprio, devolve a linha crua — os predicados que DECIDEM registro lançam com \'S\'/\'N\' (D-NE66 (a) segura); os que não leem o registro aceitam a linha crua calados', () => {
    const sel = (barrel as any).transmissionViewSelect('fiscal_api')
    expect(sel).toMatch(/^SELECT .* FROM `fiscal_api`\.vw_invoice_service_transmission v$/s)
    const raw = RAW({ accessKey: KEY, authorityRecorded: 'S', lastKind: 'A', lastSource: 'P' }) as any
    for (const f of [() => currentOf([raw]), () => isFiscalRecord(raw), () => blocksNewAttempt(raw), () => reconfirmationCandidate([raw])]) expect(f).toThrow(/fora do domínio boolean/)
    expect([isLiveTransmission(raw), fiscalStateOf(raw)]).toEqual([false, 'authorized'])
  })
  it('resistiu: o SQL cru com WHERE (`familyViewQuery/Many`) não está na superfície nem no barrel; o leitor e o veredito estão nos dois', () => {
    for (const n of ['familyViewQuery', 'familyViewQueryMany', 'familyViewQueryLives']) expect([n, n in readingSurface, n in barrel]).toEqual([n, false, false])
    for (const n of ['readFamilyTransmissions', 'readFamilyTransmissionsMany', 'reconfirmationVerdict']) expect([n, n in readingSurface, n in barrel]).toEqual([n, true, true])
  })
})

// ---------------------------------------------------------------------------
// assertCheckRefuses — sessão, conexão e o MOTIVO da recusa
// ---------------------------------------------------------------------------
const checkErr = (name: string) => Object.assign(new Error(`CONSTRAINT \`${name}\` failed for \`fiscal_api\`.\`t\``), { errno: 4025, code: 'ER_CONSTRAINT_FAILED' })
function poolWith(onQuery: (sql: string, params?: unknown[]) => Promise<any>, conn: Record<string, any> = {}) {
  const c = { beginTransaction: jest.fn(), rollback: jest.fn(), release: jest.fn(), destroy: jest.fn(), query: jest.fn(onQuery), ...conn }
  return { conn: c, pool: { getConnection: jest.fn(async () => c) } as any }
}
const P = (value: string): CheckProbe => ({ value, constraint: 'ck_x', sql: 'INSERT INTO t (k) VALUES (?)', params: [value] })

describe('[F2A1-05] assertCheckRefuses — a recusa tem de ser do CHECK do DOMÍNIO', () => {
  it('[CORRIGIDO na sessão] [LOW F2A1-05] sondas recusadas por OUTRO CHECK (ex.: um CHECK futuro `tb_institution_id > 0` ou o do código do cancelamento) NÃO provam o domínio — o boot não pode passar', async () => {
    const { pool } = poolWith(async sql => { if (/^INSERT/.test(sql)) throw checkErr('ck_t_institution_positive'); return [{}] })
    await expect(assertCheckRefuses(pool, 'o kind', [P('S'), P('f')])).rejects.toThrow()
  })
  it('resistiu: sonda com erro que NÃO é CHECK no meio (FK desligada) → o erro sobe COMO ESTÁ, a sessão é RESTAURADA (foreign_key_checks = 1), a transação desfeita e a conexão volta ao pool', async () => {
    const e = Object.assign(new Error('Table doesn\'t exist'), { errno: 1146, code: 'ER_NO_SUCH_TABLE' })
    const { conn, pool } = poolWith(async (sql, p) => { if (/^INSERT/.test(sql) && p?.[0] === 'f') throw e; if (/^INSERT/.test(sql)) throw checkErr('ck_x'); return [{}] })
    await expect(assertCheckRefuses(pool, 'x', [P('S'), P('f')], { withoutForeignKeys: true })).rejects.toBe(e)
    expect(conn.query.mock.calls.map(c => c[0]).slice(-1)).toEqual(['SET SESSION foreign_key_checks = 1'])
    expect([conn.rollback.mock.calls.length, conn.release.mock.calls.length, conn.destroy.mock.calls.length]).toEqual([1, 1, 0])
  })
  it('resistiu: BEGIN que falha → nada de sessão alterada; a conexão é devolvida e o erro sobe', async () => {
    const e = new Error('Lost connection')
    const { conn, pool } = poolWith(async () => [{}], { beginTransaction: jest.fn(async () => { throw e }) })
    await expect(assertCheckRefuses(pool, 'x', [P('S')], { withoutForeignKeys: true })).rejects.toBe(e)
    expect(conn.query).not.toHaveBeenCalled()
    expect(conn.release).toHaveBeenCalledTimes(1)
  })
  it('[CORRIGIDO na sessão — socrático 4] ROLLBACK que falha (rede OU conexão viva) → a conexão é DESTRUÍDA, nunca devolvida ao pool (com a conexão viva, o próximo BEGIN comitaria a sonda)', async () => {
    const { conn, pool } = poolWith(async sql => { if (/^INSERT/.test(sql)) throw checkErr('ck_x'); return [{}] }, { rollback: jest.fn(async () => { throw new Error('ECONNRESET') }) })
    await expect(assertCheckRefuses(pool, 'x', [P('ZZ'), P('se')])).resolves.toBeUndefined()
    expect([conn.release.mock.calls.length, conn.destroy.mock.calls.length]).toEqual([0, 1])
  })
  it('resistiu: duas sondas concorrentes (duas instâncias no boot — D-F9) usam conexões próprias e não compartilham estado', async () => {
    const a = poolWith(async sql => { if (/^INSERT/.test(sql)) throw checkErr('ck_x'); return [{}] })
    const b = poolWith(async () => [{ affectedRows: 1 }])
    const [ra, rb] = await Promise.allSettled([assertCheckRefuses(a.pool, 'x', [P('S'), P('f')]), assertCheckRefuses(b.pool, 'x', [P('S'), P('f')])])
    expect([ra.status, rb.status]).toEqual(['fulfilled', 'rejected'])
  })
})
