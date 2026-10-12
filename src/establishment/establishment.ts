import { Pool, PoolConnection } from 'mysql2/promise'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'
import { Queryable, withTransaction } from '../db/tx'
import { MasterKeyRing } from '../secret/cipher'
import { CertificateInfo, certificateInfo, pkcs12ToPem, validateIssuerPair, validatePrivateKeyPem } from '../secret/certificate'
import {
  IssuerModel, IssuerEnvironment, IssuerRow, CertificateRow,
  getIssuer, getCertificate, saveCertificate, issuerRowsState, assertCertificateWritable,
  issuerModelStillInErp, establishmentStillInErp,
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
  opts: { expectedCnpj: string | null; userId: number | null; schemaName: string },
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
 * fatos). 55/65 NASCEM virados (D-F42 — réplica só nasce do `migrate:setes` e só SE; a série/número deles é do ERP, D-F21) e NÃO
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

export type { IssuerModel, IssuerEnvironment, IssuerRow }
