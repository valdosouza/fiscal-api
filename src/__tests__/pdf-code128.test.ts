/// <reference types="jest" />
// NE-1b (D-NE118): o Code-128 híbrido C/A da NT Conjunta 2025.001 §6 — símbolos decididos pela peça pura, larguras pela lib, e o TESTE decodifica
// as barras com a tabela-oráculo própria (independente da lib e da produção).
import * as bwipjs from 'bwip-js'
import { code128Symbols, code128Bars, CODE128 } from '../pdf/barcode/code128'
import { decodeCode128 } from './pdf-oracle'

/** Chave de 44 posições no formato da NF-e: cUF AAMM CNPJ(12 alfanuméricos + 2 DV) mod série nNF tpEmis cNF cDV. */
function randomKey(rnd: () => number, cnpjBase?: string): string {
  const pick = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('')
  const D = '0123456789', AN = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  return `41${pick(D, 4)}${cnpjBase ?? pick(AN, 12)}${pick(D, 2)}55${pick(D, 3)}${pick(D, 9)}1${pick(D, 8)}${pick(D, 1)}`
}
/** Gerador determinístico (os testes de propriedade reproduzem). */
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}
/** Quantos símbolos de DADOS a lib usa no modo AUTOMÁTICO (referência de comprimento — ela troca para B onde a NT sugere A). */
function libAutoDataLength(text: string): number {
  const sbs = (bwipjs.raw('code128', text, '') as unknown as Array<{ sbs: number[] }>)[0].sbs
  return decodeCode128(sbs).values.length - 3                          // menos Start, DV e Stop
}

