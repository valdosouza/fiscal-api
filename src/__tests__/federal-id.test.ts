// Inscrição federal (D-CJ2 — frente do CNPJ alfanumérico, Valdo 2026-10-15): a regra única TS contra o VETOR OFICIAL de casos — o
// mesmo arquivo que a suíte Dart do `setes_validators` lê (espelho garantido por construção, não por cópia).
import {
  canonicalizeFederalIdText, cnpjCheckDigits, federalIdOf, formatCnpj, formatCpf, isValidCnpj, isValidCpf, mod11Ascii48, normalizeCnpj,
  normalizeCpf, readFederalIdFact, CNPJ_FORM, FEDERAL_ID_MASK_LITERALS,
} from '../federal-id'
import * as surface from '../federal-id'
import * as barrel from '../index'
import vector from '../federal-id/federal-id.vector.json'

describe('D-CJ2 — inscrição federal contra o vetor oficial', () => {
  it.each(vector.cnpjValidos.map(c => [c.valor, c.origem]))('CNPJ válido %s (%s)', valor => {
    expect(isValidCnpj(valor)).toBe(true)
    expect(federalIdOf('cnpj', valor)).toEqual({ kind: 'cnpj', value: valor })
  })
  it.each(vector.cnpjInvalidos.map(c => [c.valor, c.motivo]))('CNPJ inválido %j (%s)', valor => {
    expect(isValidCnpj(valor)).toBe(false)
    expect(federalIdOf('cnpj', valor)).toBeNull()
  })
  it.each(vector.normalizarCnpj.map(c => [c.entrada, c.saida]))('normalizar %j → %j (canonicaliza, nunca apaga)', (entrada, saida) => {
    expect(normalizeCnpj(entrada)).toBe(saida)
  })
  it.each(vector.canonicalizarTexto.map(c => [c.entrada, c.saida]))('canonicalizar texto %j → %j', (entrada, saida) => {
    expect(canonicalizeFederalIdText(entrada)).toBe(saida)
  })
  it.each(vector.formatarCnpj.map(c => [c.valor, c.saida]))('formatar %s → %s', (valor, saida) => {
    expect(formatCnpj(valor)).toBe(saida)
  })
  it.each(vector.dvCnpj.map(c => [c.base, c.dv]))('DV de %s = %s (ASCII − 48, pesos 2…9 recomeçando)', (base, dv) => {
    expect(cnpjCheckDigits(base)).toBe(dv)
  })
  it('CPF segue numérico', () => {
    for (const v of vector.cpfValidos) expect([v, isValidCpf(v), normalizeCpf(v)]).toEqual([v, true, v])
    for (const v of vector.cpfInvalidos) expect([v, isValidCpf(v)]).toEqual([v, false])
    for (const c of vector.formatarCpf) expect(formatCpf(c.valor)).toBe(c.saida)
    expect(normalizeCpf('529.982.247-25')).toBe('52998224725')
  })
})

describe('D-CJ2 — o que a peça promete além do vetor', () => {
  it('a primitiva mod11 recusa o que não é [0-9A-Z] (nunca calcula sobre minúscula ou máscara)', () => {
    expect(() => mod11Ascii48('12abc')).toThrow(RangeError)
    expect(() => mod11Ascii48('12.34')).toThrow(RangeError)
    expect(() => mod11Ascii48('')).toThrow(RangeError)
    expect(cnpjCheckDigits('12abc34501de')).toBeNull()
  })
  it('a forma canônica do CNPJ: 12 alfanuméricos maiúsculos + 2 DV NUMÉRICOS', () => {
    expect(CNPJ_FORM.test('ZZZZZZZZZZZZ00')).toBe(true)
    expect(CNPJ_FORM.test('ZZZZZZZZZZZZ0Z')).toBe(false)
    expect(FEDERAL_ID_MASK_LITERALS).toEqual(['.', '/', '-', ' '])
    expect(Object.isFrozen(FEDERAL_ID_MASK_LITERALS)).toBe(true)
  })
  it('não é string → inválido (nunca lança na fronteira)', () => {
    for (const v of [null, undefined, 11222333000181, {}, ['11222333000181']]) {
      expect(isValidCnpj(v)).toBe(false)
      expect(isValidCpf(v)).toBe(false)
      expect(normalizeCnpj(v)).toBeNull()
      expect(canonicalizeFederalIdText(v)).toBeNull()
    }
  })
  it('o tipo vem de quem chama (o LUGAR) — um CPF válido não vira CNPJ pelo comprimento, nem o contrário', () => {
    expect(federalIdOf('cnpj', '52998224725')).toBeNull()
    expect(federalIdOf('cpf', '11222333000181')).toBeNull()
    expect(Object.isFrozen(federalIdOf('cnpj', '11222333000181'))).toBe(true)
  })
  it('fato gravado em TRÊS estados: ausente ≠ inválido ≠ válido; o sentinela "0" do CNPJ é ausente (D-CJ5); nada é normalizado', () => {
    expect(readFederalIdFact('cnpj', null)).toEqual({ state: 'absent' })
    expect(readFederalIdFact('cnpj', undefined)).toEqual({ state: 'absent' })
    expect(readFederalIdFact('cnpj', '')).toEqual({ state: 'absent' })
    expect(readFederalIdFact('cnpj', '   ')).toEqual({ state: 'absent' })
    expect(readFederalIdFact('cnpj', '0')).toEqual({ state: 'absent' })
    expect(readFederalIdFact('cpf', '0')).toEqual({ state: 'invalid', raw: '0' })
    expect(readFederalIdFact('cnpj', '12.ABC.345/01DE-35')).toEqual({ state: 'invalid', raw: '12.ABC.345/01DE-35' })
    expect(readFederalIdFact('cnpj', 'pc3d315k000193')).toEqual({ state: 'invalid', raw: 'pc3d315k000193' })
    expect(readFederalIdFact('cnpj', '11222333000182')).toEqual({ state: 'invalid', raw: '11222333000182' })
    expect(readFederalIdFact('cnpj', 'PC3D315K000193')).toEqual({ state: 'valid', id: { kind: 'cnpj', value: 'PC3D315K000193' } })
    expect(readFederalIdFact('cpf', '52998224725')).toEqual({ state: 'valid', id: { kind: 'cpf', value: '52998224725' } })
  })
  it('a superfície `fiscal-api/federal-id` = o módulo inteiro, e o barrel também carrega a peça', () => {
    const mod = require('../federal-id/federal-id')
    expect(Object.keys(surface).sort()).toEqual(Object.keys(mod).sort())
    for (const n of Object.keys(mod)) expect([n, n in barrel]).toEqual([n, true])
  })
})
