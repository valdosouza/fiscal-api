/// <reference types="jest" />
// D-F175 (= Q-F183 (b), Valdo 2026-10-13 — gate adversarial da Rodada 8, R8-ADV-01): o Space-Saving guarda o ERRO de cada contador e a
// linha dos kids imprime o MÍNIMO GARANTIDO (`count − erro`) — o inventado visto uma vez não se passa pelo real (`prompt_apis_fiscais_isoladas.md`
// §7, §22.30).
import { authRejectLog } from '../auth/product-jwt'

const topOf = (warn: jest.Mock) => warn.mock.calls.map(c => c[1]).find(m => m && m.topKids)?.topKids as { authClass: string; kid: string; count: number }[]

describe('D-F175 — o mínimo GARANTIDO na linha dos kids', () => {
  it('o kid real (50) e os inventados que herdaram contagem: o real aparece com 50, cada inventado com o que de fato viu (~1) — nunca a herança', () => {
    const warn = jest.fn()
    let t = 0
    const log = authRejectLog({ warn }, 5, () => t)
    for (let i = 0; i < 50; i++) log({ authClass: 'unknown_kid', kid: 'k2026-11', route: 'GET /x' })
    for (let i = 0; i < 40; i++) log({ authClass: 'unknown_kid', kid: `inventado${i}`, route: 'GET /x' })
    t = 60_000
    log({ authClass: 'missing', route: 'GET /x' })
    const top = topOf(warn)
    expect(top[0]).toEqual({ authClass: 'unknown_kid', kid: 'k2026-11', count: 50 })
    expect(top.slice(1).every(x => x.count <= 1)).toBe(true)                          // a herança NÃO aparece como contagem
  })

  it('o mínimo garantido nunca passa da contagem real (propriedade em 500 janelas aleatórias) e a lista sai ordenada por ele', () => {
    let seed = 20261013
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let w = 0; w < 500; w++) {
      const warn = jest.fn()
      let t = 0
      const log = authRejectLog({ warn }, 5, () => t)
      const real: Record<string, number> = {}
      const n = 50 + Math.floor(rnd() * 400)
      for (let i = 0; i < n; i++) {
        const kid = rnd() < 0.3 ? 'quente' : `k${Math.floor(rnd() * 60)}`
        real[kid] = (real[kid] ?? 0) + 1
        log({ authClass: 'unknown_kid', kid, route: 'GET /x' })
      }
      t = 60_000
      log({ authClass: 'missing', route: 'GET /x' })
      const top = topOf(warn)
      for (const x of top) expect([w, x.kid, x.count <= real[x.kid], x.count >= 0]).toEqual([w, x.kid, true, true])
      for (let i = 1; i < top.length; i++) expect(top[i - 1].count >= top[i].count).toBe(true)
    }
  })
})
