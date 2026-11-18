import { assertSchema } from '../db/schema'
import type { ReadQueryable } from '../voice/family-reader'
import {
  ESTABLISHMENT_IBSCBS_ASSESSMENT_COLUMNS, ESTABLISHMENT_IBSCBS_ASSESSMENT_VIEW, EstablishmentIbscbsAssessmentColumn,
  EstablishmentIbscbsAssessmentRow, IbscbsAssessmentResolved, ibscbsAssessmentOf, isIbscbsAssessment, isIbscbsAssessmentDate,
} from '../ibscbs-assessment/ibscbs-assessment'

/**
 * LEITOR da opção de apuração do IBS/CBS do Simples do estabelecimento pela VIEW publicada do ERP (fase IBS/CBS, `fiscal-api:IBS.E1.P2`;
 * D-IB127…D-IB129 — `prompt_fase_ibs_cbs.md` §17). Quem consome: a nfse-api ao montar o DPS (`nfse-api:IBS.E3.P2`, `regApIBSCBSSN`).
 *
 * Fonte: a view `vw_establishment_ibscbs_assessment` do schema do CLIENTE — AINDA NÃO EXISTE quando esta peça nasce: é do setes-api (dono
 * da tabela da opção, D-IB100 — este arquivo nunca a nomeia) e nasce em `setes-api:IBS.E6.P7`, que também confere o DDL dela contra o contrato
 * (`ESTABLISHMENT_IBSCBS_ASSESSMENT_COLUMNS`, no subpath puro) e prova a leitura ao vivo pelo usuário `fiscal_api` (o GRANT `setes\_%` já
 * cobre). Aqui o contrato é provado contra um driver falso (`ibs-opcao-apuracao.test.ts`). Nunca a tabela: só a view.
 *
 * A REGRA da vigente não mora aqui: é o `ibscbsAssessmentOf` da peça pura (uma biblioteca só — D-IB128). O leitor só traz as linhas vivas
 * com início ≤ competência, confere cada uma (mapa ESTRITO) e entrega ao seletor.
 *
 * Eixos OBRIGATÓRIOS: schema (`assertSchema`), estabelecimento (inteiro ≥ 1, até o teto do INT) e a COMPETÊNCIA (data real — D-IB64; no DPS
 * `dCompet = dtEmission`). Eixo torto é erro de quem chama, nunca um '1' calado. Só SELECT, SEM trava: pela D-IB101 a opção de uma data já
 * lida por nota do ERP web é imutável, e o faturamento já a leu travado ao emitir.
 *
 * Só no barrel (`fiscal-api`), FORA de `fiscal-api/reading` (molde da D-IB125) — a superfície de leitura do setes-api não muda.
 */

const WHO = 'Leitura da opção de apuração do IBS/CBS'
/** Teto das colunas INT(11) — um id acima disto nunca existe no banco (iria e voltaria "sem linha" = '1'). */
const INT_MAX = 2_147_483_647
const VIEW = ESTABLISHMENT_IBSCBS_ASSESSMENT_VIEW

function institutionAxis(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > INT_MAX) {
    throw new Error(`${WHO}: estabelecimento inválido: ${JSON.stringify(v)} (inteiro entre 1 e ${INT_MAX})`)
  }
  return v
}

function competenceAxis(v: unknown): string {
  if (!isIbscbsAssessmentDate(v)) throw new Error(`${WHO}: competência inválida: ${JSON.stringify(v)} (data real YYYY-MM-DD a partir de 2000-01-01)`)
  return v
}

