import { FINAL_TRANSMISSION_KINDS, KIND_CLASS } from '../kinds'

/**
 * PROVA DE "NÃO REGISTRADA" da NF-e (FAMILIA.E5.P6.T2 — D-NE111, D-NE235, Valdo 2026-11-22; RF-NFE-72).
 *
 * O MOC 7.00 diz do 217 só "NF-e não consta na base de dados da SEFAZ" (RF-NFE-21, J03): NENHUMA norma o lê como "o fisco não tem
 * esta nota". Ler assim é POLÍTICA DO PRODUTO, e a política é esta (D-NE235): o 217 só prova pela rota própria `reconfirm` (nunca pelo
 * `refresh`), com a `chNFe` do retorno igual à da tentativa, no autorizador gravado na tentativa (D-NE37), sem recibo 103/105 em
 * aberto e se a última voz é ainda a que a pergunta viu. Molde de COMPORTAMENTO: a prova E2404 da NFS-e (D-F90/D-F109,
 * `service.ts`) — identidades diferentes, nenhum código em comum: não generalizar numa "prova negativa" única.
 *
 * CONTRATO DE QUEM CHAMA (a nfe-api, NFE.E6.P1):
 *  1. Só o handler de `POST /v1/nfe/invoices/{invoiceId}/reconfirm` declara `route: 'reconfirm'`; o `refresh` nunca. O núcleo não vê
 *     HTTP: a declaração é de quem chama, e a prova disso é cerca de teste na nfe-api (só o handler da reconfirm chama o escritor).
 *  2. A peça só VEREDITA; não grava. A coluna `nfe_not_registered_at` (migration 002 da nfe-api) e o escritor
 *     `recordNfeNotRegistered` são da nfe-api, relógio NOSSO (`NOW()`), como o `recordNfseNotGenerated` da nfse-api.
 *  3. A guarda "voz inalterada" é DUPLA e por isso o `UPDATE … WHERE (SELECT COALESCE(MAX(event), 0) …) = <voz vista>` não pode sumir:
 *     o veredito compara a voz LIDA; a trava de verdade contra a corrida entre a pergunta e a gravação é a condição no UPDATE. Peça
 *     pura sozinha é TOCTOU.
 *  4. O resultado é FATO da tentativa, nunca voz; `last_queried_at` nunca entra (é só a cota do rodízio).
 *  5. A tentativa em voo SEM recibo (sem voz ou S) é justamente o que o 217 prova (a transmissão interrompida); a nova tentativa só sai
 *     depois do veredito `provada` e do fato gravado. ATENÇÃO — a peça NÃO confere a IDADE da tentativa: uma `reconfirm` poucos segundos
 *     depois do envio (sem voz, sem recibo) passaria, e o POST original ainda poderia chegar ao fisco. O intervalo mínimo entre consultas
 *     da mesma chave (`last_queried_at`) NÃO protege a primeira pergunta (a transmissão não o grava). Pré-condição de quem chama (PM-8 da
 *     nfe-api): exigir uma idade mínima da tentativa antes de perguntar, como a nfse-api faz com a voz S (`IN_FLIGHT_MINUTES`); o valor é
 *     decisão do Valdo.
 *  6. R e F são vozes fechadas sem registro: a peça as aceita, mas a `reconfirm` da nfe-api as devolve antes (`tentativa-fechada`).
 * Nada tem valor padrão (R20-02 do gate da Rodada 20): campo ausente ou torto = `entrada-invalida`, falhando FECHADO. O nome é
 * `notRegisteredProven` e NÃO `notFound`: "não consta" é a voz N, e o nome antigo convidaria a gravar em qualquer 404.
 */

export const NOT_REGISTERED_CSTAT = 217

export type NotRegisteredRoute = 'reconfirm' | 'refresh' | 'manual'

export type NotRegisteredReason =
  | 'provada'
  | 'rota-nao-reconfirm'
  | 'cstat-nao-217'
  | 'chave-diferente'
  | 'autorizador-diferente'
  | 'recibo-em-aberto'
  | 'voz-de-registro'
  | 'voz-mudou'
  | 'entrada-invalida'

/** O que a pergunta trouxe e o que a tentativa tem — todos obrigatórios (o valor pode ser `null` onde o tipo diz). */
export interface NotRegisteredQuestion {
  /** Declarada por quem chama (contrato 1). */
  readonly route: NotRegisteredRoute
  /** cStat do retorno da consulta por chave. */
  readonly cStat: number
  /** `chNFe` DO RETORNO. */
  readonly queriedAccessKey: string
  /** A chave da tentativa. */
  readonly attemptAccessKey: string
  /** Autorizador que respondeu a pergunta. */
  readonly answeredBy: string
  /** Autorizador gravado na tentativa (D-NE37). */
  readonly attemptAuthorizer: string
  /** Recibo da tentativa (103/105); `null` = sem recibo. */
  readonly receipt: string | null
  /** Letra da última voz da tentativa NA LEITURA QUE A PERGUNTA VIU (a mesma de `seenLastEvent`); `null` = sem voz (em voo). */
  readonly lastKind: string | null
  /** Última voz que a PERGUNTA viu (número do evento, a partir de 1); `null` = sem voz — nulo se e só se `lastKind` é nulo. */
  readonly seenLastEvent: number | null
  /** Última voz AGORA (número do evento, a partir de 1); `null` = sem voz. */
  readonly currentLastEvent: number | null
}

