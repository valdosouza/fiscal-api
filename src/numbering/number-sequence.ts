import type { Pool } from 'mysql2/promise'
import type { Queryable } from '../db/tx'
import { assertCheckRefuses, CheckProbe, isCheckViolationOf } from '../db/check'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'
import { IssuerModel, modelsOf } from '../establishment/issuer-models'
import { getIssuer, IssuerEnvironment } from '../establishment/establishment.repository'

/**
 * O ÚLTIMO NÚMERO da NF-e/NFC-e — peça do núcleo (fiscal-api:FAMILIA.E5.P5; D-NE255, D-NE257, D-NE263 e D-NE265, Valdo 2026-11-23): o nNF
 * do 55 nasce na TRANSMISSÃO, na nfe-api, do último número guardado em `tb_fiscal_number_sequence` (migration 008 do núcleo) — uma linha
 * por estabelecimento × modelo × série × AMBIENTE. A D-NE257 troca a D-F21 no ponto do número (a série segue do ERP).
 *
 * LADO DE ESCRITA: só no barrel, FORA de `fiscal-api/reading` (o ERP web não gera número — é outro controle, paralelo à tabela de controle
 * de notas dele, D-NE255/D-NE258).
 *
 * TRAVAS — a ordem de quem chama (PADROES_BANCO §9): nota no ERP (`lockInvoice`) → linha da habilitação do modelo → A1 → linha da sequência.
 * A inutilização não tem nota: habilitação → A1 → sequência. Cada peça daqui RELÊ a habilitação do modelo com `FOR UPDATE` e só depois toca
 * a sequência. A habilitação é travada por UMA linha, pela PK inteira (trava de registro — regra 8). É ela que SERIALIZA tudo: gerar,
 * travar para a inutilização e abrir, de TODAS as séries do mesmo estabelecimento × modelo, esperam umas pelas outras na linha da
 * habilitação; a trava na linha da sequência é o cinto (segura quem escrever nela sem passar por aqui).
 * LINHA AUSENTE nunca é LIDA com trava (seria trava de INTERVALO, que faz estabelecimentos vizinhos esperarem ou fecharem deadlock — regras
 * 12 e 13): a 1ª geração em H é um upsert, a abertura em P é um INSERT que decide pelo 1062, e `lockNumberSequence` só trava a linha que existe.
 * Um caso sobra: o `UPDATE` da geração em PRODUÇÃO sobre a sequência NÃO aberta deixa trava de intervalo até o fim da transação que recebeu
 * o 409 — por isso o item 4 do contrato.
 *
 * CONTRATO DE QUEM CHAMA (a reserva da família — a nfe-api):
 *  1. Chamar DENTRO da própria transação, e travar a habilitação ANTES do A1 (`openIssuer` com `forUpdate`) — a releitura daqui cai na
 *     mesma linha já travada e não inverte a ordem. NENHUMA leitura comum (sem trava), de tabela ALGUMA, antes de travar a habilitação:
 *     o retrato do REPEATABLE READ é da transação inteira e nasceria velho (regras 2 e 13). Com retrato velho as peças falham FECHADO —
 *     `lockNumberSequence` devolve `null` para uma linha que nasceu depois dele (recusa uma inutilização legítima; nunca libera número) —
 *     mas falham caladas.
 *  2. Deadlock (1213) e espera esgotada (1205) sobem CRUS, como o banco os dá: quem chama repete a transação inteira ou devolve 409 de
 *     "tente de novo" — nunca reaproveita um número lido antes do erro.
 *  3. O número só existe depois do COMMIT de quem chama; transação desfeita devolve o número à sequência (ninguém o viu).
 *  4. Recebeu o 409 `FISCAL_NUMBER_SEQUENCE_NOT_OPEN`: DESFAZER a transação logo, sem mais nada nela (em especial, nunca abrir a sequência
 *     na mesma transação) — a trava de intervalo do `UPDATE` que não achou linha segura a abertura e a 1ª geração dos vizinhos enquanto ela viver.
 *
 * O AMBIENTE nunca vem de quem chama: sai da habilitação lida sob a trava (uma fonte só). Réplica do ERP (`cutover_at` NULL) nunca gera
 * número (D-F39, molde `nextDpsNumber`).
 */

/** A tabela do último número (migration 008 do núcleo). */
export const NUMBER_SEQUENCE_TABLE = 'tb_fiscal_number_sequence'

