import { Queryable } from '../db/tx'
import { legacyWallBeforeCutover } from '../time/zone'
import type { InvoiceRef } from '../ref/invoice-ref'
import { InvoiceTx, assertInvoiceTx } from '../erp/invoice-tx'
import { KIND_CLASS, TransmissionEventKind, TransmissionSource } from './kinds'
import { TransmissionView, VoiceFamilyReading } from './reading'
import { readonlySet } from '../util/readonly-set'

/**
 * A VOZ do fisco de UMA família — ESCRITOR ÚNICO do núcleo (D-F108 = Q-F114 (a), Valdo 2026-10-11; parte 2 da NE-1a, D-NE13/D-NE58/D-NE74;
 * nota de implantação no `prompt_onda_nfe_sefaz.md` §12.8). Este é o ÚNICO arquivo do núcleo com SQL na tabela da voz — o escritor e os dois
 * leitores de idempotência (lista branca da cerca D-F31, com a exceção NOMEADA `${table}`).
 *
 * DOIS descritores, compostos (parecer do guardião): `VoiceFamilyReading` é o CONTRATO PUBLICADO (views — o setes-api importa, D-F33);
 * `VoiceFamily<K>` é o lado INTERNO — a tabela da voz e a LISTA DE ESCRITA da família, que a família DECLARA (o valor mora nela: a NFS-e é
 * dona de `SERVICE_VOICE_WRITE_KINDS`, no mesmo repo do CHECK da F2a — D-F107). O núcleo conhece só a FORMA (colunas comuns da voz, UNIQUE
 * `(…, kind, dh)`); o NOME da tabela chega pelo descritor, validado — nunca um literal de família aqui (a cerca do núcleo cego segue sem exceção).
 *
 * Defesas que vieram da NFS-e (D-F105/D-F106) e valem para TODA família:
 *  - a porta é PROPRIEDADE-FUNÇÃO, nunca método (método é BIVARIANTE: aceitaria o escritor estreito e deixaria gravar S — provado com
 *    `tsc --strict` no gate R22); o tipo do `kind` é a lista da família (`WriteKindOf<F>`);
 *  - o FUNIL confere a lista em EXECUÇÃO (sensível a caixa — o 's' que a colação _ci leria como S também é recusado — D-F103) ANTES de
 *    qualquer query (cast, spread, JSON e `as any` apagam o tipo no JS);
 *  - D-NE74/D-NE81: o escritor EXIGE o `InvoiceTx` EMITIDO pelo `withInvoiceTx` e ainda aberto — confere na entrada e de novo logo antes
 *    do INSERT (gate NE1A2-02: a escrita não aguardada terminaria depois do COMMIT);
 *  - a entrada é lida UMA vez (gate NE1A2-03: um getter passava o funil com A e gravava S — o valor conferido é o valor gravado).
 * CONHECIMENTO NEGATIVO: nenhum "S antes do POST" comum às famílias — quem produzir S (a NF-e pode — D-F105) entrega a saída dela junto.
 */

export interface VoiceEventInput<K extends TransmissionEventKind> {
  kind:           K
  authorityCode?: string | null
  message?:       string | null
  dh?:            string | null
  source:         TransmissionSource
}

/** Uma voz como a tabela a guarda (instantes 'YYYY-MM-DD HH:MM:SS' UTC). */
export interface VoiceEventRow {
  attempt:       number
  event:         number
  kind:          TransmissionEventKind
  authorityCode: string | null
  message:       string | null
  dh:            string | null
  source:        TransmissionSource
  userId:        number | null
  createdAt:     string | null
}

export interface VoiceFamily<K extends TransmissionEventKind> {
  readonly reading:    VoiceFamilyReading<TransmissionView>
  readonly eventTable: string
  readonly writeKinds: readonly K[]
  /** Nome da família nas mensagens (a recusa do funil diz QUAL lista recusou) — declarado pela família: o núcleo não tem literal dela. */
  readonly label:      string
  /** Append-only; nº do evento = MAX+1 sob a trava da nota. PROPRIEDADE-FUNÇÃO (nunca método — D-F108). */
  readonly insertTransmissionEvent: (itx: InvoiceTx, attempt: number, userId: number | null, e: VoiceEventInput<K>) => Promise<number>
  /** Já existe esta fala (kind, dh)? Casa também a forma ANTIGA (parede de Brasília) até o corte (Q-TZ3). */
  readonly hasTransmissionEvent: (q: Queryable, ref: InvoiceRef, attempt: number, kind: TransmissionEventKind, dh: string | null) => Promise<boolean>
  /** Última fala de um KIND nesta tentativa (HIGH-3a: um C por tentativa, qualquer dh). */
  readonly findTransmissionEventByKind: (q: Queryable, ref: InvoiceRef, attempt: number, kind: TransmissionEventKind, forUpdate?: boolean) => Promise<VoiceEventRow | null>
}

/** A lista de escrita de uma família (o tipo que o escritor dela aceita). */
export type WriteKindOf<F> = F extends VoiceFamily<infer K> ? K : never

