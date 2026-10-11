/// <reference types="jest" />
// GATE ADVERSARIAL — Rodada 18 das APIs fiscais (D-F94…D-F97, Valdo 2026-10-11 "siga as recomendações") — NÚCLEO fiscal-api.
// Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
// Alvo do delta no núcleo: D-F97 (= Q-F103 (b)) — `reconfirmationProven(candidate, lifeList = [candidate])` em
// `src/voice/reading.ts`: o E2404 (`nfseNotGeneratedAt`) tem de ser POSTERIOR à ÚLTIMA apresentação do Id do DPS (o maior entre
// `createdAt` e `lastEventAt` de cada tentativa da vida com o MESMO `dpsId` e o MESMO `environment`). Hoje NENHUM chamador de
// produção — o consumidor é a F2a (setes-api lendo `vw_invoice_service_transmission`); o que se ataca é o CONTRATO.
//
//  * ACHADOS (`it.failing('[SEV R18-xx] …')`) — o teste afirma o que a spec promete e FALHA no código atual: é a prova do bug.
//    O corretor troca `it.failing` por `it` depois de corrigir (ou de decidida a questão). NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (ficam como regressão).
//  * CONTEXTO (`it('contexto …')`) — fixa o comportamento atual que fundamenta um achado ou uma QUESTÃO (decisão do Valdo).
//
// REGRAS DO GATE: puro (sem banco, sem socket, sem fisco).
import { reconfirmationCandidate, reconfirmationProven, transmissionViewSelect, mapTransmissionView, inLife } from '../voice/reading'

/** Linha da view como o `mapTransmissionView` a entrega (instantes 'YYYY-MM-DD HH:MM:SS' UTC — DATE_FORMAT do leitor). */
const row = (over: any = {}) => mapTransmissionView({
  institutionId: 1, invoiceId: 6200, terminal: 0, attempt: 1, lifeEvent: 1, environment: 'P', serie: '1', dpsNumber: 42, dpsId: 'DPS1',
  accessKey: null, nfseNumber: null, dhProc: null, lastQueriedAt: null, nfseNotGeneratedAt: null, createdAt: '2026-10-01 09:59:00',
  lastEvent: 2, lastKind: 'F', lastCode: null, lastMessage: null, lastSource: 'Q', lastDh: null, lastEventAt: '2026-10-01 10:00:00', ...over,
})
/** Candidata: F por consulta em P (tentativa 1) com E2404 em 02/10 (posterior ao F de 01/10). */
const cand = (over: any = {}) => row({ nfseNotGeneratedAt: '2026-10-02 10:00:00', ...over })
/** Tentativa 2 da MESMA vida (mesmo Id, mesmo ambiente) apresentada em 03/10 e RECUSADA (voz R da resposta direta). */
const reapresentada = (over: any = {}) => row({ attempt: 2, createdAt: '2026-10-03 10:00:00', lastEvent: 1, lastKind: 'R', lastSource: 'P', lastEventAt: '2026-10-03 10:00:05', ...over })
/** Tentativa 2 da MESMA vida reservada em 03/10 e ainda EM VOO (sem voz: o POST pode ter chegado ao fisco DEPOIS da reserva). */
const emVoo = (over: any = {}) => row({ attempt: 2, createdAt: '2026-10-03 10:00:00', lastEvent: null, lastKind: null, lastSource: null, lastEventAt: null, ...over })

// ===========================================================================
// ACHADOS — falham no código atual (prova do bug); passam depois da correção
// ===========================================================================