describe('NE-1b — Code-128 híbrido C/A pela NT Conjunta 2025.001 §6', () => {
  it('reproduz o EXEMPLO oficial "5225AB83": Start C, 52, 25, CODE A, A, B, CODE C, 83 — soma 1987, DV 30 — e a lib concorda com o nosso DV', () => {
    const s = code128Symbols('5225AB83')
    expect([s.start, ...s.data]).toEqual([105, 52, 25, 101, 33, 34, 99, 83])
    expect(s.data.reduce((sum, v, k) => sum + v * (k + 1), s.start)).toBe(1987)
    expect(s.check).toBe(30)
    const decoded = decodeCode128(code128Bars(s).widths)
    expect(decoded.text).toBe('5225AB83')
    expect(decoded.values).toEqual([105, 52, 25, 101, 33, 34, 99, 83, 30, 106])
  })

  it('CONHECIMENTO NEGATIVO: o texto da NT erra o "código 100" (100 = CODE B) e o "103 = Start C" (103 = Start A) — vale o exemplo dela', () => {
    expect(CODE128).toEqual({ START_A: 103, START_C: 105, CODE_A_FROM_C: 101, CODE_C_FROM_A: 99, STOP: 106 })
    const s = code128Symbols('5225AB83')
    expect(s.start).not.toBe(103)
    expect(s.data).not.toContain(100)
  })

  it('chave NUMÉRICA de 44 dígitos: Start C e 22 pares, sem troca de conjunto', () => {
    const key = '41261007742094000113550010000000071000000075'
    const s = code128Symbols(key)
    expect(s.start).toBe(CODE128.START_C)
    expect(s.data).toHaveLength(22)
    expect(s.data.every(v => v < 100)).toBe(true)
    expect(decodeCode128(code128Bars(s).widths).text).toBe(key)
  })

  it('regras 1–4 da NT nos casos que a definem', () => {
    const seq = (t: string) => { const s = code128Symbols(t); return [s.start, ...s.data] }
    // regra 2: começa em C com número ÍMPAR de dígitos antes da letra → CODE A antes do último dígito
    expect(seq('1234567A')).toEqual([105, 12, 34, 56, 101, 23, 33])
    // regra 3 (ímpar): 1º dígito em A, CODE C depois; regra 4: letra em C → CODE A antes dela
    expect(seq('AB12345C')).toEqual([103, 33, 34, 17, 99, 23, 45, 101, 35])
    // regra 3 (par): CODE C antes do grupo
    expect(seq('AB1234')).toEqual([103, 33, 34, 99, 12, 34])
    // grupo de 2 no meio fica em A (trocar não encurta)
    expect(seq('AB12C')).toEqual([103, 33, 34, 17, 18, 35])
    // grupo PAR até o fim volta para C (é o que o exemplo oficial faz)
    expect(seq('AB83')).toEqual([103, 33, 34, 99, 83])
    // começa com menos de 4 dígitos → Start A
    expect(seq('123A')).toEqual([103, 17, 18, 19, 33])
    // texto de exatamente 2 dígitos → Start C
    expect(seq('42')).toEqual([105, 42])
  })

  it('chaves ALFANUMÉRICAS (propriedade, 3000 chaves): o leitor decodifica a chave exata, nunca com mais símbolos que o automático da lib, e a simbologia cabe na largura mínima da NT', () => {
    const rnd = seeded(20261017)
    for (let n = 0; n < 3000; n++) {
      const key = randomKey(rnd)
      const s = code128Symbols(key)
      const bars = code128Bars(s)
      const decoded = decodeCode128(bars.widths)
      expect(decoded.text).toBe(key)
      expect(decoded.values).toEqual([s.start, ...s.data, s.check, 106])          // a lib desenhou EXATAMENTE os nossos símbolos e o nosso DV
      expect(s.data.length).toBeLessThanOrEqual(libAutoDataLength(key))
      // NT: 539 posições no pior caso (44 símbolos + margens + Start + DV + Stop) → 11,5 cm / 539 ≥ 0,02 cm
      expect(bars.modules + 20).toBeLessThanOrEqual(539)
    }
  })

  it('o pior caso de CNPJ alfanumérico (letra e dígito alternados) ainda dá módulo ≥ 0,02 cm em 11,5 cm', () => {
    for (const base of ['A1B2C3D4E5F6', 'ZZZZZZZZZZZZ', '1A2B3C4D5E6F', '0A0A0A0A0A0A']) {
      const key = randomKey(seeded(7), base)
      const bars = code128Bars(code128Symbols(key))
      expect(decodeCode128(bars.widths).text).toBe(key)
      expect(11.5 / (bars.modules + 20)).toBeGreaterThanOrEqual(0.02)
    }
  })

  it('qualquer texto [0-9A-Z] (propriedade, 3000 textos de 1 a 60): ida e volta pelo leitor', () => {
    const rnd = seeded(44)
    const AN = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    for (let n = 0; n < 3000; n++) {
      const len = 1 + Math.floor(rnd() * 60)
      const digitHeavy = rnd() < 0.5
      const text = Array.from({ length: len }, () => (digitHeavy && rnd() < 0.8 ? String(Math.floor(rnd() * 10)) : AN[Math.floor(rnd() * AN.length)])).join('')
      expect(decodeCode128(code128Bars(code128Symbols(text)).widths).text).toBe(text)
    }
  })

  it('recusa o que não é [0-9A-Z]: vazio, minúscula, espaço, acento, controle, não-texto', () => {
    for (const bad of ['', 'abc', '12 34', 'ÇA', '12\n34', '41-26', null, undefined, 123]) {
      expect(() => code128Symbols(bad as any)).toThrow(RangeError)
    }
  })

  it('a lib que devolvesse símbolo a mais ou a menos é recusada (larguras conferidas contra o pedido)', () => {
    jest.isolateModules(() => {
      jest.doMock('../pdf/barcode/lib', () => ({ code128Widths: () => [2, 1, 1, 2, 3, 2, 2, 3, 3, 1, 1, 1, 2] }))
      const { code128Bars: bars, code128Symbols: symbols } = require('../pdf/barcode/code128')
      expect(() => bars(symbols('12345678'))).toThrow(/tamanho diferente/)
    })
  })
})
