/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 19 das APIs fiscais (D-F98…D-F99, Valdo 2026-10-11) — NÚCLEO fiscal-api.
// Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
// Alvo do delta no núcleo:
//  - D-F98 (= Q-F104 (b)+(c)): `src/errors/ambiguous-cause.ts` (novo) — a causa do ambíguo (502 FISCAL_AUTHORITY_UNKNOWN_RESPONSE)
//    é de uma lista FECHADA (`AMBIGUOUS_CAUSES`), marcada num Symbol por `tagAmbiguous` e lida por `ambiguousCauseOf` (fora da lista =
//    `nao-classificada`); o transporte (`src/transport/https-json.ts`) marca o 405/406/415 como `rota-nao-atendida`.
//  - D-F99 (= Q-F105 (b)): `reconfirmationProven(candidata, vida)` (`src/voice/reading.ts`) falha FECHADO se houver na vida tentativa da
//    MESMA identidade (Id do DPS + ambiente) SEM VOZ (`lastEventAt` nulo). Ainda sem chamador de produção — o consumidor é a F2a; o que
//    se ataca é o CONTRATO.
//
//  * ACHADOS (`it.failing('[SEV R19-xx] …')`) — o teste afirma o que a spec/decisão promete e FALHA no código atual: é a prova do bug.
//    O corretor troca `it.failing` por `it` depois de corrigir (ou de decidida a questão). NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (ficam como regressão).
//  * CONTEXTO (`it('contexto …')`) — fixa o comportamento atual que fundamenta um achado ou uma QUESTÃO (decisão do Valdo) e prova que
//    o cenário do `it.failing` vizinho monta de verdade (o `it.failing` só afirma a última coisa).
//
// REGRAS DO GATE: puro (sem banco, sem socket — `transport.request` trocado —, sem fisco). Lê o espelho do setes-api só como TEXTO.
import fs from 'fs'
import path from 'path'
import {
  reconfirmationCandidate, reconfirmationProven, transmissionViewSelect, mapTransmissionView, isLiveTransmission,
} from '../voice/reading'
import { AMBIGUOUS_CAUSES, tagAmbiguous, ambiguousCauseOf } from '../errors/ambiguous-cause'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'
import { authorityJson, transport, HttpsCall } from '../transport/https-json'
import { logger } from '../log/logger'

/** Linha da view como o `mapTransmissionView` a entrega (instantes 'YYYY-MM-DD HH:MM:SS' UTC — DATE_FORMAT do leitor). */
const row = (over: any = {}) => mapTransmissionView({
  institutionId: 1, invoiceId: 6200, terminal: 0, attempt: 1, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 42, dpsId: 'DPS1',
  accessKey: null, nfseNumber: null, dhProc: null, lastQueriedAt: null, nfseNotGeneratedAt: null, createdAt: '2026-10-01 09:59:00',
  lastEvent: 2, lastKind: 'F', lastSource: 'Q', lastCode: null, lastMessage: null, lastDh: null, lastEventAt: '2026-10-01 10:00:00', ...over,
})
/** Candidata: F por consulta em P (tentativa 1) com E2404 em 02/10 (posterior ao F de 01/10). */
const cand = (over: any = {}) => row({ nfseNotGeneratedAt: '2026-10-02 10:00:00', ...over })
/** Tentativa 2 da MESMA vida reservada em 03/10 e ainda EM VOO (sem voz). */
const emVoo = (over: any = {}) => row({ attempt: 2, createdAt: '2026-10-03 10:00:00', lastEvent: null, lastKind: null, lastSource: null, lastEventAt: null, ...over })
/** Tentativa 2 da MESMA vida reservada em 03/10 e RECUSADA às 10:00:05 (voz R da resposta direta). */
const reapresentada = (over: any = {}) => row({ attempt: 2, createdAt: '2026-10-03 10:00:00', lastEvent: 1, lastKind: 'R', lastSource: 'P', lastEventAt: '2026-10-03 10:00:05', ...over })

// o log do núcleo é silenciado e CAPTURADO em todo teste (o transporte loga por ele)
beforeEach(() => {
  jest.spyOn(logger, 'info').mockImplementation(() => undefined)
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined)
  jest.spyOn(logger, 'error').mockImplementation(() => undefined)
})
afterEach(() => jest.restoreAllMocks())

