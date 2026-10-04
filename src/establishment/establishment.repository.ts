import { Pool, PoolConnection } from 'mysql2/promise'
import { Queryable } from '../db/tx'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'
import { erpServiceIssuerExists } from '../erp/facts'
import { SealedSecret } from '../secret/cipher'

/**
 * SQL das tabelas COMUNS do `fiscal_api` (migration 001 do núcleo — D-F34/D-F35):
 * `tb_establishment_certificate` (o A1 — chave privada cifrada) e `tb_establishment_issuer`
 * (habilitação por modelo). Tabelas no banco DEFAULT da conexão (o `fiscal_api`).
 */

export type IssuerModel = 'SE' | '55' | '65'
export type IssuerEnvironment = 'H' | 'P'
/** Os modelos que o núcleo habilita — também a lista de LINHAS que `lockIssuerRows` trava (PK pontual, nunca faixa). */
export const ISSUER_MODELS: readonly IssuerModel[] = ['SE', '55', '65']

export interface IssuerRow {
  institutionId: number
  model:         IssuerModel
  environment:   IssuerEnvironment
  serie:         string | null
  userId:        number | null
  /** D-F39: desde quando (UTC) a API fiscal emite por esta habilitação; null = RÉPLICA do ERP (só leitura). */
  cutoverAt:     string | null
}

export interface CertificateRow {
  institutionId:  number
  cnpj:           string | null
  certificatePem: string | null
  sealedKey:      SealedSecret | null
  subject:        string | null
  issuedBy:       string | null
  notBefore:      string | null
  notAfter:       string | null
  fingerprint256: string | null
  userId:         number | null
}

const ISSUER_SELECT = `
  SELECT tb_institution_id AS institutionId, model, environment, serie, tb_user_id AS userId,
         DATE_FORMAT(cutover_at, '%Y-%m-%d %H:%i:%s') AS cutoverAt
    FROM tb_establishment_issuer`

function mapIssuer(r: any): IssuerRow {
  return {
    institutionId: Number(r.institutionId),
    model:         String(r.model) as IssuerModel,
    environment:   r.environment === 'P' ? 'P' : 'H',
    serie:         r.serie == null ? null : String(r.serie),
    userId:        r.userId == null ? null : Number(r.userId),
    cutoverAt:     r.cutoverAt == null ? null : String(r.cutoverAt),
  }
}

const MODEL_IN = `model IN (${ISSUER_MODELS.map(() => '?').join(', ')})`

/**
 * Estado das linhas da habilitação da institution (D-F39: réplica = `cutover_at` NULL, viva OU excluída), TRAVANDO-as
 * (FOR UPDATE) — 1ª instrução de quem decide ESCREVER o emitente (gates da Rodada 4: a leitura não travante criava o
 * snapshot do REPEATABLE READ antes da trava e o DELETE do A1 contava 0 transmissões vivas com uma reserva recém-comitada).
 * Ordem: habilitação → A1 (a mesma da reserva).
 * A trava é POR LINHA (PK completa: institution × cada modelo do domínio), nunca por FAIXA da institution (sessão
 * 2026-10-04, prova em banco descartável no MariaDB 10.4 — PADROES §9 regra 8): quem já segurava a linha SE por
 * `getIssuer(..., FOR UPDATE)` e depois pedia a faixa PROMOVIA a trava de registro para next-key; com o UPDATE do aluguel
 * na fila dessa linha, o InnoDB fechava um ciclo e matava o aluguel com 1213. Por linha, toda trava numa linha EXISTENTE é
 * de registro (a reserva, o contador, o aluguel, o upsert). Os modelos AUSENTES levam trava de INTERVALO — não espera
 * ninguém e segura o INSERT da mesma institution (a lacuna (b) continua serializada), mas o intervalo vai até a próxima
 * chave existente e pode cobrir a institution VIZINHA: CRIAÇÕES concorrentes de habilitação em institutions sem linha
 * podem deadlockar entre si (reexecutadas; esgotado = 409, nada gravado). Limitação aceita (§17 do prompt — criação é ato
 * de implantação); a faixa tinha o mesmo efeito.
 */
