/// <reference types="jest" />
// GATE ADVERSARIAL da ONDA 0 da frente do CNPJ alfanumérico (skill `testar-adversarial.md`, 2026-10-15) — núcleo (`fiscal-api/federal-id`).
// Ataque que RESISTIU = teste verde que fixa a garantia. Achado CONFIRMADO = teste que FALHAVA, marcado `[ACHADO <SEVERIDADE>]` no título;
// os 4 LOW do gate foram CORRIGIDOS na mesma sessão de entrega (títulos `[CORRIGIDO na sessão — ACHADO LOW]`; prompt da frente §8.7).
// Nada de banco, nada de rede.
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  canonicalizeFederalIdText, cnpjCheckDigits, isValidCnpj, isValidCpf, normalizeCnpj, normalizeCpf, readFederalIdFact, mod11Ascii48,
} from '../federal-id'
import { validateIssuerPair, pkcs12ToPem } from '../secret/certificate'
import { FsFiscalStorage } from '../storage/fiscal-storage'
import { makePfx } from './helpers'

const V = 'PC3D315K000193'                           // CNPJ de teste da SVRS — válido

// ---------------------------------------------------------------------------------------------------------------------------------------
// Promessa 1 — normalizar = canonicalizar, NUNCA apagar; qualquer caractere fora de [0-9A-Za-z./- ] invalida
// ---------------------------------------------------------------------------------------------------------------------------------------
describe('P1 — Unicode que o toUpperCase/NFKC tornaria ASCII nunca entra calado (RESISTIU)', () => {
  it.each([
    ['ı (i sem ponto — toUpperCase = I)', '12ıBC34501DE35'],
    ['ſ (s longo — toUpperCase = S)', 'ſ2ABC34501DE35'],
    ['ﬁ (ligadura — toUpperCase = FI)', '12ABC34501Dﬁ5'],
    ['K (sinal Kelvin)', '12ABC34501DE3K'],
    ['dígito árabe-índico', '١1222333000181'],
    ['dígito de largura total', '１1222333000181'],
    ['dígito devanágari', '१1222333000181'],
    ['NBSP no meio', '12ABC 34501DE35'],
    ['zero-width space no meio', '12ABC​34501DE35'],
    ['zero-width joiner no meio', '12ABC‍34501DE35'],
    ['tab no meio', '12ABC\t34501DE35'],
    ['quebra de linha no meio', '12ABC\n34501DE35'],
    ['combinante (A + acento agudo)', '12ÁBC34501DE35'],
    ['emoji', '12ABC34501DE35\u{1F600}'],
    ['NUL', '12ABC34501DE35\u0000'],
    ['sublinhado', '12_ABC34501DE35'],
    ['vírgula', '12,ABC34501DE35'],
    ['zero-width space na PONTA (não é espaço para o trim)', '​' + V],
    ['NEL na ponta (o trim do JS não o tira)', '\u0085' + V],
    ['separador vogal mongol na ponta', '᠎' + V],
  ])('%s → inválido (null), nunca "limpo"', (_l, entrada) => {
    expect(canonicalizeFederalIdText(entrada)).toBeNull()
    expect(normalizeCnpj(entrada)).toBeNull()
    expect(normalizeCpf(entrada)).toBeNull()
    expect(isValidCnpj(entrada)).toBe(false)
  })

  it('nenhum caractere fora de [0-9A-Za-z./- ] sobrevive à canonicalização — varredura do BMP inteiro (exceto o branco das pontas)', () => {
    const leaks: string[] = []
    for (let cp = 0; cp <= 0xFFFF; cp++) {
      if (cp >= 0xD800 && cp <= 0xDFFF) continue
      const ch = String.fromCharCode(cp)
      if (/[0-9A-Za-z./\- ]/.test(ch)) continue
      const out = canonicalizeFederalIdText(`12${ch}AB`)                   // no MEIO: o trim nunca o alcança
      if (out !== null) leaks.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}→${out}`)
    }
    expect(leaks).toEqual([])
  })

  it('não-string nunca é canonicalizado (bigint, Symbol, array, objeto com toString, Buffer)', () => {
    const tricky = [11222333000181n, Symbol('x'), [V], { toString: () => V }, Buffer.from(V), new String(V), true, NaN]
    for (const t of tricky) {
      expect(canonicalizeFederalIdText(t)).toBeNull()
      expect(normalizeCnpj(t)).toBeNull()
      expect(isValidCnpj(t)).toBe(false)
      expect(isValidCpf(t)).toBe(false)
    }
  })

  it('string gigante (5 MB) não trava nem estoura: linear, e o resultado é o da regra', () => {
    const t0 = Date.now()
    expect(canonicalizeFederalIdText('A'.repeat(5_000_000))).toHaveLength(5_000_000)
    expect(canonicalizeFederalIdText('a'.repeat(5_000_000) + '%')).toBeNull()
    expect(normalizeCnpj('1'.repeat(5_000_000))).toBeNull()
    expect(isValidCnpj('1'.repeat(5_000_000))).toBe(false)
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('o branco das PONTAS segue a definição do JavaScript (fixa a semântica que o espelho Dart precisa reproduzir — ver o teste Dart)', () => {
    // aparados pelo trim do JS (Unicode White_Space + BOM): a canonicalização devolve o CNPJ
    for (const ws of [' ', '﻿', ' ', ' ', '　', ' ', ' ', ' ', ' ', '\u000B', '\u000C', '\t', '\n', '\r']) {
      expect([JSON.stringify(ws), canonicalizeFederalIdText(ws + V + ws)]).toEqual([JSON.stringify(ws), V])
    }
    // NÃO aparados pelo JS: NEL (U+0085) e U+180E — o texto vira inválido
    for (const ws of ['\u0085', '᠎']) expect([JSON.stringify(ws), canonicalizeFederalIdText(ws + V)]).toEqual([JSON.stringify(ws), null])
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Promessa 2 — DV oficial ASCII − 48 (fora do vetor): implementação INDEPENDENTE (tabela de pesos da esquerda para a direita, Manual Serpro)
// ---------------------------------------------------------------------------------------------------------------------------------------
const W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
const W2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
function oracleDv(base12: string): string {
  const dv = (s: string, w: number[]) => { const r = [...s].reduce((a, c, i) => a + (c.charCodeAt(0) - 48) * w[i], 0) % 11; return r < 2 ? 0 : 11 - r }
  const d1 = dv(base12, W1)
  return `${d1}${dv(base12 + d1, W2)}`
}
/** O algoritmo NUMÉRICO que o setes-api tinha antes desta onda (removido de `validators.ts`) — o "cálculo de sempre". */
function legacyNumericIsValidCnpj(cnpj: string): boolean {
  if (!/^\d{14}$/.test(cnpj)) return false
  if (/^(\d)\1{13}$/.test(cnpj)) return false
  const digits = cnpj.split('').map(Number)
  for (const position of [12, 13]) {
    let weight = position - 7, sum = 0
    for (let i = 0; i < position; i++) { sum += digits[i] * weight; weight = weight === 2 ? 9 : weight - 1 }
    const rest = sum % 11
    if ((rest < 2 ? 0 : 11 - rest) !== digits[position]) return false
  }
  return true
}
let seed = 20261015
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

describe('P2 — DV ASCII − 48 contra um ORÁCULO independente, fora do vetor (RESISTIU)', () => {
  it('5.000 raízes alfanuméricas aleatórias: DV da peça = DV do oráculo; o CNPJ montado é válido e qualquer outro DV não', () => {
    for (let n = 0; n < 5000; n++) {
      const base = Array.from({ length: 12 }, () => ALNUM[Math.floor(rnd() * 36)]).join('')
      const dv = cnpjCheckDigits(base)
      expect([base, dv]).toEqual([base, oracleDv(base)])
      const wrong = String((Number(dv![1]) + 1 + Math.floor(rnd() * 9)) % 10)
      expect(isValidCnpj(base + dv)).toBe(!/^(\d)\1{13}$/.test(base + dv))   // só os 14 dígitos iguais são vetados
      expect(isValidCnpj(base + dv![0] + wrong)).toBe(false)
    }
  })
  it('CNPJ NUMÉRICO: a peça decide EXATAMENTE como o algoritmo numérico antigo (20.000 aleatórios + os válidos de cada raiz)', () => {
    for (let n = 0; n < 20000; n++) {
      const s = Array.from({ length: 14 }, () => String(Math.floor(rnd() * 10))).join('')
      expect([s, isValidCnpj(s)]).toEqual([s, legacyNumericIsValidCnpj(s)])
      const base = s.slice(0, 12), ok = base + cnpjCheckDigits(base)
      expect([ok, isValidCnpj(ok)]).toEqual([ok, legacyNumericIsValidCnpj(ok)])
    }
  })
  it('mod11Ascii48 recusa o que o ASCII − 48 tornaria número (pontuação abaixo de 0x30 daria peso NEGATIVO)', () => {
    for (const bad of ['12/AB', "12'AB", '12 AB', '12\u0000AB', 'ab', '١٢']) expect(() => mod11Ascii48(bad)).toThrow(RangeError)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Fato gravado em três estados — tipos que não são texto
// ---------------------------------------------------------------------------------------------------------------------------------------
describe('readFederalIdFact — fato do ERP que não é texto', () => {
  it('número e Buffer (o que o mysql2 pode devolver) são lidos pelo texto — fixa a semântica (RESISTIU)', () => {
    expect(readFederalIdFact('cnpj', 11222333000181)).toEqual({ state: 'valid', id: { kind: 'cnpj', value: '11222333000181' } })
    expect(readFederalIdFact('cnpj', 1222333000181)).toMatchObject({ state: 'invalid' })   // zero à esquerda perdido = inválido, nunca "consertado"
    expect(readFederalIdFact('cnpj', Buffer.from(V))).toEqual({ state: 'valid', id: { kind: 'cnpj', value: V } })
    expect(readFederalIdFact('cnpj', 0)).toEqual({ state: 'absent' })                       // o sentinela '0' (D-CJ5) também como número
  })
  it('[CORRIGIDO na sessão — ACHADO LOW] array de 1 elemento e objeto com toString NÃO são fato de CNPJ — o `String(raw)` os tornava VÁLIDOS (confusão de tipo)', () => {
    expect(readFederalIdFact('cnpj', [V]).state).not.toBe('valid')
    expect(readFederalIdFact('cnpj', { toString: () => V }).state).not.toBe('valid')
  })
  it('[CORRIGIDO na sessão — ACHADO LOW] validateIssuerPair com um "fato" que não é FederalIdFact (array/objeto qualquer) recusa legível (422) — estourava TypeError (500)', () => {
    const pair = pkcs12ToPem(makePfx({ cn: 'SETES:12345678000195', password: 'p' }).pfx, 'p')
    let err: any = null
    try { validateIssuerPair(pair.certPem, pair.keyPem, ['12345678000195'] as any) } catch (e) { err = e }
    expect(err).toMatchObject({ statusCode: 422 })
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Arquivo fiscal — a pasta é a forma canônica; nada sai da pasta do CNPJ
// ---------------------------------------------------------------------------------------------------------------------------------------
describe('FsFiscalStorage — CNPJ alfanumérico e nomes hostis (RESISTIU)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-cnpj-'))
  const st = new FsFiscalStorage(root)
  const when = new Date('2026-10-15T12:00:00Z')
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
  it.each([['../../x'], ['PC3D315K000193/..'], ['PC3D315K000193́'], ['ＰC3D315K000193'], ['PC3D315K000193\u0000'], [' PC3D315K000193']])(
    'CNPJ hostil %j recusado (nunca vira outra pasta)', bad => {
      expect(() => st.save({ cnpj: bad, kind: 'nfse', serie: 1, environment: 'P', zone: 'UTC' }, 'A-nfse.xml', '<a/>', when)).toThrow(/CNPJ inválido para o arquivo fiscal/)
    })
  it('nome de arquivo com separador/traversal recusado mesmo com CNPJ alfanumérico válido', () => {
    const key = { cnpj: V, kind: 'nfse' as const, serie: 1, environment: 'P' as const, zone: 'UTC' }
    for (const name of ['../x-nfse.xml', '..\\x-nfse.xml', 'a/b-nfse.xml']) expect(() => st.save(key, name, '<a/>', when)).toThrow(/Nome de arquivo fiscal inválido/)
    expect(st.find(key, '../x-nfse.xml', [])).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Promessa 6 — cercas D-CJ12: o predicado (arquivo GÊMEO `federal-id-fence.ts` dos 3 repositórios TS) contra formas de mutilação
// (prova manual feita contra a 1ª versão: arquivo temporário em src/ com cada forma → `npx jest federal-id-fence` PASSOU → escapou;
// corrigido na sessão: o predicado saiu do texto da cerca para o arquivo gêmeo e foi alargado)
// ---------------------------------------------------------------------------------------------------------------------------------------
const WORKSPACE = path.resolve(__dirname, '..', '..', '..')
const PREDICATES = [
  path.join(WORKSPACE, 'fiscal-api', 'src', '__tests__', 'federal-id-fence.ts'),
  path.join(WORKSPACE, 'nfse-api', 'src', '__tests__', 'federal-id-fence.ts'),
  path.join(WORKSPACE, 'setes-api', 'src', 'test-setup', 'federal-id-fence.ts'),
]

/** O predicado de cada repositório, carregado do arquivo gêmeo dele. */
function fencePredicate(file: string): (code: string) => boolean {
  const { strippingHitsIn } = require(file) as { strippingHitsIn: (code: string) => string[] }
  return code => strippingHitsIn(code).length > 0
}

describe('P6 — cerca federal-id-fence (D-CJ12) nos 3 repositórios TS', () => {
  it('os três predicados existem e são o MESMO arquivo (gêmeos — fins de linha normalizados)', () => {
    const texts = PREDICATES.map(f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))
    expect(new Set(texts).size).toBe(1)
  })
  it.each(PREDICATES.map(f => [path.relative(WORKSPACE, f)]))('%s pega as formas que ela promete (RESISTIU)', rel => {
    const caught = fencePredicate(path.join(WORKSPACE, rel))
    for (const code of ["x.replace(/\\D/g, '')", "x.replaceAll(/\\D/g, '')", "x?.replace(/[^0-9]/g, '')", "x.replace(/[^\\d]+/g, '')", "x.replace(/\\D+/g, '')"]) {
      expect([code, caught(code)]).toEqual([code, true])
    }
  })
  it.each(PREDICATES.map(f => [path.relative(WORKSPACE, f)]))('[CORRIGIDO na sessão — ACHADO LOW] %s pega as mutilações equivalentes que a 1ª versão deixava escapar', rel => {
    const caught = fencePredicate(path.join(WORKSPACE, rel))
    const escapes = [
      "cnpj.split(/\\D/).join('')",                                  // split + join
      "cnpj.replace(new RegExp('\\\\D', 'g'), '')",                  // RegExp construído
      "(cnpj.match(/\\d/g) ?? []).join('')",                         // match dos dígitos
      "cnpj.replace(/[A-Z]/g, '')",                                   // tira as LETRAS (o CNPJ alfanumérico vira outro número)
      "cnpj.replace(/[^0-9.]/g, '')",                                 // classe negada com um caractere a mais
      "cnpj.replace(/[^0123456789]/g, '')",                           // classe negada por extenso
      "cnpj['replace'](/\\D/g, '')",                                  // acesso por índice
      "String.prototype.replace.call(cnpj, /\\D/g, '')",              // .call
      "[...cnpj].filter(c => c >= '0' && c <= '9').join('')",        // filtro por caractere
    ]
    expect(escapes.filter(code => !caught(code))).toEqual([])
  })
})
