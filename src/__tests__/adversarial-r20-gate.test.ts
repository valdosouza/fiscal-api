/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 20 das APIs fiscais (D-F100…D-F101, Valdo 2026-10-11) — NÚCLEO fiscal-api.
// Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
// Alvo do delta no núcleo:
//  - D-F101 (= Q-F107 (b)): `reconfirmationProven(candidata, vida)` (`src/voice/reading.ts`) falha FECHADO com tentativa da MESMA
//    identidade (Id do DPS + ambiente) VIVA — `!t.lastEventAt || !FINAL_TRANSMISSION_KINDS.has(t.lastKind ?? '')` (finais A R C F N;
//    S e K vivas; `lastKind` ausente = viva). A candidata também passa pelo laço. Sem chamador de produção — o consumidor é a F2a; o
//    que se ataca é o CONTRATO (e o leitor real que a F2a vai usar: `transmissionViewSelect` + `mapTransmissionView`).
//  - D-F100 (= Q-F106 (a)): só comentário de conhecimento negativo ("nada da resposta alheia é guardado") — aqui, a borda HTTP do
//    núcleo (`sendError`) não devolve o corpo cru do fisco; a composição é atacada no r20 da nfse-api.
//
//  * ACHADOS (`it.failing('[SEV R20-xx] …')`) — o teste afirma o que a spec/decisão promete e FALHA no código atual: é a prova do bug.
//    O corretor troca `it.failing` por `it` depois de corrigir (ou de decidida a questão). NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (ficam como regressão).
//  * CONTEXTO (`it('contexto: …')`) — fixa o comportamento atual que fundamenta um achado ou uma QUESTÃO (decisão do Valdo).
//
// REGRAS DO GATE: puro (sem banco, sem socket, sem fisco). Lê a migration da nfse-api só como TEXTO.
import fs from 'fs'
import path from 'path'
import { isLiveTransmission, currentOf } from '../voice/reading'
// NE-1a: as regras e a leitura da NFS-e moram na família de serviço (mesmos nomes na biblioteca)
import {
  reconfirmationCandidate, reconfirmationProven, transmissionViewSelect, mapTransmissionView,
  ServiceTransmissionView as TransmissionView,
} from '../voice/families/service'
import { FINAL_TRANSMISSION_KINDS } from '../voice/kinds'
import { sendError } from '../http/http'
import { AuthorityHttpError } from '../transport/https-json'
import { ErrorCodes } from '../errors/error-codes'
import { logger } from '../log/logger'

const SRC_ROOT = path.resolve(__dirname, '..')
const WORKSPACE = path.resolve(SRC_ROOT, '..', '..')

beforeEach(() => {
  jest.spyOn(logger, 'info').mockImplementation(() => undefined)
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined)
  jest.spyOn(logger, 'error').mockImplementation(() => undefined)
})
afterEach(() => jest.restoreAllMocks())

/**
 * Linha CRUA como o mysql2 devolve o SELECT de `transmissionViewSelect` (INT → number, CHAR → string, DATE_FORMAT → string, NULL →
 * null). Candidata padrão: tentativa 1 da vida 1, F por CONSULTA em P (o "envio interrompido" da D-F51), reservada 09:59, F às 10:00.
 */