export async function lockIssuerRows(q: Queryable, institutionId: number): Promise<{ rows: number; replicas: number }> {
  const [rows] = await q.query(
    `SELECT cutover_at AS c FROM tb_establishment_issuer WHERE tb_institution_id = ? AND ${MODEL_IN} FOR UPDATE`,
    [institutionId, ...ISSUER_MODELS])
  const list = rows as any[]
  return { rows: list.length, replicas: list.filter(r => r.c == null).length }
}

/**
 * O mesmo estado SEM travar — no MESMO domínio de modelos da trava (gates do delta de 2026-10-04: a contagem sem filtro e
 * a trava filtrada divergiam com um modelo fora da lista e a cerca se contradizia). O domínio vira fato do banco com a
 * Q-F56 (CHECK); até lá, modelo fora de `ISSUER_MODELS` não existe para a cerca.
 */
export async function issuerRowsState(q: Queryable, institutionId: number): Promise<{ rows: number; replicas: number }> {
  const [rows] = await q.query(
    `SELECT COUNT(*) AS n, SUM(cutover_at IS NULL) AS r FROM tb_establishment_issuer WHERE tb_institution_id = ? AND ${MODEL_IN}`,
    [institutionId, ...ISSUER_MODELS])
  return { rows: Number((rows as any[])[0]?.n ?? 0), replicas: Number((rows as any[])[0]?.r ?? 0) }
}

/**
 * D-F45 (Valdo 2026-10-04) — boot: o domínio do modelo é FATO do banco (CHECK da migration 004) e o MOTOR o APLICA
 * (MySQL < 8.0.16 aceita o CHECK e ignora em silêncio; MySQL 8 pode tê-lo NOT ENFORCED). A prova é o próprio ato: um
 * modelo fora do domínio, numa transação SEMPRE desfeita, tem de ser RECUSADO pelo banco — senão o boot falha alto.
 */
export async function assertIssuerModelDomainEnforced(pool: Pool): Promise<void> {
  const conn = await pool.getConnection()
  let accepted = false
  try {
    await conn.beginTransaction()
    try {
      await conn.query(
        `INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, dps_last_number, deleted) VALUES (0, 'ZZ', 'H', 0, 'N')`)
      accepted = true
    } catch (err: any) {
      // ER_CONSTRAINT_FAILED (MariaDB 4025) · ER_CHECK_CONSTRAINT_VIOLATED (MySQL 3819) = o motor aplicou o CHECK
      if (!(err?.errno === 4025 || err?.errno === 3819 || /CONSTRAINT/.test(String(err?.code ?? '')))) throw err
    }
  } finally {
    try { await conn.rollback() } catch { /* a conexão pode ter caído — o release resolve */ }
    conn.release()
  }
  if (accepted) {
    throw new Error('O banco ACEITOU um modelo fora do domínio na habilitação — o motor não aplica CHECK (exige MariaDB ≥ 10.2 '
      + 'ou MySQL ≥ 8.0.16 com o CHECK ENFORCED; D-F45, migration 004 do núcleo)')
  }
}

export async function listIssuers(q: Queryable, institutionId: number): Promise<IssuerRow[]> {
  const [rows] = await q.query(`${ISSUER_SELECT} WHERE tb_institution_id = ? AND deleted = 'N' ORDER BY model`, [institutionId])
  return rows.map(mapIssuer)
}

export async function getIssuer(q: Queryable, institutionId: number, model: IssuerModel, forUpdate = false): Promise<IssuerRow | null> {
  const [rows] = await q.query(
    `${ISSUER_SELECT} WHERE tb_institution_id = ? AND model = ? AND deleted = 'N'${forUpdate ? ' FOR UPDATE' : ''}`,
    [institutionId, model])
  return rows[0] ? mapIssuer(rows[0]) : null
}

