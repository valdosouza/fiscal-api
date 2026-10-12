import { AuthorityHttpError } from '../transport/https-json'
import { ErrorCodes } from '../errors/error-codes'
import { readonlySet } from '../util/readonly-set'
import { TransmissionEventKind } from './kinds'

/**
 * O DESFECHO de uma chamada ao fisco que FALHOU → a voz que ele grava — peça do núcleo da parte 2 da NE-1a (D-NE13/D-NE58: a POLÍTICA em
 * peças; o ROTEIRO — quando chamar, o que fazer depois — fica na família). Veio da nfse-api sem mudar de comportamento (§12.9.7, passo 5).
 *  - recusa EXPLÍCITA de regra → R; credencial recusada pelo fisco → F; credencial LOCAL (Q-N30b) → F; cadeia do SERVIDOR não confiável
 *    (D-NE57 — classificação EXPLÍCITA: código desconhecido cairia no ambíguo) → F; o resto é AMBÍGUO (D-I21): nada grava, a tentativa
 *    fica em voo e a consulta reconcilia;
 *  - `OUTCOME_KIND` é EXAUSTIVO pelo tipo (Record sobre os desfechos que gravam — desfecho novo não compila sem dizer a voz; o ambíguo
 *    fica de fora de propósito) e CONGELADO (gate R22, R22-02: `Object.assign`/`Reflect.set` compilavam sem cast e trocavam a voz de
 *    toda falha local do processo); R e F estão na lista de escrita de toda família (o tipo da família os aceita — D-F106/D-F108).
 */
export type AuthorityOutcome = 'rejected' | 'auth_failed' | 'chain_untrusted' | 'ambiguous' | 'local'

export function classifyAuthorityError(err: unknown): AuthorityOutcome {
  if (!(err instanceof AuthorityHttpError)) return 'ambiguous'
  switch (err.code) {
    case ErrorCodes.FISCAL_DPS_REJECTED:          return 'rejected'
    case ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED: return 'auth_failed'
    case ErrorCodes.FISCAL_AUTHORITY_CHAIN_UNTRUSTED: return 'chain_untrusted'
    case ErrorCodes.FISCAL_CERT_INVALID:          return 'local'
    default:                                      return 'ambiguous'
  }
}

export const OUTCOME_KIND = Object.freeze({ rejected: 'R', auth_failed: 'F', chain_untrusted: 'F', local: 'F' } as const) satisfies
  Readonly<Record<Exclude<AuthorityOutcome, 'ambiguous'>, TransmissionEventKind>>

/** Erros do EMISSOR, não da nota (LOW-A): a passada do rodízio pára no 1º. Conjunto IMUTÁVEL em execução (NE1A-06). */
export const EMITTER_FAILURE_CODES: ReadonlySet<string> = readonlySet([
  ErrorCodes.FISCAL_AUTHORITY_UNAVAILABLE, ErrorCodes.FISCAL_AUTHORITY_AUTH_FAILED, ErrorCodes.FISCAL_AUTHORITY_CHAIN_UNTRUSTED, ErrorCodes.FISCAL_CERT_INVALID,
  ErrorCodes.FISCAL_ISSUER_MISSING, ErrorCodes.FISCAL_CERT_MISSING, ErrorCodes.FISCAL_CERT_EXPIRED,
  ErrorCodes.FISCAL_MASTER_KEY_UNAVAILABLE,
])

/** Fecho de um `switch` EXAUSTIVO sobre o desfecho nos roteiros da família: desfecho novo sem caso não compila (em vez de cair calado no
 *  ambíguo — num cancelamento, isso prendia o K da reserva). Em execução (só com cast) falha alto. */
export function unhandledOutcome(outcome: never): never {
  throw new Error(`Desfecho do fisco sem tratamento no roteiro: ${String(outcome)}`)
}
