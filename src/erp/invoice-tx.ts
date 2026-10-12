import { Pool, PoolConnection } from 'mysql2/promise'
import { withTransaction } from '../db/tx'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'
import { InvoiceRef, invoiceRef } from '../ref/invoice-ref'
import { LockedInvoice, lockInvoice } from './facts'

/**
 * Transação SOB A TRAVA DA NOTA (D-F27/D-F31) — peça do núcleo da parte 2 da NE-1a (D-NE13/D-NE58: a POLÍTICA em peças). A 1ª coisa que a
 * transação faz no ERP é o `FOR UPDATE` na linha da nota (`lockInvoice`); transmitir × cancelar local (setes-api) se serializam nela.
 *
 * D-NE74 (= Q-NE74 (a), Valdo 2026-10-12): o `InvoiceTx` (conexão + a referência TRAVADA + a vida lida sob a trava) só nasce aqui — o
 * escritor da voz e os escritores da tentativa (D-NE75) o EXIGEM, então "escrita sempre sob a trava da nota" vale por CONSTRUÇÃO e a nota
 * escrita é obrigatoriamente a travada.
 *
 * D-NE81 (gates da parte 2 — Valdo 2026-10-12, a recomendação do socrático): a conferência é por IDENTIDADE, não por forma — o núcleo
 * guarda os `InvoiceTx` que EMITIU (`ISSUED`, privado deste módulo) e só eles passam no `assertInvoiceTx`; um objeto montado à mão (com
 * `as any`, copiando os campos de um verdadeiro) é recusado em execução. Exceção NOMEADA da regra 3 do núcleo ("nenhum Map/Set de controle
 * em memória"): o `WeakSet` não serializa nada — a trava segue no BANCO (`FOR UPDATE`); ele só diz "este objeto saiu do `withInvoiceTx`
 * e a transação dele ainda está aberta" (entra na emissão, sai no fim do callback; fraco — não segura memória).
 *
 * A referência e a vida são CÓPIAS CONGELADAS tiradas ANTES da trava: quem segura o `InvoiceTx` não troca a nota escrita depois de travada.
 * Ele só vale DENTRO da transação: `open` cai e o registro o esquece quando o callback termina — guardado e usado depois (a conexão já
 * voltou ao pool, a trava já soltou) é recusado.
 *
 * [who] = quem pede (o estabelecimento AUTENTICADO e o schema dele): referência de outra institution, id/terminal fora do domínio falham
 * ALTO aqui, no núcleo (gate socrático da parte 2 — a garantia vale para quem chama a peça direto, como a futura nfe-api; D-F39).
 *
 * [lock] = o leitor travante do ERP — o do núcleo por padrão; a família pode passar o MESMO (`erp.lockInvoice` do índice) para que os
 * testes dela o simulem pela costura de sempre (`jest.mock('fiscal-api')`). Não é ponto de extensão: em produção é sempre o do núcleo
 * (D-NE80 — cerca por AST nas famílias: `lock:` só `erp.lockInvoice`).
 */
declare const INVOICE_TX: unique symbol

export interface InvoiceTx {
  readonly conn:   PoolConnection
  readonly ref:    InvoiceRef
  readonly locked: LockedInvoice
  /** true só enquanto o callback do `withInvoiceTx` roda (getter — cai no fim da transação). */
  readonly open:   boolean
  readonly [INVOICE_TX]: true
}

export type InvoiceLocker = (conn: PoolConnection, schemaName: string, ref: InvoiceRef) => Promise<LockedInvoice | null>

/** Quem pede a transação: o estabelecimento autenticado e o schema dele no ERP. */
export interface InvoiceTxRequester {
  readonly schemaName:    string
  readonly institutionId: number
}

/** Os `InvoiceTx` EMITIDOS e ainda abertos (D-NE81 — identidade, não controle; ver o cabeçalho). */
const ISSUED = new WeakSet<object>()

const validId = (v: unknown, min: number) => typeof v === 'number' && Number.isInteger(v) && v >= min

export async function withInvoiceTx<T>(
  pool: Pool, who: InvoiceTxRequester, ref: InvoiceRef,
  opts: { label: string; requireAlive?: boolean; lock?: InvoiceLocker },
  fn: (itx: InvoiceTx) => Promise<T>,
): Promise<T> {
  if (!who || !validId(who.institutionId, 1) || typeof who.schemaName !== 'string') {
    throw new Error(`withInvoiceTx: quem pede é obrigatório (estabelecimento autenticado e schema): ${JSON.stringify(who)}`)
  }
  // lida UMA vez (a referência que chegou pode ter getters) e conferida contra quem pede, antes de qualquer conexão
  const held = ref ? invoiceRef(ref.institutionId, ref.invoiceId, ref.terminal) : null
  if (!held || held.institutionId !== who.institutionId || !validId(held.invoiceId, 1) || !validId(held.terminal, 0)) {
    throw new Error(`Referência da nota inválida para quem pede (institution ${who.institutionId}): ${JSON.stringify(held)}`)
  }
  return withTransaction(pool, opts.label, { institutionId: held.institutionId, invoiceId: held.invoiceId }, async conn => {
    const locked = await (opts.lock ?? lockInvoice)(conn, who.schemaName, held)
    if (!locked || (opts.requireAlive && !locked.alive)) {
      throw new HttpError(404, `Nota ${held.invoiceId} não encontrada`, undefined, ErrorCodes.INVOICE_NOT_FOUND)
    }
    let open = true
    const itx = Object.freeze({ conn, ref: held, locked: Object.freeze({ ...locked }), get open() { return open } }) as InvoiceTx
    ISSUED.add(itx)
    try {
      return await fn(itx)
    } finally {
      open = false
      ISSUED.delete(itx)
    }
  })
}

/**
 * Conferência em EXECUÇÃO de quem recebe um `InvoiceTx` (o tipo some no JS): EMITIDO pelo `withInvoiceTx` e ainda ABERTO (D-NE81 —
 * identidade, não forma). Quem escreve confere na ENTRADA e de novo logo ANTES de gravar (gate adversarial NE1A2-02: a escrita começada
 * no callback e não aguardada terminaria depois do COMMIT).
 */
export function assertInvoiceTx(itx: unknown): asserts itx is InvoiceTx {
  if (!itx || typeof itx !== 'object' || !ISSUED.has(itx) || (itx as InvoiceTx).open !== true) {
    throw new Error('D-NE74: escrita FORA da trava da nota (InvoiceTx não emitido pelo withInvoiceTx, ou de transação encerrada) — nada gravado')
  }
}
