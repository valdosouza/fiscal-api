/// <reference types="jest" />
// Fase IBS/CBS — fiscal-api:IBS.E1.P1 (D-IB124…D-IB126, `prompt_fase_ibs_cbs.md` §15): o LEITOR dos valores de IBS/CBS que o fisco calculou
// para a NFS-e. A view é da nfse-api (nasce em `nfse-api:IBS.E4.P1`, com a prova ao vivo); aqui se prova o CONTRATO contra um driver falso —
// o núcleo não copia o DDL da família.
import fs from 'fs'
import path from 'path'
import {
  SERVICE_AUTHORITY_IBSCBS_VIEW, SERVICE_AUTHORITY_IBSCBS_COLUMNS, serviceAuthorityIbscbsSelect, serviceAuthorityIbscbsQuery,
  mapServiceAuthorityIbscbs, readServiceAuthorityIbscbs, serviceAuthorityIbscbsOf, assertServiceAuthorityIbscbsViewReadable,
} from '../voice/families/service-authority-ibscbs'
import { invoiceRef, WEB_TERMINAL } from '../ref/invoice-ref'
import { currentOf } from '../voice/reading'
import * as reading from '../reading'
import * as barrel from '../index'

const REF = invoiceRef(1, 8014, WEB_TERMINAL)
const LIFE = 3
const ASKED = { ref: REF, lifeEvent: LIFE }
// a prova em H de 2026-11-01 (nota 8014): vTotNF 10,00 · IBS 0,01 · CBS 0,09 (RF-NFS-08; vetor VTN-010)
const line = (over: Record<string, unknown> = {}) => ({
  institutionId: 1, invoiceId: 8014, terminal: 0, attempt: 2, lifeEvent: 3, totalInvoiceValue: '10.00', ibsTotalValue: '0.01', cbsValue: '0.09', ...over,
})
const fake = (rows: unknown) => {
  const calls: { sql: string; params: unknown[] }[] = []
  const q: any = { query: jest.fn(async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return [rows] }) }
  return { q, calls }
}
const NAMES = ['SERVICE_AUTHORITY_IBSCBS_VIEW', 'SERVICE_AUTHORITY_IBSCBS_COLUMNS', 'serviceAuthorityIbscbsSelect', 'serviceAuthorityIbscbsQuery',
  'mapServiceAuthorityIbscbs', 'readServiceAuthorityIbscbs', 'serviceAuthorityIbscbsOf', 'assertServiceAuthorityIbscbsViewReadable']

