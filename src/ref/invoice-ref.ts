/**
 * Referência da NOTA no ERP (NE-1a — D-NE12; ordem da Rodada 1 da NE-1a — D-NE59, Valdo 2026-10-11): a chave da nota no ERP é
 * (id, institution, TERMINAL) — a NFC-e (F5) terá nota e série por terminal. Toda peça do núcleo que lê ou trava a nota recebe a
 * referência INTEIRA; o terminal da web (`WEB_TERMINAL`) só existe na BORDA de quem monta a referência — nunca como literal num SQL
 * do núcleo (nem na F2a, que lê as views pelas peças daqui).
 *
 * Sem validação aqui (de propósito): a referência só carrega o que a borda já conferiu; um id torto segue virando "nota não
 * encontrada" no SQL, como antes — nunca um erro 500 novo no caminho da NFS-e.
 */
export interface InvoiceRef {
  readonly institutionId: number
  readonly invoiceId:     number
  readonly terminal:      number
}

/**
 * Família = RAMO da nota no `fiscal_api` (55 e 65 são a MESMA família — mercadoria). Nunca coluna. Mora aqui (e não em `voice/`) para
 * que a habilitação (`establishment/` — catálogo `ISSUER_MODEL_FACTS`, D-NE10) a use sem depender da voz (parecer do guardião da parte 2
 * da NE-1a); `voice/reading.ts` a re-exporta com o mesmo nome.
 */
export type InvoiceBranch = 'service' | 'merchandise'

/** Escopo de LEITURAS EM LOTE (várias notas): o estabelecimento e o terminal — a nota inteira menos o id (D-NE12). */
export type InvoiceScope = Pick<InvoiceRef, 'institutionId' | 'terminal'>

/** Terminal das notas emitidas pela web/servidor (o legado e o PDV usam 1..N — D-NE12). Usar SÓ na borda. */
export const WEB_TERMINAL = 0

export function invoiceRef(institutionId: number, invoiceId: number, terminal: number): InvoiceRef {
  return Object.freeze({ institutionId, invoiceId, terminal })
}

/** Filtro da nota numa VIEW/tabela que tenha as três colunas da chave (o alias é do chamador) — o terminal vai como PARÂMETRO. */
export function invoiceRefFilter(ref: InvoiceRef, alias: string): { sql: string; params: number[] } {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error(`Alias inválido: ${alias}`)
  return {
    sql: `${alias}.tb_institution_id = ? AND ${alias}.tb_invoice_id = ? AND ${alias}.terminal = ?`,
    params: [ref.institutionId, ref.invoiceId, ref.terminal],
  }
}
