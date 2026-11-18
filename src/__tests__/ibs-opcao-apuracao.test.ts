/// <reference types="jest" />
// Fase IBS/CBS — fiscal-api:IBS.E1.P2 (D-IB127…D-IB129, `prompt_fase_ibs_cbs.md` §17): a opção de apuração do IBS/CBS do Simples
// (`regApIBSCBSSN`) — a REGRA de leitura e o CONTRATO da view no subpath puro `fiscal-api/ibscbs-assessment`, e o LEITOR da view em `erp/`.
// A view é do setes-api (nasce em `setes-api:IBS.E6.P7`, com a prova ao vivo); aqui se prova o contrato contra um driver falso.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import {
  IBSCBS_ASSESSMENTS, IBSCBS_ASSESSMENT_WITHOUT_OPTION, isIbscbsAssessment, isIbscbsAssessmentDate, ibscbsAssessmentOf,
  ESTABLISHMENT_IBSCBS_ASSESSMENT_VIEW, ESTABLISHMENT_IBSCBS_ASSESSMENT_COLUMNS,
} from '../ibscbs-assessment'
import {
  establishmentIbscbsAssessmentSelect, establishmentIbscbsAssessmentQuery, mapEstablishmentIbscbsAssessment,
  readEstablishmentIbscbsAssessment, assertEstablishmentIbscbsAssessmentViewReadable,
} from '../erp/establishment-ibscbs-assessment'
import * as subpath from '../ibscbs-assessment'
import * as reading from '../reading'
import * as barrel from '../index'

const SRC = path.resolve(__dirname, '..')

/** Os módulos que um arquivo importa/reexporta/requer, pelo parser do TypeScript (texto em comentário ou string nunca conta). */
function specifiers(file: string): string[] {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text)
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))
      && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) out.push(n.arguments[0].text)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}
const SCHEMA = 'setes_setes'
const line = (validFrom: string, assessment: any) => ({ validFrom, assessment })

