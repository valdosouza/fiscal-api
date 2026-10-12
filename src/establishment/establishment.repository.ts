import { Pool, PoolConnection } from 'mysql2/promise'
import { Queryable } from '../db/tx'
import { assertCheckRefuses } from '../db/check'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'
import { erpServiceIssuerExists } from '../erp/facts'
import { SealedSecret } from '../secret/cipher'
import { ISSUER_MODELS, IssuerModel, SERVICE_ISSUER_MODEL, erpTransmitted, isIssuerModel } from './issuer-models'

/**
 * SQL das tabelas COMUNS do `fiscal_api` (migration 001 do núcleo — D-F34/D-F35):
 * `tb_establishment_certificate` (o A1 — chave privada cifrada) e `tb_establishment_issuer`
 * (habilitação por modelo). Tabelas no banco DEFAULT da conexão (o `fiscal_api`).
 */

// o DOMÍNIO e o catálogo dos modelos moram em `issuer-models.ts` (D-NE10 — parte 2 da NE-1a); re-exportados com os mesmos nomes
export { ISSUER_MODELS, SERVICE_ISSUER_MODEL }
export type { IssuerModel }
export type IssuerEnvironment = 'H' | 'P'

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

const modelIn = (models: readonly IssuerModel[]) => `model IN (${models.map(() => '?').join(', ')})`
const MODEL_IN = modelIn(ISSUER_MODELS)

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
/**
 * D-F57 (= Q-F64 (a), Valdo 2026-10-10): `serviceRows` = linhas da habilitação SE (vivas ou excluídas). A lacuna (b) da cerca
 * olha a LINHA SE — uma linha 55/65 (que nasce virada, D-F42) não pode esconder a SE que o ERP ainda emite.
 */
export interface IssuerRowsState { rows: number; replicas: number; serviceRows: number }

/**
 * As LINHAS da habilitação (vivas ou excluídas) da institution, TRAVADAS por PK — uma por modelo do domínio (`c` = cutover_at). D-NE84
 * (gate adversarial da parte 2, NE1A2-07): o `model IN (…)` do SQL decide na colação da tabela (_ci — 'se' casa com 'SE'), então o modelo
 * volta CANÔNICO e o filtro em JS decide igual à leitura (`issuerRowsState`): a trava e a leitura nunca discordam. Desde a A1 da F2a o
 * CHECK do `model` é BINÁRIO (migration 005 do núcleo — 'se' recusado); a canonização fica como defesa (banco anterior à 005).
 */
async function lockIssuerRowList(q: Queryable, institutionId: number): Promise<{ model: string; c: unknown }[]> {
  const [rows] = await q.query(
    `SELECT model, cutover_at AS c FROM tb_establishment_issuer WHERE tb_institution_id = ? AND ${MODEL_IN} FOR UPDATE`,
    [institutionId, ...ISSUER_MODELS])
  return (rows as any[]).map(r => ({ ...r, model: ISSUER_MODELS.find(m => m.toUpperCase() === String(r.model).toUpperCase()) ?? String(r.model) }))
}

export async function lockIssuerRows(q: Queryable, institutionId: number): Promise<IssuerRowsState> {
  const list = await lockIssuerRowList(q, institutionId)
  return { rows: list.length, replicas: list.filter(r => r.c == null).length, serviceRows: list.filter(r => r.model === SERVICE_ISSUER_MODEL).length }
}

/**
 * O mesmo estado SEM travar — no MESMO domínio de modelos da trava (gates do delta de 2026-10-04: a contagem sem filtro e
 * a trava filtrada divergiam com um modelo fora da lista e a cerca se contradizia). O domínio é fato do banco (CHECK da 004).
 * [models] (parte 2 da NE-1a — D-NE10): restringe a contagem às linhas de ALGUNS modelos (a decisão POR MODELO da cerca); omitido
 * = o domínio inteiro (o grão do ESTABELECIMENTO, como antes).
 */
