/**
 * FÓRMULA DO vNF da NF-e/NFC-e (W16-10, rej. 610) — peça PURA do núcleo (`fiscal-api:FAMILIA.E5.P4.T2`; D-NE215 = Q-NE215 (a), Valdo
 * 2026-11-21, `prompt_onda_nfe_sefaz.md` §22.5): a regra ÚNICA lida pelo ERP (que CUNHA o vNF no faturamento — `setes-api:NFE.E1.P1.T2`) e
 * pela nfe-api (que CONFERE na tolerância zero — D-NE27). Sai pelo subpath `fiscal-api/merchandise-total` (precedente `fiscal-api/federal-id`)
 * e pelo barrel. Sem banco, sem I/O.
 *
 * DATADA PELO FATO (D-IB13): a fórmula vigente na data do fato (a data do `dhEmi` na zona do estabelecimento — escolha de quem chama) é a
 * de maior `validFrom` ≤ a data. Hoje uma linha só — a da NT 2023.004 (D-NE102), produção da v1.11 em 01/07/2024; data anterior = RECUSA
 * (a web não emite antes dela; nunca "a atual" por omissão). Versão nova entra como LINHA nova, sem mexer na anterior.
 *
 * A FÓRMULA (RF-NFE-28; NT 2023.004 v1.20 §4.5): vNF = vProd − vDesc − vICMSDeson + vST + vFCPST + vICMSMonoReten + vFrete + vSeg + vOutro +
 * vII + vIPI + vIPIDevol + vServ + PISST/vPIS (indSomaPISST = 1) + COFINSST/vCOFINS (indSomaCOFINSST = 1).
 *  - Exceção 1 (veículo novo, `tpOp` = 2): sem vST, vFCPST e vIPIDevol.
 *  - Exceção 4 (`indDeduzDeson`): o fisco aceita subtrair ou não o desonerado dos itens com `indDeduzDeson` = 0 — a peça subtrai SÓ o dos
 *    itens com `indDeduzDeson` = 1 (D-NE225). Por isso o campo é `vICMSDesonDeducted` e não o W04a: QUEM CHAMA já filtrou.
 *  - PIS/COFINS-ST: idem — `vPISSTSummed`/`vCOFINSSTSummed` são só os itens com `indSoma…` = 1.
 *  - Exceção 2 (importação, CFOP 3xxx): o fisco não confere a W16 ali; a peça não distingue (ERP e nfe-api usam a mesma — a conferência
 *    zero não dá 422 falso). A nota de importação está fora do 1º release (suposição marcada na ficha).
 *
 * Soma em CENTAVOS INTEIROS (nunca ponto flutuante — conhecimento negativo do §22.2-5). Campo que não é inteiro ≥ 0 seguro, data inválida
 * e vNF negativo são RECUSA com o nome do que falhou.
 */

/** Os campos que a W16 lê, em centavos inteiros (≥ 0). Os três "filtrados" já vêm só com os itens que entram (ver o cabeçalho). */
export interface MerchandiseTotalsCents {
  readonly vProd:              number
  readonly vDesc:              number
  /** Soma do vICMSDeson dos itens com `indDeduzDeson` = 1 (D-NE225) — NÃO o W04a inteiro. */
  readonly vICMSDesonDeducted: number
  readonly vST:                number
  readonly vFCPST:             number
  readonly vICMSMonoReten:     number
  readonly vFrete:             number
  readonly vSeg:               number
  readonly vOutro:             number
  readonly vII:                number
  readonly vIPI:               number
  readonly vIPIDevol:          number
  /** vServ do `ISSQNtot` (itens de serviço da nota conjugada). */
  readonly vServ:              number
  /** PISST/vPIS dos itens com `indSomaPISST` = 1. */
  readonly vPISSTSummed:       number
  /** COFINSST/vCOFINS dos itens com `indSomaCOFINSST` = 1. */
  readonly vCOFINSSTSummed:    number
  /** `tpOp` = 2 (venda de veículo novo) — Exceção 1. */
  readonly newVehicleSale:     boolean
}

export const MERCHANDISE_TOTAL_CENT_FIELDS = Object.freeze([
  'vProd', 'vDesc', 'vICMSDesonDeducted', 'vST', 'vFCPST', 'vICMSMonoReten', 'vFrete', 'vSeg', 'vOutro', 'vII', 'vIPI', 'vIPIDevol', 'vServ',
  'vPISSTSummed', 'vCOFINSSTSummed',
] as const)

