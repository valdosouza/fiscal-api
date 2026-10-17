/**
 * Code-128 HÍBRIDO C/A (NT Conjunta 2025.001 §6 — CNPJ alfanumérico; D-NE118). Os SÍMBOLOS são decididos AQUI, pela regra da NT; a lib só
 * desenha (`./lib`). A tabela de larguras do Code-128 NÃO vive em produção — fica no teste, como oráculo independente da lib.
 *
 * Regras da NT (orientações "START, CODE e SHIFT"): (1) Start C quando o texto começa com 4+ dígitos; (2)/(4) em C, dígito ímpar sobrando ou
 * caractere não numérico → CODE A antes dele; (3) em A, grupo de 4+ dígitos → CODE C antes do grupo (par) ou depois do 1º dígito (ímpar).
 * Acréscimo para reproduzir o EXEMPLO oficial ("5225AB83" → … CODE C 83, DV 30): em A, grupo PAR de dígitos que vai até o FIM também volta
 * para C (mesmo comprimento; nunca acontece numa chave real — depois do CNPJ vêm sempre 26+ dígitos).
 *
 * CONHECIMENTO NEGATIVO — o TEXTO da NT erra duas vezes; vale o EXEMPLO dela: "código 100 para alternar os subtipos A e C" (100 é CODE B; de C
 * para A é 101, de A para C é 99) e "o valor 103 corresponde ao caractere de início (start) para o padrão Code C" (103 é Start A; Start C = 105).
 */
import { code128Widths } from './lib'

export const CODE128 = Object.freeze({ START_A: 103, START_C: 105, CODE_A_FROM_C: 101, CODE_C_FROM_A: 99, STOP: 106 })

export interface Code128Symbols {
  readonly start: number
  readonly data: readonly number[]
  /** (start + Σ valor × posição) mód. 103 — conferido contra a lib pelo teste. */
  readonly check: number
}

export interface Code128Bars {
  /** Larguras em MÓDULOS, alternando barra/espaço, começando por barra (Start … DV, Stop) — sem a margem clara. */
  readonly widths: readonly number[]
  /** Soma das larguras (módulos), sem a margem clara. */
  readonly modules: number
}

const ALPHABET = /^[0-9A-Z]+$/
const isDigit = (c: string): boolean => c >= '0' && c <= '9'
/** Conjunto A: ASCII 32–95 → 0–63 ('0' = 16, 'A' = 33). */
const valueInA = (c: string): number => c.charCodeAt(0) - 32

export function code128Symbols(text: string): Code128Symbols {
  if (typeof text !== 'string' || !ALPHABET.test(text)) {
    throw new RangeError('Code-128 da base: o texto tem de ter só dígitos e letras maiúsculas [0-9A-Z], ao menos 1')
  }
  const runAt = (i: number): number => { let j = i; while (j < text.length && isDigit(text[j])) j++; return j - i }
  const lead = runAt(0)
  let set: 'A' | 'C' = lead >= 4 || (lead === 2 && text.length === 2) ? 'C' : 'A'   // regra 1 (e o texto de exatamente 2 dígitos)
  const start = set === 'C' ? CODE128.START_C : CODE128.START_A
  const data: number[] = []
  let i = 0
  while (i < text.length) {
    const run = runAt(i)
    if (set === 'C') {
      if (run >= 2) { data.push(Number(text.slice(i, i + 2))); i += 2; continue }
      data.push(CODE128.CODE_A_FROM_C); set = 'A'                                    // regras 2 e 4
      continue
    }
    if (run >= 4 || (run >= 2 && run % 2 === 0 && i + run === text.length)) {     // regra 3 (+ grupo par até o fim — o exemplo da NT)
      if (run % 2 === 1) { data.push(valueInA(text[i])); i++ }
      data.push(CODE128.CODE_C_FROM_A); set = 'C'
      continue
    }
    data.push(valueInA(text[i])); i++
  }
  const check = data.reduce((sum, v, k) => sum + v * (k + 1), start) % 103
  return Object.freeze({ start, data: Object.freeze(data), check })
}

/** Os símbolos viram larguras pela lib (modo `raw`); quem desenha é `drawBars`. */
export function code128Bars(symbols: Code128Symbols): Code128Bars {
  const widths = code128Widths([symbols.start, ...symbols.data])
  // Start + dados + DV + Stop: 11 módulos por símbolo, 13 no Stop — a lib não pode ter acrescentado nem tirado símbolo
  const expected = 11 * (symbols.data.length + 2) + 13
  const modules = widths.reduce((a, b) => a + b, 0)
  if (modules !== expected || widths.length !== 6 * (symbols.data.length + 2) + 7) {
    throw new Error('a lib de símbolos devolveu um Code-128 de tamanho diferente do pedido')
  }
  return Object.freeze({ widths: Object.freeze(widths), modules })
}
