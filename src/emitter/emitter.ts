import { Pool } from 'mysql2/promise'
import { Queryable, withTransaction } from '../db/tx'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'
import { logger } from '../log/logger'
import { MasterKeyRing } from '../secret/cipher'
import type { InvoiceBranch } from '../ref/invoice-ref'
import { FINAL_TRANSMISSION_KINDS, TransmissionEnvironment } from '../voice/kinds'
import { VOICE_READINGS } from '../voice/families'
import { ISSUER_MODEL_FACTS, IssuerAuthority, IssuerModel, authorityOf, branchOf, isIssuerModel, modelsOf } from '../establishment/issuer-models'
import {
  IssuerEnvironment, assertCertificateWritable, assertIssuerWritable, eraseCertificate, getIssuer, listIssuers, softDeleteIssuer, upsertIssuer,
} from '../establishment/establishment.repository'
import { IssuerCertificateStatus, certificateStatus, isIssuerEnabled, storeCertificate } from '../establishment/establishment'
import type { ExpectedCnpj } from '../secret/certificate'

/**
 * EMITTER do núcleo (D-NE9 = Q-NE9 (c), Valdo 2026-10-10 — "módulo emitter no NÚCLEO, montado pelas duas"; parte 2 da NE-1a,
 * `prompt_onda_nfe_sefaz.md` §12.9.7): a COMPOSIÇÃO "o estabelecimento como emissor no `fiscal_api`" — habilitação por modelo + o A1
 * (UM por estabelecimento — D-N31) + as transmissões VIVAS das famílias, lidas pelas leituras PUBLICADAS (`VOICE_READINGS`, views da
 * família — D-F15/D-F35). Cada serviço monta as rotas `/v1/emitter` dele (borda, DTO e a recusa do modelo que não é dele); a política
 * mora aqui, uma vez.
 *
 * Palavra ocupada (glossário): "emitter" aqui é o EMISSOR do `fiscal_api` (habilitação + A1) — nunca o emitente lido do ERP
 * (`EmitterIdentity` da família).
 *
 * Quem barra o quê (parecer do guardião da parte 2):
 *   PUT da habilitação de M (troca de ambiente) — vivas da FAMÍLIA de M no ambiente atual;
 *   DELETE da habilitação de M                  — vivas da família de M em qualquer ambiente;
 *   DELETE do A1                                — vivas de TODAS as famílias (sem o A1 nenhuma reconciliação fecha, em família nenhuma).
 * CONHECIMENTO NEGATIVO: (1) as vivas do A1 NÃO filtram terminal (o A1 serve todos os terminais — o cuidado da D-NE12 não se aplica);
 * (2) 55 e 65 dividem a MESMA família — as vivas de um barram o ambiente do outro (sobre-bloqueio, falha FECHADO). D-NE160 (NE-2,
 * Valdo 2026-10-20): a projeção NÃO ganha `model` até a F5 — na F4 só existe o 55 (D-NE2) e o sobre-bloqueio não tem objeto; na F5 o
 * modelo sai da CHAVE (posições 21-22) e, se este emitter precisar filtrar por modelo, `model` entra na PROJEÇÃO COMUM (a NFS-e
 * publica 'SE'), nunca como coluna só da família; (3) família no catálogo sem a migration dela aplicada = erro 1146 no DELETE do A1 —
 * NUNCA tratar como 0 (falha ABERTO); a família só entra em `VOICE_READINGS` junto com a conferência de boot da view dela (D-NE158: a
 * leitura `merchandise` existe no núcleo desde a NE-2 e entra no catálogo na janela da NE-6 — até lá este emitter conta 0 para ela,
 * legítimo: nenhuma tentativa de NF-e é possível antes).
 */

export interface EmitterDeps {
  pool:    Pool
  keyring: MasterKeyRing
}

/** Quem age: o estabelecimento do token (institution + schema do ERP) e o usuário. */
export interface EmitterActor {
  institutionId: number
  userId:        number | null
  schemaName:    string
}

