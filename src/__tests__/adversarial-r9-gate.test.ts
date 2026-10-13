/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA da Rodada 9 (2026-10-13 — skill Infra-IA/skills-genericas/testar-adversarial.md;
// prompt_apis_fiscais_isoladas.md §7 D-F170/D-F173). Alvo: núcleo `92811fc..fe71164` — só TEXTO: o JSDoc do `authRejectLog` passou a
// prometer "todo kid com MAIS DE 1/maxKids das recusas com kid da janela fica na lista (com 16 contadores, > N/16)" e registra o limite
// conhecido (D-F173). Aqui a frase nova é atacada contra o código: ela é VERDADE? para qual unidade?
// Convenção: `it('[RESISTIU] …')` = o ataque foi barrado; `it('[FATO …]')` = comportamento atual registrado.
// Nada aqui toca rede nem banco.
import { authRejectLog, AuthReject, AuthRejectClass } from '../auth/product-jwt'

type Top = { authClass: string; kid: string; count: number }
/** Roda um fluxo de recusas numa janela e fecha a janela com 1 recusa sem kid; devolve a linha dos kids mais frequentes (molde do gate R8). */
function windowOf(stream: AuthReject[], maxKids = 16): Top[] | undefined {
  const warn = jest.fn()
  let t = 0
  const log = authRejectLog({ warn }, 5, () => t, maxKids)
  for (const r of stream) log(r)
  t = 60_000
  log({ authClass: 'missing', route: 'GET /v1/nfse/x' })
  return warn.mock.calls.map(c => c[1]).find(m => m && m.topKids)?.topKids as Top[] | undefined
}

/** PRNG determinístico (mulberry32) — o teste de propriedade repete igual. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CLASSES: AuthRejectClass[] = ['unknown_kid', 'invalid', 'expired', 'identity_mismatch']

describe('D-F173 — a garantia escrita no JSDoc contra o código', () => {
  it('[RESISTIU] PROPRIEDADE — 1.500 janelas aleatórias (semente fixa; 200–3.000 recusas; 1–4 kids "pesados" com taxas sorteadas, o resto kids inventados distintos, 4 classes, ordem embaralhada): todo PAR (classe, kid) com MAIS DE N/16 das recusas com kid está na linha dos mais frequentes e a contagem listada NUNCA o subestima — a frase nova do JSDoc é verdadeira (a do R8, 1/17, era falsa)', () => {
    const rand = rng(20261013)
    let checked = 0
    for (let run = 0; run < 1500; run++) {
      const n = 200 + Math.floor(rand() * 2800)
      const heavy = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, i) => ({
        key: { authClass: CLASSES[Math.floor(rand() * CLASSES.length)], kid: `real${i}` },
        rate: 0.03 + rand() * 0.12,
      }))
      const stream: AuthReject[] = []
      let forged = 0
      for (let i = 0; i < n; i++) {
        const x = rand()
        let acc = 0
        const h = heavy.find(hv => (acc += hv.rate) > x)
        stream.push(h
          ? { ...h.key, route: 'GET /v1/x' }
          : { authClass: CLASSES[Math.floor(rand() * CLASSES.length)], kid: `f${run}_${forged++}`, route: 'GET /v1/x' })
      }
      const truth = new Map<string, number>()
      for (const r of stream) truth.set(`${r.authClass}:${r.kid}`, (truth.get(`${r.authClass}:${r.kid}`) ?? 0) + 1)
      const top = windowOf(stream) ?? []
      expect(top.length).toBeLessThanOrEqual(16)
      for (const [key, count] of truth) {
        if (count * 16 <= n) continue
        checked++
        const [authClass, kid] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
        const listed = top.find(x => x.authClass === authClass && x.kid === kid)
        expect([run, key, !!listed]).toEqual([run, key, true])
        expect(listed!.count).toBeGreaterThanOrEqual(count)
      }
    }
    expect(checked).toBeGreaterThan(500)                                              // a propriedade foi exercitada de verdade
  })

  it('[FATO — a unidade da garantia é o PAR (classe, kid), não o kid] o JSDoc diz "todo kid com mais de 1/16"; o contador é por "classe:kid": o MESMO kid com 9,1 % das recusas com kid (100 de 1.100) REPARTIDO em duas classes (50 "expired" + 50 "invalid" — cada par com 4,5 %, abaixo de 1/16) e depois 1.000 kids inventados distintos some da linha; as mesmas 100 numa classe só ficam. Hoje inofensivo: o caso da D-F157 (rotação mal publicada) cai numa classe só (`unknown_kid`) e a linha imprime pares — o texto é que ficou mais largo que a garantia (registro, sem achado)', () => {
    const stream = (split: boolean): AuthReject[] => {
      const s: AuthReject[] = []
      for (let i = 0; i < 100; i++) s.push({ authClass: split && i % 2 ? 'expired' : 'invalid', kid: 'k-real', route: 'GET /v1/x' })
      for (let f = 0; f < 1000; f++) s.push({ authClass: 'unknown_kid', kid: `forjado${f}`, route: 'GET /v1/x' })
      return s
    }
    expect(100 / 1100).toBeGreaterThan(1 / 16)                                         // o kid tem mais de 1/16 das recusas com kid
    expect((windowOf(stream(true)) ?? []).some(x => x.kid === 'k-real')).toBe(false)    // repartido em 2 classes: some
    expect((windowOf(stream(false)) ?? []).some(x => x.kid === 'k-real' && x.authClass === 'invalid')).toBe(true)   // numa só: fica
  })
})