export interface NotRegisteredVerdict {
  readonly proven: boolean
  readonly reason: NotRegisteredReason
}

const ROUTES: readonly string[] = ['reconfirm', 'refresh', 'manual']
/**
 * Quem a peça recusa pela VOZ da tentativa (S2/S9 da ficha, revistas depois do código da `reconfirm` da nfe-api): A, N (autorizada),
 * C (cancelada), D (denegada) e K (cancelamento em voo, que pressupõe a autorização) são REGISTRO do fisco — "não registrada" gravado
 * sobre elas seria contradição (`voz-de-registro`); P é a consulta do recibo em andamento (`recibo-em-aberto`). Prova a tentativa que
 * o fisco não respondeu: SEM VOZ ou S (a transmissão interrompida — o caso de uso da D-NE235), além de F e R (fechadas sem registro).
 * A D-NE235 só exclui o recibo 103/105 em aberto; a tentativa em voo sem recibo PROVA (idade mínima: contrato 5, de quem chama).
 */
/** Chave: 44 caracteres [0-9A-Z] (o CNPJ alfanumérico entra na chave); fora disso não é chave. */
const ACCESS_KEY = /^[0-9A-Z]{44}$/

const verdict = (reason: NotRegisteredReason): NotRegisteredVerdict => Object.freeze({ proven: reason === 'provada', reason })

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isEvent = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1)

/**
 * O veredito. Ordem das recusas (a primeira que falha é o motivo): entrada → rota → cStat → chave → autorizador → recibo/tentativa
 * em aberto → voz de registro → voz. A chave é comparada por IGUALDADE EXATA de texto, no formato de 44 caracteres [0-9A-Z]. `lastKind` e
 * `seenLastEvent` são da MESMA leitura (a que a pergunta viu): `lastKind` nulo ⇔ `seenLastEvent` nulo ("sem voz"); `currentLastEvent`
 * é a última voz AGORA (nulo = sem voz). Eventos são números a partir de 1 — quem lê o banco com `COALESCE(MAX(event), 0)` converte o 0 em
 * `null` ANTES de chamar (a peça recusa 0). Recibo em aberto: há recibo 103/105 e a voz não é final (sem voz ou S), ou a voz é P.
 * A entrada é COPIADA no início (um getter que muda entre leituras não mistura valores) e só conta o que é próprio dela.
 */
export function notRegisteredProven(input: NotRegisteredQuestion): NotRegisteredVerdict {
  if (input === null || typeof input !== 'object') return verdict('entrada-invalida')
  const own = (k: keyof NotRegisteredQuestion): unknown => (Object.prototype.hasOwnProperty.call(input, k) ? (input as unknown as Record<string, unknown>)[k] : undefined)
  const q = {
    route: own('route'), cStat: own('cStat'), queriedAccessKey: own('queriedAccessKey'), attemptAccessKey: own('attemptAccessKey'),
    answeredBy: own('answeredBy'), attemptAuthorizer: own('attemptAuthorizer'), receipt: own('receipt'), lastKind: own('lastKind'),
    seenLastEvent: own('seenLastEvent'), currentLastEvent: own('currentLastEvent'),
  }
  const kindKnown = q.lastKind === null || (typeof q.lastKind === 'string' && Object.prototype.hasOwnProperty.call(KIND_CLASS, q.lastKind))
  if (typeof q.route !== 'string' || !ROUTES.includes(q.route) || typeof q.cStat !== 'number' || !Number.isSafeInteger(q.cStat)
      || !isText(q.queriedAccessKey) || !isText(q.attemptAccessKey) || !isText(q.answeredBy) || !isText(q.attemptAuthorizer)
      || !(q.receipt === null || isText(q.receipt)) || !kindKnown || !isEvent(q.seenLastEvent) || !isEvent(q.currentLastEvent)
      || (q.lastKind === null) !== (q.seenLastEvent === null)) {
    return verdict('entrada-invalida')
  }
  if (q.route !== 'reconfirm') return verdict('rota-nao-reconfirm')
  if (q.cStat !== NOT_REGISTERED_CSTAT) return verdict('cstat-nao-217')
  if (!ACCESS_KEY.test(q.queriedAccessKey) || !ACCESS_KEY.test(q.attemptAccessKey) || q.queriedAccessKey !== q.attemptAccessKey) return verdict('chave-diferente')
  if (q.answeredBy !== q.attemptAuthorizer) return verdict('autorizador-diferente')
  const lastKind = q.lastKind as string | null
  const finalVoice = lastKind !== null && FINAL_TRANSMISSION_KINDS.has(lastKind)
  if (lastKind === 'A' || lastKind === 'N' || lastKind === 'C' || lastKind === 'D' || lastKind === 'K') return verdict('voz-de-registro')
  if (lastKind === 'P' || (q.receipt !== null && !finalVoice)) return verdict('recibo-em-aberto')
  if (q.seenLastEvent !== q.currentLastEvent) return verdict('voz-mudou')
  return verdict('provada')
}