export interface IssuerItemView {
  model:       IssuerModel
  environment: IssuerEnvironment
  serie:       string | null
  enabled:     boolean
  authority:   IssuerAuthority
  /** D-F39: desde quando a API fiscal emite por esta habilitação; null = réplica do ERP. */
  cutoverAt:   string | null
}

export interface EmitterView {
  issuers:     IssuerItemView[]
  certificate: IssuerCertificateStatus
}

const VIEW = /^vw_[a-z0-9_]+$/
/** Os RAMOS do domínio (os do catálogo de modelos) — um ramo fora dele é erro de quem chama, nunca "nada a contar". */
const BRANCHES: readonly string[] = Object.freeze(Object.values(ISSUER_MODEL_FACTS).map(f => f.branch).filter((b, i, all) => all.indexOf(b) === i))
const isNoSuchTable = (err: unknown) => (err as any)?.errno === 1146 || (err as any)?.code === 'ER_NO_SUCH_TABLE'

/**
 * D-NE76 (gate socrático da parte 2 — Valdo 2026-10-12): a família está INSTALADA neste `fiscal_api`? Nem a view publicada nem a tabela
 * de tentativas dela existem = NÃO instalada (a outra API ainda não subiu aqui — D-F20) → 0 legítimo. Qualquer uma presente = instalada:
 * o 1146 de quem perguntou sobe (falha fechado — "erro nunca vira 0"). A consulta ao catálogo do banco falhando também sobe. A tabela
 * vem da CONVENÇÃO da leitura publicada (`vw_<x>` sobre `tb_<x>`) — o núcleo segue sem o nome de tabela de família nenhuma.
 */
