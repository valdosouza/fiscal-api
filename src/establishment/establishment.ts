import { Pool, PoolConnection } from 'mysql2/promise'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'
import { Queryable, withTransaction, isLockWaitTimeout, isDeadlock } from '../db/tx'
import { logger } from '../log/logger'
import { MasterKeyRing, SealedSecret } from '../secret/cipher'
import { CertificateInfo, ExpectedCnpj, certificateInfo, pkcs12ToPem, validateIssuerPair, validatePrivateKeyPem } from '../secret/certificate'
import {
  IssuerModel, IssuerEnvironment, IssuerRow, CertificateRow,
  getIssuer, getCertificate, saveCertificate, issuerRowsState, assertCertificateWritable,
  issuerModelStillInErp, establishmentStillInErp, certificatesOutsideKeyVersion, rewrapCertificateKey, sampleCertificatesPerKeyVersion,
} from './establishment.repository'
import { IssuerAuthority, authorityOf } from './issuer-models'

/**
 * PEÇA do núcleo: "este estabelecimento fala com o fisco com o SEU A1, num ambiente, por modelo"
 * (conceito A da Onda 3 — D-N4/D-N5/D-N6/D-N31/D-E1/D-E4; casa nova no `fiscal_api` — D-F34).
 *  - Habilitação = `tb_establishment_issuer` por MODELO (SE · 55 · 65); autoridade DERIVADA do modelo.
 *  - A1 = `tb_establishment_certificate`, UM por estabelecimento, chave privada CIFRADA (D-F16).
 *  - "Habilitado" é DERIVADO: linha viva + A1 presente, legível, vigente. Não existe `active`.
 *  - O `.pfx` e a senha existem SÓ na chamada de upload. A chave decifrada existe SÓ na chamada ao fisco.
 */

// autoridade DERIVADA do modelo pelo catálogo `ISSUER_MODEL_FACTS` (D-E1/D-NE10 — `issuer-models.ts`); re-exportada com o mesmo nome
export { authorityOf }
export type { IssuerAuthority }

/** AAD da chave cifrada: amarra o texto cifrado à LINHA (copiar para outro estabelecimento não abre). */
export const certificateAad = (institutionId: number) => `tb_establishment_certificate:${institutionId}`

export interface IssuerCertificateStatus {
  certificate:     boolean
  privateKey:      boolean
  certificateInfo: CertificateInfo | null
}

export interface OpenedIssuer {
  issuer: IssuerRow
  cert:   Buffer
  key:    Buffer
  info:   CertificateInfo
}

export interface EstablishmentDeps {
  pool:    Pool
  keyring: MasterKeyRing
}

function statusOf(row: CertificateRow | null): IssuerCertificateStatus {
  if (!row || !row.certificatePem) return { certificate: false, privateKey: !!row?.sealedKey, certificateInfo: null }
  let info: CertificateInfo | null = null
  try { info = certificateInfo(row.certificatePem) } catch { info = null }
  return { certificate: true, privateKey: !!row.sealedKey, certificateInfo: info }
}

/** Situação do A1 — o que a aba "Emissor fiscal" mostra (nunca conteúdo). */
export async function certificateStatus(q: Queryable, institutionId: number): Promise<IssuerCertificateStatus> {
  return statusOf(await getCertificate(q, institutionId))
}

/** Habilitado = A1 presente, legível, vigente (a linha do modelo é conferida por quem chama). */
export function isIssuerEnabled(status: IssuerCertificateStatus): boolean {
  return status.certificate && status.privateKey && status.certificateInfo !== null
    && !status.certificateInfo.expired && !status.certificateInfo.notYetValid
}

/**
 * Abre o emissor de um modelo para UMA chamada ao fisco: linha viva, A1 presente, certificado vigente,
 * chave que decifra e abre. Cada ausência é um 409 legível com código próprio, nesta ordem — nunca
 * 500 e nunca chamada ao fisco às cegas. Dentro de transação: `conn` + `forUpdate` quando a decisão
 * grava (cunhar nDPS — MEDIUM-3: ambiente/série congelados DESTA leitura).
 */