/**
 * D-F39 (gates da Rodada 4) — o EMITENTE (A1 e habilitação) só se escreve se a emissão do estabelecimento NÃO é do ERP: as
 * linhas da habilitação são TRAVADAS primeiro (1ª instrução da transação — nada de snapshot antes da trava) e recusa-se a
 * réplica (viva OU excluída) e a lacuna (b): sem linha no `fiscal_api` e com habilitação SE no ERP. Vale para quem chama a
 * peça direto (script, a futura nfe-api), não só para a borda da nfse-api.
 */
export async function assertEmitterWritable(q: Queryable, schemaName: string, institutionId: number): Promise<void> {
  const { rows, replicas } = await lockIssuerRows(q, institutionId)
  if (replicas > 0 || (rows === 0 && await erpServiceIssuerExists(q, schemaName, institutionId))) {
    throw new HttpError(409, 'A emissão fiscal deste estabelecimento ainda é do ERP — o emitente só muda pelo ERP até a virada',
      undefined, ErrorCodes.FISCAL_CUTOVER_PENDING)
  }
}

/**
 * Cria/altera a habilitação; linha excluída REVIVE (habilitação é ato de implantação). A cerca da virada é conferida AQUI,
 * com trava, como 1ª instrução (re-prova R4: a habilitação que nasce virada não pode nascer na lacuna (b) — seria uma 2ª
 * numeração na mesma série do ERP).
 */
export async function upsertIssuer(
  conn: PoolConnection, schemaName: string, institutionId: number, model: IssuerModel,
  input: { environment: IssuerEnvironment; serie: string | null; userId: number | null },
): Promise<IssuerRow> {
  await assertEmitterWritable(conn, schemaName, institutionId)
  // D-F39: habilitação que NASCE pela API fiscal nasce virada (cutover_at = NOW()); revive/ON DUPLICATE KEY nunca toca a
  // coluna — uma réplica do ERP continua réplica (quem chama já conferiu que o ERP não emite por este estabelecimento)
  await conn.query(
    `INSERT INTO tb_establishment_issuer
       (tb_institution_id, model, environment, serie, dps_last_number, tb_user_id, created_at, updated_at, deleted, cutover_at)
     VALUES (?, ?, ?, ?, 0, ?, NOW(), NOW(), 'N', NOW())
     ON DUPLICATE KEY UPDATE environment = VALUES(environment), serie = VALUES(serie), tb_user_id = VALUES(tb_user_id),
       deleted = 'N', updated_at = NOW()`,
    [institutionId, model, input.environment, input.serie, input.userId])
  const row = await getIssuer(conn, institutionId, model)
  if (!row) throw new Error(`Habilitação do emissor ${model} não persistida`)
  return row
}

export async function softDeleteIssuer(conn: PoolConnection, schemaName: string, institutionId: number, model: IssuerModel): Promise<boolean> {
  await assertEmitterWritable(conn, schemaName, institutionId)          // a réplica do ERP não se exclui por aqui (D-F39)
  const [r] = await conn.query<any>(
    `UPDATE tb_establishment_issuer SET deleted = 'S', updated_at = NOW() WHERE tb_institution_id = ? AND model = ? AND deleted = 'N'`,
    [institutionId, model])
  return Number(r?.affectedRows ?? 0) > 0
}

/**
 * Próximo nDPS (D-N18): UPDATE +1 na linha SE do emissor — quem chama já a travou FOR UPDATE
 * (`openIssuer(..., { forUpdate: true })`). Contínuo mesmo trocando a série; nunca volta.
 * D-F39: a condição da virada está NO PRÓPRIO comando que cunha — réplica do ERP nunca cunha número.
 */
export async function nextDpsNumber(conn: PoolConnection, institutionId: number): Promise<number> {
  const [r] = await conn.query<any>(
    `UPDATE tb_establishment_issuer SET dps_last_number = dps_last_number + 1, updated_at = NOW()
      WHERE tb_institution_id = ? AND model = 'SE' AND deleted = 'N' AND cutover_at IS NOT NULL`,
    [institutionId])
  if (Number(r?.affectedRows ?? 0) === 0) {
    const [live] = await conn.query<any[]>(
      `SELECT 1 AS x FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE' AND deleted = 'N'`, [institutionId])
    if ((live as any[]).length) {
      throw new HttpError(409, 'A emissão fiscal deste estabelecimento ainda é do ERP (réplica) — nenhum nDPS é cunhado aqui até a virada',
        undefined, ErrorCodes.FISCAL_CUTOVER_PENDING)
    }
    throw new Error('Emissor SE sem linha para cunhar o nDPS (habilitação ausente)')
  }
  const [rows] = await conn.query<any[]>(
    `SELECT dps_last_number AS n FROM tb_establishment_issuer WHERE tb_institution_id = ? AND model = 'SE' AND deleted = 'N'`,
    [institutionId])
  return Number(rows[0].n)
}