describe('o contrato da view e a consulta — nota inteira e vida OBRIGATÓRIAS, tudo por parâmetro', () => {
  it('o SELECT publicado: as cinco colunas da chave e da vida cruas, os três valores por CAST … AS CHAR, sobre a view da família', () => {
    expect(SERVICE_AUTHORITY_IBSCBS_VIEW).toBe('vw_invoice_service_transmission_ibscbs')
    expect(SERVICE_AUTHORITY_IBSCBS_COLUMNS).toEqual([
      ['tb_institution_id', 'institutionId'], ['tb_invoice_id', 'invoiceId'], ['terminal', 'terminal'], ['attempt', 'attempt'], ['life_event', 'lifeEvent'],
      ['total_invoice_value', 'totalInvoiceValue', 'decimal'], ['ibs_total_value', 'ibsTotalValue', 'decimal'], ['cbs_value', 'cbsValue', 'decimal'],
    ])
    expect(serviceAuthorityIbscbsSelect('fiscal_api').replace(/\s+/g, ' ')).toBe(
      'SELECT v.tb_institution_id AS institutionId, v.tb_invoice_id AS invoiceId, v.terminal AS terminal, v.attempt AS attempt, v.life_event AS lifeEvent, '
      + 'CAST(v.total_invoice_value AS CHAR) AS totalInvoiceValue, CAST(v.ibs_total_value AS CHAR) AS ibsTotalValue, CAST(v.cbs_value AS CHAR) AS cbsValue '
      + 'FROM `fiscal_api`.vw_invoice_service_transmission_ibscbs v')
    expect(serviceAuthorityIbscbsSelect('fiscal_api', 'x')).toContain('CAST(x.cbs_value AS CHAR) AS cbsValue')
  })
  it('a lista de colunas é congelada em profundidade (ninguém troca a coluna do SELECT publicado)', () => {
    expect(Object.isFrozen(SERVICE_AUTHORITY_IBSCBS_COLUMNS)).toBe(true)
    expect(SERVICE_AUTHORITY_IBSCBS_COLUMNS.every(Object.isFrozen)).toBe(true)
    expect(() => { (SERVICE_AUTHORITY_IBSCBS_COLUMNS as any)[5][0] = 'cbs_value' }).toThrow()
    expect(() => { (SERVICE_AUTHORITY_IBSCBS_COLUMNS as any).push(['x', 'x']) }).toThrow()
  })
  it('a consulta filtra a nota inteira (terminal por parâmetro — D-NE12) e a vida (D-F119), em ordem de tentativa', () => {
    const { sql, params } = serviceAuthorityIbscbsQuery('fiscal_api', REF, LIFE)
    expect(sql).toMatch(/ v WHERE v\.tb_institution_id = \? AND v\.tb_invoice_id = \? AND v\.terminal = \? AND v\.life_event = \? ORDER BY v\.attempt$/)
    expect(params).toEqual([1, 8014, 0, 3])
    expect(sql).not.toMatch(/terminal = 0/)                                                    // nunca o terminal como literal
    expect(serviceAuthorityIbscbsQuery('fiscal_api', invoiceRef(1, 8014, 7), LIFE).params).toEqual([1, 8014, 7, 3])   // nota de PDV
  })
  it('o terminal 0 (web) PASSA; eixo ausente ou torto é erro de quem chama — nunca "sem valores" calado', () => {
    expect(() => serviceAuthorityIbscbsQuery('fiscal_api', invoiceRef(1, 8014, 0), LIFE)).not.toThrow()
    const bad: [unknown, unknown, RegExp][] = [
      [{ ...REF, institutionId: 0 }, LIFE, /estabelecimento inválido/], [{ ...REF, institutionId: undefined }, LIFE, /estabelecimento/],
      [{ ...REF, institutionId: '1' }, LIFE, /estabelecimento/], [{ ...REF, invoiceId: 0 }, LIFE, /nota inválido/],
      [{ ...REF, invoiceId: 1.5 }, LIFE, /nota/], [{ ...REF, invoiceId: null }, LIFE, /nota/],
      [{ ...REF, terminal: undefined }, LIFE, /terminal inválido/], [{ ...REF, terminal: -1 }, LIFE, /terminal inválido/],
      [{ ...REF, terminal: '0' }, LIFE, /terminal inválido/], [{ ...REF, terminal: 0.5 }, LIFE, /terminal inválido/],
      [undefined, LIFE, /estabelecimento/], [null, LIFE, /estabelecimento/],
      [REF, undefined, /vida da nota inválido/], [REF, 0, /vida da nota/], [REF, '3', /vida da nota/], [REF, 1.5, /vida da nota/], [REF, null, /vida da nota/],
    ]
    for (const [ref, life, re] of bad) expect(() => serviceAuthorityIbscbsQuery('fiscal_api', ref as any, life as any)).toThrow(re)
    expect(() => serviceAuthorityIbscbsQuery('fiscal_api; DROP', REF, LIFE)).toThrow(/Banco fiscal inválido/)
    expect(() => serviceAuthorityIbscbsQuery(undefined as any, REF, LIFE)).toThrow(/Banco fiscal inválido/)
    expect(() => serviceAuthorityIbscbsQuery('fiscal_api', REF, LIFE, 'v; --')).toThrow(/Alias/)
    expect(() => serviceAuthorityIbscbsQuery('fiscal_api', REF, LIFE, 'V')).toThrow(/Alias/)
  })
})

