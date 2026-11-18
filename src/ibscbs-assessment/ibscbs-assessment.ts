/**
 * OPÇÃO DE APURAÇÃO DO IBS/CBS DO SIMPLES do estabelecimento (`regApIBSCBSSN`, NT 009: 1/2/3) — a regra ÚNICA de LEITURA e o CONTRATO da
 * view (fase IBS/CBS, `fiscal-api:IBS.E1.P2`; D-IB99/D-IB100/D-IB101 e, do desenho de 2026-11-18, D-IB127…D-IB129 — `prompt_fase_ibs_cbs.md`
 * §17).
 *
 * Peça PURA (sem banco, sem I/O — molde `fiscal-api/federal-id`): sai pelo subpath `fiscal-api/ibscbs-assessment` e pelo barrel. A PADROES
 * §11 regra 3 manda "tipos e regras de leitura da view saem de UMA biblioteca, nunca duas cópias" (D-IB128): o leitor da view no núcleo
 * (`erp/establishment-ibscbs-assessment.ts`) escolhe a vigente por ESTE seletor, e a peça `@shared/ibscbs-assessment` do setes-api (dona
 * da TABELA, da escrita, da trava e do "suportado") passa a escolher por ele no `setes-api:IBS.E6.P7` — até lá ela ainda tem a cópia dela. O contrato da view (nome e colunas) mora aqui também (D-IB129), para o teste DDL ×
 * colunas do setes-api (`setes-api:IBS.E6.P7`, que cria a view) importá-lo pelo subpath.
 *
 * A REGRA: a opção vigente na COMPETÊNCIA (a data da nota — D-IB64; no DPS, `dCompet`) é a linha viva de MAIOR `validFrom` ≤ competência;
 * sem linha, vale '1' (o efeito legal de não optar — D-IB1/D-IB99; nunca há backfill nem linha "1" implícita na view). Linha com início
 * DEPOIS da competência é dado válido (opção futura) e é ignorada — o seletor serve também a quem tem a lista de todas as linhas vivas.
 *
 * Fora daqui, de propósito: o "suportado" e a recusa do faturamento (política do setes-api — D-IB99); o piso de 2027 para 2/3 (regra da
 * ESCRITA no setes-api — D-IB100; não é regra de leitura); o opSimpNac (RF-SN-20 — a montagem do DPS é da nfse-api); trava.
 */

/** As três opções (`regApIBSCBSSN`): 1 IBS e CBS pelo SN · 2 CBS pelo SN e IBS pelo regime regular · 3 IBS e CBS pelo regime regular. */
export const IBSCBS_ASSESSMENTS = Object.freeze(['1', '2', '3'] as const)
export type IbscbsAssessment = typeof IBSCBS_ASSESSMENTS[number]

/** Sem linha até a competência = '1' (efeito legal de não optar — D-IB1/D-IB99). */
export const IBSCBS_ASSESSMENT_WITHOUT_OPTION: IbscbsAssessment = '1'

/** Uma opção do domínio — só o TEXTO exato ('1', '2', '3'); número, espaço ou outro valor não é. */
export const isIbscbsAssessment = (v: unknown): v is IbscbsAssessment =>
  typeof v === 'string' && (IBSCBS_ASSESSMENTS as readonly string[]).includes(v)

/**
 * Data de calendário REAL `YYYY-MM-DD`, a partir de 2000-01-01 — a mesma do `isIsoDate` do setes-api (`@shared/ibscbs-assessment`), para os
 * dois lados aceitarem as mesmas datas ('2027-02-30' não é data; o servidor sem modo estrito a gravaria como '0000-00-00').
 */
export function isIbscbsAssessmentDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= '2000-01-01'
}

/**
 * Uma opção datada viva, como a view a publica (sem o estabelecimento — quem lê já filtrou por ele). Nome distinto do
 * `IbscbsAssessmentLine` da peça do setes-api (a linha da TELA, com suportado/vigente/editável — gate socrático de 2026-11-18, M1).
 */
export interface IbscbsAssessmentDatedOption {
  readonly validFrom:  string
  readonly assessment: IbscbsAssessment
}

/** A opção que vale numa competência. `validFrom` null = nenhuma linha até a data (vale '1'). */
export interface IbscbsAssessmentResolved {
  readonly assessment: IbscbsAssessment
  readonly validFrom:  string | null
}

const WHO = 'Opção de apuração do IBS/CBS'

