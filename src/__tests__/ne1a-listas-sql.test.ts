/// <reference types="jest" />
// NE-1a parte 2 — passo 3: D-NE69 (= Q-NE69 (a)) — as listas de kinds do SQL das famílias DERIVAM da classificação total (`KIND_CLASS`);
// `sqlKindList` só aceita kinds do vocabulário (as letras de UM fato o chamador acrescenta pelo nome).
import { KIND_CLASS, LIVE_VOICE_KINDS, AUTHORIZED_KINDS, FINAL_TRANSMISSION_KINDS, sqlKindList } from '../voice/kinds'
import { isLiveTransmission } from '../voice/reading'

describe('D-NE69 — listas derivadas da classificação total', () => {
  it('vivas COM voz = os kinds não finais (S, K, P) — complemento exato dos finais; a viva SEM voz é o outro caso de `isLiveTransmission`', () => {
    const all = Object.keys(KIND_CLASS)
    expect([...LIVE_VOICE_KINDS]).toEqual(['S', 'K', 'P'])
    expect(all.filter(k => !FINAL_TRANSMISSION_KINDS.has(k))).toEqual([...LIVE_VOICE_KINDS])
    expect(all.every(k => LIVE_VOICE_KINDS.has(k) === isLiveTransmission({ lastKind: k as any }))).toBe(true)
    expect(isLiveTransmission({ lastKind: null })).toBe(true)
  })
  it('imutável em execução (o conjunto vai para o texto do SQL — `.add` mudaria a regra do processo inteiro)', () => {
    expect(() => (LIVE_VOICE_KINDS as any).add('Z')).toThrow()
    expect(LIVE_VOICE_KINDS.has('Z')).toBe(false)
  })
  it('`sqlKindList`: lista literal na ordem dada; recusa o que não é kind (minúscula, sentinela, injeção) e a lista vazia', () => {
    expect(sqlKindList(AUTHORIZED_KINDS)).toBe("'A','N'")
    expect(sqlKindList([...LIVE_VOICE_KINDS, ...AUTHORIZED_KINDS, 'C'])).toBe("'S','K','P','A','N','C'")
    for (const bad of [['s'], ['-'], ["A') OR ('1'='1"], ['__proto__'], ['toString']]) expect(() => sqlKindList(bad)).toThrow(/fora do vocabulário/)
    expect(() => sqlKindList([])).toThrow(/vazia/)
  })
})