/** Modelos com numeração NOSSA (ramo de mercadoria — 55/65); a NFS-e tem o nDPS na habilitação. */
export const NUMBER_SEQUENCE_MODELS: readonly IssuerModel[] = modelsOf('merchandise')

/** O teto do `nNF` (RF-NFE-44 — `TNF` do PL_010f: de 1 a 999.999.999). */
export const MAX_INVOICE_NUMBER = 999_999_999

/** O eixo que quem chama informa — o AMBIENTE sai da habilitação. */
export interface NumberSequenceScope {
  readonly institutionId: number
  readonly model:         IssuerModel
  readonly serie:         number
}

export interface GeneratedInvoiceNumber {
  readonly number:      number
  /** O ambiente da habilitação sob a trava — o da sequência que gerou o número. */
  readonly environment: IssuerEnvironment
}

export interface LockedNumberSequence {
  readonly environment: IssuerEnvironment
  /**
   * O valor de `last_number` do ambiente vigente; `null` = a linha não existe (nada gerado em homologação; produção não aberta).
   * NÃO é sempre "um número já gerado": a sequência de produção aberta com o número inicial N guarda N − 1 antes da 1ª nota (0 quando
   * N = 1). `null` e 0 querem dizer "nada a inutilizar"; se N − 1 libera inutilizar números anteriores ao sistema é decisão da família.
   */
  readonly lastNumber:  number | null
}

const WHERE_AXIS = 'tb_institution_id = ? AND model = ? AND serie = ? AND environment = ?'

function assertScope(scope: NumberSequenceScope): NumberSequenceScope {
  const intIn = (v: unknown, what: string, min: number, max: number): void => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`Último número da NF-e: ${what} inválido (${JSON.stringify(v)} — inteiro entre ${min} e ${max})`)
  }
  intIn(scope?.institutionId, 'estabelecimento', 1, 2_147_483_647)
  if (!NUMBER_SEQUENCE_MODELS.includes(scope?.model)) throw new Error(`Último número da NF-e: modelo fora da numeração NOSSA (${JSON.stringify(scope?.model)} — ${NUMBER_SEQUENCE_MODELS.join('/')})`)
  intIn(scope?.serie, 'série', 0, 999)                                    // RF-NFE-44 — `TSerie`
  return scope
}

/** A habilitação do modelo, TRAVADA: viva e virada — senão ninguém gera, trava nem abre número por ela. */
async function lockedEnvironment(conn: Queryable, scope: NumberSequenceScope): Promise<IssuerEnvironment> {
  const issuer = await getIssuer(conn, scope.institutionId, scope.model, true)
  if (!issuer) throw new Error(`Último número da NF-e: estabelecimento ${scope.institutionId} sem habilitação viva do modelo ${scope.model}`)
  if (issuer.cutoverAt == null) {
    throw new HttpError(409, 'A emissão fiscal deste estabelecimento ainda é do ERP (réplica) — nenhum número de NF-e é gerado aqui até a virada',
      undefined, ErrorCodes.FISCAL_CUTOVER_PENDING)
  }
  return issuer.environment
}

const axis = (scope: NumberSequenceScope, environment: IssuerEnvironment) => [scope.institutionId, scope.model, scope.serie, environment]
const describeAxis = (scope: NumberSequenceScope, environment: IssuerEnvironment) => `${scope.institutionId}/${scope.model}/série ${scope.serie}/${environment}`

/** A linha do eixo como está (`null` = não existe); linha excluída falha ALTO — o contador não se exclui e nunca "recomeça". */
async function readRow(conn: Queryable, scope: NumberSequenceScope, environment: IssuerEnvironment, forUpdate: boolean): Promise<number | null> {
  const [rows] = await conn.query(
    `SELECT last_number AS n, deleted AS d FROM tb_fiscal_number_sequence WHERE ${WHERE_AXIS}${forUpdate ? ' FOR UPDATE' : ''}`, axis(scope, environment))
  if (!Array.isArray(rows)) throw new Error('Último número da NF-e: o driver não devolveu linhas')
  if (!rows.length) return null
  if (rows[0].d !== 'N') throw new Error(`Último número da NF-e: a sequência ${describeAxis(scope, environment)} está marcada como excluída — corrija no banco antes de gerar (o contador nunca recomeça)`)
  const n = Number(rows[0].n)
  if (!Number.isInteger(n) || n < 0 || n > MAX_INVOICE_NUMBER) throw new Error(`Último número da NF-e: valor torto na sequência ${describeAxis(scope, environment)} (${JSON.stringify(rows[0].n)})`)
  return n
}