describe('a leitura — mapa ESTRITO (valor como TEXTO decimal; view torta nunca entra numa conferência de título)', () => {
  it('mapeia as linhas (inteiros como vêm do driver — número ou texto), congeladas, na ordem do banco; os valores seguem TEXTO', async () => {
    // o driver falso entrega 2 antes de 1: o leitor NÃO reordena (a ordem é a do ORDER BY do SELECT publicado)
    const { q, calls } = fake([line({ institutionId: '1', invoiceId: '8014', terminal: '0', attempt: '2', lifeEvent: '3' }), line({ attempt: 1, totalInvoiceValue: '9.00' })])
    const out = await readServiceAuthorityIbscbs(q, 'fiscal_api', REF, LIFE)
    expect(out).toEqual([line(), line({ attempt: 1, totalInvoiceValue: '9.00' })])
    expect(out.every(Object.isFrozen)).toBe(true)
    for (const row of out) {
      for (const field of ['totalInvoiceValue', 'ibsTotalValue', 'cbsValue'] as const) expect([field, typeof row[field]]).toEqual([field, 'string'])
      for (const field of ['institutionId', 'invoiceId', 'terminal', 'attempt', 'lifeEvent'] as const) expect([field, typeof row[field]]).toEqual([field, 'number'])
    }
    expect(out[0].totalInvoiceValue).toBe('10.00')                                             // o texto da view, sem passar por número
    expect(calls).toHaveLength(1)
    expect(calls[0].params).toEqual([1, 8014, 0, 3])
    expect(calls[0].sql).toContain('FROM `fiscal_api`.vw_invoice_service_transmission_ibscbs v WHERE')
  })
  it("'0.00' e o maior DECIMAL(17,2) são valores válidos (zero calculado pelo fisco não é ausência)", () => {
    const row = mapServiceAuthorityIbscbs(line({ totalInvoiceValue: '999999999999999.99', ibsTotalValue: '0.00', cbsValue: '0.00' }), ASKED)
    expect(row).toMatchObject({ totalInvoiceValue: '999999999999999.99', ibsTotalValue: '0.00', cbsValue: '0.00' })
  })
  it('valor fora do texto decimal canônico falha ALTO — número do JS (view sem o CAST), notação, espaço, zero à esquerda, sinal, casas, 16 dígitos, vírgula, nulo', () => {
    const bad: unknown[] = [10, 10.5, 0, '10', '10.0', '10.000', '1e3', ' 10.00', '10.00 ', '010.00', '00.00', '-1.00', '+1.00', '1000000000000000.00', '10,00', '.50', '', null, undefined, true, {}, [], Buffer.from('10.00')]
    for (const field of ['totalInvoiceValue', 'ibsTotalValue', 'cbsValue']) {
      for (const v of bad) expect(() => mapServiceAuthorityIbscbs(line({ [field]: v }), ASKED)).toThrow(/fora do texto decimal canônico/)
    }
    expect(() => mapServiceAuthorityIbscbs(line({ totalInvoiceValue: 10 }), ASKED)).toThrow(/vTotNF/)
    expect(() => mapServiceAuthorityIbscbs(line({ ibsTotalValue: null }), ASKED)).toThrow(/vIBSTot/)
    expect(() => mapServiceAuthorityIbscbs(line({ cbsValue: '0,09' }), ASKED)).toThrow(/vCBS/)
  })
  it('inteiro não canônico, linha de OUTRA nota, terminal ou vida, e linha que não é objeto falham ALTO', () => {
    for (const [over, re] of [
      [{ attempt: 0 }, /tentativa inválido/], [{ attempt: '1e3' }, /tentativa inválido/], [{ attempt: ' 2 ' }, /tentativa inválido/], [{ attempt: '02' }, /tentativa inválido/],
      [{ attempt: 1.5 }, /tentativa inválido/], [{ attempt: null }, /tentativa inválido/], [{ attempt: '99999999999999999999' }, /tentativa inválido/],
      [{ institutionId: 0 }, /estabelecimento inválido/], [{ invoiceId: -1 }, /nota inválido/], [{ terminal: -1 }, /terminal inválido/], [{ terminal: null }, /terminal inválido/],
      [{ lifeEvent: 0 }, /vida inválido/], [{ lifeEvent: undefined }, /vida inválido/],
      [{ institutionId: 2 }, /fora da nota\/vida pedida/], [{ invoiceId: 8015 }, /fora da nota\/vida pedida/], [{ terminal: 1 }, /fora da nota\/vida pedida/], [{ lifeEvent: 4 }, /fora da nota\/vida pedida/],
    ] as [Record<string, unknown>, RegExp][]) {
      expect(() => mapServiceAuthorityIbscbs(line(over), ASKED)).toThrow(re)
    }
    for (const r of [null, undefined, 'x', 7]) expect(() => mapServiceAuthorityIbscbs(r, ASKED)).toThrow(/Linha da view dos valores do fisco inválida/)
    // quem chama o mapa direto também responde pelos eixos pedidos
    expect(() => mapServiceAuthorityIbscbs(line(), undefined as any)).toThrow(/estabelecimento/)
    expect(() => mapServiceAuthorityIbscbs(line(), { ref: REF } as any)).toThrow(/vida da nota/)
  })
  it('tentativa repetida = view torta (os valores são 1:1 da tentativa) — falha ALTO, nunca "a primeira"', async () => {
    await expect(readServiceAuthorityIbscbs(fake([line({ attempt: 1 }), line(), line()]).q, 'fiscal_api', REF, LIFE)).rejects.toThrow(/tentativa 2 mais de uma vez/)
  })
  it('lista vazia = sem valores (nunca zero); driver sem lista de linhas = defeito de quem chamou; eixo torto nem chega ao banco', async () => {
    expect(await readServiceAuthorityIbscbs(fake([]).q, 'fiscal_api', REF, LIFE)).toEqual([])
    for (const rows of [undefined, null, { affectedRows: 0 }, 'x']) {
      await expect(readServiceAuthorityIbscbs(fake(rows).q, 'fiscal_api', REF, LIFE)).rejects.toThrow(/não devolveu linhas/)
    }
    const { q, calls } = fake([])
    await expect(readServiceAuthorityIbscbs(q, 'fiscal_api', REF, 0)).rejects.toThrow(/vida da nota/)
    await expect(readServiceAuthorityIbscbs(q, 'fiscal_api', { ...REF, terminal: undefined } as any, LIFE)).rejects.toThrow(/terminal inválido/)
    expect(calls).toHaveLength(0)
  })
})