const EVENT_TABLE = /^tb_[a-z0-9_]+_transmission_event$/
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

export function defineVoiceFamily<const K extends TransmissionEventKind>(d: {
  reading: VoiceFamilyReading<TransmissionView>; eventTable: string; writeKinds: readonly K[]; label: string
}): VoiceFamily<K> {
  if (!d?.reading?.branch) throw new Error('defineVoiceFamily: a leitura publicada da família é obrigatória')
  if (typeof d.eventTable !== 'string' || !EVENT_TABLE.test(d.eventTable)) {
    throw new Error(`defineVoiceFamily: tabela da voz inválida (${JSON.stringify(d.eventTable)}) — só o nome simples da tabela da família no banco da conexão`)
  }
  if (!Array.isArray(d.writeKinds) || !d.writeKinds.length
      || !d.writeKinds.every(k => Object.prototype.hasOwnProperty.call(KIND_CLASS, k))) {
    throw new Error(`defineVoiceFamily: lista de escrita fora do vocabulário (${JSON.stringify(d.writeKinds)})`)
  }
  if (typeof d.label !== 'string' || !/^\S(?:.*\S)?$/.test(d.label) || d.label.length > 40) {
    throw new Error(`defineVoiceFamily: rótulo da família inválido (${JSON.stringify(d.label)})`)
  }
  const table = d.eventTable
  const label = d.label
  const writeKinds = Object.freeze([...d.writeKinds]) as readonly K[]
  const writeSet = readonlySet<string>(writeKinds)

  const insertTransmissionEvent = async (itx: InvoiceTx, attempt: number, userId: number | null, e: VoiceEventInput<K>): Promise<number> => {
    // a entrada lida UMA vez (NE1A2-03): o que o funil confere é o que o INSERT grava
    const kind = e?.kind as unknown
    const source = e?.source, dh = e?.dh ?? null, message = e?.message, authorityCode = e?.authorityCode
    // o FUNIL — nada é lido nem gravado antes da recusa (D-F106 → D-F108: a lista é a da FAMÍLIA)
    if (typeof kind !== 'string' || !writeSet.has(kind)) {
      throw new Error(`D-F106: kind fora do vocabulário de escrita da ${label} (${JSON.stringify(kind)}) — nada gravado`)
    }
    assertInvoiceTx(itx)                                                           // D-NE74/D-NE81
    const { conn, ref } = itx
    const [mx] = await conn.query<any[]>(
      `SELECT COALESCE(MAX(event), 0) + 1 AS next FROM ${table}
        WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ? AND attempt = ?`,
      [ref.institutionId, ref.invoiceId, ref.terminal, attempt])
    const event = Number(mx[0].next)
    assertInvoiceTx(itx)                                                           // NE1A2-02: ainda dentro da transação?
    await conn.query(
      `INSERT INTO ${table}
         (tb_institution_id, tb_invoice_id, terminal, attempt, event, kind, authority_code, message, dh, source, tb_user_id, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
      [ref.institutionId, ref.invoiceId, ref.terminal, attempt, event, kind, authorityCode?.slice(0, 10) ?? null,
       message ? String(message).slice(0, 255) : null, dh, source, userId])
    return event
  }

  const hasTransmissionEvent = async (q: Queryable, ref: InvoiceRef, attempt: number, kind: TransmissionEventKind, dh: string | null): Promise<boolean> => {
    const [rows] = await q.query(
      `SELECT COUNT(*) AS n FROM ${table}
        WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ? AND attempt = ? AND deleted = 'N'
          AND kind = ? AND ${dh === null ? 'dh IS NULL' : 'dh IN (?, ?)'}`,
      dh === null
        ? [ref.institutionId, ref.invoiceId, ref.terminal, attempt, kind]
        : [ref.institutionId, ref.invoiceId, ref.terminal, attempt, kind, dh, legacyWallBeforeCutover(dh) ?? dh])
    return Number((rows as any[])?.[0]?.n ?? 0) > 0
  }

  const findTransmissionEventByKind = async (
    q: Queryable, ref: InvoiceRef, attempt: number, kind: TransmissionEventKind, forUpdate = false,
  ): Promise<VoiceEventRow | null> => {
    const [rows] = await q.query(
      `SELECT attempt, event, kind, authority_code AS authorityCode, message, DATE_FORMAT(dh, '%Y-%m-%d %H:%i:%s') AS dh,
              source, tb_user_id AS userId, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS createdAt
         FROM ${table}
        WHERE tb_institution_id = ? AND tb_invoice_id = ? AND terminal = ? AND attempt = ? AND deleted = 'N' AND kind = ?
        ORDER BY event DESC LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
      [ref.institutionId, ref.invoiceId, ref.terminal, attempt, kind])
    const r = (rows as any[])[0]
    if (!r) return null
    return { ...r, attempt: Number(r.attempt), event: Number(r.event), userId: n(r.userId) } as VoiceEventRow
  }

  return Object.freeze({ reading: d.reading, eventTable: table, writeKinds, label, insertTransmissionEvent, hasTransmissionEvent, findTransmissionEventByKind })
}
