/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA COMBINADO (correções dos gates da Rodada 9 + Rodada 10 — 2026-10-13; skill
// Infra-IA/skills-genericas/testar-adversarial.md; prompt_apis_fiscais_isoladas.md §7 D-F170/D-F173/D-F175). Alvo: núcleo
// `fe71164..4c225f7` — D-F175: o Space-Saving guarda o ERRO de cada contador e a linha dos kids imprime o MÍNIMO GARANTIDO
// (`count − erro`), ordenada por ele. Os gates R8/R9 atacaram com fluxos ALEATÓRIOS; aqui o atacante é ADAPTATIVO — vê o estado interno
// (o pior caso: um espelho do algoritmo decide cada recusa forjada; usa o desempate pelo índice), começa com a tabela já cheia e o kid
// real pode entrar tarde — e a janela que vira.
// Convenção: `it('[RESISTIU] …')` = o ataque foi barrado; `it('[FATO …]')` / `[LIMITE CONHECIDO]` = comportamento atual registrado.
// Nada aqui toca rede nem banco.
import { authRejectLog, AuthReject } from '../auth/product-jwt'

type Top = { authClass: string; kid: string; count: number }

/** Espelho do Space-Saving de `authRejectLog` (mesmo desempate — o 1º mínimo pelo índice): o atacante "vê" o estado interno. */
class Mirror {
  keys: string[] = []
  counts: number[] = []
  errors: number[] = []
  constructor(readonly m: number) {}
  firstMin(): number {
    let k = 0
    for (let j = 1; j < this.counts.length; j++) if (this.counts[j] < this.counts[k]) k = j
    return k
  }
  add(key: string): void {
    const i = this.keys.indexOf(key)
    if (i >= 0) { this.counts[i] += 1; return }
    if (this.keys.length < this.m) { this.keys.push(key); this.counts.push(1); this.errors.push(0); return }
    const k = this.firstMin()
    this.keys[k] = key
    this.errors[k] = this.counts[k]
    this.counts[k] += 1
  }
}

/** Uma janela inteira contra o log REAL; fecha a janela com 1 recusa sem kid e devolve a linha dos kids. */
function run(stream: AuthReject[], maxKids = 16): Top[] {
  const warn = jest.fn()
  let t = 0
  const log = authRejectLog({ warn }, 5, () => t, maxKids)
  for (const r of stream) log(r)
  t = 60_000
  log({ authClass: 'missing', route: 'GET /v1/x' })
  return (warn.mock.calls.map(c => c[1]).find(x => x && x.topKids)?.topKids ?? []) as Top[]
}

const rej = (kid: string): AuthReject => ({ authClass: 'unknown_kid', kid, route: 'GET /v1/x' })

/**
 * O ATACANTE ADAPTATIVO (guloso, vê o estado): [prefill] recusas forjadas enchem a tabela antes; o kid real chega a uma taxa FIXA (1 a cada
 * [every] recusas a partir de [lateStart] — a rotação mal publicada: toda sessão, toda requisição); em cada recusa forjada o atacante olha
 * o contador que o algoritmo despejaria (o 1º mínimo): se é o do real, manda um kid NOVO (despeja o real, inclusive no EMPATE); senão
 * REPETE aquele forjado (sobe o piso para o real virar o mínimo).
 */
function adaptive(n: number, every: number, m = 16, lateStart = 0, prefill = 0) {
  const mirror = new Mirror(m)
  const stream: AuthReject[] = []
  const REAL = 'unknown_kid:k-real'
  let fresh = 0, realCount = 0
  const push = (kid: string) => { stream.push(rej(kid)); mirror.add(`unknown_kid:${kid}`) }
  for (let i = 0; i < prefill; i++) push(`cheio${i % m}`)
  for (let i = 0; i < n; i++) {
    if (i >= lateStart && (i - lateStart) % every === 0) { push('k-real'); realCount++; continue }
    if (mirror.keys.length < m) { push(`novo${fresh++}`); continue }
    const t = mirror.firstMin()
    push(mirror.keys[t] === REAL ? `novo${fresh++}` : mirror.keys[t].slice('unknown_kid:'.length))
  }
  return { stream, mirror, realCount }
}

describe('D-F175 — o mínimo garantido contra um atacante ADAPTATIVO (o pior caso)', () => {
  it('[RESISTIU] PROPRIEDADE — o kid real ESTÁVEL acima de 1/m das recusas desde que apareceu (taxas 1/15…1/2), com 1, 2, 4 e 16 contadores, 400–6.000 recusas, a tabela já CHEIA antes (0–1.600 forjadas) e o real entrando tarde: contra o atacante que vê o estado, repete kids e usa os empates do desempate, o mínimo garantido do real é a sua contagem REAL — EXATA (uma vez dentro, a dívida dos forjados para alcançá-lo cresce a cada passo: m·p − 1 > 0) —; nenhuma contagem impressa passa da real; o espelho bate com o log (o atacante via o estado verdadeiro)', () => {
    let exact = 0
    for (const m of [1, 2, 4, 16]) {
      for (const every of [2, 3, 5, 8, 12, 15]) {
        for (const n of [400, 1_500, 6_000]) {
          for (const [lateStart, prefill] of [[0, 0], [37, 0], [0, 100 * m], [211, 100 * m]]) {
            const { stream, mirror, realCount } = adaptive(n, every, m, lateStart, prefill)
            const truth = new Map<string, number>()
            for (const r of stream) truth.set(r.kid!, (truth.get(r.kid!) ?? 0) + 1)
            const top = run(stream, m)
            const where = [m, every, n, lateStart, prefill]
            for (const x of top) expect([...where, x.kid, x.count <= truth.get(x.kid)!, x.count >= 1]).toEqual([...where, x.kid, true, true])
            const mirrored = mirror.keys.map((k, i) => [k.slice('unknown_kid:'.length), mirror.counts[i] - mirror.errors[i]] as const)
            expect(new Map(top.map(x => [x.kid, x.count]))).toEqual(new Map(mirrored))
            if (every >= m) continue                                                      // taxa ≤ 1/m: fora da promessa (D-F173) — só (i)/(iv)
            expect([...where, top.find(x => x.kid === 'k-real')?.count]).toEqual([...where, realCount])
            exact++
          }
        }
      }
    }
    expect(exact).toBeGreaterThan(90)                                                    // 96 combinações com a promessa (m=4: 1/2 e 1/3; m=16: todas)
  })

  it('[LIMITE CONHECIDO — D-F173, sem achado] ABAIXO de 1/16 (1 a cada 17 recusas) o mesmo atacante despeja o real a cada volta: ele ainda aparece na linha (estava dentro no fechamento), mas com mínimo garantido 1 e em ÚLTIMO — a garantia é só para quem passa de 1/16 (o texto da D-F173); e em EXATAMENTE 1/16 (1 a cada 16) o real fica com a contagem exata (a dívida não cresce, mas também não zera)', () => {
    const below = adaptive(6_000, 17)
    const topBelow = run(below.stream)
    const real = topBelow.find(x => x.kid === 'k-real')!
    expect([real.count, topBelow.indexOf(real), below.realCount > 300]).toEqual([1, topBelow.length - 1, true])
    const at = adaptive(6_000, 16)
    expect(run(at.stream).find(x => x.kid === 'k-real')?.count).toBe(at.realCount)
  })

  it('[RESISTIU] a JANELA que vira zera o erro: o kid que entrou com herança alta na janela 1 aparece com o mínimo garantido (1, não 51); na janela 2 começa do zero (a linha da janela 2 diz só o que ela viu, ordenada); o relógio que VOLTA também abre janela nova', () => {
    const warn = jest.fn()
    let t = 0
    const log = authRejectLog({ warn }, 5, () => t)
    for (let i = 0; i < 16; i++) for (let k = 0; k < 50; k++) log(rej(`cheio${i}`))       // 16 contadores com 50
    log(rej('tardio'))                                                                     // entra com erro 50
    t = 61_000
    for (let k = 0; k < 3; k++) log(rej('tardio'))                                        // janela 2: 3 recusas
    for (let k = 0; k < 6; k++) log(rej('outro'))
    t = 30_000                                                                             // o relógio VOLTOU
    log({ authClass: 'missing', route: 'GET /v1/x' })
    const lines = warn.mock.calls.map(c => c[1]).filter(x => x && x.topKids).map(x => x.topKids as Top[])
    expect(lines).toHaveLength(2)
    expect(lines[0].find(x => x.kid === 'tardio')?.count).toBe(1)
    expect(lines[0][0].count).toBe(50)
    expect(lines[1].map(x => [x.kid, x.count])).toEqual([['outro', 6], ['tardio', 3]])
  })
})
