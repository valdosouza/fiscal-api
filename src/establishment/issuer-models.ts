import type { InvoiceBranch } from '../ref/invoice-ref'

/**
 * CATÁLOGO dos modelos que o núcleo habilita (D-NE10, Valdo 2026-10-10; parte 2 da NE-1a — `prompt_onda_nfe_sefaz.md` §12.9.7).
 * Três grãos (parecer do guardião): o RAMO (`branch` — tabelas, views, leitura e lista de escrita da família) × o MODELO (a LINHA da
 * habilitação: ambiente, série, `cutover_at`, aluguel, nDPS, autoridade) × o ESTABELECIMENTO (o A1, a trava de TODAS as linhas, o ato
 * da virada). Este catálogo liga modelo → autoridade e modelo → ramo.
 *
 * Em CÓDIGO, congelado — nunca tabela: ler uma tabela-catálogo antes do `FOR UPDATE` da habilitação recriaria o snapshot antes da trava
 * (veto registrado na migration 004 do núcleo). O DOMÍNIO (`ISSUER_MODELS`) é o mesmo do CHECK da 004 (teste compara); modelo novo =
 * migration que estende o CHECK + uma entrada aqui (o tipo exige a entrada — `satisfies Record<IssuerModel, …>`).
 *
 * `erpTransmitted` (D-NE73 — não "legado": no acervo "legado" é o Gestao2016): o ERP (setes-api) já transmitia este modelo ANTES da
 * extração, e a lacuna (b) da cerca consulta a habilitação DELE quando o `fiscal_api` não tem linha do modelo. Só a SE (D-F42: réplica
 * só nasce do `migrate:setes` e só SE); 55/65 NASCEM virados e não dependem da SE (D-NE10 (a)).
 */

export type IssuerAuthority = 'ADN' | 'SEFAZ'

/** Domínio do modelo (= CHECK `ck_establishment_issuer_model` da migration 004) — também a lista de LINHAS que `lockIssuerRows` trava. */
export const ISSUER_MODELS = Object.freeze(['SE', '55', '65'] as const)
export type IssuerModel = typeof ISSUER_MODELS[number]

export interface IssuerModelFacts {
  readonly authority:      IssuerAuthority
  readonly branch:         InvoiceBranch
  readonly erpTransmitted: boolean
}

const facts = (authority: IssuerAuthority, branch: InvoiceBranch, erpTransmitted: boolean): IssuerModelFacts =>
  Object.freeze({ authority, branch, erpTransmitted })

export const ISSUER_MODEL_FACTS: Readonly<Record<IssuerModel, IssuerModelFacts>> = Object.freeze({
  SE:   facts('ADN',   'service',     true),
  '55': facts('SEFAZ', 'merchandise', false),
  '65': facts('SEFAZ', 'merchandise', false),
} satisfies Record<IssuerModel, IssuerModelFacts>)

/** O modelo da habilitação de SERVIÇO (a única que o ERP transmitia — a lacuna (b) da cerca olha a LINHA dela: D-F57). */
export const SERVICE_ISSUER_MODEL: IssuerModel = 'SE'

export function isIssuerModel(model: unknown): model is IssuerModel {
  return typeof model === 'string' && (ISSUER_MODELS as readonly string[]).includes(model)
}

function factsOf(model: IssuerModel): IssuerModelFacts {
  if (!isIssuerModel(model)) throw new Error(`Modelo fora do domínio da habilitação: ${String(model)}`)
  return ISSUER_MODEL_FACTS[model]
}

/** Autoridade fiscal DERIVADA do modelo — catálogo constante, nunca coluna (D-E1). */
export function authorityOf(model: IssuerModel): IssuerAuthority {
  return factsOf(model).authority
}

/** Ramo (família) do modelo. */
export function branchOf(model: IssuerModel): InvoiceBranch {
  return factsOf(model).branch
}

/** Modelos de um ramo, na ordem do domínio (serviço → SE; mercadoria → 55, 65). */
export function modelsOf(branch: InvoiceBranch): readonly IssuerModel[] {
  return Object.freeze(ISSUER_MODELS.filter(m => ISSUER_MODEL_FACTS[m].branch === branch))
}

/** O ERP transmitia este modelo antes da extração (a lacuna (b) da cerca vale para ele). */
export function erpTransmitted(model: IssuerModel): boolean {
  return factsOf(model).erpTransmitted
}