describe('o seletor — os valores da tentativa VIGENTE (a regra da vigente é só a do `currentOf`)', () => {
  const tx = (attempt: number, authorityRecorded: boolean, over: Record<string, unknown> = {}) => ({ institutionId: 1, invoiceId: 8014, terminal: 0, lifeEvent: 3, attempt, authorityRecorded, ...over })
  const rows = [mapServiceAuthorityIbscbs(line({ attempt: 1, totalInvoiceValue: '9.00' }), ASKED), mapServiceAuthorityIbscbs(line(), ASKED)]

  it('devolve a linha da tentativa vigente; sem vigente, sem linhas ou sem linha DELA = null (não conferido, nunca zero)', () => {
    const current = currentOf([tx(1, false), tx(2, true), tx(3, false)])                       // a registrada (2), não a última
    expect(serviceAuthorityIbscbsOf(current, rows)).toBe(rows[1])
    expect(serviceAuthorityIbscbsOf(tx(1, false), rows)).toBe(rows[0])
    expect(serviceAuthorityIbscbsOf(null, rows)).toBeNull()
    expect(serviceAuthorityIbscbsOf(current, [])).toBeNull()
    expect(serviceAuthorityIbscbsOf(tx(3, true), rows)).toBeNull()                             // limite conhecido: valores só na tentativa antiga
  })
  it('a vigente e as linhas têm de ser da MESMA nota e vida — mesma tentativa de OUTRA nota nunca empresta os valores', () => {
    for (const over of [{ invoiceId: 8015 }, { institutionId: 2 }, { terminal: 1 }, { lifeEvent: 4 }]) {
      expect(() => serviceAuthorityIbscbsOf(tx(2, true, over) as any, rows)).toThrow(/serviceAuthorityIbscbsOf: lista mistura/)
    }
    // chave ausente ou de outro tipo na vigente nunca conta como "a mesma nota" (nem com linhas igualmente tortas: undefined === undefined)
    for (const [over, re] of [[{ invoiceId: undefined }, /vigente com invoiceId inválido/], [{ lifeEvent: '3' }, /vigente com lifeEvent inválido/],
      [{ terminal: null }, /vigente com terminal inválido/], [{ institutionId: undefined }, /vigente com institutionId inválido/]] as [Record<string, unknown>, RegExp][]) {
      expect(() => serviceAuthorityIbscbsOf(tx(2, true, over) as any, rows)).toThrow(re)
    }
    const noLife = [{ ...rows[1], lifeEvent: undefined }] as any
    expect(() => serviceAuthorityIbscbsOf(tx(2, true, { lifeEvent: undefined }) as any, noLife)).toThrow(/vigente com lifeEvent inválido/)
    const other = mapServiceAuthorityIbscbs(line({ invoiceId: 8015, attempt: 3 }), { ref: invoiceRef(1, 8015, 0), lifeEvent: 3 })
    expect(() => serviceAuthorityIbscbsOf(tx(2, true), [...rows, other])).toThrow(/lista mistura invoiceId/)
  })
  it('vigente ou lista tortas falham ALTO', () => {
    expect(() => serviceAuthorityIbscbsOf(undefined as any, rows)).toThrow(/vigente inválida/)
    expect(() => serviceAuthorityIbscbsOf(7 as any, rows)).toThrow(/vigente inválida/)
    expect(() => serviceAuthorityIbscbsOf(tx(0, true), rows)).toThrow(/tentativa da vigente inválida/)
    expect(() => serviceAuthorityIbscbsOf({ ...tx(2, true), attempt: '2' } as any, rows)).toThrow(/tentativa da vigente/)
    expect(() => serviceAuthorityIbscbsOf(tx(2, true), undefined as any)).toThrow(/lista de valores inválida/)
    expect(() => serviceAuthorityIbscbsOf(tx(2, true), [...rows, rows[1]])).toThrow(/tentativa 2 aparece mais de uma vez/)
  })
})