const raw = (over: any = {}) => ({
  institutionId: 1, invoiceId: 6200, terminal: 0, attempt: 1, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 42, dpsId: 'DPS1',
  accessKey: null, nfseNumber: null, dhProc: null, lastQueriedAt: '2026-10-01 10:00:00', nfseNotGeneratedAt: null, createdAt: '2026-10-01 09:59:00',
  lastEvent: 2, lastKind: 'F', lastCode: null, lastMessage: 'Sem resposta do fisco e nenhuma NFS-e gerada para este DPS — envio interrompido',
  lastSource: 'Q', lastDh: null, lastEventAt: '2026-10-01 10:00:00',
  authorityRecorded: over.accessKey != null ? 'S' : 'N',   // NE-1a (D-NE56): coluna da view 004 — na NFS-e espelha a chave
  ...over,
})
/** O LEITOR REAL que a F2a vai usar: o SELECT publicado da view + o mapa — aqui com um `query` falso que devolve as linhas cruas. */
async function readLife(rows: any[]): Promise<TransmissionView[]> {
  let seen = ''
  const query = async (sql: string) => { seen = sql; return [rows] as const }
  const [got] = await query(`${transmissionViewSelect('fiscal_api')} WHERE v.tb_institution_id = ? AND v.tb_invoice_id = ? AND v.life_event = ? ORDER BY v.attempt`)
  expect(seen).toMatch(/FROM `fiscal_api`\.vw_invoice_service_transmission v/)
  return (got as any[]).map(mapTransmissionView)
}
const row = (over: any = {}) => mapTransmissionView(raw(over))
/** Candidata com o E2404 da reconferência em 02/10 (POSTERIOR ao F de 01/10 10:00). */
const cand = (over: any = {}) => row({ nfseNotGeneratedAt: '2026-10-02 10:00:00', ...over })
/** Irmã da MESMA identidade (tentativa 2), reservada 01/10 11:00 e com a última voz às 11:00:05 — ANTES do E2404 de 02/10. */
const sib = (lastKind: any, over: any = {}) => ({
  ...row({ attempt: 2, createdAt: '2026-10-01 11:00:00', lastEvent: 1, lastSource: 'P', lastEventAt: '2026-10-01 11:00:05', ...over }),
  lastKind,                                                     // fora do mapa: `undefined` tem de chegar como undefined
}) as TransmissionView
const FINAL = ['A', 'R', 'C', 'F', 'N'] as const
const LIVE: any[] = ['S', 'K', null, undefined, '']

// ===========================================================================
// ATAQUE 1 — a candidata REAL, montada pelo leitor real: prova quando deve (sem falso negativo permanente)
// ===========================================================================

