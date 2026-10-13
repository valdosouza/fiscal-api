/// <reference types="jest" />
// D-F170 (= Q-F178 (b), Valdo 2026-10-13 — gate socrático da Rodada 7, R7-SOC-01): o resumo da janela lista os kids MAIS FREQUENTES
// (Space-Saving, 16 contadores — memória fixa): o kid de uma rotação mal publicada nunca some atrás de kids inventados
// (`prompt_apis_fiscais_isoladas.md` §7, §22.24).
import { authRejectLog } from '../auth/product-jwt'

const topOf = (warn: jest.Mock) => warn.mock.calls.map(c => c[1]).find(m => m && m.topKids)?.topKids as { authClass: string; kid: string; count: number }[] | undefined

describe('D-F170 — os kids mais frequentes no resumo da janela', () => {
  it('16 kids FORJADOS no começo esgotam o conjunto da D-F167, mas o kid REAL (50 recusas) é o 1º do resumo da janela seguinte', () => {
    const warn = jest.fn()
    let t = 0
    const log = authRejectLog({ warn }, 5, () => t)
    for (let i = 0; i < 16; i++) log({ authClass: 'unknown_kid', kid: `forjado${i}`, route: 'GET /x' })
    for (let i = 0; i < 50; i++) log({ authClass: 'unknown_kid', kid: 'k2026-11', route: 'GET /x' })
    expect(warn.mock.calls.some(c => c[1].kid === 'k2026-11')).toBe(false)              // o cenário do R7-SOC-01
    t = 60_000
    log({ authClass: 'missing', route: 'GET /x' })
    const top = topOf(warn)!
    expect(top[0]).toMatchObject({ authClass: 'unknown_kid', kid: 'k2026-11' })
    expect(top[0].count).toBeGreaterThanOrEqual(50)                                    // Space-Saving: herda o mínimo (51) — nunca subestima
  })

  it('1.000 kids distintos (um de cada) intercalados com 100 recusas do kid real: ele FICA na lista (Space-Saving com 16 contadores: > N/16 das recusas — R8-SOC-01)', () => {
    const warn = jest.fn()
    let t = 0
    const log = authRejectLog({ warn }, 5, () => t)
    for (let i = 0; i < 1000; i++) {
      log({ authClass: 'unknown_kid', kid: `ruido${i}`, route: 'GET /x' })
      if (i % 10 === 0) log({ authClass: 'unknown_kid', kid: 'k2026-11', route: 'GET /x' })
    }
    t = 60_000
    log({ authClass: 'missing', route: 'GET /x' })
    const top = topOf(warn)!
    expect(top.length).toBeLessThanOrEqual(16)
    expect(top[0].kid).toBe('k2026-11')
    expect(top[0].count).toBeGreaterThanOrEqual(100)                                   // Space-Saving nunca subestima
  })

  it('janela SEM supressão não gera a linha dos kids (cada recusa já foi ao log); a janela seguinte zera os contadores', () => {
    const warn = jest.fn()
    let t = 0
    const log = authRejectLog({ warn }, 5, () => t)
    for (let i = 0; i < 3; i++) log({ authClass: 'unknown_kid', kid: 'k1', route: 'GET /x' })
    t = 60_000
    log({ authClass: 'missing', route: 'GET /x' })
    expect(topOf(warn)).toBeUndefined()
    for (let i = 0; i < 9; i++) log({ authClass: 'expired', kid: 'default', route: 'GET /x' })
    t = 120_000
    log({ authClass: 'missing', route: 'GET /x' })
    expect(topOf(warn)).toEqual([{ authClass: 'expired', kid: 'default', count: 9 }])
  })
})
