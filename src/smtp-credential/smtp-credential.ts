import type { Pool, PoolConnection } from 'mysql2/promise'
import { HttpError, FieldError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'
import type { Queryable } from '../db/tx'
import { assertCheckRefuses, CheckProbe } from '../db/check'
import { MasterKeyRing } from '../secret/cipher'
import {
  SMTP_SECURITIES, SmtpSecurity, eraseSmtpCredential, getSmtpCredential, saveSmtpCredential, smtpCredentialAad,
} from './smtp-credential.repository'

/**
 * PEÇA do núcleo: "o estabelecimento tem UMA conta de envio de e-mail, cuja SENHA só quem envia abre" (FAMILIA.E5.P7 — D-NE236, Valdo
 * 2026-11-22: o e-mail da nota ao destinatário sai pelo SMTP de cada cliente, guardado no núcleo; D-NE261: quem ENVIA é a família).
 *
 *  - GUARDA, não envia: nenhum transporte de e-mail aqui. Gravar confere só a FORMA; a situação nunca diz "funciona" (o teste de conexão é
 *    de quem envia).
 *  - A senha é SEGREDO: cifrada pelo cofre (`MasterKeyRing` — D-F16) com a AAD da linha (`smtpCredentialAad`); existe em claro SÓ na chamada
 *    de gravar e no retorno de `openSmtpCredential` (a ÚNICA leitura em claro, para UM envio). Nunca em situação, retorno de escrita, mensagem
 *    de erro ou log — esta peça não usa o logger e nenhuma mensagem interpola a senha (cerca no teste).
 *  - Sem cerca da virada: a conta de e-mail não é emissão fiscal (a peça não lê o ERP nem a habilitação).
 *  - Sem porta padrão derivada de `security`: a porta é dado de quem cadastra.
 */

export { smtpCredentialAad }
export type { SmtpSecurity }

/** Maior senha aceita, em bytes UTF-8 (a cifra GCM tem o tamanho do texto; a coluna `password_cipher` é VARBINARY(1024)). */
export const SMTP_PASSWORD_MAX_BYTES = 512

export interface SmtpCredentialInput {
  host:          string
  port:          number
  security:      SmtpSecurity
  username:      string
  senderAddress: string
  /** A senha em claro — existe só nesta chamada. */
  password:      string
  /** Quem grava (usuário do produto); null = script ou ato de implantação. */
  userId:        number | null
}

/** O que a tela mostra — NUNCA a senha. */
export interface SmtpCredentialStatus {
  configured:    boolean
  host:          string | null
  port:          number | null
  security:      SmtpSecurity | null
  username:      string | null
  senderAddress: string | null
  updatedAt:     string | null
}

/** A conta aberta para UM envio: os dados do transporte e a senha em claro. Não guardar, não logar, não devolver em resposta. */
export interface OpenedSmtpCredential {
  host:          string
  port:          number
  security:      SmtpSecurity
  username:      string
  senderAddress: string
  password:      string
}

export interface SmtpCredentialDeps {
  pool:    Pool
  keyring: MasterKeyRing
}

const NOT_CONFIGURED: SmtpCredentialStatus = Object.freeze({
  configured: false, host: null, port: null, security: null, username: null, senderAddress: null, updatedAt: null,
})

// nome de servidor ou IPv4: rótulos de letras, dígitos e hífen separados por ponto, sem começar nem terminar por ponto ou hífen
const HOST_FORM = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/
// usuário: sem controle (Cc), formato invisível ou de direção (Cf — ex.: U+202E inverte o texto na tela) nem separador de linha/parágrafo
const USERNAME_FORM = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u
/** Texto que volta IGUAL do UTF-8 (surrogate solto seria gravado trocado por U+FFFD em silêncio). */
const utf8RoundTrips = (s: string) => Buffer.from(s, 'utf8').toString('utf8') === s
// `local@domínio` em ASCII imprimível, sem espaço, < > e sem 2º @ (a conferência fina do endereço é de quem envia)
const SENDER_FORM = /^[\x21-\x3B\x3D\x3F\x41-\x7E]+@[\x21-\x3B\x3D\x3F\x41-\x7E]+$/

function assertInstitutionId(institutionId: unknown): asserts institutionId is number {
  if (typeof institutionId !== 'number' || !Number.isInteger(institutionId) || institutionId <= 0) {
    throw new Error('Conta de envio de e-mail: estabelecimento inválido (inteiro positivo)')
  }
}

/** Confere a FORMA da conta. As mensagens dizem o CAMPO e a regra — nunca o valor da senha. */
function invalidFields(input: SmtpCredentialInput): FieldError[] {
  const bad: FieldError[] = []
  const text = (v: unknown): v is string => typeof v === 'string'
  if (!text(input.host) || input.host.length < 1 || input.host.length > 255 || !HOST_FORM.test(input.host)) {
    bad.push({ field: 'host', message: 'Servidor: 1 a 255 caracteres, só letras, dígitos, ponto e hífen' })
  }
  if (typeof input.port !== 'number' || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    bad.push({ field: 'port', message: 'Porta: inteiro de 1 a 65535' })
  }
  if (!text(input.security) || !SMTP_SECURITIES.some(s => s === input.security)) {
    bad.push({ field: 'security', message: `Segurança: ${SMTP_SECURITIES.join(' ou ')} (não há opção sem criptografia)` })
  }
  if (!text(input.username) || input.username.length < 1 || input.username.length > 255 || !USERNAME_FORM.test(input.username)
    || !utf8RoundTrips(input.username)) {
    bad.push({ field: 'username', message: 'Usuário: 1 a 255 caracteres, sem caractere de controle ou invisível' })
  }
  if (!text(input.senderAddress) || input.senderAddress.length < 3 || input.senderAddress.length > 254 || !SENDER_FORM.test(input.senderAddress)) {
    bad.push({ field: 'senderAddress', message: 'Remetente: endereço na forma local@domínio, até 254 caracteres, sem espaço' })
  }
  if (!text(input.password) || input.password.length < 1) {
    bad.push({ field: 'password', message: 'Senha: obrigatória' })
  } else {
    const bytes = Buffer.from(input.password, 'utf8')
    // texto que não volta igual do UTF-8 (surrogate solto) seria gravado TROCADO em silêncio; o NUL é o separador do AUTH PLAIN
    if (bytes.length > SMTP_PASSWORD_MAX_BYTES || bytes.toString('utf8') !== input.password || bytes.includes(0)) {
      bad.push({ field: 'password', message: `Senha: texto de até ${SMTP_PASSWORD_MAX_BYTES} bytes, sem o caractere nulo` })
    }
    bytes.fill(0)
  }
  if (input.userId !== null && (typeof input.userId !== 'number' || !Number.isInteger(input.userId) || input.userId <= 0)) {
    bad.push({ field: 'userId', message: 'Autor: inteiro positivo ou nulo' })
  }
  return bad
}

/** Situação da conta — o que a tela mostra (nunca a senha, nem a cifra). */
export async function smtpCredentialStatus(q: Queryable, institutionId: number): Promise<SmtpCredentialStatus> {
  assertInstitutionId(institutionId)
  const row = await getSmtpCredential(q, institutionId)
  if (!row) return NOT_CONFIGURED
  return {
    configured: true, host: row.host, port: row.port, security: row.security, username: row.username,
    senderAddress: row.senderAddress, updatedAt: row.updatedAt,
  }
}

/**
 * Grava a conta de envio do estabelecimento (cria, troca ou revive): confere a forma, cifra a senha com a AAD da linha e grava. Devolve a
 * SITUAÇÃO — nunca a senha. Forma inválida = 422 `SMTP_CREDENTIAL_INVALID` com os campos; chave-mestra ausente = 503 do cofre, nada gravado.
 */
export async function storeSmtpCredential(
  deps: SmtpCredentialDeps, institutionId: number, input: SmtpCredentialInput,
): Promise<SmtpCredentialStatus> {
  assertInstitutionId(institutionId)
  // UMA leitura de cada campo (gate adversarial L1): o que se confere é exatamente o que se grava — um getter não troca o valor no meio
  const fields: SmtpCredentialInput = {
    host: input?.host, port: input?.port, security: input?.security, username: input?.username,
    senderAddress: input?.senderAddress, password: input?.password, userId: input?.userId,
  }
  const bad = invalidFields(fields)
  if (bad.length) {
    throw new HttpError(422, 'Conta de envio de e-mail fora da forma', bad, ErrorCodes.SMTP_CREDENTIAL_INVALID)
  }
  const sealedPassword = deps.keyring.seal(fields.password, smtpCredentialAad(institutionId))
  await saveSmtpCredential(deps.pool, {
    institutionId, host: fields.host, port: fields.port, security: fields.security, username: fields.username,
    senderAddress: fields.senderAddress, sealedPassword, userId: fields.userId,
  })
  return smtpCredentialStatus(deps.pool, institutionId)
}

/**
 * Abre a conta para UM envio — a ÚNICA leitura da senha em claro. Sem conta = 409 `SMTP_CREDENTIAL_MISSING`; senha que não decifra (cifra
 * adulterada, copiada de outra linha, chave-mestra trocada) = 409 `SMTP_CREDENTIAL_UNREADABLE`; chave-mestra ausente = 503 do cofre.
 * [conn]: a conexão da transação de quem chama, quando houver.
 */
export async function openSmtpCredential(
  deps: SmtpCredentialDeps, institutionId: number, opts: { conn?: PoolConnection } = {},
): Promise<OpenedSmtpCredential> {
  assertInstitutionId(institutionId)
  const row = await getSmtpCredential(opts.conn ?? deps.pool, institutionId)
  if (!row) {
    throw new HttpError(409, 'Estabelecimento sem conta de envio de e-mail cadastrada',
      [{ field: 'smtp', message: 'Cadastre a conta de e-mail do estabelecimento' }], ErrorCodes.SMTP_CREDENTIAL_MISSING)
  }
  const unreadable = () => new HttpError(409, 'A senha da conta de envio de e-mail não decifra — cadastre a conta de novo',
    [{ field: 'smtp', message: 'Senha ilegível' }], ErrorCodes.SMTP_CREDENTIAL_UNREADABLE)
  let plain: Buffer
  try {
    plain = deps.keyring.open(row.sealedPassword, smtpCredentialAad(institutionId))
  } catch (err) {
    if (err instanceof HttpError) throw err                       // chave-mestra ausente → 503 próprio
    throw unreadable()
  }
  try {
    const password = plain.toString('utf8')
    if (plain.length < 1 || !Buffer.from(password, 'utf8').equals(plain)) throw unreadable()
    return { host: row.host, port: row.port, security: row.security, username: row.username, senderAddress: row.senderAddress, password }
  } finally {
    plain.fill(0)
  }
}

/** Apaga a conta: a cifra vira NULL e a linha fica 'S'. true = havia conta viva. */
export async function clearSmtpCredential(deps: Pick<SmtpCredentialDeps, 'pool'>, institutionId: number, userId: number | null): Promise<boolean> {
  assertInstitutionId(institutionId)
  if (userId !== null && (typeof userId !== 'number' || !Number.isInteger(userId) || userId <= 0)) {
    throw new Error('Conta de envio de e-mail: autor inválido (inteiro positivo ou nulo)')
  }
  return eraseSmtpCredential(deps.pool, institutionId, userId)
}

// ---------------------------------------------------------------------------------------------------------------------------------
// BOOT: o motor APLICA os CHECKs da 009 (molde `assertFiscalCodeDomainsEnforced` — D-F45/D-NE84). Sondas numa transação SEMPRE desfeita;
// cada uma viola UM CHECK só e tem PK própria (negativa — nunca um estabelecimento real).
// ---------------------------------------------------------------------------------------------------------------------------------
const PROBE_BYTES = Buffer.from('sonda do boot')
function probe(
  value: string, constraint: string, id: number,
  over: { security?: string; port?: number; deleted?: string; sealed?: boolean } = {},
): CheckProbe {
  const sealed = over.sealed ?? true
  return {
    value, constraint,
    sql: `INSERT INTO tb_establishment_smtp_credential
            (tb_institution_id, host, port, security, username, sender_address, password_cipher, password_iv, password_tag, cipher_key_version, deleted)
          VALUES (?, 'sonda.invalid', ?, ?, 'sonda', 'sonda@sonda.invalid', ?, ?, ?, ?, ?)`,
    params: [id, over.port ?? 587, over.security ?? 'starttls',
      sealed ? PROBE_BYTES : null, sealed ? PROBE_BYTES.subarray(0, 12) : null, sealed ? PROBE_BYTES : null, sealed ? 1 : null,
      over.deleted ?? 'N'],
  }
}

export async function assertSmtpCredentialDomainsEnforced(pool: Pick<Pool, 'getConnection'>): Promise<void> {
  await assertCheckRefuses(pool, 'a segurança da conta de e-mail', [
    probe('TLS', 'ck_establishment_smtp_credential_security_bin', -1, { security: 'TLS' }),
    probe('none', 'ck_establishment_smtp_credential_security_bin', -2, { security: 'none' }),
  ])
  await assertCheckRefuses(pool, 'a porta da conta de e-mail', [
    probe('porta 0', 'ck_establishment_smtp_credential_port', -3, { port: 0 }),
  ])
  await assertCheckRefuses(pool, 'o deleted da conta de e-mail', [
    probe("deleted 'n'", 'ck_establishment_smtp_credential_deleted_bin', -4, { deleted: 'n' }),
    // 's' sem cifra: sob `_ci` passa pelo CHECK de presença (conta como apagada) — só o binário a recusa
    probe("deleted 's'", 'ck_establishment_smtp_credential_deleted_bin', -5, { deleted: 's', sealed: false }),
  ])
  await assertCheckRefuses(pool, 'a presença da senha cifrada da conta de e-mail', [
    probe('viva sem cifra', 'ck_establishment_smtp_credential_secret_presence', -6, { sealed: false }),
    probe('apagada com cifra', 'ck_establishment_smtp_credential_secret_presence', -7, { deleted: 'S' }),
  ])
}