describe('IBS.E1.P2 regra — a opção vigente na competência (uma biblioteca só — D-IB128)', () => {
  it('o domínio e o "sem opção" são os da peça do setes-api (1/2/3; sem linha = 1)', () => {
    expect(IBSCBS_ASSESSMENTS).toEqual(['1', '2', '3'])
    expect(Object.isFrozen(IBSCBS_ASSESSMENTS)).toBe(true)
    expect(IBSCBS_ASSESSMENT_WITHOUT_OPTION).toBe('1')
    for (const v of ['1', '2', '3']) expect(isIbscbsAssessment(v)).toBe(true)
    for (const v of [1, 2, ' 1', '1 ', '0', '4', '', null, undefined, '01', 'a']) expect([v, isIbscbsAssessment(v)]).toEqual([v, false])
  })
  it('data real YYYY-MM-DD a partir de 2000-01-01 (a mesma do isIsoDate do setes-api)', () => {
    for (const v of ['2027-01-01', '2000-01-01', '2028-02-29', '2026-12-31']) expect([v, isIbscbsAssessmentDate(v)]).toEqual([v, true])
    for (const v of ['2027-02-30', '2027-13-01', '1999-12-31', '2027-1-01', '20270101', ' 2027-01-01', '2027-01-01T00:00:00', 20270101, null, undefined, new Date('2027-01-01')]) {
      expect([String(v), isIbscbsAssessmentDate(v)]).toEqual([String(v), false])
    }
  })
  it('sem linha → 1 com início null (efeito legal de não optar)', () => {
    expect(ibscbsAssessmentOf([], '2027-01-15')).toEqual({ assessment: '1', validFrom: null })
  })
  it('a vigente é a de MAIOR início ≤ competência: antes, no mesmo dia e depois; a ordem da lista não importa', () => {
    const lines = [line('2027-07-01', '1'), line('2027-01-01', '3'), line('2028-01-01', '2')]
    expect(ibscbsAssessmentOf(lines, '2026-12-31')).toEqual({ assessment: '1', validFrom: null })        // tudo depois → sem opção
    expect(ibscbsAssessmentOf(lines, '2027-01-01')).toEqual({ assessment: '3', validFrom: '2027-01-01' }) // no mesmo dia vale
    expect(ibscbsAssessmentOf(lines, '2027-06-30')).toEqual({ assessment: '3', validFrom: '2027-01-01' })
    expect(ibscbsAssessmentOf(lines, '2027-07-01')).toEqual({ assessment: '1', validFrom: '2027-07-01' }) // linha '1' explícita fecha o 3
    expect(ibscbsAssessmentOf(lines, '2030-05-05')).toEqual({ assessment: '2', validFrom: '2028-01-01' })
    expect(ibscbsAssessmentOf([...lines].reverse(), '2027-06-30')).toEqual({ assessment: '3', validFrom: '2027-01-01' })
  })
  it('o resultado é congelado e não é a linha de quem chamou', () => {
    const l = line('2027-01-01', '2')
    const r = ibscbsAssessmentOf([l], '2027-02-01')
    expect(Object.isFrozen(r)).toBe(true)
    expect(r).not.toBe(l)
    expect(Object.isFrozen(ibscbsAssessmentOf([], '2027-02-01'))).toBe(true)
  })
  it('competência torta é erro de quem chama — nunca "sem linha = 1" calado', () => {
    for (const d of ['2027-02-30', '1999-12-31', '', 20270101, null, undefined]) {
      expect(() => ibscbsAssessmentOf([], d as any)).toThrow(/competência inválida/)
    }
  })
  it('lista ou linha torta falham ALTO: não lista, não objeto, início torto, opção fora do domínio, início repetido (é a PK)', () => {
    expect(() => ibscbsAssessmentOf(null as any, '2027-01-01')).toThrow(/lista de linhas inválida/)
    expect(() => ibscbsAssessmentOf({} as any, '2027-01-01')).toThrow(/lista de linhas inválida/)
    expect(() => ibscbsAssessmentOf([null] as any, '2027-01-01')).toThrow(/linha inválida/)
    expect(() => ibscbsAssessmentOf(['2027-01-01'] as any, '2027-01-01')).toThrow(/linha inválida/)
    expect(() => ibscbsAssessmentOf([line('2027-02-30', '1')], '2027-03-01')).toThrow(/início inválido/)
    expect(() => ibscbsAssessmentOf([line('2027-01-01', 1)], '2027-03-01')).toThrow(/fora do domínio/)
    expect(() => ibscbsAssessmentOf([line('2027-01-01', '4')], '2027-03-01')).toThrow(/fora do domínio/)
    expect(() => ibscbsAssessmentOf([line('2027-01-01', ' 3')], '2027-03-01')).toThrow(/fora do domínio/)
    expect(() => ibscbsAssessmentOf([line('2027-01-01', '1'), line('2027-01-01', '3')], '2027-03-01')).toThrow(/mais de uma vez/)
    // linha torta DEPOIS da competência também falha: ignorar o início não dispensa conferir a linha
    expect(() => ibscbsAssessmentOf([line('2029-01-01', '9')], '2027-03-01')).toThrow(/fora do domínio/)
  })
})

describe('IBS.E1.P2 contrato — a view publicada (D-IB129: o contrato mora no subpath puro)', () => {
  it('nome e colunas da view: só as linhas vivas, três colunas, congeladas em profundidade', () => {
    expect(ESTABLISHMENT_IBSCBS_ASSESSMENT_VIEW).toBe('vw_establishment_ibscbs_assessment')
    expect(ESTABLISHMENT_IBSCBS_ASSESSMENT_COLUMNS).toEqual([
      ['tb_institution_id', 'institutionId'], ['valid_from', 'validFrom', 'date'], ['assessment', 'assessment'],
    ])
    expect(Object.isFrozen(ESTABLISHMENT_IBSCBS_ASSESSMENT_COLUMNS)).toBe(true)
    for (const c of ESTABLISHMENT_IBSCBS_ASSESSMENT_COLUMNS) expect(Object.isFrozen(c)).toBe(true)
  })
  it('o subpath é PURO: o grafo de `ibscbs-assessment.ts` não sai da pasta da peça nem importa pacote externo (nada de banco, nada de I/O)', () => {
    const seen = new Set<string>()
    const stack = [path.join(SRC, 'ibscbs-assessment.ts')]
    const external: string[] = []
    while (stack.length) {
      const f = stack.pop()!
      if (seen.has(f)) continue
      seen.add(f)
      for (const s of specifiers(f)) {
        if (!s.startsWith('.')) { external.push(s); continue }
        stack.push(path.resolve(path.dirname(f), s) + '.ts')
      }
    }
    expect(external).toEqual([])
    expect([...seen].map(f => path.relative(SRC, f).replace(/\\/g, '/')).sort()).toEqual(['ibscbs-assessment.ts', 'ibscbs-assessment/ibscbs-assessment.ts'])
  })
})