/**
 * ALUGUEL da consulta ativa (migration 002 — gates da F1): UPDATE atômico na linha do emissor do modelo.
 * Devolve o TOKEN do dono (o próprio `refresh_lease_until` gravado — cada aluguel novo é estritamente maior
 * que o anterior, porque só se toma aluguel vencido) ou null (ocupado / sem habilitação). Nenhuma conexão
 * fica retida. A devolução só apaga o aluguel se ele AINDA for do dono (gate adversarial R2: a passada que
 * estourava os 60 s apagava o aluguel da seguinte e uma 3ª rodava junto).
 */
export async function acquireRefreshLease(q: Queryable, institutionId: number, model: IssuerModel, seconds: number): Promise<string | null> {
  const [r] = await q.query(
    `UPDATE tb_establishment_issuer SET refresh_lease_until = DATE_ADD(NOW(), INTERVAL ? SECOND)
      WHERE tb_institution_id = ? AND model = ? AND deleted = 'N' AND cutover_at IS NOT NULL
        AND (refresh_lease_until IS NULL OR refresh_lease_until < NOW())`,
    [seconds, institutionId, model])
  if (Number(r?.affectedRows ?? 0) !== 1) return null
  const [rows] = await q.query(
    `SELECT DATE_FORMAT(refresh_lease_until, '%Y-%m-%d %H:%i:%s') AS token FROM tb_establishment_issuer
      WHERE tb_institution_id = ? AND model = ?`, [institutionId, model])
  return (rows as any[])[0]?.token ?? null
}

/**
 * RENOVA o aluguel do dono (token) por mais [seconds] — a passada renova antes de cada candidata (gates da Rodada 4: uma
 * consulta pode durar 2 × 30 s e o aluguel vencia no meio; outra passada consultava a mesma candidata em paralelo).
 * Devolve o token novo, ou null se o aluguel já não é deste dono (a passada para).
 */
export async function renewRefreshLease(q: Queryable, institutionId: number, model: IssuerModel, token: string, seconds: number): Promise<string | null> {
  const [r] = await q.query(
    `UPDATE tb_establishment_issuer SET refresh_lease_until = DATE_ADD(NOW(), INTERVAL ? SECOND)
      WHERE tb_institution_id = ? AND model = ? AND refresh_lease_until = ? AND cutover_at IS NOT NULL`,
    [seconds, institutionId, model, token])
  if (Number(r?.affectedRows ?? 0) !== 1) return null
  const [rows] = await q.query(
    `SELECT DATE_FORMAT(refresh_lease_until, '%Y-%m-%d %H:%i:%s') AS token FROM tb_establishment_issuer
      WHERE tb_institution_id = ? AND model = ?`, [institutionId, model])
  return (rows as any[])[0]?.token ?? null
}

/** Devolve o aluguel SÓ se ainda for deste dono (token); aluguel já tomado por outro fica intacto. */
export async function releaseRefreshLease(q: Queryable, institutionId: number, model: IssuerModel, token: string): Promise<boolean> {
  const [r] = await q.query(
    `UPDATE tb_establishment_issuer SET refresh_lease_until = NULL
      WHERE tb_institution_id = ? AND model = ? AND refresh_lease_until = ?`, [institutionId, model, token])
  return Number(r?.affectedRows ?? 0) === 1
}

// ---------------------------------------------------------------------------
// Certificado A1 (D-N31: UM por estabelecimento)
// ---------------------------------------------------------------------------