describe('ACHADO R18-03 (MEDIUM) — D-F97: a identidade da candidata é OPCIONAL no tipo (`PresentationLike = Partial<…>`): candidata sem `dpsId`/`environment` + a VIDA passada → `t.dpsId !== candidate.dpsId` pula TODAS as tentativas da vida (undefined ≠ \'DPS1\') e a prova volta à regra pré-D-F97 em silêncio — com a vida em mãos', () => {
  it('[CORRIGIDO na sessão] candidata de 2 campos (sem identidade) e vida vazia → falha FECHADO (o molde da F2a não prova sem o Id do DPS e o ambiente)', () => {
    expect(reconfirmationProven({ lastEventAt: '2026-10-01 10:00:00', nfseNotGeneratedAt: '2026-10-02 10:00:00' }, [])).toBe(false)
  })
  it('[CORRIGIDO na sessão] [MEDIUM R18-03] candidata projetada SEM dpsId/environment, vida COM a reapresentação de 03/10 (posterior ao E2404 de 02/10) → NÃO prova (falha fechado, como a D-F97 promete)', () => {
    const projected = { lastEventAt: '2026-10-01 10:00:00', nfseNotGeneratedAt: '2026-10-02 10:00:00' }   // sem identidade
    expect(reconfirmationProven(projected, [cand(), reapresentada()])).toBe(false)                      // hoje: true
  })
  it('[CORRIGIDO na sessão] [MEDIUM R18-03] candidata com `dpsId` mas SEM `environment` (projeção parcial) → a vida em P também é ignorada; não pode provar', () => {
    const { environment: _e, ...noEnv } = cand()
    expect(reconfirmationProven(noEnv as any, [cand(), reapresentada()])).toBe(false)                   // hoje: true
  })
  it('resistiu: com a linha COMPLETA da view (o caminho natural: `reconfirmationCandidate` devolve a própria linha) a reapresentação derruba a prova', () => {
    const life = [cand(), reapresentada()]
    const c = reconfirmationCandidate(life)
    expect(c?.attempt).toBe(1)
    expect(reconfirmationProven(c!, life)).toBe(false)
    expect(reconfirmationProven({ ...c!, nfseNotGeneratedAt: '2026-10-03 10:00:06' }, life)).toBe(true)
  })
})

describe('ACHADO R18-05 (LOW — depende de decisão: Q-F105) — D-F97: "apresentação" = max(createdAt, lastEventAt); numa tentativa EM VOO (sem voz) só há o `createdAt` da RESERVA — o POST chega ao fisco DEPOIS (assinatura, disco, rede); um E2404 que caia entre a reserva e a chegada do POST prova contra uma apresentação que ainda não aconteceu', () => {
  it('[CORRIGIDO — D-F99] [LOW R18-05] vida com tentativa da MESMA identidade EM VOO (sem voz) → não prova (a apresentação dela é desconhecida)', () => {
    // E2404 da candidata às 10:00:02 — DEPOIS da reserva da 2 (10:00:00), ANTES do POST dela chegar ao fisco
    expect(reconfirmationProven(cand({ nfseNotGeneratedAt: '2026-10-03 10:00:02' }), [cand(), emVoo()])).toBe(false)   // hoje: true
  })
  it('[CORRIGIDO — D-F99] a função sozinha agora sabe (a recusa do plano de cancelamento — `isLiveTransmission` — segue como 2ª barreira); quando a 2 ganha voz, a prova POSTERIOR a ela volta a valer', () => {
    expect(reconfirmationProven(cand({ nfseNotGeneratedAt: '2026-10-03 10:00:02' }), [cand(), emVoo()])).toBe(false)
    expect(reconfirmationProven(cand({ nfseNotGeneratedAt: '2026-10-03 10:00:06' }), [cand(), reapresentada()])).toBe(true)
  })
})

// ===========================================================================
// CONTEXTO — o contrato confia no leitor
// ===========================================================================

describe('CONTEXTO R18-04/R18-06 (LOW) — o contrato da D-F97 tem dois defaults que falham ABERTO', () => {
  it('[CORRIGIDO na sessão — R18-04] `lifeList` é OBRIGATÓRIA (sem default): quem chama tem de passar a vida; com ela, a reapresentação derruba a prova', () => {
    expect(reconfirmationProven.length).toBe(2)                              // o 2º parâmetro não tem mais default
    expect(reconfirmationProven(cand(), [cand(), reapresentada()])).toBe(false)
  })
  it('[CORRIGIDO na sessão — R18-06] instante fora do formato do leitor (ISO com `T`/`Z`) → falha FECHADO (a comparação por texto só é cronológica no formato do DATE_FORMAT)', () => {
    expect(reconfirmationProven(cand({ nfseNotGeneratedAt: '2026-10-03T09:00:00Z' }), [cand(), reapresentada()])).toBe(false)
    expect(reconfirmationProven(cand({ nfseNotGeneratedAt: '2026-10-03T11:00:00Z' }), [cand(), reapresentada()])).toBe(false)
  })
  it('resistiu: o leitor do núcleo entrega TODOS os instantes da prova pelo DATE_FORMAT (formato fixo, sem T/Z) — createdAt, lastEventAt e nfseNotGeneratedAt', () => {
    const sql = transmissionViewSelect('fiscal_api').replace(/\s+/g, ' ')
    for (const col of ['created_at', 'last_event_at', 'nfse_not_generated_at']) {
      expect(sql).toContain(`DATE_FORMAT(v.${col}, '%Y-%m-%d %H:%i:%s')`)
    }
  })
})

