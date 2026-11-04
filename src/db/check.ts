import type { Pool, PoolConnection } from 'mysql2/promise'

/**
 * DOMÍNIO FECHADO = CHECK (D-F45; PADROES_BANCO §11) — e o boot PROVA que o MOTOR o aplica: grava, numa transação SEMPRE desfeita,
 * valores que o domínio RECUSA; cada um tem de ser recusado pelo CHECK ESPERADO (MariaDB 4025 / MySQL 3819, com o NOME da constraint na
 * mensagem). Por que mais de uma sonda: MySQL < 8.0.16 aceita o CHECK e o IGNORA em silêncio (valor fora do domínio passa), e um CHECK em
 * colação `_ci` aceita a MINÚSCULA de um valor válido — a sonda leva um valor fora do domínio E a minúscula de um válido (D-NE84 para o
 * `model`, D-F107 para o `kind` da NFS-e, D-F120 para `environment`/`source`; gate R21: `'ZZ'` sozinho não distingue o binário do `_ci`).
 * Outro erro (sem GRANT, FK, coluna, OUTRO CHECK) sobe como está — nunca vira "o motor aplica" (gates da A1 da F2a, F2A1-05: a violação
 * de um CHECK qualquer não prova o CHECK do domínio). Molde: `assertIssuerModelDomainEnforced` (D-F45), generalizado na F2a.
 *
 * CONHECIMENTO NEGATIVO (D-F122 = Q-F132 (a), Valdo 2026-10-12): o MariaDB deixa a SESSÃO desligar o CHECK (`SET SESSION
 * check_constraint_checks = 0`, sem privilégio extra — provado no 10.4.20) — nenhum código do workspace usa essa variável (cerca em
 * `f2a-a1.test.ts`); e `INSERT IGNORE … SELECT` REBAIXA a violação do CHECK a aviso (a linha some calada — F2A1-08): cópia que precisa do
 * domínio confere ANTES de inserir.
 */
export interface CheckProbe {
  /** O valor que o domínio recusa (aparece na mensagem — nunca dado de cliente). */
  readonly value:      string
  /** O NOME da constraint que tem de recusar este valor (a mensagem do motor o traz). */
  readonly constraint: string
  readonly sql:        string
  readonly params:     readonly unknown[]
}

/** MariaDB 4025 ER_CONSTRAINT_FAILED · MySQL 3819 ER_CHECK_CONSTRAINT_VIOLATED. */
export function isCheckViolation(err: any): boolean {
  return err?.errno === 4025 || err?.errno === 3819 || /CONSTRAINT/.test(String(err?.code ?? ''))
}

/** A violação é do CHECK [constraint] (o nome entre crases ou aspas na mensagem do motor — MariaDB `ck`, MySQL 'ck'). */
export function isCheckViolationOf(err: any, constraint: string): boolean {
  if (!isCheckViolation(err)) return false
  const msg = String(err?.sqlMessage ?? err?.message ?? '')
  return msg.includes(`\`${constraint}\``) || msg.includes(`'${constraint}'`) || msg.includes(`"${constraint}"`)
}

export async function assertCheckRefuses(
  pool: Pick<Pool, 'getConnection'>, what: string, probes: readonly CheckProbe[], opts: { withoutForeignKeys?: boolean } = {},
): Promise<void> {
  if (!probes.length) throw new Error('assertCheckRefuses: nenhuma sonda')
  const accepted: string[] = []
  await probeInTransaction(pool, opts, async conn => {
    for (const p of probes) {
      try {
        await conn.query(p.sql, [...p.params])
        accepted.push(p.value)
      } catch (err) {
        if (isCheckViolationOf(err, p.constraint)) continue
        if (isCheckViolation(err)) {
          // F2A1-05: a recusa veio de OUTRO CHECK (ex.: o _ci da migration anterior) — não prova o domínio; diagnóstico explícito
          throw new Error(`A sonda de ${what} ('${p.value}') foi recusada por OUTRO CHECK, não pelo ${p.constraint} — falta a migration que o cria, `
            + `ou outro CHECK interfere na sonda (${String((err as any)?.sqlMessage ?? (err as any)?.message ?? '').slice(0, 160)})`)
        }
        throw err
      }
    }
  })
  reportAccepted(what, probes, accepted)
}

/** MariaDB e MySQL 1406 ER_DATA_TOO_LONG — o texto maior que a coluna, recusado pela sessão ESTRITA (D-NE172). */
export function isDataTooLong(err: any): boolean {
  return err?.errno === 1406 || String(err?.code ?? '') === 'ER_DATA_TOO_LONG'
}