describe('ATAQUE 1 — D-F101 × leitor real: a candidata F por consulta (lida da view pelo SELECT publicado) prova com E2404 posterior quando não há irmã viva', () => {
  it('resistiu: o SELECT publicado entrega `last_kind AS lastKind` (e os demais campos da prova) — a F2a não precisa projetar nada à mão', () => {
    const sql = transmissionViewSelect('fiscal_api')
    expect(sql).toMatch(/v\.last_kind AS lastKind/)
    expect(sql).toMatch(/v\.last_source AS lastSource/)
    expect(sql).toMatch(/v\.dps_id AS dpsId/)
    expect(sql).toMatch(/v\.environment/)
    expect(sql).toMatch(/DATE_FORMAT\(v\.nfse_not_generated_at, '%Y-%m-%d %H:%i:%s'\) AS nfseNotGeneratedAt/)
    expect(sql).toMatch(/DATE_FORMAT\(v\.last_event_at, '%Y-%m-%d %H:%i:%s'\) AS lastEventAt/)
    expect(sql).toMatch(/DATE_FORMAT\(v\.created_at, '%Y-%m-%d %H:%i:%s'\) AS createdAt/)
  })
  it('resistiu: a VIEW publicada (migration 003 da nfse-api) tira `last_kind` da ÚLTIMA voz viva (LEFT JOIN + NOT EXISTS de evento maior) — `last_kind` e `last_event_at` vêm da MESMA linha (nulos juntos)', () => {
    const f = path.join(WORKSPACE, 'nfse-api', 'src', 'migrations', 'sql', '003_transmission_nfse_not_generated.sql')
    if (!fs.existsSync(f)) return                                         // núcleo isolado (sem o workspace)
    const ddl = fs.readFileSync(f, 'utf8')
    expect(ddl).toMatch(/le\.`kind`\s+AS `last_kind`/)
    expect(ddl).toMatch(/le\.`created_at`\s+AS `last_event_at`/)
    expect(ddl).toMatch(/LEFT JOIN `tb_invoice_service_transmission_event` le/)
    expect(ddl).toMatch(/AND x\.`event` > le\.`event`\)/)
  })
  it('resistiu: vida = [F por consulta com E2404 posterior] pelo leitor real → candidata = tentativa 1 e PROVA', async () => {
    const life = await readLife([raw({ nfseNotGeneratedAt: '2026-10-02 10:00:00' })])
    const c = reconfirmationCandidate(life)
    expect(c?.attempt).toBe(1)
    expect(c?.lastKind).toBe('F')
    expect(reconfirmationProven(c!, life)).toBe(true)
  })
  it('resistiu: vida = [F (cand.), R da reapresentação ANTES do E2404, F por P antes do E2404] pelo leitor real → candidata 1 e PROVA (as finais não derrubam)', async () => {
    const life = await readLife([
      raw({ nfseNotGeneratedAt: '2026-10-02 10:00:00' }),
      raw({ attempt: 2, createdAt: '2026-10-01 11:00:00', lastEvent: 1, lastKind: 'R', lastSource: 'P', lastCode: 'E0116', lastEventAt: '2026-10-01 11:00:05' }),
      raw({ attempt: 3, createdAt: '2026-10-01 12:00:00', lastEvent: 1, lastKind: 'F', lastSource: 'P', lastEventAt: '2026-10-01 12:00:01' }),
    ])
    const c = reconfirmationCandidate(life)
    expect(c?.attempt).toBe(1)
    expect(reconfirmationProven(c!, life)).toBe(true)
  })
  it('resistiu: a candidata cuja prova é o E2404 do PRÓPRIO F (mesmo instante) ou anterior a ele não prova — e a reconferência seguinte (E2404 novo) prova', async () => {
    for (const at of ['2026-10-01 10:00:00', '2026-10-01 09:00:00']) {
      const life = await readLife([raw({ nfseNotGeneratedAt: at })])
      expect(reconfirmationProven(reconfirmationCandidate(life)!, life)).toBe(false)
    }
    const life = await readLife([raw({ nfseNotGeneratedAt: '2026-10-11 10:00:00' })])
    expect(reconfirmationProven(reconfirmationCandidate(life)!, life)).toBe(true)
  })
  it('resistiu: vida com tentativa EM VOO (sem voz) pelo leitor real — `last_kind`/`last_event_at` NULL → o mapa entrega null/null → não prova; ganhou F (D-F51) e o E2404 posterior → prova (o falso negativo NÃO é permanente)', async () => {
    const inFlight = raw({ attempt: 2, createdAt: '2026-10-02 09:00:00', lastEvent: null, lastKind: null, lastSource: null, lastMessage: null, lastEventAt: null })
    const life1 = await readLife([raw({ nfseNotGeneratedAt: '2026-10-02 10:00:00' }), inFlight])
    expect(life1[1].lastKind).toBeNull()
    expect(reconfirmationProven(reconfirmationCandidate(life1)!, life1)).toBe(false)
    const closed = { ...inFlight, lastEvent: 1, lastKind: 'F', lastSource: 'Q', lastEventAt: '2026-10-02 09:20:00' }
    const life2 = await readLife([raw({ nfseNotGeneratedAt: '2026-10-02 10:00:00' }), { ...closed, nfseNotGeneratedAt: '2026-10-02 09:30:00' }])
    const c = reconfirmationCandidate(life2)
    expect(c?.attempt).toBe(2)                                           // a fechada pela consulta vira a candidata
    expect(reconfirmationProven(c!, life2)).toBe(true)
  })
  it.each(['f', 'F ', ' F', '', 'X', 'E', 'ff'])('resistiu: candidata com `last_kind` INESPERADO vindo do banco (%p) → o seletor não a escolhe e a prova falha FECHADO (nunca prova por ela)', async k => {
    const life = await readLife([raw({ lastKind: k, nfseNotGeneratedAt: '2099-01-01 00:00:00' })])
    expect(life[0].lastKind).toBe(k)                                     // o mapa NÃO normaliza (nem trim, nem caixa)
    expect(reconfirmationCandidate(life)).toBeNull()
    expect(reconfirmationProven(life[0], life)).toBe(false)
    expect(isLiveTransmission(life[0])).toBe(true)                       // e a barreira do plano a vê como VIVA — coerente com a prova
  })
})

// ===========================================================================
// ATAQUE 2 — tabela: cada voz da irmã da MESMA identidade (apresentação ANTES do E2404)
// ===========================================================================