async function familyInstalled(q: Queryable, view: string): Promise<boolean> {
  const table = `tb_${view.slice(3)}`
  const [rows] = await q.query(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?)`, [view, table])
  return (rows as any[]).length > 0
}

/**
 * Tentativas VIVAS (sem voz ou última voz não final — `isLiveTransmission`) do estabelecimento, somando as LEITURAS PUBLICADAS das
 * famílias pedidas ([branches] — 'all' = todo o catálogo). A view de cada família já exclui a tentativa excluída e escolhe a última voz
 * não excluída (projeção comum). Ramo sem leitura no catálogo = a família ainda não existe (nenhuma tentativa possível). Banco DEFAULT
 * da conexão (o `fiscal_api`, onde as views moram). Chame sob a TRAVA da habilitação (1ª instrução da transação de quem decide).
 * [branches] vazio, que não é lista, ou com ramo fora do domínio falha ALTO (gate NE1A2-06 — antes devolvia 0 sem SQL: a guarda do A1
 * falhava aberto). Família do catálogo NÃO INSTALADA neste banco conta 0 (D-NE76); instalada sem a view, falha fechado.
 */
export async function countLiveTransmissions(
  q: Queryable, institutionId: number, opts: { branches: 'all' | readonly InvoiceBranch[]; environment?: TransmissionEnvironment },
): Promise<number> {
  const branches = opts?.branches
  if (branches !== 'all' && (!Array.isArray(branches) || !branches.length || !branches.every(b => BRANCHES.includes(b)))) {
    throw new Error(`countLiveTransmissions: ramos inválidos (${JSON.stringify(branches)}) — 'all' ou uma lista não vazia de ${BRANCHES.join('/')}`)
  }
  const finals = [...FINAL_TRANSMISSION_KINDS].map(k => `'${k}'`).join(',')
  const readings = Object.values(VOICE_READINGS).filter(r => !!r && (branches === 'all' || branches.includes(r.branch)))
  let total = 0
  for (const reading of readings) {
    if (!reading || !VIEW.test(reading.transmissionView)) throw new Error(`View de tentativas inválida: ${reading?.transmissionView}`)
    let rows: unknown
    try {
      ;[rows] = await q.query(
        `SELECT COUNT(*) AS n FROM ${reading.transmissionView} t
          WHERE t.tb_institution_id = ? AND (? IS NULL OR t.environment = ?)
            AND (t.last_kind IS NULL OR t.last_kind NOT IN (${finals}))`,
        [institutionId, opts.environment ?? null, opts.environment ?? null])
    } catch (err) {
      if (isNoSuchTable(err) && !(await familyInstalled(q, reading.transmissionView))) continue   // D-NE76
      throw err
    }
    total += Number((rows as any[])?.[0]?.n ?? 0)
  }
  return total
}

function assertDomain(model: IssuerModel): IssuerModel {
  if (!isIssuerModel(model)) throw new Error(`Modelo fora do domínio da habilitação: ${String(model)}`)
  return model
}

/** O emissor visto por UMA família: as habilitações dos modelos DELA + a situação do A1 (comum). */
export async function emitterView(deps: EmitterDeps, institutionId: number, branch: InvoiceBranch): Promise<EmitterView> {
  const mine = modelsOf(branch)
  const rows = (await listIssuers(deps.pool, institutionId)).filter(r => mine.includes(r.model))
  const certificate = await certificateStatus(deps.pool, institutionId)
  return {
    // D-F39: `cutoverAt` null = RÉPLICA do ERP (a API só lê); habilitada = virada + A1 vigente
    issuers: rows.map(r => ({ model: r.model, environment: r.environment, serie: r.serie, cutoverAt: r.cutoverAt,
      enabled: !!r.cutoverAt && isIssuerEnabled(certificate), authority: authorityOf(r.model) })),
    certificate,
  }
}

/**
 * Cria/altera a habilitação de [model] (ambiente + série). Trocar o AMBIENTE com transmissão viva da FAMÍLIA do modelo no ambiente
 * atual → 409 (D-I26/D-I27 espelhadas). A cerca é a 1ª instrução (trava por linha + réplica/lacuna do MODELO — D-NE10).
 */
export async function writeIssuer(
  deps: EmitterDeps, actor: EmitterActor, model: IssuerModel, input: { environment: IssuerEnvironment; serie: string | null },
): Promise<void> {
  assertDomain(model)
  await withTransaction(deps.pool, 'habilitação do emissor', { institutionId: actor.institutionId, model }, async conn => {
    // D-F39: a CERCA é a 1ª instrução (trava por linha + réplica/lacuna) — antes de qualquer outra leitura; com a linha do
    // modelo travada ANTES dela, dois modelos vivos (SE + 55 da nfe-api) se cruzariam (gates do delta de 2026-10-04)
    await assertIssuerWritable(conn, actor.schemaName, actor.institutionId, model)
    const current = await getIssuer(conn, actor.institutionId, model, true)
    if (current && current.environment !== input.environment) {
      const live = await countLiveTransmissions(conn, actor.institutionId, { branches: [branchOf(model)], environment: current.environment })
      if (live > 0) {
        throw new HttpError(409, `Emissor tem ${live} transmissão(ões) viva(s) no ambiente ${current.environment === 'P' ? 'produção' : 'homologação'} — aguarde a voz do fisco antes de mudar o ambiente`,
          [{ field: 'environment', message: `${live} transmissão(ões) viva(s) em ${current.environment}` }], ErrorCodes.FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS)
      }
    }
    await upsertIssuer(conn, actor.schemaName, actor.institutionId, model, { environment: input.environment, serie: input.serie, userId: actor.userId })
  })
  logger.info('Habilitação do emissor fiscal salva', { institutionId: actor.institutionId, model, environment: input.environment, serie: input.serie })
}

/** Exclui a habilitação de [model] (o A1 fica). Com transmissão viva da FAMÍLIA do modelo (qualquer ambiente) → 409. */
export async function deleteIssuer(deps: EmitterDeps, actor: EmitterActor, model: IssuerModel): Promise<void> {
  assertDomain(model)
  await withTransaction(deps.pool, 'excluir habilitação do emissor', { institutionId: actor.institutionId, model }, async conn => {
    await assertIssuerWritable(conn, actor.schemaName, actor.institutionId, model)     // D-F39/D-NE10: a cerca é a 1ª instrução
    const current = await getIssuer(conn, actor.institutionId, model, true)
    if (!current) throw new HttpError(404, `Estabelecimento não tem habilitação do emissor para o modelo ${model}`, undefined, ErrorCodes.FISCAL_ISSUER_MISSING)
    const live = await countLiveTransmissions(conn, actor.institutionId, { branches: [branchOf(model)] })
    if (live > 0) {
      throw new HttpError(409, `Emissor tem ${live} transmissão(ões) viva(s) no fisco — aguarde a voz do fisco antes de excluir a habilitação`,
        undefined, ErrorCodes.FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS)
    }
    await softDeleteIssuer(conn, actor.schemaName, actor.institutionId, model)
  })
  logger.info('Habilitação do emissor fiscal excluída (A1 mantido)', { institutionId: actor.institutionId, model })
}

const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/

/**
 * Upload do A1 (D-N5) em base64. [expectedCnpj] = o CNPJ do estabelecimento que a BORDA da família leu no ERP (fonte de fatos —
 * `erp.establishmentCnpjFact` — três estados, D-CJ2; D-N29): o par do e-CNPJ tem de ser dele — ausente, inválido ou divergente, o
 * `storeCertificate` recusa (422/409), nunca grava.
 * Devolve a situação (nunca o conteúdo).
 */
export async function uploadCertificate(
  deps: EmitterDeps, actor: EmitterActor, input: { pfxBase64: string; password: string }, opts: { expectedCnpj: ExpectedCnpj },
): Promise<IssuerCertificateStatus> {
  if (!BASE64_RE.test(input.pfxBase64)) {
    throw new HttpError(400, 'Arquivo .pfx precisa vir em base64', [{ field: 'pfxBase64', message: 'base64 inválido' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  const pfx = Buffer.from(input.pfxBase64, 'base64')
  if (pfx.length === 0) throw new HttpError(400, 'Arquivo .pfx vazio', [{ field: 'pfxBase64', message: 'base64 inválido' }], ErrorCodes.FISCAL_CERT_INVALID)
  const status = await storeCertificate(deps, actor.institutionId, pfx, input.password,
    { expectedCnpj: opts.expectedCnpj, userId: actor.userId, schemaName: actor.schemaName })
  logger.info('Certificado A1 do emissor atualizado (cifrado no fiscal_api)', {
    institutionId: actor.institutionId, cnpj: status.certificateInfo?.cnpj ?? null, notAfter: status.certificateInfo?.notAfter ?? null,
  })
  return status
}

/**
 * Apaga o A1 (as habilitações ficam e deixam de estar habilitadas). Transação: a TRAVA das linhas da habilitação + a cerca do
 * ESTABELECIMENTO (1ª instrução — gates R4) → as vivas de TODAS as famílias (sem o A1 nenhuma reconciliação fecha) → apaga.
 * É o ÚNICO caminho que apaga o A1 (a guarda injetada pela família morreu — parte 2 da NE-1a: a família só conhecia as dela, e a
 * nfse-api apagaria o A1 com uma NF-e viva).
 */
export async function clearCertificate(
  deps: EmitterDeps, institutionId: number, userId: number | null, opts: { schemaName: string },
): Promise<IssuerCertificateStatus> {
  await withTransaction(deps.pool, 'apagar A1', { institutionId }, async conn => {
    await assertCertificateWritable(conn, opts.schemaName, institutionId)    // 1ª instrução: TRAVA a habilitação (gates R4)
    const live = await countLiveTransmissions(conn, institutionId, { branches: 'all' })
    if (live > 0) {
      throw new HttpError(409, `Emissor tem ${live} transmissão(ões) viva(s) no fisco — aguarde a voz do fisco antes de excluir o certificado`,
        undefined, ErrorCodes.FISCAL_ISSUER_HAS_LIVE_TRANSMISSIONS)
    }
    return eraseCertificate(conn, institutionId, userId)
  })
  return certificateStatus(deps.pool, institutionId)
}

/** DELETE do A1 pela borda (a composição + o registro). */
export async function deleteCertificate(deps: EmitterDeps, actor: EmitterActor): Promise<IssuerCertificateStatus> {
  const status = await clearCertificate(deps, actor.institutionId, actor.userId, { schemaName: actor.schemaName })
  logger.info('Certificado A1 do emissor removido', { institutionId: actor.institutionId })
  return status
}