const toIso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) return v.toISOString()
  const s = String(v)
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}.000Z` : s
}

/**
 * [locking] = leitura TRAVANTE compartilhada (`LOCK IN SHARE MODE`): quem decide gravar com o A1 (a reserva)
 * lê o A1 ATUAL, nunca o snapshot — gate adversarial R2: a reserva que esperava a trava da habilitação
 * acordava e assinava com o A1 que o DELETE já tinha apagado (leitura consistente = snapshot antigo).
 */
export async function getCertificate(q: Queryable, institutionId: number, locking = false): Promise<CertificateRow | null> {
  const [rows] = await q.query(
    `SELECT tb_institution_id AS institutionId, cnpj, certificate_pem AS certificatePem,
            private_key_cipher AS cipher, private_key_iv AS iv, private_key_tag AS tag, cipher_key_version AS version,
            subject, issued_by AS issuedBy, not_before AS notBefore, not_after AS notAfter,
            fingerprint256, tb_user_id AS userId
       FROM tb_establishment_certificate
      WHERE tb_institution_id = ? AND deleted = 'N'${locking ? ' LOCK IN SHARE MODE' : ''}`,
    [institutionId])
  const r = rows[0]
  if (!r) return null
  const sealedKey = r.cipher && r.iv && r.tag && r.version != null
    ? { cipher: Buffer.from(r.cipher), iv: Buffer.from(r.iv), tag: Buffer.from(r.tag), version: Number(r.version) }
    : null
  return {
    institutionId: Number(r.institutionId), cnpj: r.cnpj ?? null,
    certificatePem: r.certificatePem == null ? null : String(r.certificatePem), sealedKey,
    subject: r.subject ?? null, issuedBy: r.issuedBy ?? null,
    notBefore: toIso(r.notBefore), notAfter: toIso(r.notAfter),
    fingerprint256: r.fingerprint256 ?? null, userId: r.userId == null ? null : Number(r.userId),
  }
}

export async function saveCertificate(
  conn: PoolConnection, row: Omit<CertificateRow, 'sealedKey'> & { sealedKey: SealedSecret },
): Promise<void> {
  const dt = (iso: string | null) => (iso ? iso.slice(0, 19).replace('T', ' ') : null)
  await conn.query(
    `INSERT INTO tb_establishment_certificate
       (tb_institution_id, cnpj, certificate_pem, private_key_cipher, private_key_iv, private_key_tag, cipher_key_version,
        subject, issued_by, not_before, not_after, fingerprint256, tb_user_id, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE cnpj = VALUES(cnpj), certificate_pem = VALUES(certificate_pem),
       private_key_cipher = VALUES(private_key_cipher), private_key_iv = VALUES(private_key_iv),
       private_key_tag = VALUES(private_key_tag), cipher_key_version = VALUES(cipher_key_version),
       subject = VALUES(subject), issued_by = VALUES(issued_by), not_before = VALUES(not_before),
       not_after = VALUES(not_after), fingerprint256 = VALUES(fingerprint256), tb_user_id = VALUES(tb_user_id),
       deleted = 'N', updated_at = NOW()`,
    [row.institutionId, row.cnpj, row.certificatePem, row.sealedKey.cipher, row.sealedKey.iv, row.sealedKey.tag,
     row.sealedKey.version, row.subject, row.issuedBy, dt(row.notBefore), dt(row.notAfter), row.fingerprint256, row.userId])
}

/** Excluir o A1: segredos e certificado viram NULL e a linha fica 'S' — chave excluída não fica guardada. */
export async function eraseCertificate(conn: PoolConnection, institutionId: number, userId: number | null): Promise<boolean> {
  const [r] = await conn.query<any>(
    `UPDATE tb_establishment_certificate
        SET certificate_pem = NULL, private_key_cipher = NULL, private_key_iv = NULL, private_key_tag = NULL,
            cipher_key_version = NULL, tb_user_id = ?, deleted = 'S', updated_at = NOW()
      WHERE tb_institution_id = ? AND deleted = 'N'`,
    [userId, institutionId])
  return Number(r?.affectedRows ?? 0) > 0
}