describe('ATAQUE 2 — D-F101: voz da irmã da MESMA identidade × prova (todas as apresentações dela ANTES do E2404)', () => {
  it.each(FINAL)('resistiu: irmã com voz FINAL %s → PROVA (não derruba)', k => {
    expect(reconfirmationProven(cand(), [cand(), sib(k)])).toBe(true)
  })
  it.each(LIVE)('resistiu: irmã VIVA/sem voz conhecida (lastKind %p) → NÃO prova, sem lançar', k => {
    expect(() => reconfirmationProven(cand(), [cand(), sib(k)])).not.toThrow()
    expect(reconfirmationProven(cand(), [cand(), sib(k)])).toBe(false)
  })
  it('resistiu: irmã com lastKind final mas SEM instante de voz (linha incoerente) → NÃO prova', () => {
    for (const k of FINAL) expect(reconfirmationProven(cand(), [cand(), sib(k, { lastEventAt: null })])).toBe(false)
  })
  it.each(['a', 'r', 'c', 'f', 'n', 's', 'k', 'F ', ' R', 'AR', 'E', 'X'])('resistiu: irmã com lastKind fora do vocabulário (%p) → falha FECHADO', k => {
    expect(reconfirmationProven(cand(), [cand(), sib(k)])).toBe(false)
  })
  it('resistiu: o predicado da prova é EXATAMENTE o `isLiveTransmission` (o da barreira do plano) para toda linha com voz — varredura de A–Z, a–z, vazio, espaço, null, undefined, números', () => {
    const kinds: any[] = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split(''), '', ' ', null, undefined, 0, 1, true]
    for (const k of kinds) {
      const s = sib(k)
      expect([k, reconfirmationProven(cand(), [cand(), s])]).toEqual([k, !isLiveTransmission(s)])
    }
  })
  it('contexto [NE-1a — D-NE14]: o vocabulário FINAL é {A,R,C,F,N} + D (NF-e denegada) e é o MESMO Set da barreira (`isLiveTransmission`) — S, K e P (NF-e em processamento) são vivas', () => {
    expect([...FINAL_TRANSMISSION_KINDS].sort()).toEqual(['A', 'C', 'D', 'F', 'N', 'R'])
    for (const k of ['S', 'K', 'P']) expect(isLiveTransmission({ attempt: 1, accessKey: null, lastKind: k as any })).toBe(true)
  })
})

// ===========================================================================
// ATAQUE 3 — o que NÃO pode derrubar a prova
// ===========================================================================

describe('ATAQUE 3 — D-F101 não derruba o que não é a mesma identidade nem o que é final e anterior', () => {
  it.each(LIVE)('resistiu: irmã VIVA (%p) de OUTRO Id de DPS → prova', k => {
    expect(reconfirmationProven(cand(), [cand(), sib(k, { dpsId: 'DPS2', lifeEvent: 2 })])).toBe(true)
  })
  it.each(LIVE)('resistiu: irmã VIVA (%p) de OUTRO ambiente (H) → prova (o fisco de P não vê o POST de H)', k => {
    expect(reconfirmationProven(cand(), [cand(), sib(k, { environment: 'H' })])).toBe(true)
  })
  it.each(FINAL)('resistiu: irmã FINAL %s da mesma identidade — apresentação ANTES do E2404 prova; NO MESMO instante ou DEPOIS não prova (D-F97, estritamente maior)', k => {
    expect(reconfirmationProven(cand(), [cand(), sib(k)])).toBe(true)
    expect(reconfirmationProven(cand(), [cand(), sib(k, { lastEventAt: '2026-10-02 10:00:00' })])).toBe(false)
    expect(reconfirmationProven(cand(), [cand(), sib(k, { createdAt: '2026-10-02 10:00:01', lastEventAt: '2026-10-02 10:00:02' })])).toBe(false)
  })
  it('resistiu: a ORDEM da vida não muda a resposta (irmã viva antes/depois da candidata; candidata ausente da lista)', () => {
    expect(reconfirmationProven(cand(), [sib('S'), cand()])).toBe(false)
    expect(reconfirmationProven(cand(), [sib('S')])).toBe(false)
    expect(reconfirmationProven(cand(), [sib('R'), cand()])).toBe(true)
    expect(reconfirmationProven(cand(), [sib('R')])).toBe(true)
  })
})

