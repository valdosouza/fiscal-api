import { notRegisteredProven, NOT_REGISTERED_CSTAT, type NotRegisteredQuestion } from '../voice/families/merchandise-proof'
import * as barrel from '../index'

/** FAMILIA.E5.P6.T2 — D-NE235: o 217 só prova "não registrada" nas condições da política (vetor nfe-consulta-reconfirm). */
const KEY = '35261112345678000195550010000000011000000015'
const ALNUM = '35261112AB345678000195550010000000011000000015'.slice(0, 44)
const base: NotRegisteredQuestion = {
  route: 'reconfirm', cStat: 217, queriedAccessKey: KEY, attemptAccessKey: KEY,
  answeredBy: 'PR', attemptAuthorizer: 'PR', receipt: null, lastKind: 'S', seenLastEvent: 3, currentLastEvent: 3,
}
const ask = (over: Partial<Record<keyof NotRegisteredQuestion, unknown>>) => notRegisteredProven({ ...base, ...over } as NotRegisteredQuestion)
const NO_VOICE = { lastKind: null, seenLastEvent: null, currentLastEvent: null }

describe('notRegisteredProven (D-NE235)', () => {
  it('217, chave igual, autorizador igual, sem recibo aberto, sem voz de registro e voz inalterada = provada', () => {
    expect(KEY).toHaveLength(44)
    expect(ask({})).toEqual({ proven: true, reason: 'provada' })
    expect(ask({ lastKind: 'F' }).proven).toBe(true)
    expect(ask({ lastKind: 'R' }).proven).toBe(true)                                                 // fechadas sem registro: a peça aceita (a reconfirm da nfe-api as devolve antes)
  })

  it('vetor: rota refresh e manual nunca provam', () => {
    expect(ask({ route: 'refresh' })).toEqual({ proven: false, reason: 'rota-nao-reconfirm' })
    expect(ask({ route: 'manual' }).reason).toBe('rota-nao-reconfirm')
  })

  it('outro cStat não prova (nem o 100, nem o 105)', () => {
    for (const c of [100, 105, 656, 0]) expect(ask({ cStat: c })).toEqual({ proven: false, reason: 'cstat-nao-217' })
    expect(NOT_REGISTERED_CSTAT).toBe(217)
  })

  it('vetor: chNFe diferente não prova — nem por um caractere, nem por caixa; chave fora do formato de 44 não prova nem igual a si mesma', () => {
    expect(ask({ queriedAccessKey: KEY.slice(0, 43) + '6' }).reason).toBe('chave-diferente')
    expect(ALNUM).toHaveLength(44)
    expect(ask({ attemptAccessKey: ALNUM, queriedAccessKey: ALNUM.toLowerCase() }).reason).toBe('chave-diferente')
    expect(ask({ attemptAccessKey: ALNUM, queriedAccessKey: ALNUM }).proven).toBe(true)
    for (const bad of ['x', ' ', 'undefined', KEY.slice(0, 43), KEY + '0', KEY.slice(0, 43) + '-']) {
      expect(ask({ attemptAccessKey: bad, queriedAccessKey: bad })).toEqual({ proven: false, reason: 'chave-diferente' })
    }
  })

  it('respondeu outro autorizador que o gravado na tentativa: não prova (D-NE37)', () => {
    expect(ask({ answeredBy: 'SVRS' }).reason).toBe('autorizador-diferente')
  })

  it('vetor: recibo 103/105 em aberto não prova (voz P, ou recibo sem voz final); recibo com a voz já final (R/F) não impede', () => {
    expect(ask({ receipt: '411000000000001', lastKind: 'P' }).reason).toBe('recibo-em-aberto')
    expect(ask({ lastKind: 'P' }).reason).toBe('recibo-em-aberto')                                 // P é o recibo em andamento, mesmo sem o texto do recibo
    expect(ask({ receipt: '411000000000001', ...NO_VOICE }).reason).toBe('recibo-em-aberto')
    expect(ask({ receipt: '411000000000001', lastKind: 'S' }).reason).toBe('recibo-em-aberto')
    expect(ask({ receipt: '411000000000001', lastKind: 'R' }).proven).toBe(true)
    expect(ask({ receipt: '411000000000001', lastKind: 'F' }).proven).toBe(true)
  })

  it('o caso de uso da D-NE235: a tentativa em voo SEM recibo (sem voz, ou S) é a que o 217 prova — a transmissão interrompida', () => {
    expect(ask(NO_VOICE)).toEqual({ proven: true, reason: 'provada' })
    expect(ask({ lastKind: 'S' })).toEqual({ proven: true, reason: 'provada' })
  })

  it('voz de registro do fisco — A, N, C, D — e cancelamento em voo (K) nunca admitem o 217 como prova', () => {
    for (const k of ['A', 'N', 'C', 'D', 'K']) expect(ask({ lastKind: k })).toEqual({ proven: false, reason: 'voz-de-registro' })
  })

  it('vetor: a última voz mudou entre a pergunta e agora = não prova', () => {
    expect(ask({ seenLastEvent: 3, currentLastEvent: 4 })).toEqual({ proven: false, reason: 'voz-mudou' })
    expect(ask({ seenLastEvent: 3, currentLastEvent: null }).reason).toBe('voz-mudou')
    expect(ask({ ...NO_VOICE, currentLastEvent: 1 }).reason).toBe('voz-mudou')                        // a voz nasceu depois da pergunta
    expect(ask({ lastKind: 'F', seenLastEvent: 1, currentLastEvent: 1 }).proven).toBe(true)
  })

  it('ordem das recusas: a primeira que falha é o motivo', () => {
    expect(ask({ route: 'refresh', cStat: 100, queriedAccessKey: 'x' }).reason).toBe('rota-nao-reconfirm')
    expect(ask({ cStat: 100, queriedAccessKey: 'x' }).reason).toBe('cstat-nao-217')
    expect(ask({ queriedAccessKey: 'x', answeredBy: 'SVRS' }).reason).toBe('chave-diferente')
    expect(ask({ answeredBy: 'SVRS', lastKind: 'P' }).reason).toBe('autorizador-diferente')
    expect(ask({ lastKind: 'P', currentLastEvent: 9 }).reason).toBe('recibo-em-aberto')
    expect(ask({ lastKind: 'A', currentLastEvent: 9 }).reason).toBe('voz-de-registro')
  })

  it('campo ausente, vazio ou torto = entrada-invalida (falha fechado, sem valor padrão)', () => {
    const bad: Array<Partial<Record<keyof NotRegisteredQuestion, unknown>>> = [
      { route: 'reconfirma' }, { route: undefined }, { cStat: '217' }, { cStat: 217.5 }, { cStat: NaN },
      { queriedAccessKey: '' }, { queriedAccessKey: undefined }, { attemptAccessKey: null }, { answeredBy: '' },
      { attemptAuthorizer: undefined }, { receipt: '' }, { receipt: undefined }, { receipt: 5 },
      { lastKind: 'Z' }, { lastKind: undefined }, { lastKind: 'toString' }, { lastKind: '__proto__' },
      { seenLastEvent: undefined }, { seenLastEvent: -1 }, { seenLastEvent: 0 }, { seenLastEvent: 1.5 }, { currentLastEvent: '3' },
      { currentLastEvent: 0 },
      // consistência cruzada: voz sem evento e evento sem voz (a mesma leitura)
      { lastKind: 'A', seenLastEvent: null }, { lastKind: null, seenLastEvent: 3 },
    ]
    for (const b of bad) expect(ask(b)).toEqual({ proven: false, reason: 'entrada-invalida' })
    expect(notRegisteredProven(null as never)).toEqual({ proven: false, reason: 'entrada-invalida' })
    expect(notRegisteredProven(undefined as never).reason).toBe('entrada-invalida')
  })

  it('a entrada é copiada e só conta o que é dela: getter que muda e propriedade herdada não enganam', () => {
    let n = 0
    const shifty = { ...base } as Record<string, unknown>
    Object.defineProperty(shifty, 'route', { enumerable: true, get: () => (n++ === 0 ? 'refresh' : 'reconfirm') })
    expect(notRegisteredProven(shifty as never).proven).toBe(false)
    expect(notRegisteredProven(Object.create(base)).reason).toBe('entrada-invalida')
  })

  it('o veredito é congelado e a peça só sai pelo barrel, nunca por fiscal-api/reading', () => {
    expect(Object.isFrozen(ask({}))).toBe(true)
    expect(barrel.notRegisteredProven).toBe(notRegisteredProven)
  })
})