/**
 * O PRÓXIMO número do eixo (D-NE257) — dentro da transação de quem chama (a reserva da transmissão). Em HOMOLOGAÇÃO a linha nasce sozinha
 * na 1ª geração, num comando só (o primeiro número é o 1 — D-NE243); em PRODUÇÃO a linha só nasce por `openNumberSequence` (D-NE265): sem
 * ela, 409 e nada gravado. O número nunca volta: rejeição e nota cancelada não o devolvem (o reuso do número de uma nota rejeitada é da
 * reserva da família, que guarda o número na tentativa).
 */
export async function nextInvoiceNumber(conn: Queryable, scope: NumberSequenceScope): Promise<GeneratedInvoiceNumber> {
  assertScope(scope)
  const environment = await lockedEnvironment(conn, scope)
  try {
    if (environment === 'H') {
      // linha excluída não avança (o IF) — a leitura de volta, travante, a recusa
      await conn.query(
        `INSERT INTO tb_fiscal_number_sequence (tb_institution_id, model, serie, environment, last_number, created_at, updated_at, deleted)
         VALUES (?, ?, ?, ?, 1, NOW(), NOW(), 'N')
         ON DUPLICATE KEY UPDATE updated_at = IF(deleted = 'N', NOW(), updated_at), last_number = IF(deleted = 'N', last_number + 1, last_number)`,
        axis(scope, environment))
    } else {
      const [r] = await conn.query(
        `UPDATE tb_fiscal_number_sequence SET last_number = last_number + 1, updated_at = NOW() WHERE ${WHERE_AXIS} AND deleted = 'N'`, axis(scope, environment))
      if (Number(r?.affectedRows ?? 0) === 0) {
        // linha excluída falha ALTO aqui (leitura comum: um retrato velho só troca a mensagem — 409 no lugar de "excluída" —, falha fechado
        // nos dois casos e nada foi gravado). O `UPDATE` acima JÁ deixou trava de intervalo se a linha não existe: quem chama desfaz a
        // transação logo (item 4 do contrato)
        await readRow(conn, scope, environment, false)
        throw new HttpError(409, `A numeração de produção da NF-e (modelo ${scope.model}, série ${scope.serie}) ainda não foi aberta — informe o número inicial antes de transmitir em produção`,
          undefined, ErrorCodes.FISCAL_NUMBER_SEQUENCE_NOT_OPEN)
      }
    }
  } catch (err) {
    if (isCheckViolationOf(err, 'ck_fiscal_number_sequence_last_number')) {
      throw new Error(`Último número da NF-e: numeração esgotada na sequência ${describeAxis(scope, environment)} (o nNF vai até ${MAX_INVOICE_NUMBER})`)
    }
    throw err
  }
  // leitura de volta TRAVANTE (leitura corrente, não a do retrato): a linha existe e, tendo avançado, já é nossa. Com a leitura comum, uma
  // linha marcada excluída DEPOIS do retrato desta transação faria o `IF` não avançar e a leitura devolver o número antigo como "gerado"
  const number = await readRow(conn, scope, environment, true)
  if (number == null || number < 1) throw new Error(`Último número da NF-e: a sequência ${describeAxis(scope, environment)} não devolveu o número gerado`)
  return { number, environment }
}

/**
 * TRAVA e lê o último número do ambiente vigente (D-NE263) — para a reserva da INUTILIZAÇÃO, que só vale até ele: enquanto a transação de
 * quem chama estiver aberta, nenhuma geração deste estabelecimento × modelo anda (espera na habilitação; a linha, quando existe, também
 * fica travada). Linha AUSENTE não é travada (seria trava de intervalo): devolve `null`, e nada nasce enquanto a habilitação estiver presa.
 */
export async function lockNumberSequence(conn: Queryable, scope: NumberSequenceScope): Promise<LockedNumberSequence> {
  assertScope(scope)
  const environment = await lockedEnvironment(conn, scope)
  // 1º a leitura comum, só para saber se a linha EXISTE; existindo, a leitura travante (corrente) é a que vale
  if (await readRow(conn, scope, environment, false) == null) return { environment, lastNumber: null }
  return { environment, lastNumber: await readRow(conn, scope, environment, true) }
}

