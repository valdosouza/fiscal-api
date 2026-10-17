/// <reference types="jest" />
// NE-1b (D-NE32/D-NE119): a matriz do QR — decodificada por um leitor INDEPENDENTE (jsQR, só devDependency) a partir da imagem montada aqui.
import { qrMatrix } from '../pdf/barcode/qr'
import { readQr } from './pdf-oracle'

describe('NE-1b — QR da base de PDF', () => {
  const URLS = [
    'https://www.sefaz.pr.gov.br/nfce/qrcode?p=4126104ABC2DEF000135650010000000071000000075|3|1',
    'https://www.nfe.fazenda.gov.br/portal/consultaRecaptcha.aspx?tipoConsulta=resumo&nfe=41261007742094000113550010000000071000000075',
  ]

  it('o leitor independente lê de volta exatamente o texto (URL com chave numérica e alfanumérica)', () => {
    for (const url of URLS) {
      const m = qrMatrix(url, { ecLevel: 'M' })
      expect(m.rows).toHaveLength(m.size)
      expect(m.rows.every(r => r.length === m.size)).toBe(true)
      expect(readQr(m)).toBe(url)
    }
  })

  it('os quatro níveis de correção decodificam; mais correção nunca dá matriz menor', () => {
    let last = 0
    for (const ecLevel of ['L', 'M', 'Q', 'H'] as const) {
      const m = qrMatrix(URLS[0], { ecLevel })
      expect(readQr(m)).toBe(URLS[0])
      expect(m.size).toBeGreaterThanOrEqual(last)
      last = m.size
    }
  })

  it('recusa texto fora do ASCII imprimível (a codificação dos bytes ficaria por conta da lib) e nível desconhecido', () => {
    for (const bad of ['', 'ação', 'linha\nnova', 'tab\t', '€', null as any]) expect(() => qrMatrix(bad, { ecLevel: 'M' })).toThrow(RangeError)
    expect(() => qrMatrix('ok', { ecLevel: 'X' as any })).toThrow(RangeError)
    expect(() => qrMatrix('ok', undefined as any)).toThrow(RangeError)
  })

  it('a matriz devolvida é congelada (quem desenha não altera o símbolo)', () => {
    const m = qrMatrix('ABC', { ecLevel: 'L' })
    expect(Object.isFrozen(m)).toBe(true)
    expect(Object.isFrozen(m.rows)).toBe(true)
    expect(Object.isFrozen(m.rows[0])).toBe(true)
  })
})