export async function openIssuer(
  deps: EstablishmentDeps, institutionId: number, model: IssuerModel,
  opts: { conn?: PoolConnection; forUpdate?: boolean; schemaName?: string } = {},
): Promise<OpenedIssuer> {
  const q: Queryable = opts.conn ?? deps.pool
  const issuer = await getIssuer(q, institutionId, model, opts.forUpdate ?? false)
  if (!issuer) {
    // D-F39: réplica EXCLUÍDA continua réplica e a lacuna (b) é do ERP — "configure a habilitação" seria mentira, o PUT
    // recusaria. Com [schemaName], o predicado COMPLETO do MODELO (gates do delta de 2026-10-04 — F2; D-NE10); sem ele, só a
    // réplica do modelo. Só no caminho da falha (sem custo no caminho feliz).
    const stillInErp = opts.schemaName
      ? await emissionStillInErp(q, opts.schemaName, institutionId, model)
      : (await issuerRowsState(q, institutionId, [model])).replicas > 0
    if (stillInErp) {
      throw new HttpError(409, 'A emissão fiscal deste estabelecimento ainda é do ERP — a API fiscal só consulta até a virada',
        undefined, ErrorCodes.FISCAL_CUTOVER_PENDING)
    }
    throw new HttpError(409, `Estabelecimento sem habilitação do emissor para o modelo ${model}`,
      [{ field: 'model', message: 'Configure ambiente e série na aba Emissor fiscal' }], ErrorCodes.FISCAL_ISSUER_MISSING)
  }
  // D-F39: quem fala com o fisco abre o emissor — e a RÉPLICA do ERP não abre (toda conversa com o fisco passa aqui)
  if (!issuer.cutoverAt) {
    throw new HttpError(409, 'A emissão fiscal deste estabelecimento ainda é do ERP — a API fiscal só consulta até a virada',
      undefined, ErrorCodes.FISCAL_CUTOVER_PENDING)
  }
  // forUpdate (decisão que grava): o A1 também é lido ATUAL (travante), não do snapshot — ordem emissor → A1
  const row = await getCertificate(q, institutionId, opts.forUpdate ?? false)
  if (!row || !row.certificatePem || !row.sealedKey) {
    throw new HttpError(409, 'Certificado digital A1 do estabelecimento ausente no cofre',
      [{ field: 'certificate', message: 'Envie o .pfx na aba Emissor fiscal' }], ErrorCodes.FISCAL_CERT_MISSING)
  }
  let info: CertificateInfo
  try { info = certificateInfo(row.certificatePem) } catch {
    throw new HttpError(409, 'Certificado do emissor no cofre está ilegível — envie o .pfx novamente',
      [{ field: 'certificate', message: 'PEM ilegível' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  if (info.expired) {
    throw new HttpError(409, `Certificado digital A1 do emissor expirou em ${info.notAfter.slice(0, 10)} — renove e envie o novo`,
      [{ field: 'certificate', message: 'Expirado' }], ErrorCodes.FISCAL_CERT_EXPIRED)
  }
  if (info.notYetValid) {
    throw new HttpError(409, `Certificado digital A1 do emissor só vale a partir de ${info.notBefore.slice(0, 10)}`,
      [{ field: 'certificate', message: 'Ainda não vigente' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  let key: Buffer
  try {
    key = deps.keyring.open(row.sealedKey, certificateAad(institutionId))
  } catch (err) {
    if (err instanceof HttpError) throw err                       // chave-mestra ausente → 503 próprio
    throw new HttpError(409, 'Chave privada do emissor não decifra (cofre adulterado ou chave-mestra trocada) — envie o .pfx novamente',
      [{ field: 'certificate', message: 'Chave privada ilegível' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  const keyWhy = validatePrivateKeyPem(key)
  if (keyWhy) {
    throw new HttpError(409, `Chave privada do emissor no cofre está ilegível (${keyWhy}) — envie o .pfx novamente`,
      [{ field: 'certificate', message: 'Chave privada ilegível' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  return { issuer, cert: Buffer.from(row.certificatePem, 'utf8'), key, info }
}

/**
 * Upload do A1 (D-N5): abre o PKCS#12, valida o par INTEIRO (incluindo o CNPJ do CN contra o CNPJ do
 * estabelecimento lido no ERP — D-N29b) e SÓ ENTÃO grava — certificado público + chave cifrada.
 * Invariante "cofre = último par válido". Devolve a situação (nunca o conteúdo).
 */
export async function storeCertificate(
  deps: EstablishmentDeps, institutionId: number, pfx: Buffer, password: string,
  opts: { expectedCnpj: ExpectedCnpj; userId: number | null; schemaName: string },
): Promise<IssuerCertificateStatus> {
  const { certPem, keyPem } = pkcs12ToPem(pfx, password)
  const info = validateIssuerPair(certPem, keyPem, opts.expectedCnpj)
  const sealedKey = deps.keyring.seal(keyPem, certificateAad(institutionId))
  await withTransaction(deps.pool, 'gravar A1', { institutionId }, async conn => {
    await assertCertificateWritable(conn, opts.schemaName, institutionId)   // D-F39: 1ª instrução — trava + réplica/lacuna
    await saveCertificate(conn, {
      institutionId, cnpj: info.cnpj, certificatePem: certPem, sealedKey,
      subject: info.subject.slice(0, 512), issuedBy: info.issuer.slice(0, 512),
      notBefore: info.notBefore, notAfter: info.notAfter, fingerprint256: info.fingerprint256, userId: opts.userId,
    })
  })
  return certificateStatus(deps.pool, institutionId)
}

// Apagar o A1 é ato do EMITTER (`../emitter/emitter.ts` — `clearCertificate`): precisa das transmissões vivas de TODAS as famílias,
// que esta peça (cega à voz) não lê — parte 2 da NE-1a (D-NE9).


/**
 * D-F39 + D-NE10 (a) (parte 2 da NE-1a) — "a emissão deste MODELO ainda é do ERP": réplica do modelo no `fiscal_api` (viva ou
 * excluída) OU, para o modelo que o ERP transmitia (SE) e sem linha dele, a habilitação própria no ERP (lacuna (b), lida pela fonte de
 * fatos). 55/65 NASCEM virados (D-F42 — réplica só nasce do `migrate:setes` e só SE; a série deles é do ERP, D-F21, e o número nasce na transmissão, D-NE257) e NÃO
 * dependem da SE. Quem age no fisco por um modelo confere ESTE predicado; [model] é obrigatório (sem padrão — prova de segurança não
 * tem default, lição R18-04).
 */
export async function emissionStillInErp(q: Queryable, schemaName: string, institutionId: number, model: IssuerModel): Promise<boolean> {
  return issuerModelStillInErp(q, schemaName, institutionId, model)
}

/**
 * O MESMO no grão do ESTABELECIMENTO (o A1 é UM — D-N31; o ato da virada é por institution): réplica em QUALQUER linha OU a lacuna (b)
 * da SE — o predicado de antes da D-NE10, = a disjunção de `emissionStillInErp` sobre o catálogo. Quem escreve o A1 (rotas do A1) e a
 * pós-condição do ato confere ESTE.
 */
export async function anyEmissionStillInErp(q: Queryable, schemaName: string, institutionId: number): Promise<boolean> {
  return establishmentStillInErp(q, schemaName, institutionId)
}

/** Versões de chave-mestra que ainda cifram algum A1 vivo (health: todas têm que estar no anel). */
export async function storedKeyVersions(q: Queryable): Promise<number[]> {
  const [rows] = await q.query(
    `SELECT DISTINCT cipher_key_version AS v FROM tb_establishment_certificate
      WHERE deleted = 'N' AND cipher_key_version IS NOT NULL`)
  return (rows as any[]).filter(r => r.v != null).map(r => Number(r.v)).filter(v => Number.isInteger(v) && v > 0)
}

export interface KeyRotationReport {
  /** versão da chave-mestra que cifra agora (a MAIOR do anel) */
  currentVersion: number
  /** estabelecimentos regravados com a versão atual (de → para) */
  rewrapped: Array<{ institutionId: number; from: number }>
  /**
   * A1 NÃO regravados, intocados: versão ausente do anel (FISCAL_MASTER_KEY_UNAVAILABLE), chave errada (FISCAL_CERT_INVALID),
   * linha disputada (RESOURCE_BUSY — rodar de novo) ou o novo selo não conferiu (KEY_ROTATION_RESEAL_MISMATCH)
   */
  failed: Array<{ institutionId: number; from: number | null; code: string }>
  /** linha trocada ou apagada entre a lista e a trava — nada a fazer nela */
  skipped: number[]
}

/** Erro de infraestrutura no meio da rotação (pool, conexão): leva o relatório do que JÁ foi commitado. */
export class KeyRotationAborted extends Error {
  /** [inDoubt] = o estabelecimento em curso quando caiu: se caiu no commit, pode ter sido regravado ou não (rodar de novo resolve) */
  constructor(readonly report: KeyRotationReport, readonly causeError: unknown, readonly inDoubt: number) {
    super(`Rotação da chave-mestra interrompida no A1 ${inDoubt} depois de ${report.rewrapped.length} regravado(s) — rodar de novo (idempotente)`)
  }
}

const RESEAL_MISMATCH = 'KEY_ROTATION_RESEAL_MISMATCH'
class ResealMismatch extends Error {}

/**
 * DEPLOY.E3.P1.T2 (D-F16 — "reabre com a antiga, regrava com a nova"): todo A1 vivo cifrado por versão de chave-mestra
 * diferente da ATUAL (a maior do anel) é aberto com a versão dele e regravado com a atual, UM estabelecimento por transação:
 *  - a linha do certificado é lida com FOR UPDATE (exclusivo já na leitura; a trava é só dela — quem abre o emissor trava a
 *    habilitação e depois o A1, nunca o contrário, e a rotação não pede outra trava segurando esta: não há ciclo);
 *  - o novo selo é conferido (abre com a AAD da linha) ANTES do UPDATE, que só grava se a linha ainda está na versão aberta;
 *  - A1 que não abre fica INTOCADO e vai para [failed] (nunca regravar o que não se leu); os outros seguem — também quando
 *    UMA linha cai em contenção (1205/1213) ou no selo que não confere; só erro de infraestrutura para a rodada, e leva o
 *    relatório do que já foi commitado (`KeyRotationAborted`);
 *  - a chave decifrada vive só dentro da volta e é zerada no fim. Nada do segredo vai para log nem para o relatório.
 * Idempotente: rodar de novo com o mesmo anel não acha nada a regravar.
 *
 * ORDEM DA OPERAÇÃO (runbook — o anel é de cada processo, e a função não o vê nos outros):
 *  1. publicar o anel {antiga, nova} em TODOS os processos que usam o cofre (nfse-api, nfe-api) e reiniciá-los — antes disso, um
 *     processo só com a antiga não abriria o A1 regravado;
 *  2. rodar a rotação; 3. conferir `failed` vazio, `storedKeyVersions` = [nova] e `verifyStoredKeys` ok;
 *  4. só então tirar a antiga do anel em todos os processos — e guardar a NOVA fora do servidor (é o backup do A1).
 */
export async function rotateCertificateKeys(deps: EstablishmentDeps): Promise<KeyRotationReport> {
  const current = deps.keyring.currentVersion
  if (current === null) {
    throw new HttpError(503, 'Chave-mestra do cofre indisponível (nenhuma chave configurada) — configure FISCAL_MASTER_KEYS',
      undefined, ErrorCodes.FISCAL_MASTER_KEY_UNAVAILABLE)
  }
  const report: KeyRotationReport = { currentVersion: current, rewrapped: [], failed: [], skipped: [] }
  for (const institutionId of await certificatesOutsideKeyVersion(deps.pool, current)) {
    const aad = certificateAad(institutionId)
    // o resultado só entra no relatório DEPOIS do commit (commit que falha não pode virar "regravado")
    type Outcome = { kind: 'rewrapped' | 'failed' | 'skipped'; from?: number; code?: string }
    let out: Outcome
    try {
      out = await withTransaction<Outcome>(deps.pool, 'rotacionar chave-mestra do A1', { institutionId }, async conn => {
        const row = await getCertificate(conn, institutionId, 'update')
        const sealed = row?.sealedKey
        if (!sealed || sealed.version === current) return { kind: 'skipped' }
        if (!deps.keyring.hasVersion(sealed.version)) {
          return { kind: 'failed', from: sealed.version, code: ErrorCodes.FISCAL_MASTER_KEY_UNAVAILABLE }
        }
        let plain: Buffer | null = null
        try {
          try { plain = deps.keyring.open(sealed, aad) } catch {
            return { kind: 'failed', from: sealed.version, code: ErrorCodes.FISCAL_CERT_INVALID }
          }
          const resealed = deps.keyring.seal(plain, aad)
          let check: Buffer
          try { check = deps.keyring.open(resealed, aad) } catch { throw new ResealMismatch() }
          const same = check.equals(plain)
          check.fill(0)
          if (!same) throw new ResealMismatch()
          if (await rewrapCertificateKey(conn, institutionId, sealed.version, resealed)) return { kind: 'rewrapped', from: sealed.version }
          // sob FOR UPDATE a linha não pode ter mudado: 0 linhas aqui é anomalia — registrada (só o id), nada gravado
          logger.warn('Rotação da chave-mestra: UPDATE do A1 achou 0 linhas sob FOR UPDATE', { institutionId })
          return { kind: 'skipped' }
        } finally {
          plain?.fill(0)
        }
      })
    } catch (err) {
      if (err instanceof ResealMismatch) out = { kind: 'failed', code: RESEAL_MISMATCH }
      else if (isLockWaitTimeout(err) || isDeadlock(err)) out = { kind: 'failed', code: ErrorCodes.RESOURCE_BUSY }
      else throw new KeyRotationAborted(report, err, institutionId)
    }
    if (out.kind === 'rewrapped') report.rewrapped.push({ institutionId, from: out.from! })
    else if (out.kind === 'failed') report.failed.push({ institutionId, from: out.from ?? null, code: out.code! })
    else report.skipped.push(institutionId)
  }
  return report
}

export interface StoredKeyCheck {
  /** toda versão em uso abre ALGUM dos A1 de amostra (sem A1 guardado = ok: não há o que provar) */
  ok: boolean
  /** alguma amostra não abriu numa versão que outra amostra provou: a chave está certa, mas há A1 ilegível — alarme, não queda */
  degraded: boolean
  /** por versão: ok, o código quando nenhuma amostra abriu, e quantas amostras não abriram */
  versions: Array<{ version: number; ok: boolean; code?: string; unreadable: number }>
}

/** Quantos A1 por versão o health tenta abrir antes de dizer que a versão não abre. */
export const STORED_KEY_SAMPLES_PER_VERSION = 3

/**
 * DEPLOY.E3.P1.T1 (D-F243 — Valdo, 2026-11-16): a prova de que a chave do SERVIDOR é a que cifrou os A1 de cada versão em uso. O
 * `selfTest` do anel cifra e decifra um vetor que ele mesmo criou — passa com qualquer chave de 32 bytes; `storedKeyVersions` só confere
 * o número. Aqui, por versão, abre os A1 de amostra (os de menor institution, até [STORED_KEY_SAMPLES_PER_VERSION], numa leitura só)
 * em ordem até UM abrir, e zera cada um na hora:
 *  - chave errada no servidor → o GCM recusa TODAS as amostras → versão não ok (FISCAL_CERT_INVALID) → `ok` falso;
 *  - UMA linha ilegível (corrompida, restaurada de outro lugar) com outra que abre → versão ok, `degraded` verdadeiro — o estabelecimento
 *    dela já recebe 409 próprio no `openIssuer`; ela não derruba o serviço de todos;
 *  - `ok` prova a CHAVE da versão, não que todo A1 abra.
 * Leitura comum (sem trava). Nada do segredo sai daqui — só versão, ok, código e contagem. Quem expõe (health público) decide o que
 * mostrar e com que frequência roda (D-F243: a adoção é da nfse-api).
 */
export async function verifyStoredKeys(
  deps: EstablishmentDeps, perVersion = STORED_KEY_SAMPLES_PER_VERSION,
): Promise<StoredKeyCheck> {
  // agrupa por versão numa LISTA (a leitura já vem ordenada por versão, id) — sem Map/Set em memória (regra 3, cerca D-F10)
  const groups: Array<{ version: number; samples: Array<{ institutionId: number; sealed: SealedSecret }> }> = []
  for (const s of await sampleCertificatesPerKeyVersion(deps.pool, perVersion)) {
    const last = groups[groups.length - 1]
    if (last && last.version === s.version) last.samples.push(s)
    else groups.push({ version: s.version, samples: [s] })
  }
  const out: StoredKeyCheck = { ok: true, degraded: false, versions: [] }
  for (const { version, samples } of groups) {
    if (!deps.keyring.hasVersion(version)) {
      out.versions.push({ version, ok: false, code: ErrorCodes.FISCAL_MASTER_KEY_UNAVAILABLE, unreadable: samples.length })
      continue
    }
    let unreadable = 0
    let opened = false
    for (const { institutionId, sealed } of samples) {
      let plain: Buffer | null = null
      try {
        plain = deps.keyring.open(sealed, certificateAad(institutionId))
        opened = true
        break
      } catch {
        unreadable++
      } finally {
        plain?.fill(0)
      }
    }
    out.versions.push(opened
      ? { version, ok: true, unreadable }
      : { version, ok: false, code: ErrorCodes.FISCAL_CERT_INVALID, unreadable })
  }
  out.ok = out.versions.every(v => v.ok)
  out.degraded = out.versions.some(v => v.ok && v.unreadable > 0)
  return out
}

export type { IssuerModel, IssuerEnvironment, IssuerRow }