/** SELECT pronto da view no schema do cliente — `valid_from` como TEXTO `YYYY-MM-DD`, o resto cru. */
export function establishmentIbscbsAssessmentSelect(schemaName: string, alias = 'v'): string {
  // só TEXTO (gate adversarial, M1): o `assertSchema` confere `String(x)` e devolve o valor original — um objeto cujo `toString` muda a
  // cada chamada passaria na conferência e entraria outro texto no SQL
  if (typeof schemaName !== 'string') throw new Error(`${WHO}: schemaName inválido (não é texto)`)
  const s = assertSchema(schemaName)
  if (typeof alias !== 'string' || !/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error(`Alias inválido: ${alias}`)
  const col = ([column, field, kind]: EstablishmentIbscbsAssessmentColumn) => kind === 'date'
    ? `DATE_FORMAT(${alias}.${column}, '%Y-%m-%d') AS ${field}`
    : `${alias}.${column} AS ${field}`
  return `SELECT ${ESTABLISHMENT_IBSCBS_ASSESSMENT_COLUMNS.map(col).join(', ')}
    FROM \`${s}\`.${VIEW} ${alias}`
}

/** A consulta das linhas vivas do estabelecimento com início ≤ competência, em ordem de início — os dois eixos por parâmetro. */
export function establishmentIbscbsAssessmentQuery(
  schemaName: string, institutionId: number, competenceDate: string, alias = 'v',
): { sql: string; params: [number, string] } {
  const select = establishmentIbscbsAssessmentSelect(schemaName, alias)
  return {
    sql: `${select} WHERE ${alias}.tb_institution_id = ? AND ${alias}.valid_from <= ? ORDER BY ${alias}.valid_from`,
    params: [institutionAxis(institutionId), competenceAxis(competenceDate)],
  }
}

/**
 * Mapa ESTRITO de uma linha da view: estabelecimento só como número ou texto inteiro canônico e IGUAL ao pedido; `validFrom` só como data
 * real (a view lida sem o `DATE_FORMAT` entregaria `Date` do driver — falha ALTO); `assessment` só como texto do domínio (número, espaço,
 * '4' falham ALTO). Cada campo lido UMA vez.
 */
export function mapEstablishmentIbscbsAssessment(r: any, institutionId: number): EstablishmentIbscbsAssessmentRow {
  const asked = institutionAxis(institutionId)
  if (r === null || typeof r !== 'object') throw new Error(`Linha da view da opção de apuração inválida (${JSON.stringify(r)})`)
  // campos PRÓPRIOS (gate adversarial, L4): valor herdado do protótipo não é coluna da view
  for (const k of ['institutionId', 'validFrom', 'assessment']) {
    if (!Object.prototype.hasOwnProperty.call(r, k)) throw new Error(`Linha da view da opção de apuração sem a coluna ${k}`)
  }
  const { institutionId: rawInst, validFrom, assessment } = r
  const inst = typeof rawInst === 'number' ? rawInst
    : (typeof rawInst === 'string' && /^(?:0|[1-9][0-9]*)$/.test(rawInst) ? Number(rawInst) : NaN)
  if (inst !== asked) throw new Error(`Linha da view da opção de apuração de outro estabelecimento ou torta (${JSON.stringify(rawInst)}; pedido ${asked})`)
  if (!isIbscbsAssessmentDate(validFrom)) {
    throw new Error(`Linha da view da opção de apuração com início fora de YYYY-MM-DD (${JSON.stringify(validFrom)}) — a view é lida pelo SELECT publicado (DATE_FORMAT)?`)
  }
  if (!isIbscbsAssessment(assessment)) throw new Error(`Linha da view da opção de apuração com opção fora do domínio 1/2/3 (${JSON.stringify(assessment)})`)
  return Object.freeze({ institutionId: inst, validFrom, assessment })
}

/**
 * A opção de apuração VIGENTE do estabelecimento na competência — `{ assessment, validFrom }`, com `validFrom` null quando não há linha
 * até a data (vale '1'). A escolha é do seletor da peça pura; linha com início depois da competência devolvida pelo banco também falha
 * ALTO aqui (a consulta pediu ≤ — view torta).
 */
export async function readEstablishmentIbscbsAssessment(
  q: ReadQueryable, schemaName: string, institutionId: number, competenceDate: string,
): Promise<IbscbsAssessmentResolved> {
  const { sql, params } = establishmentIbscbsAssessmentQuery(schemaName, institutionId, competenceDate)
  const [inst, competence] = params                                       // conferidos UMA vez: o mesmo vai ao banco, ao mapa e ao seletor
  const [rows] = await q.query(sql, params)
  if (!Array.isArray(rows)) throw new Error(`${WHO}: o driver não devolveu linhas`)
  // por ÍNDICE (gate adversarial, L3): um `map` trocado na lista do driver nunca vira "sem linha = 1" calado
  const lines: EstablishmentIbscbsAssessmentRow[] = []
  for (let i = 0; i < rows.length; i++) {
    const l = mapEstablishmentIbscbsAssessment(rows[i], inst)
    if (l.validFrom > competence) throw new Error(`${WHO}: a view devolveu início ${l.validFrom} depois da competência ${competence}`)
    lines.push(l)
  }
  return ibscbsAssessmentOf(lines, competence)
}

/**
 * Boot de quem lê a opção (a nfse-api, a partir de `nfse-api:IBS.E3.P2`): a view do schema responde ao SELECT publicado com TODAS as
 * colunas. Falta de view, coluna ou GRANT = falha ALTO no boot, nunca 500 na 1ª nota. Nenhum boot chama isto sozinho.
 */
export async function assertEstablishmentIbscbsAssessmentViewReadable(q: ReadQueryable, schemaName: string): Promise<void> {
  const select = establishmentIbscbsAssessmentSelect(schemaName)        // schema inválido é erro de quem chama, com a mensagem dele
  try {
    await q.query(`${select} WHERE 1 = 0`)
  } catch (err: any) {
    // só o código do erro entra na mensagem (nunca o texto do banco nem o SQL); a causa original segue em `cause`
    throw Object.assign(new Error(`A view da opção de apuração do IBS/CBS (${schemaName}.${VIEW}) não responde ao SELECT publicado `
      + `(${err?.code || err?.errno || 'erro'}) — a migration da view (setes-api) não foi aplicada, falta coluna ou falta GRANT (D-IB127)`), { cause: err })
  }
}
