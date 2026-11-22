/// <reference types="jest" />
// fiscal-api:FAMILIA.E5.P3.T2 — D-NE158 (= Q-NE158 (b), Valdo 2026-10-20), executada na janela da NE-6: a família de MERCADORIA entra no
// catálogo `VOICE_READINGS` e `assertFamilyViewsReadable` perde o valor padrão (cada chamador diz o que confere). A superfície
// `fiscal-api/reading` (merchandise, numbering, habilitação) é a ordem 3 da ficha — cerca `ne1a-superficie` e o bloco "superfície" abaixo.
import { VOICE_READINGS } from '../voice/families'
import { MERCHANDISE_VOICE_READING } from '../voice/families/merchandise'
import { SERVICE_VOICE_READING } from '../voice/families/service'
import { assertFamilyViewsReadable, ReadQueryable } from '../voice/family-reader'

const fake = () => {
  const calls: string[] = []
  const q: ReadQueryable = { query: jest.fn(async (sql: string) => { calls.push(sql); return [[], []] as [any, any] }) }
  return { q, calls }
}

describe('o catálogo — as duas famílias, congelado', () => {
  it('`service` e `merchandise`, cada ramo com a SUA leitura publicada; o objeto e as leituras são imutáveis', () => {
    expect(Object.keys(VOICE_READINGS)).toEqual(['service', 'merchandise'])
    expect(VOICE_READINGS.service).toBe(SERVICE_VOICE_READING)
    expect(VOICE_READINGS.merchandise).toBe(MERCHANDISE_VOICE_READING)
    for (const [branch, r] of Object.entries(VOICE_READINGS)) expect([branch, r!.branch]).toEqual([branch, branch])
    expect(Object.values(VOICE_READINGS).map(r => r!.transmissionView)).toEqual(['vw_invoice_service_transmission', 'vw_invoice_merchandise_transmission'])
    expect(Object.isFrozen(VOICE_READINGS) && Object.isFrozen(MERCHANDISE_VOICE_READING)).toBe(true)
    expect(() => { (VOICE_READINGS as any).merchandise = SERVICE_VOICE_READING }).toThrow(TypeError)
    expect(() => { delete (VOICE_READINGS as any).merchandise }).toThrow(TypeError)
  })
})

describe('assertFamilyViewsReadable SEM valor padrão — cada chamador passa o que confere', () => {
  it('a chamada sem a lista NÃO COMPILA (o tsc do `ts-jest` derruba este arquivo se a diretiva ficar sem uso) e, vinda de JS, falha ALTO com o motivo', async () => {
    const { q, calls } = fake()
    // @ts-expect-error — D-NE158: o 3º parâmetro é obrigatório desde a janela da NE-6
    await expect(assertFamilyViewsReadable(q, 'fiscal_api')).rejects.toThrow(/catálogo de famílias vazio — cada chamador passa a lista que confere \(D-NE158\)/)
    await expect(assertFamilyViewsReadable(q, 'fiscal_api', [])).rejects.toThrow(/catálogo de famílias vazio/)
    await expect(assertFamilyViewsReadable(q, 'fiscal_api', null as any)).rejects.toThrow(/catálogo de famílias vazio/)
    expect(calls).toEqual([])
  })
  it('confere exatamente o que foi passado: uma família, a outra, ou o catálogo inteiro', async () => {
    for (const [readings, views] of [
      [[SERVICE_VOICE_READING], ['vw_invoice_service_transmission']],
      [[MERCHANDISE_VOICE_READING], ['vw_invoice_merchandise_transmission']],
      [Object.values(VOICE_READINGS), ['vw_invoice_service_transmission', 'vw_invoice_merchandise_transmission']],
    ] as [any[], string[]][]) {
      const { q, calls } = fake()
      await assertFamilyViewsReadable(q, 'fiscal_api', readings)
      expect(calls.map(c => /FROM `fiscal_api`\.(vw_[a-z_]+) v WHERE 1 = 0$/.exec(c)?.[1])).toEqual(views)
    }
  })
})
