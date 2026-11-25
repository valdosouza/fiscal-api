import type { PoolConnection } from 'mysql2/promise'
import type { Queryable } from '../db/tx'
import type { SealedSecret } from '../secret/cipher'
import type { SealedSample, SealedStore } from '../secret/sealed-store'
import { ErrorCodes } from '../errors/error-codes'

/**
 * SQL da CONTA DE ENVIO DE E-MAIL do estabelecimento (`tb_establishment_smtp_credential` — migration 009 do núcleo; FAMILIA.E5.P7, D-NE236).
 * UMA linha por estabelecimento (PK). A senha só existe aqui como CIFRA (`SealedSecret`): nenhuma função deste arquivo recebe ou devolve a
 * senha em claro — quem cifra e abre é a peça (`smtp-credential.ts`).
 */

export const SMTP_SECURITIES = Object.freeze(['tls', 'starttls'] as const)
export type SmtpSecurity = typeof SMTP_SECURITIES[number]

export interface SmtpCredentialRow {
  institutionId:  number
  host:           string
  port:           number
  security:       SmtpSecurity
  username:       string
  senderAddress:  string
  sealedPassword: SealedSecret
  userId:         number | null
  /** Quando a conta foi gravada pela última vez (UTC, ISO); null se o banco não trouxe. */
  updatedAt:      string | null
}