// ===========================================================================
// D-F101 — a CANDIDATA também passa pelo laço
// ===========================================================================

describe('D-F101 — a candidata passa pelo laço (o próprio `lastKind` dela conta)', () => {
  it.each(LIVE)('resistiu: candidata com lastKind %p → não prova, nem com E2404 de 2099', k => {
    const c = { ...cand({ nfseNotGeneratedAt: '2099-01-01 00:00:00' }), lastKind: k } as TransmissionView
    expect(reconfirmationProven(c, [c])).toBe(false)
  })
  it('contexto: a função não reconfere que a candidata é "F por consulta" — uma candidata final A/R/C/N com E2404 posterior prova; quem garante "F por consulta em P" é o SELETOR (`reconfirmationCandidate`), que a F2a tem de usar (e que devolve null com chave na vida)', () => {
    for (const k of ['A', 'R', 'C', 'N']) {
      const c = cand({ lastKind: k })
      expect(reconfirmationProven(c, [c])).toBe(true)
      expect(reconfirmationCandidate([c])).toBeNull()
    }
  })
})

// ===========================================================================
// R20-02 (LOW, contrato) — `lastKind` é OPCIONAL no tipo: o esquecimento compila e vira falso negativo permanente silencioso
// ===========================================================================

describe('ACHADO R20-02 (LOW — contrato da F2a; mesma classe do R18-04, agora na direção do falso NEGATIVO) — D-F101 diz "`lastKind` entra no contrato", mas o tipo da candidata (`Pick<…,\'nfseNotGeneratedAt\'|\'lastEventAt\'> & PresentationLike`) e o das irmãs (`PresentationLike` = `Partial<…>`) deixam `lastKind` OPCIONAL: uma projeção sem `last_kind` COMPILA e a prova nunca passa (laço "reconfira" que só se descobre testando)', () => {
  // ⚠️ testemunha de COMPILAÇÃO — [CORRIGIDO na sessão — R20-02]: o tipo foi endurecido (`lastKind` obrigatório, `null` aceito); a
  // chamada com a projeção SEM `lastKind` agora NÃO compila (`@ts-expect-error` abaixo) — o fallback de execução segue falhando fechado.
  type ProjectionWithoutKind = Pick<TransmissionView, 'nfseNotGeneratedAt' | 'lastEventAt' | 'createdAt' | 'dpsId' | 'environment'>
  const projected: ProjectionWithoutKind = { nfseNotGeneratedAt: '2099-01-01 00:00:00', lastEventAt: '2026-10-01 10:00:00', createdAt: '2026-10-01 09:59:00', dpsId: 'DPS1', environment: 'P' }
  it('[CORRIGIDO na sessão — R20-02] a projeção sem `lastKind` NÃO compila mais; forçada (execução), segue NUNCA provando — a mesma linha com `lastKind` F prova', () => {
    // @ts-expect-error — R20-02: `lastKind` é obrigatório no contrato da prova
    expect(reconfirmationProven(projected, [projected])).toBe(false)
    expect(reconfirmationProven({ ...projected, lastKind: 'F' }, [{ ...projected, lastKind: 'F' }])).toBe(true)
  })
  it('contexto: o caminho certo (o leitor real `mapTransmissionView` + o seletor) SEMPRE traz `lastKind` — o risco é só da F2a projetar à mão', () => {
    // NE-1a (D-NE56 e gates da parte 1): registro, ambiente e terminal são obrigatórios na linha
    const r = mapTransmissionView({ attempt: 1, authorityRecorded: 'N', environment: 'P', terminal: 0 })
    expect(Object.prototype.hasOwnProperty.call(r, 'lastKind')).toBe(true)
    expect(r.lastKind).toBeNull()
  })
})

// ===========================================================================
// R20-03 (LOW, fora do delta — só com dado gravado por fora do código) — domínio de `kind` não é conferido no banco
// ===========================================================================

