import type { Pool } from 'mysql2/promise'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'
import { Queryable, withTransaction, isLockWaitTimeout, isDeadlock } from '../db/tx'
import { logger } from '../log/logger'
import { MasterKeyRing } from './cipher'
import type { SealedStore } from './sealed-store'
import { CERTIFICATE_SEALED_STORE } from '../establishment/establishment.repository'
import { SMTP_CREDENTIAL_SEALED_STORE } from '../smtp-credential/smtp-credential.repository'

/**
 * Os DONOS de segredo cifrado do cofre — lista FECHADA (FAMILIA.E5.P7): o A1 e a senha da conta de e-mail. Tudo o que decide sobre a
 * chave-mestra (que versões ainda estão em uso, o que falta regravar, a rotação, a prova da chave do servidor) percorre ESTA lista — um dono
 * fora dela ficaria para trás na rotação e perderia o segredo quando a chave antiga saísse do anel. Array congelado (nunca `Map`/`Set`).
 */
export const SEALED_STORES: readonly SealedStore[] = Object.freeze([CERTIFICATE_SEALED_STORE, SMTP_CREDENTIAL_SEALED_STORE])

export interface SealedStoresDeps {
  pool:    Pool
  keyring: MasterKeyRing
}

/** Segredos vivos cifrados por versão DIFERENTE de [version], de TODOS os donos (o que a rotação ainda tem a regravar). Leitura comum. */
export async function storedSecretsOutsideKeyVersion(
  q: Queryable, version: number, stores: readonly SealedStore[] = SEALED_STORES,
): Promise<Array<{ store: string; institutionId: number }>> {
  const out: Array<{ store: string; institutionId: number }> = []
  for (const store of stores) {
    for (const institutionId of await store.outsideKeyVersion(q, version)) out.push({ store: store.name, institutionId })
  }
  return out
}

export interface StoredKeyRotationReport {
  /** versão da chave-mestra que cifra agora (a MAIOR do anel) */
  currentVersion: number
  /** segredos regravados com a versão atual, com o dono (a tabela) de cada um */
  rewrapped: Array<{ store: string; institutionId: number; from: number }>
  /**
   * segredos NÃO regravados, intocados: versão ausente do anel (FISCAL_MASTER_KEY_UNAVAILABLE), não abre (o código do dono), linha
   * disputada (RESOURCE_BUSY — rodar de novo) ou o novo selo não conferiu (KEY_ROTATION_RESEAL_MISMATCH)
   */
  failed: Array<{ store: string; institutionId: number; from: number | null; code: string }>
  /** linha trocada ou apagada entre a lista e a trava — nada a fazer nela */
  skipped: Array<{ store: string; institutionId: number }>
}

/** Erro de infraestrutura no meio da rotação (pool, conexão): leva o relatório do que JÁ foi commitado. */
export class StoredKeyRotationAborted extends Error {
  /** [inDoubt] = o segredo em curso quando caiu: se caiu no commit, pode ter sido regravado ou não (rodar de novo resolve) */
  constructor(
    readonly report: StoredKeyRotationReport, readonly causeError: unknown,
    readonly inDoubt: { store: string; institutionId: number },
  ) {
    super(`Rotação da chave-mestra interrompida em ${inDoubt.store} ${inDoubt.institutionId} depois de ${report.rewrapped.length} `
      + 'regravado(s) — rodar de novo (idempotente)')
  }
}

const RESEAL_MISMATCH = 'KEY_ROTATION_RESEAL_MISMATCH'
class ResealMismatch extends Error {}