/** O objeto tem o campo como PRÓPRIO (não herdado do protótipo). */
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/**
 * A opção VIGENTE na competência: a linha de maior `validFrom` ≤ competência; nenhuma → `{ '1', null }`. ESTRITO: competência fora de
 * data real é erro de quem chama (nunca "sem linha = 1" calado — ADV-IB99-03 do setes-api); linha que não é objeto, com data torta ou opção
 * fora do domínio, e `validFrom` repetido (é a PK da tabela) falham ALTO. A ordem da lista não importa. Resultado congelado.
 */
export function ibscbsAssessmentOf(lines: readonly IbscbsAssessmentDatedOption[], competenceDate: string): IbscbsAssessmentResolved {
  if (!isIbscbsAssessmentDate(competenceDate)) throw new Error(`${WHO}: competência inválida (${JSON.stringify(competenceDate)}) — data real YYYY-MM-DD a partir de 2000-01-01`)
  if (!Array.isArray(lines)) throw new Error(`${WHO}: lista de linhas inválida`)
  const seen: string[] = []                                               // lista local da chamada (nada de Map/Set — regra 3 do núcleo)
  let best: IbscbsAssessmentDatedOption | null = null
  // por ÍNDICE (gate adversarial, L2): um iterador trocado na lista, ou buraco de lista esparsa, nunca vira "sem linha = 1" calado
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l === null || typeof l !== 'object') throw new Error(`${WHO}: linha inválida (${JSON.stringify(l)})`)
    // campos PRÓPRIOS (gate adversarial, L4): valor herdado do protótipo não é linha da view
    if (!hasOwn(l, 'validFrom') || !hasOwn(l, 'assessment')) throw new Error(`${WHO}: linha inválida (sem início ou opção próprios)`)
    const { validFrom, assessment } = l                                   // cada campo lido UMA vez
    if (!isIbscbsAssessmentDate(validFrom)) throw new Error(`${WHO}: linha com início inválido (${JSON.stringify(validFrom)})`)
    if (!isIbscbsAssessment(assessment)) throw new Error(`${WHO}: linha com opção fora do domínio 1/2/3 (${JSON.stringify(assessment)})`)
    if (seen.includes(validFrom)) throw new Error(`${WHO}: o início ${validFrom} aparece mais de uma vez (é a chave da opção)`)
    seen.push(validFrom)
    if (validFrom <= competenceDate && (best === null || validFrom > best.validFrom)) best = { validFrom, assessment }
  }
  return Object.freeze(best === null
    ? { assessment: IBSCBS_ASSESSMENT_WITHOUT_OPTION, validFrom: null }
    : { assessment: best.assessment, validFrom: best.validFrom })
}

// ── O CONTRATO da view (D-IB129) ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A view publicada pelo setes-api no schema do cliente (nasce em `setes-api:IBS.E6.P7`): só as linhas vivas, sem resolver nada. */
export const ESTABLISHMENT_IBSCBS_ASSESSMENT_VIEW = 'vw_establishment_ibscbs_assessment'

/** Uma linha da view como o leitor a devolve antes do seletor. */
export interface EstablishmentIbscbsAssessmentRow {
  readonly institutionId: number
  readonly validFrom:     string
  readonly assessment:    IbscbsAssessment
}

/**
 * Coluna publicada: [coluna da view, campo da linha, 'date'?] — a marca 'date' diz que a coluna é DATE e sai como TEXTO `YYYY-MM-DD`
 * (`DATE_FORMAT`). Marca em texto de propósito: a lista não compila onde se espera coluna da voz.
 */
export type EstablishmentIbscbsAssessmentColumn = readonly [column: string, field: keyof EstablishmentIbscbsAssessmentRow, kind?: 'date']

/**
 * As colunas da view — UMA lista: monta o SELECT do leitor do núcleo e é o que o teste DDL do setes-api confere contra a migration dele.
 * Ficam de fora `deleted` (a view já filtra), `tb_user_id`, `created_at` e `updated_at` (sem consumidor — D-IB77). Congelada em profundidade.
 */
export const ESTABLISHMENT_IBSCBS_ASSESSMENT_COLUMNS: readonly EstablishmentIbscbsAssessmentColumn[] = Object.freeze(([
  ['tb_institution_id', 'institutionId'], ['valid_from', 'validFrom', 'date'], ['assessment', 'assessment'],
] as const).map(c => Object.freeze(c)))
