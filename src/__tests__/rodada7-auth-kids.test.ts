/// <reference types="jest" />
// D-F167 (= Q-F175 (b), Valdo 2026-10-13 — gate adversarial da Rodada 6, R6-ADV-01): a 1ª ocorrência de cada kid DISTINTO (por classe) na
// janela vai ao log ALÉM do limite por classe — o kid REAL de uma rotação mal publicada nunca some atrás de kids inventados
// (`prompt_apis_fiscais_isoladas.md` §7, §22.22).
import { authRejectLog } from '../auth/product-jwt'

describe('D-F167 — kid distinto no log do 401', () => {
  it('ruído com kids inventados ocupa a cota da classe, mas o kid NOVO ainda aparece (1ª ocorrência); o repetido não', () => {
    const warn = jest.fn()
    const log = authRejectLog({ warn }, 5, () => 0)
    for (let i = 0; i < 5; i++) log({ authClass: 'unknown_kid', kid: `ruido${i}`, route: 'GET /x' })
    log({ authClass: 'unknown_kid', kid: 'ruido0', route: 'GET /x' })                          // repetido, cota cheia: não
    log({ authClass: 'unknown_kid', kid: 'k2026-11', route: 'GET /x' })                         // o REAL: aparece
    expect(warn.mock.calls.map(c => c[1].kid)).toEqual(['ruido0', 'ruido1', 'ruido2', 'ruido3', 'ruido4', 'k2026-11'])
  })

  it('o conjunto é LIMITADO por janela (16): passou disso, vale só o limite por classe; a janela seguinte zera; o resumo conta só o que NÃO foi ao log', () => {
    const warn = jest.fn()
    let t = 0
    const log = authRejectLog({ warn }, 5, () => t, 16)
    for (let i = 0; i < 40; i++) log({ authClass: 'unknown_kid', kid: `f${i}`, route: 'GET /x' })
    expect(warn).toHaveBeenCalledTimes(16)
    t = 60_000
    log({ authClass: 'unknown_kid', kid: 'k2026-11', route: 'GET /x' })
    expect(warn.mock.calls[16][1]).toEqual({ authClass: 'unknown_kid', suppressed: 24, windowStartedAt: new Date(0).toISOString() })
    expect(warn.mock.calls[17][1].topKids).toHaveLength(16)                                  // D-F170: os kids mais frequentes da janela
    expect(warn.mock.calls[18][1].kid).toBe('k2026-11')
  })

  it('o mesmo kid em OUTRA classe conta como novo (expirado para uns, assinatura inválida para outros); sem kid só o limite por classe', () => {
    const warn = jest.fn()
    const log = authRejectLog({ warn }, 1, () => 0)
    log({ authClass: 'expired', kid: 'default', route: 'GET /x' })
    log({ authClass: 'invalid', kid: 'default', route: 'GET /x' })
    log({ authClass: 'invalid', kid: 'default', route: 'GET /x' })
    log({ authClass: 'missing', route: 'GET /x' })
    log({ authClass: 'missing', route: 'GET /x' })
    expect(warn.mock.calls.map(c => c[1].authClass)).toEqual(['expired', 'invalid', 'missing'])
  })
})