const fake = (rows: unknown) => {
  const calls: { sql: string; params: unknown[] }[] = []
  const q: any = { query: jest.fn(async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return [rows] }) }
  return { q, calls }
}

describe('IBS.E1.P2 leitor — a view do schema do cliente, eixos obrigatórios, mapa ESTRITO, regra do subpath', () => {
  it('o SELECT publicado: as três colunas da view, `valid_from` por DATE_FORMAT, sobre a view do schema', () => {
    expect(establishmentIbscbsAssessmentSelect(SCHEMA).replace(/\s+/g, ' ')).toBe(
      "SELECT v.tb_institution_id AS institutionId, DATE_FORMAT(v.valid_from, '%Y-%m-%d') AS validFrom, v.assessment AS assessment "
      + 'FROM `setes_setes`.vw_establishment_ibscbs_assessment v')
  })
  it('a consulta filtra o estabelecimento e o início ≤ competência por PARÂMETRO, em ordem de início', () => {
    const { sql, params } = establishmentIbscbsAssessmentQuery(SCHEMA, 7, '2027-01-15')
    expect(sql.replace(/\s+/g, ' ')).toMatch(/ WHERE v\.tb_institution_id = \? AND v\.valid_from <= \? ORDER BY v\.valid_from$/)
    expect(params).toEqual([7, '2027-01-15'])
  })
  it('eixo torto é erro de quem chama e não chega ao banco — schema, estabelecimento, competência, alias', async () => {
    const { q } = fake([])
    await expect(readEstablishmentIbscbsAssessment(q, 'setes_central; DROP', 1, '2027-01-01')).rejects.toThrow(/schemaName inválido/)
    await expect(readEstablishmentIbscbsAssessment(q, 'fiscal_api', 1, '2027-01-01')).rejects.toThrow(/schemaName inválido/)
    for (const inst of [0, -1, 1.5, '1', null, undefined, 2_147_483_648, NaN]) {
      await expect(readEstablishmentIbscbsAssessment(q, SCHEMA, inst as any, '2027-01-01')).rejects.toThrow(/estabelecimento inválido/)
    }
    for (const d of ['2027-02-30', '1999-12-31', '', null, 20270101]) {
      await expect(readEstablishmentIbscbsAssessment(q, SCHEMA, 1, d as any)).rejects.toThrow(/competência inválida/)
    }
    expect(() => establishmentIbscbsAssessmentSelect(SCHEMA, 'v; x')).toThrow(/Alias inválido/)
    expect(q.query).not.toHaveBeenCalled()
    // o teto do INT passa
    const ok = fake([])
    await expect(readEstablishmentIbscbsAssessment(ok.q, SCHEMA, 2_147_483_647, '2027-01-01')).resolves.toEqual({ assessment: '1', validFrom: null })
  })
  it('lê as linhas e devolve a vigente pela regra do subpath; sem linha → 1 com início null', async () => {
    const { q, calls } = fake([
      { institutionId: 7, validFrom: '2026-12-01', assessment: '1' },
      { institutionId: '7', validFrom: '2027-01-01', assessment: '3' },          // inteiro em texto canônico, como alguns drivers devolvem
    ])
    expect(await readEstablishmentIbscbsAssessment(q, SCHEMA, 7, '2027-03-10')).toEqual({ assessment: '3', validFrom: '2027-01-01' })
    expect(calls).toHaveLength(1)
    expect(calls[0].params).toEqual([7, '2027-03-10'])
    expect(await readEstablishmentIbscbsAssessment(fake([]).q, SCHEMA, 7, '2027-03-10')).toEqual({ assessment: '1', validFrom: null })
  })
  it('mapa ESTRITO: outro estabelecimento, inteiro torto, `Date` do driver (view sem DATE_FORMAT), opção número ou fora do domínio falham ALTO', () => {
    const r = (over: Record<string, unknown>) => ({ institutionId: 7, validFrom: '2027-01-01', assessment: '2', ...over })
    expect(mapEstablishmentIbscbsAssessment(r({}), 7)).toEqual({ institutionId: 7, validFrom: '2027-01-01', assessment: '2' })
    expect(Object.isFrozen(mapEstablishmentIbscbsAssessment(r({}), 7))).toBe(true)
    for (const inst of [8, '8', '07', ' 7', '7.0', null, undefined]) expect(() => mapEstablishmentIbscbsAssessment(r({ institutionId: inst }), 7)).toThrow(/outro estabelecimento ou torta/)
    for (const d of [new Date('2027-01-01T00:00:00Z'), '2027-01-01 00:00:00', '2027-02-30', null]) expect(() => mapEstablishmentIbscbsAssessment(r({ validFrom: d }), 7)).toThrow(/DATE_FORMAT/)
    for (const a of [2, '4', ' 2', '', null]) expect(() => mapEstablishmentIbscbsAssessment(r({ assessment: a }), 7)).toThrow(/fora do domínio/)
    expect(() => mapEstablishmentIbscbsAssessment(null, 7)).toThrow(/inválida/)
    expect(() => mapEstablishmentIbscbsAssessment(r({}), 0)).toThrow(/estabelecimento inválido/)
  })
  it('view torta falha ALTO: início depois da competência, início repetido, driver sem lista', async () => {
    await expect(readEstablishmentIbscbsAssessment(fake([{ institutionId: 7, validFrom: '2027-04-01', assessment: '1' }]).q, SCHEMA, 7, '2027-03-10'))
      .rejects.toThrow(/depois da competência/)
    await expect(readEstablishmentIbscbsAssessment(fake([
      { institutionId: 7, validFrom: '2027-01-01', assessment: '1' }, { institutionId: 7, validFrom: '2027-01-01', assessment: '3' },
    ]).q, SCHEMA, 7, '2027-03-10')).rejects.toThrow(/mais de uma vez/)
    const bad: any = { query: jest.fn(async () => [null]) }
    await expect(readEstablishmentIbscbsAssessment(bad, SCHEMA, 7, '2027-03-10')).rejects.toThrow(/não devolveu linhas/)
  })
  it('o boot pergunta `WHERE 1 = 0` à view e falha ALTO com o código do erro (nunca o texto do banco), guardando a causa', async () => {
    const { q, calls } = fake([])
    await assertEstablishmentIbscbsAssessmentViewReadable(q, SCHEMA)
    expect(calls[0].sql.replace(/\s+/g, ' ')).toMatch(/FROM `setes_setes`\.vw_establishment_ibscbs_assessment v WHERE 1 = 0$/)
    const cause = Object.assign(new Error("Table 'setes_setes.vw_establishment_ibscbs_assessment' doesn't exist SEGREDO"), { code: 'ER_NO_SUCH_TABLE' })
    const broken: any = { query: jest.fn(async () => { throw cause }) }
    const err: any = await assertEstablishmentIbscbsAssessmentViewReadable(broken, SCHEMA).catch(e => e)
    expect(err.message).toMatch(/ER_NO_SUCH_TABLE/)
    expect(err.message).toMatch(/D-IB127/)
    expect(err.message).not.toMatch(/SEGREDO/)
    expect(err.cause).toBe(cause)
    const errno: any = await assertEstablishmentIbscbsAssessmentViewReadable({ query: jest.fn(async () => { throw { errno: 1146 } }) } as any, SCHEMA).catch(e => e)
    expect(errno.message).toMatch(/\(1146\)/)
    await expect(assertEstablishmentIbscbsAssessmentViewReadable(q, 'fiscal_api')).rejects.toThrow(/schemaName inválido/)
  })
})