const toIso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) return v.toISOString()
  const s = String(v)
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}.000Z` : s
}

/** AAD da senha cifrada: amarra a cifra à LINHA (copiar para outro estabelecimento, ou para outra tabela do cofre, não abre). */
export const smtpCredentialAad = (institutionId: number) => `tb_establishment_smtp_credential:${institutionId}`

function sealedOf(r: any): SealedSecret | null {
  return r && r.cipher && r.iv && r.tag && r.version != null
    ? { cipher: Buffer.from(r.cipher), iv: Buffer.from(r.iv), tag: Buffer.from(r.tag), version: Number(r.version) }
    : null
}

/**
 * A conta VIVA do estabelecimento, ou null. [locking] `'update'` = `FOR UPDATE` (quem vai regravar a própria linha — a rotação — trava
 * exclusivo já na leitura). Linha viva sem cifra não existe (CHECK `ck_establishment_smtp_credential_secret_presence`); se o banco a trouxer
 * (motor sem CHECK), a leitura devolve null — nunca uma conta "sem senha".
 */
export async function getSmtpCredential(
  q: Queryable, institutionId: number, locking: false | 'update' = false,
): Promise<SmtpCredentialRow | null> {
  const [rows] = await q.query(
    `SELECT tb_institution_id AS institutionId, host, port, security, username, sender_address AS senderAddress,
            password_cipher AS cipher, password_iv AS iv, password_tag AS tag, cipher_key_version AS version,
            tb_user_id AS userId, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updatedAt
       FROM tb_establishment_smtp_credential
      WHERE tb_institution_id = ? AND deleted = 'N'${locking === 'update' ? ' FOR UPDATE' : ''}`,
    [institutionId])
  const r = (rows as any[])[0]
  const sealedPassword = sealedOf(r)
  if (!r || !sealedPassword) return null
  const security = SMTP_SECURITIES.find(s => s === r.security)
  if (!security) return null
  return {
    institutionId: Number(r.institutionId), host: String(r.host), port: Number(r.port), security,
    username: String(r.username), senderAddress: String(r.senderAddress), sealedPassword,
    userId: r.userId == null ? null : Number(r.userId), updatedAt: toIso(r.updatedAt),
  }
}

/** Grava a conta (linha apagada REVIVE com a conta nova). A PK é o único índice único: o upsert é seguro (PADROES_BANCO §9 regra 10). */
export async function saveSmtpCredential(q: Queryable, row: Omit<SmtpCredentialRow, 'updatedAt'>): Promise<void> {
  await q.query(
    `INSERT INTO tb_establishment_smtp_credential
       (tb_institution_id, host, port, security, username, sender_address,
        password_cipher, password_iv, password_tag, cipher_key_version, tb_user_id, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE host = VALUES(host), port = VALUES(port), security = VALUES(security), username = VALUES(username),
       sender_address = VALUES(sender_address), password_cipher = VALUES(password_cipher), password_iv = VALUES(password_iv),
       password_tag = VALUES(password_tag), cipher_key_version = VALUES(cipher_key_version), tb_user_id = VALUES(tb_user_id),
       deleted = 'N', updated_at = NOW()`,
    [row.institutionId, row.host, row.port, row.security, row.username, row.senderAddress,
     row.sealedPassword.cipher, row.sealedPassword.iv, row.sealedPassword.tag, row.sealedPassword.version, row.userId])
}

/** Excluir a conta: a cifra vira NULL e a linha fica 'S' — senha excluída não fica guardada. */
export async function eraseSmtpCredential(q: Queryable, institutionId: number, userId: number | null): Promise<boolean> {
  const [r] = await q.query(
    `UPDATE tb_establishment_smtp_credential
        SET password_cipher = NULL, password_iv = NULL, password_tag = NULL, cipher_key_version = NULL,
            tb_user_id = ?, deleted = 'S', updated_at = NOW()
      WHERE tb_institution_id = ? AND deleted = 'N'`,
    [userId, institutionId])
  return Number((r as any)?.affectedRows ?? 0) > 0
}

/**
 * Regrava SÓ a cifra da senha (rotação da chave-mestra): a linha tem de estar viva e ainda na versão [fromVersion] que quem chama abriu —
 * se outro processo trocou a conta no meio, nada é gravado. Host, usuário, `tb_user_id` e `updated_at` ficam como estão: trocar a
 * chave-mestra não é trocar a conta.
 */
export async function rewrapSmtpCredentialPassword(
  conn: PoolConnection, institutionId: number, fromVersion: number, sealed: SealedSecret,
): Promise<boolean> {
  const [r] = await conn.query<any>(
    `UPDATE tb_establishment_smtp_credential
        SET password_cipher = ?, password_iv = ?, password_tag = ?, cipher_key_version = ?
      WHERE tb_institution_id = ? AND deleted = 'N' AND cipher_key_version = ?`,
    [sealed.cipher, sealed.iv, sealed.tag, sealed.version, institutionId, fromVersion])
  return Number(r?.affectedRows ?? 0) === 1
}

/** ER_NO_SUCH_TABLE: o banco ainda não recebeu a 009. */
const isNoSuchTable = (err: unknown) => (err as any)?.errno === 1146 || (err as any)?.code === 'ER_NO_SUCH_TABLE'

/**
 * As três leituras do COFRE (versões em uso, o que falta regravar, amostra da prova) tratam a tabela AUSENTE como "dono sem segredo" (gate
 * adversarial M2): o pré-deploy de um consumidor roda a prova da chave CONTRA O BANCO ANTIGO, antes de a versão nova subir e aplicar a 009 —
 * sem a tabela não há senha guardada, então não há o que provar nem regravar. Só o 1146; qualquer outro erro sobe como está.
 */
async function absentIsEmpty<T>(read: () => Promise<T[]>): Promise<T[]> {
  try { return await read() } catch (err) { if (isNoSuchTable(err)) return []; throw err }
}

/** Versões de chave-mestra que ainda cifram alguma senha SMTP viva. */
export async function smtpCredentialKeyVersions(q: Queryable): Promise<number[]> {
  return absentIsEmpty(() => keyVersionsOf(q))
}
async function keyVersionsOf(q: Queryable): Promise<number[]> {
  const [rows] = await q.query(
    `SELECT DISTINCT cipher_key_version AS v FROM tb_establishment_smtp_credential
      WHERE deleted = 'N' AND cipher_key_version IS NOT NULL`)
  return (rows as any[]).filter(r => r.v != null).map(r => Number(r.v)).filter(v => Number.isInteger(v) && v > 0)
}

/** Estabelecimentos com senha SMTP viva cifrada por versão de chave-mestra DIFERENTE de [version] (leitura comum, sem trava). */
export async function smtpCredentialsOutsideKeyVersion(q: Queryable, version: number): Promise<number[]> {
  return absentIsEmpty(() => outsideOf(q, version))
}
async function outsideOf(q: Queryable, version: number): Promise<number[]> {
  const [rows] = await q.query(
    `SELECT tb_institution_id AS id FROM tb_establishment_smtp_credential
      WHERE deleted = 'N' AND cipher_key_version IS NOT NULL AND cipher_key_version <> ?
      ORDER BY tb_institution_id`, [version])
  return (rows as any[]).map(r => Number(r.id)).filter(n => Number.isInteger(n) && n > 0)
}

/** Até [perVersion] senhas vivas por versão em uso (as de menor institution), já com a cifra — UMA instrução (molde do A1, D-F243). */
export async function sampleSmtpCredentialsPerKeyVersion(q: Queryable, perVersion = 3): Promise<SealedSample[]> {
  return absentIsEmpty(() => sampleOf(q, perVersion))
}
async function sampleOf(q: Queryable, perVersion: number): Promise<SealedSample[]> {
  const [rows] = await q.query(
    `SELECT v, id, cipher, iv, tag FROM (
       SELECT cipher_key_version AS v, tb_institution_id AS id,
              password_cipher AS cipher, password_iv AS iv, password_tag AS tag,
              ROW_NUMBER() OVER (PARTITION BY cipher_key_version ORDER BY tb_institution_id) AS rn
         FROM tb_establishment_smtp_credential
        WHERE deleted = 'N' AND cipher_key_version IS NOT NULL
     ) amostra
     WHERE rn <= ?
     ORDER BY v, id`, [perVersion])
  return (rows as any[])
    .filter(r => Number.isInteger(Number(r.v)) && Number(r.v) > 0 && Number(r.id) > 0)
    .map(r => ({
      version: Number(r.v), institutionId: Number(r.id),
      sealed: { cipher: Buffer.from(r.cipher ?? []), iv: Buffer.from(r.iv ?? []), tag: Buffer.from(r.tag ?? []), version: Number(r.v) },
    }))
}

/**
 * A cifra VIVA da senha, travada (FOR UPDATE), para a rotação — lida SÓ pelas colunas da cifra (gate adversarial L5): uma linha com outro
 * campo fora do domínio (motor sem o CHECK) continua sendo rotacionada, em vez de virar "pulada" e prender a versão antiga para sempre.
 */
export async function readSmtpPasswordSealedForUpdate(conn: PoolConnection, institutionId: number): Promise<SealedSecret | null> {
  const [rows] = await conn.query(
    `SELECT password_cipher AS cipher, password_iv AS iv, password_tag AS tag, cipher_key_version AS version
       FROM tb_establishment_smtp_credential
      WHERE tb_institution_id = ? AND deleted = 'N' FOR UPDATE`,
    [institutionId])
  return sealedOf((rows as any[])[0])
}

/** A senha SMTP como DONO de segredo cifrado do cofre (`SEALED_STORES` — rotação e prova da chave-mestra). */
export const SMTP_CREDENTIAL_SEALED_STORE: SealedStore = Object.freeze({
  name: 'tb_establishment_smtp_credential',
  unreadableCode: ErrorCodes.SMTP_CREDENTIAL_UNREADABLE,
  aad: smtpCredentialAad,
  keyVersions: smtpCredentialKeyVersions,
  outsideKeyVersion: smtpCredentialsOutsideKeyVersion,
  samplePerKeyVersion: sampleSmtpCredentialsPerKeyVersion,
  readSealedForUpdate: readSmtpPasswordSealedForUpdate,
  rewrap: rewrapSmtpCredentialPassword,
})
