/// <reference types="jest" />
// FAMILIA.E5.P7 — banco FALSO da conta de e-mail (`tb_establishment_smtp_credential`): entende SÓ as consultas do repositório
// (`smtp-credential.repository.ts`), interpretadas em memória. A prova no MOTOR (CHECKs, upsert, rotação) está nas suítes ao vivo.
// Guarda TUDO o que chegou ao "driver" (`sqls`, `params`) para os testes provarem que a senha em claro nunca chega lá.

export interface SmtpFakeRow {
  host: string; port: number; security: string; username: string; senderAddress: string
  cipher: Buffer | null; iv: Buffer | null; tag: Buffer | null; version: number | null
  userId: number | null; deleted: 'N' | 'S'; updatedAt: string
}

export function smtpFakeDb(opts: { failWith?: unknown; failOnLock?: (id: number) => unknown } = {}) {
  const rows = new Map<number, SmtpFakeRow>()
  const sqls: string[] = []
  const params: unknown[][] = []
  const viaConn: string[] = []
  const live = () => [...rows.entries()].filter(([, r]) => r.deleted === 'N' && r.version != null)
  const query = jest.fn(async (sql: string, p: any[] = []): Promise<[any, any]> => {
    sqls.push(sql)
    params.push(p)
    if (!/tb_establishment_smtp_credential/.test(sql)) throw new Error(`SQL inesperado no falso da conta de e-mail: ${sql}`)
    if (opts.failWith) throw opts.failWith
    if (/^\s*INSERT INTO tb_establishment_smtp_credential/.test(sql)) {
      const [id, host, port, security, username, senderAddress, cipher, iv, tag, version, userId] = p
      rows.set(id, { host, port, security, username, senderAddress, cipher, iv, tag, version, userId, deleted: 'N', updatedAt: '2026-11-25 12:00:00' })
      return [{ affectedRows: 1 }, []]
    }
    if (/SET password_cipher = NULL/.test(sql)) {                       // eraseSmtpCredential
      const [userId, id] = p
      const r = rows.get(id)
      if (!r || r.deleted !== 'N') return [{ affectedRows: 0 }, []]
      Object.assign(r, { cipher: null, iv: null, tag: null, version: null, userId, deleted: 'S' })
      return [{ affectedRows: 1 }, []]
    }
    if (/SET password_cipher = \?/.test(sql)) {                         // rewrapSmtpCredentialPassword
      const [cipher, iv, tag, version, id, from] = p
      const r = rows.get(id)
      if (!r || r.deleted !== 'N' || r.version !== from) return [{ affectedRows: 0 }, []]
      Object.assign(r, { cipher, iv, tag, version })
      return [{ affectedRows: 1 }, []]
    }
    if (/ROW_NUMBER\(\) OVER \(PARTITION BY cipher_key_version ORDER BY tb_institution_id\)/.test(sql)) {
      const seen = new Map<number, number>()
      return [live().sort((a, b) => a[1].version! - b[1].version! || a[0] - b[0])
        .filter(([, r]) => { const n = (seen.get(r.version!) ?? 0) + 1; seen.set(r.version!, n); return n <= p[0] })
        .map(([id, r]) => ({ v: r.version, id, cipher: r.cipher, iv: r.iv, tag: r.tag })), []]
    }
    if (/SELECT DISTINCT cipher_key_version AS v/.test(sql)) {
      return [[...new Set(live().map(([, r]) => r.version))].map(v => ({ v })), []]
    }
    if (/SELECT tb_institution_id AS id FROM tb_establishment_smtp_credential/.test(sql)) {
      return [live().filter(([, r]) => r.version !== p[0]).sort((a, b) => a[0] - b[0]).map(([id]) => ({ id })), []]
    }
    if (/SELECT password_cipher AS cipher, password_iv AS iv, password_tag AS tag, cipher_key_version AS version/.test(sql)) {  // a cifra, para a rotação
      if (/FOR UPDATE/.test(sql)) { const e = opts.failOnLock?.(p[0]); if (e) throw e }
      const r = rows.get(p[0])
      return [r && r.deleted === 'N' ? [{ cipher: r.cipher, iv: r.iv, tag: r.tag, version: r.version }] : [], []]
    }
    if (/SELECT tb_institution_id AS institutionId, host, port/.test(sql)) {   // getSmtpCredential
      if (/FOR UPDATE/.test(sql)) { const e = opts.failOnLock?.(p[0]); if (e) throw e }
      const r = rows.get(p[0])
      return [r && r.deleted === 'N' ? [{
        institutionId: p[0], host: r.host, port: r.port, security: r.security, username: r.username, senderAddress: r.senderAddress,
        cipher: r.cipher, iv: r.iv, tag: r.tag, version: r.version, userId: r.userId, updatedAt: r.updatedAt,
      }] : [], []]
    }
    throw new Error(`SQL inesperado no falso da conta de e-mail: ${sql}`)
  })
  const connQuery = jest.fn(async (sql: string, p?: any[]) => { viaConn.push(sql); return query(sql, p) })
  const conn = { query: connQuery, beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
  const pool = { query, getConnection: jest.fn(async () => conn) } as any
  return { pool, conn, rows, sqls, params, viaConn, query }
}

/** Tudo o que chegou ao driver, achatado em bytes — para procurar a senha em claro (texto ou Buffer). */
export function driverBytes(db: { sqls: string[]; params: unknown[][] }): Buffer {
  const parts: Buffer[] = db.sqls.map(s => Buffer.from(s, 'utf8'))
  for (const list of db.params) {
    for (const v of list) parts.push(Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8'))
  }
  return Buffer.concat(parts)
}