// ===========================================================================
// RESISTIU — D-F97 nas bordas pedidas
// ===========================================================================

describe('RESISTIU — D-F97: outras vidas, outro ambiente, nulos, empate de segundo, ordem', () => {
  it('resistiu: outro AMBIENTE (H) com o MESMO Id e a vida INTEIRA da view (todas as vidas misturadas: outro Id) não contam', () => {
    const otherLife = row({ attempt: 7, lifeEvent: 2, dpsId: 'DPS2', createdAt: '2026-10-20 10:00:00', lastEventAt: '2026-10-20 10:00:05' })
    expect(reconfirmationProven(cand(), [cand(), reapresentada({ environment: 'H' }), otherLife])).toBe(true)
    // `inLife` antes (o caminho da F2a) dá a mesma resposta
    expect(reconfirmationProven(cand(), inLife([cand(), reapresentada({ environment: 'H' }), otherLife], 1))).toBe(true)
  })
  it('resistiu: nulos — candidata sem E2404 ou sem voz → false; irmã da MESMA identidade com createdAt/lastEventAt nulos não lança e falha FECHADO (D-F99: sem voz)', () => {
    expect(reconfirmationProven(cand({ nfseNotGeneratedAt: null }), [cand()])).toBe(false)
    expect(reconfirmationProven(cand({ lastEventAt: null }), [cand()])).toBe(false)
    expect(() => reconfirmationProven(cand(), [cand(), row({ attempt: 3, createdAt: null, lastEventAt: null })])).not.toThrow()
    expect(reconfirmationProven(cand(), [cand(), row({ attempt: 3, createdAt: null, lastEventAt: null })])).toBe(false)   // D-F99
  })
  it('resistiu: E2404 no MESMO segundo da última apresentação NÃO prova (estritamente maior — falha fechado no empate)', () => {
    expect(reconfirmationProven(cand({ nfseNotGeneratedAt: '2026-10-03 10:00:05' }), [cand(), reapresentada()])).toBe(false)
    expect(reconfirmationProven(cand({ nfseNotGeneratedAt: '2026-10-03 10:00:06' }), [cand(), reapresentada()])).toBe(true)
  })
  it('resistiu: a ordem da lista e a presença (ou não) da candidata nela não mudam a resposta', () => {
    const c = cand({ nfseNotGeneratedAt: '2026-10-03 10:00:01' })
    const answers = [[c, reapresentada()], [reapresentada(), c], [reapresentada()], [reapresentada(), reapresentada(), c]]
      .map(l => reconfirmationProven(c, l))
    expect(new Set(answers)).toEqual(new Set([false]))
  })
  it('resistiu: o E2404 de OUTRA tentativa (a revisita de 24 h da tentativa 1 quando a candidata é a 2) não é a prova da candidata', () => {
    const t1 = cand({ nfseNotGeneratedAt: '2026-10-30 10:00:00' })
    const t2 = row({ attempt: 2, createdAt: '2026-10-03 10:00:00', lastEvent: 2, lastKind: 'F', lastSource: 'Q', lastEventAt: '2026-10-03 10:20:00', nfseNotGeneratedAt: null })
    const c = reconfirmationCandidate([t1, t2])
    expect(c?.attempt).toBe(2)
    expect(reconfirmationProven(c!, [t1, t2])).toBe(false)
  })
})
