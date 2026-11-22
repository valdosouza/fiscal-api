// fiscal-api:FAMILIA.E5.P4.T3 — os dados públicos do responsável técnico vêm do ambiente, conferidos no boot (D-NE217).
// Ficha: projetos/fiscal-api/GERAL/ficha-familia-e5-p4-pecas-ne4.md §5 T3 e §6 ordem 2. CNPJs do vetor `federal-id/federal-id.vector.json`.
import { technicalResponsibleFromEnv, TECHNICAL_RESPONSIBLE_ENV as E } from '../technical-responsible/technical-responsible'
import * as barrel from '../index'

const OK = {
  [E.cnpj]: '11222333000181', [E.contactName]: 'Setes Software', [E.email]: 'contato@exemplo.com.br', [E.phone]: '4433334444',
}
const failure = (env: NodeJS.ProcessEnv): string => {
  try { technicalResponsibleFromEnv(env); return 'aceitou' } catch (e) { return (e as Error).message }
}

describe('FAMILIA.E5.P4.T3 — technicalResponsibleFromEnv (D-NE217)', () => {
  it('env completa e válida → o objeto, congelado (CNPJ numérico e alfanumérico)', () => {
    const r = technicalResponsibleFromEnv(OK)
    expect(r).toEqual({ cnpj: '11222333000181', contactName: 'Setes Software', email: 'contato@exemplo.com.br', phone: '4433334444' })
    expect(Object.isFrozen(r)).toBe(true)
    expect(technicalResponsibleFromEnv({ ...OK, [E.cnpj]: '12ABC34501DE35' }).cnpj).toBe('12ABC34501DE35')
  })

  it.each(Object.values(E))('falta %s → erro com o nome da variável', name => {
    const env = { ...OK }; delete env[name]
    expect(failure(env)).toContain(`${name} ausente`)
    expect(failure({ ...OK, [name]: '' })).toContain(`${name} ausente`)
  })

  it.each([
    [E.cnpj, '11222333000182'], [E.cnpj, '00000000000000'], [E.cnpj, '11.222.333/0001-81'], [E.cnpj, '12abc34501de35'],
    [E.cnpj, '1122233300018'],
    [E.contactName, 'S'], [E.contactName, 'x'.repeat(61)], [E.contactName, ' Setes'], [E.contactName, 'Setes '], [E.contactName, 'Setes €'],
    [E.email, 'a@b.c'], [E.email, 'contato.exemplo.com.br'], [E.email, ' a@exemplo.com'], [E.email, 'x'.repeat(55) + '@a.com.br'],
    [E.phone, '12345'], [E.phone, '123456789012345'], [E.phone, '(44) 3333-4444'], [E.phone, '44 33334444'],
  ])('%s = %j → recusa nomeando a variável', (name, value) => {
    expect(failure({ ...OK, [name]: value })).toContain(`${name} fora da forma`)
  })

  it('várias faltas numa mensagem só (o boot diz tudo de uma vez)', () => {
    const m = failure({ [E.cnpj]: 'x', [E.phone]: '1' })
    for (const name of Object.values(E)) expect(m).toContain(name)
  })

  it('sai pelo barrel do núcleo', () => {
    expect(barrel.technicalResponsibleFromEnv).toBe(technicalResponsibleFromEnv)
  })
})