describe('boot e superfície', () => {
  it('a conferência do boot pergunta `WHERE 1 = 0` à view publicada e falha ALTO com o código do erro e a decisão', async () => {
    const { q, calls } = fake([])
    await assertServiceAuthorityIbscbsViewReadable(q, 'fiscal_api')
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toMatch(/^SELECT v\.tb_institution_id AS institutionId, /)
    expect(calls[0].sql).toMatch(/FROM `fiscal_api`\.vw_invoice_service_transmission_ibscbs v WHERE 1 = 0$/)
    const bad = (e: object): any => ({ query: jest.fn(async () => { throw Object.assign(new Error('x'), e) }) })
    await expect(assertServiceAuthorityIbscbsViewReadable(bad({ errno: 1142 }), 'fiscal_api')).rejects.toThrow(/valores de IBS\/CBS do fisco \(fiscal_api\.vw_invoice_service_transmission_ibscbs\).*1142.*migration da view \(nfse-api\).*D-IB126/)
    await expect(assertServiceAuthorityIbscbsViewReadable(bad({ code: 'ER_NO_SUCH_TABLE', errno: 1146 }), 'fiscal_api')).rejects.toThrow(/ER_NO_SUCH_TABLE/)
    await expect(assertServiceAuthorityIbscbsViewReadable(bad({}), 'fiscal_api')).rejects.toThrow(/\(erro\)/)
    await expect(assertServiceAuthorityIbscbsViewReadable(q, 'fiscal_api; DROP')).rejects.toThrow(/Banco fiscal inválido/)   // erro de quem chama, com a mensagem dele
  })
  it('D-IB125: a peça sai pelo barrel e NADA dela sai por `fiscal-api/reading` até o 1º leitor', () => {
    for (const n of NAMES) expect([n, n in barrel, n in reading]).toEqual([n, true, false])
    // nem pelo índice das famílias (a superfície faz `export *` dele) nem pelo catálogo da voz (catálogo de views de TENTATIVAS)
    // nenhum módulo que a superfície re-exporta (a lista de `ne1a-superficie.test.ts`) cita a peça — nem por `export type`, que não deixa nome em execução
    for (const rel of ['reading.ts', 'voice/kinds.ts', 'voice/reading.ts', 'voice/family-reader.ts', 'voice/view-query.ts', 'voice/families/service.ts',
      'voice/families/index.ts', 'ref/invoice-ref.ts']) {
      expect([rel, /service-authority-ibscbs|ServiceAuthorityIbscbs/.test(fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8'))]).toEqual([rel, false])
    }
    expect(Object.values(barrel.VOICE_READINGS).map(r => r!.transmissionView)).not.toContain(SERVICE_AUTHORITY_IBSCBS_VIEW)
    expect(Object.keys(reading).filter(n => /ibscbs/i.test(n))).toEqual([])
  })
  it('a peça só importa a referência da nota, a projeção comum, o SQL interno e o tipo do driver — e só lê a VIEW publicada, nunca a tabela', () => {
    const code = fs.readFileSync(path.resolve(__dirname, '..', 'voice', 'families', 'service-authority-ibscbs.ts'), 'utf8')
    const imports = [...code.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort()
    expect(imports).toEqual(['../../ref/invoice-ref', '../family-reader', '../reading'])
    const bare = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
    expect(bare).not.toMatch(/\btb_invoice_service_transmission_ibscbs\b/)
    expect(bare).not.toMatch(/\btb_invoice_service_transmission\b/)
    expect(bare).not.toMatch(/parseFloat|parseInt|toFixed/)                                    // valor nunca vira número do JS (o mapa: `typeof` acima)
    expect((bare.match(/\bNumber\(/g) ?? []).length).toBe(1)                                   // o único `Number(` é o dos inteiros da chave
    expect(bare).not.toMatch(/FOR UPDATE|LOCK IN SHARE MODE|INSERT|UPDATE |DELETE /)           // só SELECT, sem trava
  })
})

describe('gates de 2026-11-17 (socrático 0,84 · adversarial 0,86, sem HIGH) — os achados viram regressão', () => {
  it('M1: eixo acima do INT é erro de quem chama (iria ao banco e voltaria "sem valores" calado); o teto do INT passa', () => {
    const MAX = 2_147_483_647
    for (const big of [MAX + 1, 2 ** 53, 1e21, Number.MAX_VALUE, Infinity]) {
      expect(() => serviceAuthorityIbscbsQuery('fiscal_api', { ...REF, institutionId: big }, LIFE)).toThrow(/estabelecimento inválido/)
      expect(() => serviceAuthorityIbscbsQuery('fiscal_api', { ...REF, invoiceId: big }, LIFE)).toThrow(/nota inválido/)
      expect(() => serviceAuthorityIbscbsQuery('fiscal_api', { ...REF, terminal: big }, LIFE)).toThrow(/terminal inválido/)
      expect(() => serviceAuthorityIbscbsQuery('fiscal_api', REF, big)).toThrow(/vida da nota inválido/)
    }
    expect(serviceAuthorityIbscbsQuery('fiscal_api', invoiceRef(MAX, MAX, MAX), MAX).params).toEqual([MAX, MAX, MAX, MAX])
    for (const over of [{ institutionId: MAX + 1 }, { invoiceId: 2 ** 53 }, { terminal: MAX + 1 }, { attempt: MAX + 1 }, { lifeEvent: '2147483648' }]) {
      expect(() => mapServiceAuthorityIbscbs(line(over), ASKED)).toThrow(/inválido/)
    }
    expect(Object.is(serviceAuthorityIbscbsQuery('fiscal_api', { ...REF, terminal: -0 }, LIFE).params[2], 0)).toBe(true)   // -0 não segue adiante
    expect(() => serviceAuthorityIbscbsQuery('fiscal_api', REF, LIFE, 7 as any)).toThrow(/Alias/)
    expect(() => serviceAuthorityIbscbsQuery('fiscal_api', REF, LIFE, null as any)).toThrow(/Alias/)
  })
  it('M2: o seletor exige a chave PRESENTE na vigente (undefined === undefined nunca é "a mesma nota") e linhas que passaram pelo leitor', () => {
    const rows = [mapServiceAuthorityIbscbs(line(), ASKED)]
    const current = { institutionId: 1, invoiceId: 8014, terminal: 0, lifeEvent: 3, attempt: 2 }
    expect(() => serviceAuthorityIbscbsOf({ attempt: 2 } as any, [{ attempt: 2, totalInvoiceValue: '777.00' }] as any)).toThrow(/vigente com institutionId inválido/)
    expect(() => serviceAuthorityIbscbsOf({ ...current, invoiceId: 'x', lifeEvent: null } as any, [])).toThrow(/vigente com invoiceId inválido/)   // mesmo com a lista vazia
    expect(() => serviceAuthorityIbscbsOf({ ...current, terminal: 0.5 } as any, rows)).toThrow(/vigente com terminal inválido/)
    expect(() => serviceAuthorityIbscbsOf(current, [{ ...rows[0], attempt: '2' }] as any)).toThrow(/não passou pelo leitor/)   // era `null` calado
    expect(() => serviceAuthorityIbscbsOf(current, [null] as any)).toThrow(/não passou pelo leitor/)
    expect(() => serviceAuthorityIbscbsOf(current, [{ attempt: 2, totalInvoiceValue: '777.00' }] as any)).toThrow(/lista mistura institutionId/)
    expect(() => serviceAuthorityIbscbsOf(null, undefined as any)).toThrow(/lista de valores inválida/)
    expect(serviceAuthorityIbscbsOf(current, rows)).toBe(rows[0])
  })
  it('L1: a referência é lida UMA vez — o que foi conferido é o que vai ao banco e o que o mapa cobra', async () => {
    // referência com getter que muda: consultava a 8014 e aceitava linha da 8015
    let reads = 0
    const tricky: any = { institutionId: 1, terminal: 0, get invoiceId() { return ++reads <= 1 ? 8014 : 8015 } }
    const calls: unknown[][] = []
    const q: any = { query: async (_sql: string, params: unknown[]) => { calls.push(params); return [[line({ invoiceId: 8015 })]] } }
    await expect(readServiceAuthorityIbscbs(q, 'fiscal_api', tricky, LIFE)).rejects.toThrow(/fora da nota\/vida pedida/)
    expect(calls).toEqual([[1, 8014, 0, 3]])
    expect(reads).toBe(1)
    // referência mutável reusada num laço sem `await`: cada leitura fica com o retrato dela
    const ref = { institutionId: 1, invoiceId: 0, terminal: 0 }
    const echo: any = { query: async (_sql: string, params: number[]) => [[line({ invoiceId: params[1] })]] }
    const pending: Promise<number>[] = []
    for (const id of [8014, 8015]) { ref.invoiceId = id; pending.push(readServiceAuthorityIbscbs(echo, 'fiscal_api', ref, LIFE).then(r => r[0].invoiceId)) }
    expect(await Promise.all(pending)).toEqual([8014, 8015])
  })
  it('L2: trocar a ligação exportada do módulo (caminho interno do pacote) não muda o SELECT publicado', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../voice/families/service-authority-ibscbs')
    const before = serviceAuthorityIbscbsSelect('fiscal_api')
    const saved = { view: mod.SERVICE_AUTHORITY_IBSCBS_VIEW, columns: mod.SERVICE_AUTHORITY_IBSCBS_COLUMNS }
    try {
      try { mod.SERVICE_AUTHORITY_IBSCBS_VIEW = 'tb_invoice_service_transmission_ibscbs' } catch { /* ligação só de leitura: melhor ainda */ }
      try { mod.SERVICE_AUTHORITY_IBSCBS_COLUMNS = [['total_invoice_value', 'totalInvoiceValue']] } catch { /* idem */ }
      expect(mod.serviceAuthorityIbscbsSelect('fiscal_api')).toBe(before)
      expect(before).toContain('CAST(v.total_invoice_value AS CHAR)')
      expect(before).toContain('.vw_invoice_service_transmission_ibscbs v')
    } finally {
      try { mod.SERVICE_AUTHORITY_IBSCBS_VIEW = saved.view; mod.SERVICE_AUTHORITY_IBSCBS_COLUMNS = saved.columns } catch { /* nada a desfazer */ }
    }
  })
  it('L3: o boot guarda a causa original e cai para o errno quando o código vem vazio', async () => {
    const original = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), { code: 'ECONNREFUSED' })
    const err: any = await assertServiceAuthorityIbscbsViewReadable({ query: async () => { throw original } } as any, 'fiscal_api').catch(e => e)
    expect(err.message).toMatch(/\(ECONNREFUSED\)/)
    expect(err.message).not.toMatch(/127\.0\.0\.1/)                                             // só o código entra na mensagem
    expect(err.cause).toBe(original)
    const empty: any = await assertServiceAuthorityIbscbsViewReadable({ query: async () => { throw Object.assign(new Error('x'), { code: '', errno: 1146 }) } } as any, 'fiscal_api').catch(e => e)
    expect(empty.message).toMatch(/\(1146\)/)
    await expect(assertServiceAuthorityIbscbsViewReadable(undefined as any, 'fiscal_api')).rejects.toThrow(/não responde ao SELECT publicado \(erro\)/)
  })
  it('L4: os mutantes que sobreviviam — duplicata não vizinha, duplicata em lista de duas, decimal com quebra de linha', async () => {
    for (const attempts of [[2, 1, 2], [2, 2], [1, 2, 3, 1]]) {
      await expect(readServiceAuthorityIbscbs(fake(attempts.map(attempt => line({ attempt }))).q, 'fiscal_api', REF, LIFE)).rejects.toThrow(/mais de uma vez/)
    }
    for (const v of ['10.00\n', '\n10.00', 'abc\n10.00', '10.00\r\n', '10.00 ', '１０.００']) {
      expect(() => mapServiceAuthorityIbscbs(line({ totalInvoiceValue: v }), ASKED)).toThrow(/fora do texto decimal canônico/)
    }
  })
})