describe('IBS.E1.P2 superfície — subpath puro e barrel; NADA em `fiscal-api/reading`', () => {
  const PURE = ['IBSCBS_ASSESSMENTS', 'IBSCBS_ASSESSMENT_WITHOUT_OPTION', 'isIbscbsAssessment', 'isIbscbsAssessmentDate', 'ibscbsAssessmentOf',
    'ESTABLISHMENT_IBSCBS_ASSESSMENT_VIEW', 'ESTABLISHMENT_IBSCBS_ASSESSMENT_COLUMNS']
  const READER = ['establishmentIbscbsAssessmentSelect', 'establishmentIbscbsAssessmentQuery', 'mapEstablishmentIbscbsAssessment',
    'readEstablishmentIbscbsAssessment', 'assertEstablishmentIbscbsAssessmentViewReadable']
  it('o subpath tem SÓ a peça pura; o barrel tem a peça pura e o leitor; o `reading` não tem nada', () => {
    expect(Object.keys(subpath).sort()).toEqual([...PURE].sort())
    for (const n of [...PURE, ...READER]) expect([n, n in barrel, n in reading]).toEqual([n, true, false])
    expect((barrel as any).ibscbsAssessmentOf).toBe(subpath.ibscbsAssessmentOf)          // uma regra só, pelas duas portas
  })
  it('o leitor só lê a VIEW (nunca a tabela) e só importa o schema, o tipo do driver e a peça pura', () => {
    const file = path.join(SRC, 'erp', 'establishment-ibscbs-assessment.ts')
    const code = fs.readFileSync(file, 'utf8')
    expect(code).not.toMatch(/tb_establishment_ibscbs_assessment/)
    expect(specifiers(file).sort()).toEqual(['../db/schema', '../ibscbs-assessment/ibscbs-assessment', '../voice/family-reader'])
    // o SQL do leitor (só os TEXTOS do código — comentário nunca conta; gate socrático, L2): sem trava e sem reescrever a regra da vigente
    const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const texts: string[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) texts.push(n.text)
      else if (ts.isTemplateExpression(n)) texts.push(n.head.text, ...n.templateSpans.map(s => s.literal.text))
      ts.forEachChild(n, visit)
    }
    visit(sf)
    const sqlText = texts.join('\n')
    expect(sqlText).toMatch(/ORDER BY/)                                   // a sonda enxerga o SQL
    expect(sqlText).not.toMatch(/FOR UPDATE|LOCK IN SHARE MODE|\bDESC\b|\bLIMIT\b/)
  })
})