/**
 * ABRE a sequência de PRODUÇÃO com o número inicial (D-NE265) — sem tela nem rota neste passo; quem informa o número e quando é da virada
 * (D-NE243). Exige a habilitação viva e virada, e NÃO exige que ela já esteja em produção (dá para abrir antes de virar o ambiente). Grava
 * `firstNumber - 1` como último: a 1ª geração devolve `firstNumber`. Sequência que já existe = 409, nada muda.
 */
export async function openNumberSequence(conn: Queryable, scope: NumberSequenceScope, firstNumber: number, userId: number | null): Promise<void> {
  assertScope(scope)
  if (typeof firstNumber !== 'number' || !Number.isInteger(firstNumber) || firstNumber < 1 || firstNumber > MAX_INVOICE_NUMBER) {
    throw new Error(`Último número da NF-e: número inicial inválido (${JSON.stringify(firstNumber)} — inteiro entre 1 e ${MAX_INVOICE_NUMBER})`)
  }
  if (userId !== null && (typeof userId !== 'number' || !Number.isInteger(userId) || userId < 1)) {
    throw new Error(`Último número da NF-e: usuário inválido (${JSON.stringify(userId)})`)
  }
  await lockedEnvironment(conn, scope)
  const alreadyOpen = () => new HttpError(409, `A numeração de produção da NF-e (modelo ${scope.model}, série ${scope.serie}) já está aberta — o número inicial não muda`,
    undefined, ErrorCodes.FISCAL_NUMBER_SEQUENCE_ALREADY_OPEN)
  try {
    // INSERT direto: a chave decide (1062). Ler a linha AUSENTE com trava antes daqui seria trava de intervalo, e duas aberturas de
    // estabelecimentos vizinhos fechariam deadlock (regra 13)
    await conn.query(
      `INSERT INTO tb_fiscal_number_sequence (tb_institution_id, model, serie, environment, last_number, tb_user_id, created_at, updated_at, deleted)
       VALUES (?, ?, ?, 'P', ?, ?, NOW(), NOW(), 'N')`,
      [scope.institutionId, scope.model, scope.serie, firstNumber - 1, userId])
  } catch (err: any) {
    if (err?.errno !== 1062) throw err
    // excluída falha ALTO. Leitura COMUM: o INSERT recusado deixou trava compartilhada na linha, e um `FOR UPDATE` agora a PROMOVERIA
    // (regra 8 — deadlock com quem estiver na fila da linha). Retrato velho que não a veja cai no 409, que é a verdade (a chave existe)
    await readRow(conn, scope, 'P', false)
    throw alreadyOpen()
  }
}

/**
 * Boot de quem gera número (a nfe-api): os cinco domínios da tabela são FATO do banco e o MOTOR os aplica — cada sonda, numa transação
 * SEMPRE desfeita, tem de ser recusada pelo CHECK de NOME certo (molde `assertIssuerModelDomainEnforced`, D-F45). Cada sonda tem PK própria
 * e todo o resto válido (um motor sem CHECK não colide a 2ª na 1ª — F2A1-07).
 */
export async function assertNumberSequenceDomainsEnforced(pool: Pick<Pool, 'getConnection'>): Promise<void> {
  const probe = (value: string, constraint: string, row: { model?: string; serie?: number; environment?: string; lastNumber?: number; deleted?: string }, serie: number): CheckProbe => ({
    value, constraint,
    params: [row.model ?? '55', row.serie ?? serie, row.environment ?? 'H', row.lastNumber ?? 0, row.deleted ?? 'N'],
    sql: `INSERT INTO tb_fiscal_number_sequence (tb_institution_id, model, serie, environment, last_number, deleted) VALUES (0, ?, ?, ?, ?, ?)`,
  })
  await assertCheckRefuses(pool, 'o domínio do último número da NF-e', [
    probe('modelo SE', 'ck_fiscal_number_sequence_model_bin', { model: 'SE' }, 1),
    probe('modelo 5', 'ck_fiscal_number_sequence_model_bin', { model: '5' }, 2),
    probe('ambiente h', 'ck_fiscal_number_sequence_environment_bin', { environment: 'h' }, 3),
    probe('série 1000', 'ck_fiscal_number_sequence_serie', { serie: 1000 }, 4),
    probe('número 1000000000', 'ck_fiscal_number_sequence_last_number', { lastNumber: 1_000_000_000 }, 5),
    probe('deleted s', 'ck_fiscal_number_sequence_deleted_bin', { deleted: 's' }, 6),
  ])
}