describe('CONTEXTO R20-03 (LOW, fora do delta) — `kind` é CHAR(1) SEM CHECK de domínio numa colação _ci (migration 001 da nfse-api): o banco aceita "f"; o SQL do rodízio (_ci) o lê como F, o JS (case-sensitive) como VIVO', () => {
  it('contexto: a DDL não confere o domínio de `kind` e a colação é _ci', () => {
    const f = path.join(WORKSPACE, 'nfse-api', 'src', 'migrations', 'sql', '001_nfse_baseline.sql')
    if (!fs.existsSync(f)) return
    const ddl = fs.readFileSync(f, 'utf8')
    expect(ddl).toMatch(/`kind`\s+CHAR\(1\) NOT NULL COMMENT 'S · A · R · C · K · F · N'/)
    expect(ddl).toMatch(/COLLATE=utf8mb4_unicode_ci/)
    expect(ddl).not.toMatch(/CHECK \(`kind` IN/)
  })
  it('contexto: irmã "f" (um F gravado em minúscula) → a prova fica FALSA para sempre (o JS a vê viva; o rodízio, _ci, a trata como F e nunca a "fecha") — direção segura, mas sem saída', () => {
    expect(reconfirmationProven(cand(), [cand(), sib('f')])).toBe(false)
    expect(isLiveTransmission(sib('f'))).toBe(true)
  })
  it('contexto: a direção PERIGOSA é anterior ao delta (seletor `=== \'F\'`): vida [F gravado "f" por consulta, R depois] → o seletor devolve null ("nada a reconferir") e a barreira do plano passa (vigente R = final) — a F2a cancelaria localmente SEM a reconferência da D-F29', () => {
    const life = [row({ lastKind: 'f' }), row({ attempt: 2, createdAt: '2026-10-01 11:00:00', lastEvent: 1, lastKind: 'R', lastSource: 'P', lastEventAt: '2026-10-01 11:00:05' })]
    expect(reconfirmationCandidate(life)).toBeNull()
    expect(isLiveTransmission(currentOf(life))).toBe(false)
  })
})

// ===========================================================================
// D-F100 no núcleo — a borda HTTP nunca devolve o corpo cru do fisco
// ===========================================================================

describe('D-F100 (núcleo) — "nada da resposta alheia é guardado": a borda HTTP do núcleo (`sendError`) só devolve mensagem/código/campos', () => {
  const THIRD_CPF = '12345678909'
  const FOREIGN_DPS_ID = `DPS41069021000${THIRD_CPF}00001000000000000077`
  const fakeRes = () => { const r: any = {}; r.status = (c: number) => { r.code = c; return r }; r.json = (b: unknown) => { r.payload = b; return r }; return r }
  it('resistiu: um 502 ambíguo com o corpo CRU de terceiro (`AuthorityHttpError.body`) sai como `{error, code}` — sem o corpo, sem CPF, sem o Id alheio', () => {
    const body = JSON.stringify({ nfseXml: `<infDPS Id="${FOREIGN_DPS_ID}"><CPF>${THIRD_CPF}</CPF></infDPS>` })
    const err = new AuthorityHttpError(502, 'Fisco respondeu 200 sem envelope legível (transmitir: NFS-e de OUTRO DPS (Id divergente do enviado))',
      ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE, 200, body)
    const res = fakeRes()
    sendError(res, err, 'POST /v1/nfse/invoices/6200/transmit')
    expect(res.code).toBe(502)
    expect(res.payload).toEqual({ error: err.message, code: ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE })
    expect(JSON.stringify(res.payload)).not.toContain(THIRD_CPF)
    expect(JSON.stringify(res.payload)).not.toContain(FOREIGN_DPS_ID)
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain(THIRD_CPF)
  })
  it('contexto: o corpo cru VIAJA no erro em memória (`body` é propriedade ENUMERÁVEL — `JSON.stringify(err)` o leva): o "nada guardado" da D-F100 vale porque NENHUMA porta serializa o erro inteiro (cerca na nfse-api r20)', () => {
    const err = new AuthorityHttpError(502, 'x', ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE, 200, `{"cpf":"${THIRD_CPF}"}`)
    expect(Object.keys(err)).toContain('body')
    expect(JSON.stringify(err)).toContain(THIRD_CPF)
  })
})