/**
 * ROTAÇÃO da chave-mestra sobre TODOS os donos de segredo cifrado (D-F16 — "reabre com a antiga, regrava com a nova"; FAMILIA.E5.P7): a
 * mesma regra de `rotateCertificateKeys`, dono por dono, UM segredo por transação:
 *  - a linha é lida com FOR UPDATE (a trava é só dela; a rotação não pede outra trava segurando esta);
 *  - o novo selo é conferido (abre com a AAD da linha) ANTES do UPDATE, que só grava se a linha ainda está na versão aberta;
 *  - segredo que não abre fica INTOCADO e vai para [failed]; os outros seguem — também quando UMA linha cai em contenção (1205/1213) ou no
 *    selo que não confere; só erro de infraestrutura para a rodada, levando o relatório do que já foi commitado (`StoredKeyRotationAborted`);
 *  - o segredo decifrado vive só dentro da volta e é zerado no fim. Nada dele vai para log nem para o relatório.
 * Idempotente: rodar de novo com o mesmo anel não acha nada a regravar.
 *
 * ORDEM DA OPERAÇÃO (runbook — o anel é de cada processo, e a função não o vê nos outros):
 *  1. publicar o anel {antiga, nova} em TODOS os processos que usam o cofre (nfse-api, nfe-api) e reiniciá-los;
 *  2. rodar ESTA rotação (a do A1 sozinha, `rotateCertificateKeys`, deixa a senha da conta de e-mail na chave antiga);
 *  3. conferir `failed` vazio, `storedKeyVersions` = [nova] e `verifyStoredKeys` ok;
 *  4. só então tirar a antiga do anel em todos os processos — e guardar a NOVA fora do servidor (é o backup dos segredos).
 */
export async function rotateStoredKeys(deps: SealedStoresDeps, stores: readonly SealedStore[] = SEALED_STORES): Promise<StoredKeyRotationReport> {
  const current = deps.keyring.currentVersion
  if (current === null) {
    throw new HttpError(503, 'Chave-mestra do cofre indisponível (nenhuma chave configurada) — configure FISCAL_MASTER_KEYS',
      undefined, ErrorCodes.FISCAL_MASTER_KEY_UNAVAILABLE)
  }
  const report: StoredKeyRotationReport = { currentVersion: current, rewrapped: [], failed: [], skipped: [] }
  for (const store of stores) {
    for (const institutionId of await store.outsideKeyVersion(deps.pool, current)) {
      const aad = store.aad(institutionId)
      // o resultado só entra no relatório DEPOIS do commit (commit que falha não pode virar "regravado")
      type Outcome = { kind: 'rewrapped' | 'failed' | 'skipped'; from?: number; code?: string }
      let out: Outcome
      try {
        out = await withTransaction<Outcome>(deps.pool, 'rotacionar chave-mestra do cofre', { store: store.name, institutionId }, async conn => {
          const sealed = await store.readSealedForUpdate(conn, institutionId)
          if (!sealed || sealed.version === current) return { kind: 'skipped' }
          if (!deps.keyring.hasVersion(sealed.version)) {
            return { kind: 'failed', from: sealed.version, code: ErrorCodes.FISCAL_MASTER_KEY_UNAVAILABLE }
          }
          let plain: Buffer | null = null
          try {
            try { plain = deps.keyring.open(sealed, aad) } catch {
              return { kind: 'failed', from: sealed.version, code: store.unreadableCode }
            }
            const resealed = deps.keyring.seal(plain, aad)
            let check: Buffer
            try { check = deps.keyring.open(resealed, aad) } catch { throw new ResealMismatch() }
            const same = check.equals(plain)
            check.fill(0)
            if (!same) throw new ResealMismatch()
            if (await store.rewrap(conn, institutionId, sealed.version, resealed)) return { kind: 'rewrapped', from: sealed.version }
            // sob FOR UPDATE a linha não pode ter mudado: 0 linhas aqui é anomalia — registrada (só o dono e o id), nada gravado
            logger.warn('Rotação da chave-mestra: UPDATE achou 0 linhas sob FOR UPDATE', { store: store.name, institutionId })
            return { kind: 'skipped' }
          } finally {
            plain?.fill(0)
          }
        })
      } catch (err) {
        if (err instanceof ResealMismatch) out = { kind: 'failed', code: RESEAL_MISMATCH }
        else if (isLockWaitTimeout(err) || isDeadlock(err)) out = { kind: 'failed', code: ErrorCodes.RESOURCE_BUSY }
        else throw new StoredKeyRotationAborted(report, err, { store: store.name, institutionId })
      }
      if (out.kind === 'rewrapped') report.rewrapped.push({ store: store.name, institutionId, from: out.from! })
      else if (out.kind === 'failed') report.failed.push({ store: store.name, institutionId, from: out.from ?? null, code: out.code! })
      else report.skipped.push({ store: store.name, institutionId })
    }
  }
  return report
}