/** Uma sonda de COMPRIMENTO: o valor tem 1 posição a mais que a coluna e, cortado nela, seria VÁLIDO (passaria em todo CHECK). */
export interface LengthProbe {
  /** O que a sonda grava (aparece na mensagem — nunca dado de cliente). */
  readonly value:  string
  /** A coluna atacada (`tabela.coluna` — só para a mensagem). */
  readonly column: string
  readonly sql:    string
  readonly params: readonly unknown[]
}

/**
 * D-NE172 (Valdo 2026-10-31): o boot PROVA que a sessão do pool é ESTRITA gravando, numa transação SEMPRE desfeita, um texto 1 posição
 * maior que a coluna — o motor tem de RECUSAR com 1406. Sem o modo estrito ele TRUNCA calado (aviso 1265) e a linha cortada — válida —
 * passaria no CHECK: a sonda é montada para que o corte dê um valor que o domínio ACEITA (senão um CHECK a recusaria e a sonda não
 * provaria nada). Outro erro (sem GRANT, coluna, CHECK) sobe como está — nunca vira "a sessão é estrita". Mesma disciplina da conexão de
 * `assertCheckRefuses` (ROLLBACK que falha = conexão destruída; FK da sessão volta ao que era).
 */
export async function assertLengthRefused(
  pool: Pick<Pool, 'getConnection'>, what: string, probes: readonly LengthProbe[], opts: { withoutForeignKeys?: boolean } = {},
): Promise<void> {
  if (!probes.length) throw new Error('assertLengthRefused: nenhuma sonda')
  await probeInTransaction(pool, opts, async conn => {
    const accepted: string[] = []
    for (const p of probes) {
      try {
        await conn.query(p.sql, [...p.params])
        accepted.push(`${p.column} com ${p.value.length} posições`)
      } catch (err) {
        if (isDataTooLong(err)) continue
        throw err
      }
    }
    if (accepted.length) {
      throw new Error(`O banco ACEITOU ${what} maior que a coluna (${accepted.join(', ')}) — a sessão NÃO é estrita: o motor truncou calado `
        + `antes do CHECK (D-NE172 — o pool do núcleo soma STRICT_ALL_TABLES ao modo; algo o tirou, ou a conexão não veio do pool do núcleo)`)
    }
  })
}

/** A transação SEMPRE desfeita das sondas do boot (`assertCheckRefuses`/`assertLengthRefused`). */
async function probeInTransaction(
  pool: Pick<Pool, 'getConnection'>, opts: { withoutForeignKeys?: boolean }, body: (conn: PoolConnection) => Promise<void>,
): Promise<void> {
  const conn = await pool.getConnection()
  let previousForeignKeys: unknown = undefined
  let reusable = true
  try {
    await conn.beginTransaction()
    if (opts.withoutForeignKeys) {
      // a tabela filha só aceita a linha com a mãe — a sonda mira o CHECK/o comprimento, não a FK; a sessão VOLTA ao valor que tinha (BEGIN
      // que falha antes daqui não altera a sessão)
      const [rows] = await conn.query('SELECT @@SESSION.foreign_key_checks AS v')
      previousForeignKeys = (rows as any[])?.[0]?.v ?? 1
      await conn.query('SET SESSION foreign_key_checks = 0')
    }
    await body(conn)
  } finally {
    // ROLLBACK que falha com a conexão viva deixaria a transação aberta (o próximo BEGIN comitaria a sonda) — conexão DESTRUÍDA, nunca pool
    try { await conn.rollback() } catch { reusable = false }
    if (previousForeignKeys !== undefined) {
      try { await conn.query(`SET SESSION foreign_key_checks = ${Number(previousForeignKeys) ? 1 : 0}`) } catch { reusable = false }
    }
    if (reusable) conn.release()
    else (conn as PoolConnection & { destroy?: () => void }).destroy?.()
  }
}

function reportAccepted(what: string, probes: readonly CheckProbe[], accepted: readonly string[]): void {
  const constraints = probes.map(p => p.constraint).filter((c, i, all) => all.indexOf(c) === i).join(', ')
  if (accepted.length === probes.length) {
    throw new Error(`O banco ACEITOU ${what} fora do domínio (${accepted.join(', ')}) — o motor não aplica CHECK ou falta a migration que `
      + `cria ${constraints} (exige MariaDB ≥ 10.2 ou MySQL ≥ 8.0.16 com o CHECK ENFORCED; D-F45)`)
  }
  if (accepted.length) {
    throw new Error(`O banco ACEITOU ${what} fora do domínio (${accepted.join(', ')}) e recusou o resto — o CHECK existe mas NÃO é o `
      + `domínio publicado (colação não binária ou lista diferente — D-NE84/D-F107/D-F120): falta a migration que cria ${constraints}`)
  }
}