describe('IBS.E1.P2 gates de 2026-11-18 (socrático 0,82 · adversarial 0,85, sem HIGH) — os achados viram regressão', () => {
  it('M1 (adversarial): schemaName que não é texto (objeto com `toString` que muda) é recusado antes de entrar no SQL', async () => {
    let n = 0
    const evil: any = { toString: () => (n++ === 0 ? 'setes_a' : 'setes_a`.x; DROP TABLE y; -- ') }
    expect(() => establishmentIbscbsAssessmentQuery(evil, 1, '2027-01-01')).toThrow(/não é texto/)
    const { q } = fake([])
    await expect(readEstablishmentIbscbsAssessment(q, evil, 1, '2027-01-01')).rejects.toThrow(/não é texto/)
    await expect(assertEstablishmentIbscbsAssessmentViewReadable(q, evil)).rejects.toThrow(/não é texto/)
    expect(q.query).not.toHaveBeenCalled()
  })
  it('L2 (adversarial): iterador trocado ou lista esparsa nunca vira "sem linha = 1" calado — o seletor percorre por índice', () => {
    const arr: any = [{ validFrom: '2027-01-01', assessment: '3' }]
    arr[Symbol.iterator] = function* () { /* nada */ }
    expect(ibscbsAssessmentOf(arr, '2027-06-01')).toEqual({ assessment: '3', validFrom: '2027-01-01' })
    const sparse: any = [, { validFrom: '2027-01-01', assessment: '3' }]   // eslint-disable-line no-sparse-arrays
    expect(() => ibscbsAssessmentOf(sparse, '2027-06-01')).toThrow(/linha inválida/)
  })
  it('L3 (adversarial): `map` trocado na lista do driver não esconde as linhas', async () => {
    const rows: any = [{ institutionId: 7, validFrom: '2027-01-01', assessment: '3' }]
    rows.map = () => []
    expect(await readEstablishmentIbscbsAssessment({ query: jest.fn(async () => [rows]) } as any, SCHEMA, 7, '2027-06-01'))
      .toEqual({ assessment: '3', validFrom: '2027-01-01' })
  })
  it('L4 (adversarial): campo herdado do protótipo não é linha — no seletor e no mapa do leitor', () => {
    expect(() => ibscbsAssessmentOf([Object.create({ validFrom: '2027-01-01', assessment: '3' })], '2027-06-01')).toThrow(/próprios/)
    expect(() => mapEstablishmentIbscbsAssessment(Object.create({ institutionId: 7, validFrom: '2027-01-01', assessment: '3' }), 7)).toThrow(/sem a coluna/)
  })
  it('M1 (socrático): o tipo da opção datada não se chama `IbscbsAssessmentLine` (nome da linha da TELA no setes-api)', () => {
    const code = fs.readFileSync(path.join(SRC, 'ibscbs-assessment', 'ibscbs-assessment.ts'), 'utf8')
    expect(code).toMatch(/export interface IbscbsAssessmentDatedOption\b/)
    expect(code).not.toMatch(/export (?:interface|type) IbscbsAssessmentLine\b/)
  })
})
