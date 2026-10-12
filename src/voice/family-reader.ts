import { TransmissionView, VoiceFamilyReading, familyViewSelect } from './reading'
import { InvoiceLifeRef, familyViewQuery, familyViewQueryLives, positiveInt } from './view-query'
import { VOICE_READINGS } from './families'
import { InvoiceRef } from '../ref/invoice-ref'

export type { InvoiceLifeRef }

/**
 * O LEITOR que já MAPEIA (D-NE66 (b) = Q-NE66 (c), gates da NE-1a parte 1 — executado na F2a, Rodada 1 da F2a; `prompt_apis_fiscais_isoladas.md`
 * §22 e notas (8)/(10) da F2a): a leitura PÚBLICA da voz de uma família pela view publicada (D-F15) — SELECT pronto (`familyViewSelect` da
 * família, referência inteira por parâmetro — D-NE12) + o mapa ESTRITO da família (`reading.map`: o registro pelo fisco vira o FATO
 * booleano, coluna que decide fora do domínio falha ALTO). Nenhum consumidor recebe a linha crua.
 *
 * D-F119 (= Q-F125 (b), Valdo 2026-10-12 — gates da A1 da F2a): o leitor é ESCOPADO PELA VIDA — devolve só as tentativas da vida pedida
 * (a vida vigente vem da `vw_invoice_life` do ERP; o histórico de vidas é da tela "No fisco", que é da nfse-api). Esquecer o filtro da vida
 * deixava misturar uma vida antiga registrada com a nova e liberar o cancelamento local sem reconferir (F2A1-01). O veredito e o
 * `currentOf` também recusam lista mista.
 *
 * Só SELECT, sem trava. D-F121 (= Q-F130 (a)): quem DECIDE o cancelamento local lê DEPOIS da trava da nota no ERP — o `FOR UPDATE` da nota
 * é o 1º comando da transação (sob REPEATABLE READ a 1ª leitura consistente fixa o retrato: uma leitura antes da trava não veria a voz
 * gravada por outra conexão no meio — provado ao vivo nos gates da A1; PADROES_BANCO §9 regra 2); cerca no plano da A3.
 */

/** O mínimo do driver (mysql2 `Pool`/`PoolConnection`) — ESTRUTURAL: a superfície de leitura não importa o banco do núcleo (D-NE77). */
export interface ReadQueryable {
  query(sql: string, params?: unknown): Promise<[any, any]>
}

/** As tentativas da VIDA [lifeEvent] de UMA nota, MAPEADAS pela família — em ordem de tentativa. */
export async function readFamilyTransmissions<V extends TransmissionView>(
  q: ReadQueryable, reading: VoiceFamilyReading<V>, db: string, ref: InvoiceRef, lifeEvent: number,
): Promise<V[]> {
  positiveInt(lifeEvent, 'Vida da nota')                                   // D-F119: sem a vida, o filtro sumiria (nunca 'todas as vidas')
  const { sql, params } = familyViewQuery(reading, db, ref, 'v', lifeEvent)
  const [rows] = await q.query(sql, params)
  return checkedLives(rowsOf(rows).map(r => reading.map(r)), [{ invoiceId: ref.invoiceId, lifeEvent }])
}

/**
 * As tentativas de VÁRIAS notas do MESMO estabelecimento e terminal (lote — o selo da lista de OS), cada uma na vida PEDIDA (pares nota ×
 * vida — D-F119), MAPEADAS — em ordem de nota e tentativa. Lista vazia = lista vazia (nada a perguntar ao banco).
 */
export async function readFamilyTransmissionsMany<V extends TransmissionView>(
  q: ReadQueryable, reading: VoiceFamilyReading<V>, db: string, scope: Pick<InvoiceRef, 'institutionId' | 'terminal'>, lives: readonly InvoiceLifeRef[],
): Promise<V[]> {
  if (!lives.length) return []
  const { sql, params } = familyViewQueryLives(reading, db, scope, lives)
  const [rows] = await q.query(sql, params)
  return checkedLives(rowsOf(rows).map(r => reading.map(r)), lives)
}

/**
 * D-F113 (= Q-F119 (a), Valdo 2026-10-12): família INSTALADA = o catálogo `VOICE_READINGS` desta versão da biblioteca. O boot de quem lê a voz
 * (o setes-api na F2a; a nfse-api também, sobre as próprias views) confere que a view de tentativas de CADA família do catálogo responde ao
 * SELECT publicado — com toda coluna da projeção comum (inclusive `authority_recorded` — nota (9) da F2a) e as da família. Falta de view,
 * coluna ou GRANT = falha ALTO no boot (nunca 500 na 1ª leitura da lista). Ordem de deploy: o serviço da família ANTES de quem lê.
 */
export async function assertFamilyViewsReadable(
  q: ReadQueryable, db: string, readings: readonly VoiceFamilyReading<TransmissionView>[] = Object.values(VOICE_READINGS) as VoiceFamilyReading<TransmissionView>[],
): Promise<void> {
  if (!readings.length) throw new Error('assertFamilyViewsReadable: catálogo de famílias vazio')
  for (const reading of readings) {
    try {
      await q.query(`${familyViewSelect(reading, db)} WHERE 1 = 0`)
    } catch (err: any) {
      throw new Error(`A view de tentativas da família "${reading.branch}" (${db}.${reading.transmissionView}) não responde ao SELECT publicado `
        + `(${err?.code ?? err?.errno ?? 'erro'}) — migration da família não aplicada, coluna faltando ou sem GRANT (D-F113)`)
    }
  }
}

/** O resultado do driver para um SELECT é uma lista de linhas — outra coisa (OkPacket, undefined) é defeito de quem chamou: falha ALTO. */
function rowsOf(rows: unknown): any[] {
  if (!Array.isArray(rows)) throw new Error('Leitura da view da família: o driver não devolveu linhas')
  return rows
}

/** Cada linha devolvida é de uma vida PEDIDA — uma linha de outra vida (view torta, filtro perdido) falha ALTO, nunca entra na decisão. */
function checkedLives<V extends TransmissionView>(rows: V[], lives: readonly InvoiceLifeRef[]): V[] {
  for (const r of rows) {
    if (!lives.some(l => l.invoiceId === r.invoiceId && l.lifeEvent === r.lifeEvent)) throw new Error(`Leitura da view da família: linha da nota ${r.invoiceId} na vida ${r.lifeEvent}, que não foi pedida`)
  }
  return rows
}