export async function issuerRowsState(q: Queryable, institutionId: number, models: readonly IssuerModel[] = ISSUER_MODELS): Promise<IssuerRowsState> {
  if (models.length === 0 || !models.every(isIssuerModel)) throw new Error(`Modelos fora do domínio da habilitação: ${models.join(', ')}`)
  const [rows] = await q.query(
    `SELECT COUNT(*) AS n, SUM(cutover_at IS NULL) AS r, SUM(model = ?) AS s FROM tb_establishment_issuer WHERE tb_institution_id = ? AND ${modelIn(models)}`,
    [SERVICE_ISSUER_MODEL, institutionId, ...models])
  const r0 = (rows as any[])[0]
  return { rows: Number(r0?.n ?? 0), replicas: Number(r0?.r ?? 0), serviceRows: Number(r0?.s ?? 0) }
}

/**
 * D-NE10 (a) — a decisão "a emissão deste MODELO ainda é do ERP" sobre as linhas DESTE modelo (vivas ou excluídas):
 *  - réplica do modelo (`cutover_at` NULL) → ERP;
 *  - modelo que o ERP transmitia (`erpTransmitted` — só a SE) SEM linha no `fiscal_api` → a habilitação do ERP decide (lacuna (b));
 *  - linha virada, ou modelo que NASCE virado (55/65 — não dependem da SE) → a API fiscal.
 * Pura sobre o estado + a leitura do ERP (só consultada quando decide) — a MESMA regra para a trava e para a leitura sem trava.
 */
async function modelStillInErp(
  state: { rows: number; replicas: number }, model: IssuerModel, q: Queryable, schemaName: string, institutionId: number,
): Promise<boolean> {
  if (state.replicas > 0) return true
  if (!erpTransmitted(model)) return false
  if (state.rows > 0) return false
  // a lacuna (b) só existe para o modelo que o ERP transmitia; o leitor do ERP é o da habilitação de SERVIÇO (a única — D-F42)
  if (model !== SERVICE_ISSUER_MODEL) throw new Error(`Modelo ${model} marcado como transmitido pelo ERP sem leitor da habilitação dele no ERP`)
  return erpServiceIssuerExists(q, schemaName, institutionId)
}

/** O mesmo, no grão do ESTABELECIMENTO: réplica em QUALQUER linha OU a lacuna (b) da SE (D-F39/D-F57 — o predicado de antes). */
async function anyStillInErp(state: IssuerRowsState, q: Queryable, schemaName: string, institutionId: number): Promise<boolean> {
  if (state.replicas > 0) return true
  // D-F57 (= Q-F64 (a)): a lacuna (b) olha a LINHA SE — sem ela, a SE própria do ERP decide (uma 55/65 virada não esconde)
  if (state.serviceRows > 0) return false
  return erpServiceIssuerExists(q, schemaName, institutionId)
}

/** Predicado POR MODELO sem trava (a borda, o rodízio, o caminho da falha do `openIssuer`) — `emissionStillInErp` em `establishment.ts`. */
export async function issuerModelStillInErp(q: Queryable, schemaName: string, institutionId: number, model: IssuerModel): Promise<boolean> {
  return modelStillInErp(await issuerRowsState(q, institutionId, [model]), model, q, schemaName, institutionId)
}

/** Predicado do ESTABELECIMENTO sem trava — `anyEmissionStillInErp` em `establishment.ts`. */
export async function establishmentStillInErp(q: Queryable, schemaName: string, institutionId: number): Promise<boolean> {
  return anyStillInErp(await issuerRowsState(q, institutionId), q, schemaName, institutionId)
}

/**
 * D-F45 (Valdo 2026-10-04) — boot: o domínio do modelo é FATO do banco (CHECK da migration 004) e o MOTOR o APLICA
 * (MySQL < 8.0.16 aceita o CHECK e ignora em silêncio; MySQL 8 pode tê-lo NOT ENFORCED). A prova é o próprio ato: um
 * modelo fora do domínio, numa transação SEMPRE desfeita, tem de ser RECUSADO pelo banco — senão o boot falha alto.
 */