export interface MerchandiseTotalFormula {
  /** 1º dia (data do fato, `YYYY-MM-DD`) em que a fórmula vale. */
  readonly validFrom: string
  /** Identifica a versão para quem confere (a nfe-api diz qual o ERP usou). */
  readonly formula:   string
  readonly compute:   (t: MerchandiseTotalsCents) => bigint
}

/**
 * NT 2023.004 v1.11 em produção (01/07/2024); a v1.20 só mudou o troco. Soma EXATA em BigInt (gate adversarial LOW-2: em `number`, uma
 * parcial acima do inteiro seguro perde o centavo antes do resultado voltar à faixa); quem chama confere a faixa do resultado.
 */
const NT_2023_004 = (t: MerchandiseTotalsCents): bigint => {
  const b = BigInt
  const st = t.newVehicleSale ? 0n : b(t.vST) + b(t.vFCPST) + b(t.vIPIDevol)
  return b(t.vProd) - b(t.vDesc) - b(t.vICMSDesonDeducted) + st + b(t.vICMSMonoReten) + b(t.vFrete) + b(t.vSeg) + b(t.vOutro) + b(t.vII)
    + b(t.vIPI) + b(t.vServ) + b(t.vPISSTSummed) + b(t.vCOFINSSTSummed)
}

/** As versões, em ordem de `validFrom` — congelada. */
export const MERCHANDISE_TOTAL_FORMULAS: readonly MerchandiseTotalFormula[] = Object.freeze([
  Object.freeze({ validFrom: '2024-07-01', formula: 'NT2023.004', compute: NT_2023_004 }),
])

export class MerchandiseTotalError extends Error {
  readonly code = 'MERCHANDISE_TOTAL_INVALID'
  constructor(readonly field: string, why: string) {
    super(`vNF (W16) não calculado: ${field} ${why}`)
    this.name = 'MerchandiseTotalError'
  }
}

/** Data de calendário REAL `YYYY-MM-DD` ('2024-02-30' não é). */
function isCalendarDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/**
 * A ESCOLHA pela data do fato numa tabela de versões qualquer — a de maior `validFrom` ≤ data (independe da ordem da tabela); recusa data
 * inválida ou anterior a todas. Exportada para o teste provar a escolha com mais de uma versão (a tabela real tem uma só hoje).
 */
export function pickMerchandiseTotalFormula(formulas: readonly MerchandiseTotalFormula[], factDate: string): MerchandiseTotalFormula {
  if (!isCalendarDate(factDate)) throw new MerchandiseTotalError('factDate', 'não é uma data YYYY-MM-DD')
  let found: MerchandiseTotalFormula | null = null
  for (const f of formulas) if (f.validFrom <= factDate && (found === null || f.validFrom > found.validFrom)) found = f
  if (!found) throw new MerchandiseTotalError('factDate', 'anterior à 1ª fórmula conhecida')
  return found
}

/** A versão da fórmula vigente na data do fato — ou recusa (data inválida ou anterior à 1ª versão). */
export function merchandiseTotalFormulaAt(factDate: string): MerchandiseTotalFormula {
  return pickMerchandiseTotalFormula(MERCHANDISE_TOTAL_FORMULAS, factDate)
}

/** O vNF em centavos pela fórmula vigente na data do fato, e qual fórmula foi usada. */
export function merchandiseInvoiceTotal(totals: MerchandiseTotalsCents, factDate: string): { readonly cents: number; readonly formula: string } {
  if (totals === null || typeof totals !== 'object') throw new MerchandiseTotalError('totals', 'ausente')
  for (const k of MERCHANDISE_TOTAL_CENT_FIELDS) {
    const v = (totals as unknown as Record<string, unknown>)[k]
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new MerchandiseTotalError(k, 'não é um inteiro de centavos ≥ 0')
  }
  if (typeof totals.newVehicleSale !== 'boolean') throw new MerchandiseTotalError('newVehicleSale', 'não é booleano')
  const f = merchandiseTotalFormulaAt(factDate)
  const exact = f.compute(totals)
  if (exact < 0n) throw new MerchandiseTotalError('vNF', 'negativo')
  if (exact > BigInt(Number.MAX_SAFE_INTEGER)) throw new MerchandiseTotalError('vNF', 'passou do inteiro seguro')
  return Object.freeze({ cents: Number(exact), formula: f.formula })
}
