import { TransmissionView, VoiceFamilyReading, familyViewSelect } from './reading'
import { InvoiceRef, invoiceRefFilter } from '../ref/invoice-ref'

/**
 * SQL CRU das views de tentativas da família — INTERNO à biblioteca (D-NE66 (b) = Q-NE66 (c), gates da NE-1a parte 1; executado na F2a,
 * Rodada 1 da F2a — `prompt_apis_fiscais_isoladas.md` §22): o par SELECT + linha crua deixou de ser o caminho PÚBLICO — quem lê pela
 * superfície usa o leitor que já MAPEIA (`readFamilyTransmissions`, `voice/family-reader.ts`); a linha crua da view traz
 * `authority_recorded` como 'S'/'N' e só o mapa da família a transforma no FATO booleano (NE1A-01). Nem `fiscal-api/reading` nem o
 * barrel re-exportam este módulo.
 */
/** A vida de uma nota (o evento E que a abriu — D-N27), como o leitor público a recebe (D-F119). */
export interface InvoiceLifeRef {
  readonly invoiceId: number
  readonly lifeEvent: number
}

export const positiveInt = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new Error(`${what} inválido: ${JSON.stringify(v)} (inteiro > 0)`)
  return v
}

/**
 * As tentativas de UMA nota na view da família (a referência inteira por parâmetro — o terminal nunca é literal; D-NE12). Com [lifeEvent]
 * (D-F119 = Q-F125 (b), Valdo 2026-10-12): só as da vida pedida.
 */
export function familyViewQuery(
  reading: VoiceFamilyReading<TransmissionView>, db: string, ref: InvoiceRef, alias = 'v', lifeEvent?: number,
): { sql: string; params: number[] } {
  const f = invoiceRefFilter(ref, alias)
  if (lifeEvent === undefined) return { sql: `${familyViewSelect(reading, db, alias)} WHERE ${f.sql} ORDER BY ${alias}.attempt`, params: f.params }
  return {
    sql: `${familyViewSelect(reading, db, alias)} WHERE ${f.sql} AND ${alias}.life_event = ? ORDER BY ${alias}.attempt`,
    params: [...f.params, positiveInt(lifeEvent, 'Vida da nota')],
  }
}

/**
 * As tentativas de VÁRIAS notas do MESMO estabelecimento e terminal (lote — o selo da lista de OS na F2a; gate socrático da NE-1a, M3):
 * a chave da nota inteira por parâmetro (simétrico ao `invoiceLives`), nunca um WHERE próprio do leitor com `terminal = 0`. D-F119: o lote é
 * de PARES (nota, vida) — quem pergunta lê as vidas vigentes (`vw_invoice_life` do ERP) e o leitor nunca mistura vidas. Lista vazia é erro
 * de quem chama (não há SQL para "nenhuma nota").
 */
export function familyViewQueryLives(
  reading: VoiceFamilyReading<TransmissionView>, db: string, scope: Pick<InvoiceRef, 'institutionId' | 'terminal'>, lives: readonly InvoiceLifeRef[], alias = 'v',
): { sql: string; params: unknown[] } {
  if (!lives.length) throw new Error('familyViewQueryLives: lista de vidas vazia')
  // o escopo do lote é conferido (gates da A1: terminal ausente virava `terminal = NULL` e o lote voltava VAZIO, calado)
  positiveInt(scope?.institutionId, 'Estabelecimento do lote')
  if (typeof scope?.terminal !== 'number' || !Number.isInteger(scope.terminal) || scope.terminal < 0) throw new Error(`Terminal do lote inválido: ${JSON.stringify(scope?.terminal)} (inteiro ≥ 0)`)
  const pairs = lives.map(l => [positiveInt(l?.invoiceId, 'Nota'), positiveInt(l?.lifeEvent, 'Vida da nota')])
  return {
    sql: `${familyViewSelect(reading, db, alias)} WHERE ${alias}.tb_institution_id = ? AND ${alias}.terminal = ?`
      + ` AND (${alias}.tb_invoice_id, ${alias}.life_event) IN (?) ORDER BY ${alias}.tb_invoice_id, ${alias}.attempt`,
    params: [scope.institutionId, scope.terminal, pairs],
  }
}