export async function assertIssuerModelDomainEnforced(pool: Pick<Pool, 'getConnection'>): Promise<void> {
  // D-NE84 (gates da NE-1a parte 2; executada na F2a — migration 005 do núcleo): o CHECK é BINÁRIO — 'ZZ' prova que o motor aplica CHECK,
  // 'se' prova que a colação é binária (um CHECK _ci aceitaria a minúscula — a cerca da virada por modelo não a enxergaria)
  const probe = (value: string) => ({ value, constraint: 'ck_establishment_issuer_model_bin', params: [value],
    sql: `INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, dps_last_number, deleted) VALUES (0, ?, 'H', 0, 'N')` })
  await assertCheckRefuses(pool, 'o modelo da habilitação', [probe('ZZ'), probe('se')])
}

/**
 * D-F120 (= Q-F131 (a), Valdo 2026-10-12 — gates da A1 da F2a): o AMBIENTE da habilitação é H/P em colação BINÁRIA (migration 005 do núcleo)
 * — 'h' minúsculo era H para o SQL e outra coisa para o código (o ambiente congelado na tentativa decide registro fiscal e prova). Sonda:
 * 'X' (fora) e 'h' (minúscula); cada linha com PK própria (um motor sem CHECK não colide a 2ª sonda na 1ª — F2A1-07).
 */
export async function assertIssuerEnvironmentDomainEnforced(pool: Pick<Pool, 'getConnection'>): Promise<void> {
  const probe = (value: string, model: string) => ({ value, constraint: 'ck_establishment_issuer_environment_bin', params: [model, value],
    sql: `INSERT INTO tb_establishment_issuer (tb_institution_id, model, environment, dps_last_number, deleted) VALUES (0, ?, ?, 0, 'N')` })
  await assertCheckRefuses(pool, 'o ambiente da habilitação', [probe('X', '55'), probe('h', '65')])
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
 * D-F39 (gates da Rodada 4) — o EMITENTE só se escreve se a emissão NÃO é do ERP: as linhas da habilitação são TRAVADAS primeiro
 * (1ª instrução da transação — nada de snapshot antes da trava; SEMPRE todas as linhas do estabelecimento, por PK — PADROES §9 regra 8:
 * travar só a linha do modelo traria de volta o cruzamento SE × 55 dos gates de 04/10). Só a DECISÃO muda de grão (D-NE10 — parte 2
 * da NE-1a): vale para quem chama a peça direto (script, a futura nfe-api), não só para a borda da nfse-api.
 *
 * A1 (`assertCertificateWritable`) = grão do ESTABELECIMENTO (o A1 é UM — D-N31): recusa réplica em QUALQUER linha (viva OU excluída) e
 * a lacuna (b) (sem linha SE no `fiscal_api` e com SE no ERP) — o mesmo predicado de antes (D-NE10 (a): "a escrita do A1 segue barrada
 * enquanto houver réplica").
 */
export async function assertCertificateWritable(q: Queryable, schemaName: string, institutionId: number): Promise<void> {
  const state = await lockIssuerRows(q, institutionId)
  if (await anyStillInErp(state, q, schemaName, institutionId)) {
    throw new HttpError(409, 'A emissão fiscal deste estabelecimento ainda é do ERP — o emitente só muda pelo ERP até a virada',
      undefined, ErrorCodes.FISCAL_CUTOVER_PENDING)
  }
}

/**
 * HABILITAÇÃO de um MODELO (`assertIssuerWritable`) = grão do MODELO (D-NE10 (a)): trava TODAS as linhas e decide só pelas linhas do
 * modelo — réplica dele, ou (modelo que o ERP transmitia) sem linha e com a habilitação no ERP. 55/65 nascem virados e não dependem
 * da SE: a réplica da SE não barra a habilitação da NF-e.
 */
export async function assertIssuerWritable(q: Queryable, schemaName: string, institutionId: number, model: IssuerModel): Promise<void> {
  if (!isIssuerModel(model)) throw new Error(`Modelo fora do domínio da habilitação: ${String(model)}`)
  const mine = (await lockIssuerRowList(q, institutionId)).filter(r => r.model === model)
  const state = { rows: mine.length, replicas: mine.filter(r => r.c == null).length }
  if (await modelStillInErp(state, model, q, schemaName, institutionId)) {
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
  await assertIssuerWritable(conn, schemaName, institutionId, model)
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
  await assertIssuerWritable(conn, schemaName, institutionId, model)    // a réplica do ERP não se exclui por aqui (D-F39)
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
