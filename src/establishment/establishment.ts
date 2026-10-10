import { Pool, PoolConnection } from 'mysql2/promise'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'
import { Queryable, withTransaction } from '../db/tx'
import { MasterKeyRing } from '../secret/cipher'
import { CertificateInfo, certificateInfo, pkcs12ToPem, validateIssuerPair, validatePrivateKeyPem } from '../secret/certificate'
import {
  IssuerModel, IssuerEnvironment, IssuerRow, CertificateRow,
  getIssuer, getCertificate, saveCertificate, eraseCertificate, issuerRowsState, assertEmitterWritable,
} from './establishment.repository'
import { erpServiceIssuerExists } from '../erp/facts'

/**
 * PEÇA do núcleo: "este estabelecimento fala com o fisco com o SEU A1, num ambiente, por modelo"
 * (conceito A da Onda 3 — D-N4/D-N5/D-N6/D-N31/D-E1/D-E4; casa nova no `fiscal_api` — D-F34).
 *  - Habilitação = `tb_establishment_issuer` por MODELO (SE · 55 · 65); autoridade DERIVADA do modelo.
 *  - A1 = `tb_establishment_certificate`, UM por estabelecimento, chave privada CIFRADA (D-F16).
 *  - "Habilitado" é DERIVADO: linha viva + A1 presente, legível, vigente. Não existe `active`.
 *  - O `.pfx` e a senha existem SÓ na chamada de upload. A chave decifrada existe SÓ na chamada ao fisco.
 */

export type IssuerAuthority = 'ADN' | 'SEFAZ'

/** Autoridade fiscal DERIVADA do modelo — mapa constante, nunca coluna (D-E1). */
export function authorityOf(model: IssuerModel): IssuerAuthority {
  return model === 'SE' ? 'ADN' : 'SEFAZ'
}

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
    // recusaria. Com [schemaName], o predicado COMPLETO (gates do delta de 2026-10-04 — F2); sem ele, só a réplica.
    // Só no caminho da falha (sem custo no caminho feliz).
    const stillInErp = opts.schemaName
      ? await emissionStillInErp(q, opts.schemaName, institutionId)
      : (await issuerRowsState(q, institutionId)).replicas > 0
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
  opts: { expectedCnpj: string | null; userId: number | null; schemaName: string },
): Promise<IssuerCertificateStatus> {
  const { certPem, keyPem } = pkcs12ToPem(pfx, password)
  const info = validateIssuerPair(certPem, keyPem, opts.expectedCnpj)
  const sealedKey = deps.keyring.seal(keyPem, certificateAad(institutionId))
  await withTransaction(deps.pool, 'gravar A1', { institutionId }, async conn => {
    await assertEmitterWritable(conn, opts.schemaName, institutionId)   // D-F39: 1ª instrução — trava + réplica/lacuna
    await saveCertificate(conn, {
      institutionId, cnpj: info.cnpj, certificatePem: certPem, sealedKey,
      subject: info.subject.slice(0, 512), issuedBy: info.issuer.slice(0, 512),
      notBefore: info.notBefore, notAfter: info.notAfter, fingerprint256: info.fingerprint256, userId: opts.userId,
    })
  })
  return certificateStatus(deps.pool, institutionId)
}

/**
 * Apaga o A1 (as habilitações ficam e deixam de estar habilitadas). [guard] roda DENTRO da transação, antes de apagar — a família confere ali o que é DELA
 * (ex.: a nfse-api trava a habilitação e recusa com transmissão viva: sem A1 nenhuma reconciliação fecha).
 */
export async function clearCertificate(
  deps: EstablishmentDeps, institutionId: number, userId: number | null,
  opts: { schemaName: string; guard?: (conn: PoolConnection) => Promise<void> },
): Promise<IssuerCertificateStatus> {
  await withTransaction(deps.pool, 'apagar A1', { institutionId }, async conn => {
    await assertEmitterWritable(conn, opts.schemaName, institutionId)    // 1ª instrução: TRAVA a habilitação (gates R4)
    if (opts.guard) await opts.guard(conn)                                // a guarda da família lê DEPOIS da trava
    return eraseCertificate(conn, institutionId, userId)
  })
  return certificateStatus(deps.pool, institutionId)
}


/**
 * D-F39 — "o estabelecimento ainda é emitido pelo ERP": réplica no `fiscal_api` (viva ou excluída) OU, sem linha
 * nenhuma, habilitação SE própria no ERP (lida pela fonte de fatos). Quem escreve o emitente ou age no fisco confere.
 * Réplica só nasce do `migrate:setes` e só SE (D-F42): a habilitação 55/65 NASCE virada (não existe virada de 55/65 —
 * a série/número dela é do ERP, D-F21); por isso "réplica em qualquer linha" não precisa saber de modelo.
 */
export async function emissionStillInErp(q: Queryable, schemaName: string, institutionId: number): Promise<boolean> {
  const { replicas, serviceRows } = await issuerRowsState(q, institutionId)
  if (replicas > 0) return true
  // D-F57 (= Q-F64 (a)): a lacuna (b) olha a LINHA SE — sem ela, a SE própria do ERP decide (uma 55/65 virada não esconde)
  if (serviceRows > 0) return false
  return erpServiceIssuerExists(q, schemaName, institutionId)
}

/** Versões de chave-mestra que ainda cifram algum A1 vivo (health: todas têm que estar no anel). */
export async function storedKeyVersions(q: Queryable): Promise<number[]> {
  const [rows] = await q.query(
    `SELECT DISTINCT cipher_key_version AS v FROM tb_establishment_certificate
      WHERE deleted = 'N' AND cipher_key_version IS NOT NULL`)
  return (rows as any[]).filter(r => r.v != null).map(r => Number(r.v)).filter(v => Number.isInteger(v) && v > 0)
}

export type { IssuerModel, IssuerEnvironment, IssuerRow }
