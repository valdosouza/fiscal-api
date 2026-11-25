import type { PoolConnection } from 'mysql2/promise'
import type { Queryable } from '../db/tx'
import type { SealedSecret } from './cipher'

/**
 * DONO DE SEGREDO CIFRADO do cofre (FAMILIA.E5.P7 — parecer do guardião de 2026-11-25): uma tabela do `fiscal_api` que guarda UM segredo por
 * estabelecimento, cifrado pela chave-mestra (`MasterKeyRing` — D-F16), com versão por linha e AAD própria.
 *
 * Por que existe: a rotação da chave-mestra ("reabre com a antiga, regrava com a nova") e a prova da chave do servidor só enxergavam o A1.
 * Com um 2º segredo no mesmo anel (a senha SMTP), tirar a chave antiga depois de rotacionar só o A1 deixaria o outro sem abrir. O contrato é
 * PEQUENO e a lista dos donos é FECHADA (`SEALED_STORES`, em `sealed-stores.ts`): dono novo entra na lista, nunca por nome de tabela em
 * parâmetro (nada de SQL montado com nome que vem de fora).
 *
 * Cada função lê ou grava SÓ a cifra — nenhuma devolve nem recebe o segredo em claro.
 */
export interface SealedStore {
  /** A tabela dona (só para relatório e mensagem — nunca interpolada em SQL fora do repositório dela). */
  readonly name: string
  /** O código de erro de "o segredo guardado não abre" deste dono (relatório da rotação e da prova). */
  readonly unreadableCode: string
  /** AAD da linha: amarra a cifra ao dono e ao estabelecimento. */
  aad(institutionId: number): string
  /** Versões de chave-mestra que ainda cifram algum segredo VIVO deste dono. */
  keyVersions(q: Queryable): Promise<number[]>
  /** Estabelecimentos com segredo vivo cifrado por versão DIFERENTE de [version], em ordem. */
  outsideKeyVersion(q: Queryable, version: number): Promise<number[]>
  /** Até [perVersion] segredos vivos por versão em uso (os de menor estabelecimento), já com a cifra, ordenados por versão e estabelecimento. */
  samplePerKeyVersion(q: Queryable, perVersion: number): Promise<SealedSample[]>
  /** A cifra viva do estabelecimento, lida com `FOR UPDATE` (quem vai regravar trava exclusivo já na leitura); null = sem segredo vivo. */
  readSealedForUpdate(conn: PoolConnection, institutionId: number): Promise<SealedSecret | null>
  /** Regrava SÓ a cifra, e só se a linha ainda está viva e na versão [fromVersion]; true = 1 linha gravada. */
  rewrap(conn: PoolConnection, institutionId: number, fromVersion: number, sealed: SealedSecret): Promise<boolean>
}

export interface SealedSample {
  version:       number
  institutionId: number
  sealed:        SealedSecret
}