const SRC_ROOT = path.resolve(__dirname, '..')
const WORKSPACE = path.resolve(SRC_ROOT, '..', '..')

// ===========================================================================
// Cerca estática (molde do r18 da nfse-api): todo PRODUTOR do ambíguo é marcado com causa da lista
// ===========================================================================
const walkTs = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? (d.name === '__tests__' || d.name === 'node_modules' ? [] : walkTs(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []))
const uncomment = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
type Site = { file: string; kind: 'definicao' | 'comparacao' | 'conjunto' | 'produtor' | 'DESCONHECIDO'; tagged?: boolean; cause?: string | null }
/**
 * Cada ocorrência de `FISCAL_AUTHORITY_UNKNOWN_RESPONSE` no código (sem comentários): definição do catálogo, comparação (`===`/`!==`),
 * membro de conjunto, ou PRODUTOR (`new HttpError(`/`new AuthorityHttpError(` que leva o código) — e, no produtor, se a construção está
 * DENTRO de `tagAmbiguous(…, causa)` e qual causa. Qualquer outra forma (Object.assign, literal de objeto…) = DESCONHECIDO.
 */
function ambiguousSites(roots: string[], base: string): Site[] {
  const out: Site[] = []
  for (const f of roots.flatMap(walkTs)) {
    const code = uncomment(fs.readFileSync(f, 'utf8'))
    const rel = path.relative(base, f).replace(/\\/g, '/')
    const re = /FISCAL_AUTHORITY_UNKNOWN_RESPONSE/g
    let m: RegExpExecArray | null
    while ((m = re.exec(code))) {
      const lineStart = code.lastIndexOf('\n', m.index) + 1
      const line = code.slice(lineStart, code.indexOf('\n', m.index) === -1 ? undefined : code.indexOf('\n', m.index))
      if (/^\s*FISCAL_AUTHORITY_UNKNOWN_RESPONSE\s*:/.test(line)) { out.push({ file: rel, kind: 'definicao' }); continue }
      const before = code.slice(Math.max(0, m.index - 600), m.index)
      if (/(===|!==)\s*(ErrorCodes\.)?$/.test(before)) { out.push({ file: rel, kind: 'comparacao' }); continue }
      const ctor = Math.max(before.lastIndexOf('new HttpError('), before.lastIndexOf('new AuthorityHttpError('))
      // o texto entre o construtor e o código, sem o conteúdo das strings (mensagem com ';' não fecha a instrução)
      const between = ctor >= 0 ? before.slice(ctor).replace(/'[^'\n]*'|`[^`]*`|"[^"\n]*"/g, "''") : ''
      if (ctor >= 0 && !/;|\n\s*\n/.test(between)) {
        const pre = before.slice(0, ctor).replace(/\s+$/, '')
        const tagged = /tagAmbiguous\($/.test(pre)
        const after = code.slice(m.index, m.index + 400)
        const cause = tagged ? (after.match(/^[^;]*?\)\s*,\s*(?:'([^']*)'|(cause))\s*\)/)?.slice(1).find(Boolean) ?? null) : null
        out.push({ file: rel, kind: 'produtor', tagged, cause })
        continue
      }
      if (/new Set[^;]*$/.test(before)) { out.push({ file: rel, kind: 'conjunto' }); continue }
      out.push({ file: rel, kind: 'DESCONHECIDO' })
    }
  }
  return out
}

// ===========================================================================
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

describe('ACHADO R19-01 (MEDIUM latente — entra com a F2a; a MESMA classe do R18-03, agora do lado das IRMÃS) — D-F97/D-F99: `lifeList` é `PresentationLike[]` = `Partial<…>`; a irmã SEM identidade (sem `dpsId` ou sem `environment` — uma projeção) cai no `continue` de "outra identidade" (`undefined !== \'DPS1\'`) e é IGNORADA: a reapresentação e a tentativa em voo deixam de derrubar a prova — falha ABERTO, em silêncio', () => {
  const semId = (r: any) => { const { dpsId: _d, environment: _e, ...rest } = r; return rest }
  it('[CORRIGIDO na sessão — R19-01] a mesma vida com a irmã COMPLETA (linha da view) não prova; projetada sem identidade, também não (falha FECHADO)', () => {
    expect(reconfirmationProven(cand(), [cand(), emVoo()])).toBe(false)
    expect(reconfirmationProven(cand(), [cand(), semId(emVoo())])).toBe(false)
    expect(reconfirmationProven(cand(), [cand(), semId(reapresentada())])).toBe(false)
  })
  it('[CORRIGIDO na sessão] [MEDIUM R19-01] irmã EM VOO sem `dpsId`/`environment` na vida → NÃO prova (D-F99: a identidade dela é desconhecida — falha fechado, como o R18-03 fez para a candidata)', () => {
    expect(reconfirmationProven(cand(), [cand(), semId(emVoo())])).toBe(false)
  })
  it('[CORRIGIDO na sessão] [MEDIUM R19-01] irmã REAPRESENTADA (R em 03/10, depois do E2404 de 02/10) só sem `environment` → NÃO prova (D-F97)', () => {
    const { environment: _e, ...noEnv } = reapresentada()
    expect(reconfirmationProven(cand(), [cand(), noEnv as any])).toBe(false)
  })
  it('[CORRIGIDO na sessão] [MEDIUM R19-01] irmã em voo com `dpsId` nulo (projeção pelo `mapTransmissionView` de um SELECT sem a coluna) → NÃO prova', () => {
    expect(reconfirmationProven(cand(), [cand(), emVoo({ dpsId: undefined })])).toBe(false)
  })
  it('contexto: a view real NUNCA entrega a irmã sem identidade — `dps_id` vem do JOIN com o DPS da VIDA e `environment` é NOT NULL (o `mapTransmissionView` ainda força P/H) — falhar fechado com irmã sem identidade não tem falso positivo pela view', () => {
    const sql = transmissionViewSelect('fiscal_api')
    expect(sql).toMatch(/v\.dps_id AS dpsId/)
    expect(sql).toMatch(/v\.environment/)
    expect(mapTransmissionView({ attempt: 2, environment: null }).environment).toBe('H')          // nunca undefined depois do mapa
  })
})

describe('ACHADO R19-02 (LOW latente — questão Q-F107, decidida: D-F101) — D-F99 lê "em voo" como `lastEventAt` nulo, mas o vocabulário da casa tem uma voz VIVA: S "enviado" (`isLiveTransmission` — S/K não são finais; o SQL do rodízio também trata `le.kind IN (\'S\',\'K\')` como viva). Uma irmã da mesma identidade com última voz S tem `lastEventAt` = instante do S, e o POST dela pode chegar ao fisco DEPOIS do E2404 — o mesmo buraco do R18-05. Hoje S não tem produtor (latente)', () => {
  const enviado = (over: any = {}) => row({ attempt: 2, createdAt: '2026-10-03 10:00:00', lastEvent: 1, lastKind: 'S', lastSource: 'P', lastEventAt: '2026-10-03 10:00:00', ...over })
  it('[CORRIGIDO — D-F101 (= Q-F107 (b))] a irmã com voz S é VIVA para o núcleo (`isLiveTransmission`) e a prova também a vê assim — um E2404 2 s depois do S não prova', () => {
    expect(isLiveTransmission(enviado())).toBe(true)
    expect(reconfirmationProven(cand({ nfseNotGeneratedAt: '2026-10-03 10:00:02' }), [cand(), enviado()])).toBe(false)
  })
  it('[CORRIGIDO — D-F101] [LOW R19-02] irmã da MESMA identidade com última voz S (viva — a apresentação dela ainda é desconhecida) → NÃO prova', () => {
    expect(reconfirmationProven(cand({ nfseNotGeneratedAt: '2026-10-03 10:00:02' }), [cand(), enviado()])).toBe(false)
  })
})

// ===========================================================================
// RESISTIU — D-F99
// ===========================================================================

describe('RESISTIU — D-F99: o que é e o que não é "tentativa da MESMA identidade sem voz"', () => {
  it('resistiu: irmã EM VOO de OUTRO ambiente (H) não derruba a prova de P — o fisco de produção não vê o POST de homologação', () => {
    expect(reconfirmationProven(cand(), [cand(), emVoo({ environment: 'H' })])).toBe(true)
  })
  it('resistiu: irmã EM VOO de OUTRO Id de DPS (outra vida, que não deveria estar na lista) não derruba', () => {
    expect(reconfirmationProven(cand(), [cand(), emVoo({ dpsId: 'DPS2', lifeEvent: 2 })])).toBe(true)
  })
  it('resistiu: irmã da mesma identidade com `lastEventAt` undefined × null × string vazia → as TRÊS falham fechado (sem lançar)', () => {
    for (const lastEventAt of [undefined, null, '']) {
      const sib = { ...emVoo(), lastEventAt } as any
      expect(() => reconfirmationProven(cand(), [cand(), sib])).not.toThrow()
      expect(reconfirmationProven(cand(), [cand(), sib])).toBe(false)
    }
  })
  it('resistiu: a própria candidata SEM voz → false (antes do laço), mesmo com E2404 muito posterior', () => {
    expect(reconfirmationProven(cand({ lastEventAt: null, nfseNotGeneratedAt: '2099-01-01 00:00:00' }), [cand({ lastEventAt: null })])).toBe(false)
  })
  it('resistiu: a candidata repetida na vida (3×), em qualquer ordem, não muda a resposta — com e sem a irmã em voo', () => {
    expect(reconfirmationProven(cand(), [cand(), cand(), cand()])).toBe(true)
    expect(reconfirmationProven(cand(), [emVoo(), cand(), cand()])).toBe(false)
    expect(reconfirmationProven(cand(), [cand(), cand(), emVoo()])).toBe(false)
  })
  it('resistiu: cópia VELHA da candidata na vida (lida antes do F — sem voz) → falha fechado (direção segura do dado desatualizado)', () => {
    expect(reconfirmationProven(cand(), [cand({ lastEventAt: null, lastKind: null })])).toBe(false)
  })
  it('resistiu: leitor REAL — o SELECT da view entrega o instante da última voz por `DATE_FORMAT(v.last_event_at, …)` (NULL sem voz); o mapa transforma NULL/coluna ausente em null; um Date cru (SELECT sem DATE_FORMAT) falha fechado pelo formato (R18-06)', () => {
    expect(transmissionViewSelect('fiscal_api')).toMatch(/DATE_FORMAT\(v\.last_event_at, '%Y-%m-%d %H:%i:%s'\) AS lastEventAt/)
    const raw = { institutionId: 1, invoiceId: 6200, attempt: 2, lifeEvent: 1, environment: 'P', dpsId: 'DPS1', createdAt: '2026-10-03 10:00:00' }
    expect(mapTransmissionView({ ...raw, lastEventAt: null }).lastEventAt).toBeNull()
    expect(mapTransmissionView(raw).lastEventAt).toBeNull()
    expect(reconfirmationProven(cand(), [cand(), mapTransmissionView({ ...raw, lastEventAt: null })])).toBe(false)
    expect(reconfirmationProven(cand(), [cand(), mapTransmissionView(raw)])).toBe(false)
    const asDate = mapTransmissionView({ ...raw, lastEventAt: new Date('2026-10-03T10:00:05Z'), lastKind: 'R' })
    expect(reconfirmationProven(cand({ nfseNotGeneratedAt: '2026-10-04 00:00:00' }), [cand(), asDate])).toBe(false)
  })
  it('resistiu (com CONTEXTO da reserva morta): a tentativa sem voz prende a prova enquanto não ganhar voz — nem um E2404 de 2099 prova; ao ganhar o F (D-F51 — o rodízio/consulta da nfse-api fecha a reserva interrompida; prova na nfse-api r19) ela vira a candidata e só o E2404 POSTERIOR ao F dela prova', () => {
    const dead = emVoo({ createdAt: '2026-10-03 10:00:00' })
    expect(reconfirmationProven(cand({ nfseNotGeneratedAt: '2099-01-01 00:00:00' }), [cand(), dead])).toBe(false)
    const closed = row({ attempt: 2, createdAt: '2026-10-03 10:00:00', lastEvent: 1, lastKind: 'F', lastSource: 'Q', lastEventAt: '2026-10-03 10:20:00' })
    const life = [cand(), closed]
    expect(reconfirmationCandidate(life)?.attempt).toBe(2)
    expect(reconfirmationProven({ ...closed, nfseNotGeneratedAt: '2026-10-03 10:19:59' }, life)).toBe(false)
    expect(reconfirmationProven({ ...closed, nfseNotGeneratedAt: '2026-10-03 10:20:01' }, life)).toBe(true)
  })
  it('contexto: irmã que DETÉM a chave (NFS-e existe) não é olhada por `reconfirmationProven` — quem a barra é a composição: `reconfirmationCandidate` devolve null com chave na vida (a F2a não chega a pedir a prova)', () => {
    const holder = row({ attempt: 2, accessKey: '4'.repeat(50), lastKind: 'A', lastSource: 'Q', createdAt: '2026-10-01 11:00:00', lastEventAt: '2026-10-01 11:00:00' })
    expect(reconfirmationCandidate([cand(), holder])).toBeNull()
    expect(reconfirmationProven(cand(), [cand(), holder])).toBe(true)          // a função sozinha não sabe da chave
  })
})

// ===========================================================================
// RESISTIU — D-F98 no núcleo
// ===========================================================================

describe('RESISTIU — D-F98: a causa do ambíguo é da lista FECHADA, do produtor até o leitor', () => {
  it('resistiu: cerca estática — todo produtor de `FISCAL_AUTHORITY_UNKNOWN_RESPONSE` em fiscal-api/src (fora dos testes) está DENTRO de `tagAmbiguous(…, causa da lista)`; nenhuma outra forma de produzir o código', () => {
    const sites = ambiguousSites([SRC_ROOT], path.resolve(SRC_ROOT, '..'))
    expect(sites.filter(s => s.kind === 'DESCONHECIDO')).toEqual([])
    const producers = sites.filter(s => s.kind === 'produtor')
    expect(producers).toEqual([{ file: 'src/transport/https-json.ts', kind: 'produtor', tagged: true, cause: 'rota-nao-atendida' }])
    for (const p of producers) expect(AMBIGUOUS_CAUSES as readonly string[]).toContain(p.cause)
  })
  it('resistiu: 405/406/415 pelo transporte REAL → 502 marcado `rota-nao-atendida` (a marca sobrevive ao `throw`, inclusive num catch que relança o MESMO erro)', async () => {
    const real = transport.request
    try {
      for (const status of [405, 406, 415]) {
        transport.request = (async () => ({ status, headers: {}, text: '' })) as any
        let err: unknown
        try { await authorityJson({ url: 'https://x/nfse/1', method: 'GET' }, 'adn consultar') } catch (e) { err = e }
        expect(err).toMatchObject({ statusCode: 502, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
        expect(ambiguousCauseOf(err)).toBe('rota-nao-atendida')
        let again: unknown
        try { try { throw err } catch (e) { throw e } } catch (e) { again = e }
        expect(ambiguousCauseOf(again)).toBe('rota-nao-atendida')
      }
    } finally { transport.request = real }
  })
  it('resistiu: os demais desfechos do transporte (5xx, 401/403, 404, 4xx) NÃO são o ambíguo e não levam marca', async () => {
    const real = transport.request
    try {
      for (const status of [500, 503, 429, 401, 403, 404, 400]) {
        transport.request = (async () => ({ status, headers: {}, text: '{"erros":[{"codigo":"E1","descricao":"x"}]}' })) as any
        let err: any
        try { await authorityJson({ url: 'https://x/nfse/1', method: 'GET' }, 'adn consultar') } catch (e) { err = e }
        expect(err.code).not.toBe(ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE)
        expect(ambiguousCauseOf(err)).toBe('nao-classificada')
      }
    } finally { transport.request = real }
  })
  it('resistiu: a marca não se forja por dado externo — objeto vindo de JSON (com chave "fiscal.ambiguousCause" ou "Symbol(…)") e cópia por JSON do erro marcado leem `nao-classificada`; nenhum produtor pode marcar `nao-classificada` (a cerca exige causa da lista)', () => {
    expect(ambiguousCauseOf(JSON.parse('{"fiscal.ambiguousCause":"nfse-de-outro-dps","Symbol(fiscal.ambiguousCause)":"nfse-de-outro-dps"}'))).toBe('nao-classificada')
    const tagged = tagAmbiguous(new HttpError(502, 'x', undefined, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE), 'situacao-ilegivel')
    expect(ambiguousCauseOf(JSON.parse(JSON.stringify(tagged)))).toBe('nao-classificada')
    expect(AMBIGUOUS_CAUSES as readonly string[]).not.toContain('nao-classificada')
  })
  it('resistiu: a marca vive no registro GLOBAL de símbolos (`Symbol.for`) — um 2º carregamento do módulo (dist × src, ou o espelho do setes-api com a MESMA chave) lê a mesma causa', () => {
    const e = tagAmbiguous(new Error('x'), 'evento-recusado')
    expect((e as any)[Symbol.for('fiscal.ambiguousCause')]).toBe('evento-recusado')
    jest.isolateModules(() => {
      const again = require('../errors/ambiguous-cause') as typeof import('../errors/ambiguous-cause')
      expect(again.ambiguousCauseOf(e)).toBe('evento-recusado')
    })
  })
  it('resistiu: ESPELHO do setes-api — a lista `AMBIGUOUS_CAUSES`, a chave do Symbol e o código das duas funções são IDÊNTICOS (só o comentário de cabeçalho difere)', () => {
    const mirror = path.join(WORKSPACE, 'setes-api', 'src', 'shared', 'tax-authority', 'ambiguous-cause.ts')
    if (!fs.existsSync(mirror)) return                                   // núcleo isolado (sem o workspace): nada a comparar
    const core = path.join(SRC_ROOT, 'errors', 'ambiguous-cause.ts')
    const body = (f: string) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').replace(/^\/\*\*[\s\S]*?\*\/\n/, '')
    expect(body(mirror)).toBe(body(core))
    const list = (f: string) => [...fs.readFileSync(f, 'utf8').split('] as const')[0].matchAll(/^\s*'([a-z-]+)',/gm)].map(m => m[1])
    expect(list(mirror)).toEqual([...AMBIGUOUS_CAUSES])
  })
})

// ===========================================================================
// CONTEXTO do R19-03 (o achado é provado pela composição na nfse-api e no setes-api) — o transporte grava a URL
// ===========================================================================

describe('CONTEXTO R19-03 (LOW) — o transporte do núcleo grava a URL no log em 405/406/415 e em falha de rede; a URL de `GET /nfse/{chave}` leva a chave de acesso, e a chave EMBUTE o CPF/CNPJ do emitente (cMun 7 + ambGer 1 + tpInsc 1 + inscrição 14 + …)', () => {
  const THIRD_CPF = '12345678909'
  /** Chave de 50 dígitos de OUTRO emitente (prestador PF — tpInsc 1, inscrição = 000 + CPF). */
  const FOREIGN_KEY = `4106902${'1'}${'1'}000${THIRD_CPF}${'0000000000077'}2610${'000000000'}1`
  it('contexto: a chave de teste tem 50 dígitos e embute o CPF do terceiro', () => {
    expect(FOREIGN_KEY).toMatch(/^\d{50}$/)
    expect(FOREIGN_KEY).toContain(THIRD_CPF)
  })
  it('contexto: 405 e falha de rede no `GET /nfse/{chave}` → o log do transporte leva a URL inteira (com a chave e, nela, o documento do emitente)', async () => {
    const real = transport.request
    const warn = logger.warn as jest.Mock, error = logger.error as jest.Mock
    try {
      transport.request = (async () => ({ status: 405, headers: {}, text: '' })) as any
      await authorityJson({ url: `https://sefin/SefinNacional/nfse/${FOREIGN_KEY}`, method: 'GET' } as HttpsCall, 'adn consultar').catch(() => undefined)
      transport.request = (async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }) as any
      await authorityJson({ url: `https://sefin/SefinNacional/nfse/${FOREIGN_KEY}`, method: 'GET' } as HttpsCall, 'adn consultar').catch(() => undefined)
      expect(JSON.stringify(error.mock.calls)).toContain(THIRD_CPF)
      expect(JSON.stringify(warn.mock.calls)).toContain(THIRD_CPF)
    } finally { transport.request = real }
  })
})
