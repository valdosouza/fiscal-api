/// <reference types="jest" />
// fiscal-api:FAMILIA.E5.P7.T2 — a CONTA DE ENVIO DE E-MAIL do estabelecimento (credencial SMTP do cliente — D-NE236): mora no núcleo, a senha
// cifrada como os demais segredos (D-F16), e o conteúdo dela nunca sai em leitura, log ou erro. Unitário com banco FALSO na fronteira
// (`smtp-credential-fake.ts`); a prova no MOTOR (CHECKs da 009, upsert, rotação) está em `motor-banco.live.test.ts` e
// `rotacao-chave-mestra.live.test.ts`. Ficha: projetos/fiscal-api/GERAL/ficha-familia-e5-p7-credencial-smtp.md.
// A senha de teste é GERADA a cada execução (nunca um valor versionado).
import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import { MasterKeyRing } from '../secret/cipher'
import { HttpError } from '../errors/http-error'
import { ErrorCodes, ErrorCatalog } from '../errors/error-codes'
import {
  SMTP_PASSWORD_MAX_BYTES, SmtpCredentialInput, assertSmtpCredentialDomainsEnforced, clearSmtpCredential, openSmtpCredential,
  smtpCredentialAad, smtpCredentialStatus, storeSmtpCredential,
} from '../smtp-credential/smtp-credential'
import { getSmtpCredential } from '../smtp-credential/smtp-credential.repository'
import * as barrel from '../index'
import { stripComments } from './fence'
import { driverBytes, smtpFakeDb } from './smtp-credential-fake'

const PASSWORD = `senha-de-teste-${randomBytes(18).toString('base64')}`   // gerada na hora
const RING = MasterKeyRing.of({ 1: randomBytes(32) })
const input = (over: Partial<SmtpCredentialInput> = {}): SmtpCredentialInput => ({
  host: 'smtp.exemplo.invalid', port: 587, security: 'starttls', username: 'nota@exemplo.invalid',
  senderAddress: 'nota@exemplo.invalid', password: PASSWORD, userId: 7, ...over,
})
const SQL_009 = fs.readFileSync(path.resolve(__dirname, '..', 'migrations', 'sql', '009_establishment_smtp_credential.sql'), 'utf8')
const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '..', ...p), 'utf8')

async function failure(fn: () => Promise<unknown>): Promise<any> {
  try { await fn() } catch (err) { return err }
  throw new Error('era para ter falhado')
}
/** Tudo o que um erro carrega (mensagem, campos, propriedades próprias) em texto — para procurar a senha. */
const errorText = (err: any) => [String(err?.message), JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}))].join('\n')

describe('FAMILIA.E5.P7 — migration 009', () => {
  const ddl = stripSqlComments(SQL_009)
  function stripSqlComments(sql: string) { return sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n') }

  it('uma tabela, re-executável, com a PK no estabelecimento e sem semente', () => {
    expect(ddl.match(/CREATE TABLE/g)).toHaveLength(1)
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS `tb_establishment_smtp_credential`/)
    expect(ddl).toMatch(/PRIMARY KEY \(`tb_institution_id`\)/)
    expect(ddl).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/)
    expect(ddl).not.toMatch(/UNIQUE|AUTO_INCREMENT|FOREIGN KEY/)
  })
  it('os quatro CHECKs de nome próprio: segurança e deleted BINÁRIOS, porta e presença do segredo', () => {
    expect(ddl).toMatch(/CONSTRAINT `ck_establishment_smtp_credential_security_bin` CHECK \(`security` COLLATE utf8mb4_bin IN \('tls', 'starttls'\)\)/)
    expect(ddl).toMatch(/CONSTRAINT `ck_establishment_smtp_credential_deleted_bin` CHECK \(`deleted` COLLATE utf8mb4_bin IN \('N', 'S'\)\)/)
    expect(ddl).toMatch(/CONSTRAINT `ck_establishment_smtp_credential_port` CHECK \(`port` BETWEEN 1 AND 65535\)/)
    expect(ddl).toMatch(/CONSTRAINT `ck_establishment_smtp_credential_secret_presence` CHECK/)
    expect(ddl.match(/CONSTRAINT `ck_/g)).toHaveLength(4)
  })
  it('a senha só existe como cifra: nenhuma coluna de senha em texto, e não é a exceção de texto puro da 006', () => {
    const columns = [...ddl.matchAll(/^\s+`([a-z_0-9]+)`\s+([A-Z]+)/gm)].map(m => [m[1], m[2]])
    expect(columns.map(c => c[0])).toEqual([
      'tb_institution_id', 'host', 'port', 'security', 'username', 'sender_address',
      'password_cipher', 'password_iv', 'password_tag', 'cipher_key_version', 'tb_user_id', 'created_at', 'updated_at', 'deleted',
    ])
    for (const [name, type] of columns.filter(c => /pass|secret|senha/.test(c[0]))) expect([name, type]).toEqual([name, 'VARBINARY'])
    expect(SQL_009).not.toMatch(/EXCEÇÃO NOMEADA/)
    expect(SQL_009).toMatch(/SEGREDO SÓ CIFRADO \(D-F16/)
  })
})

describe('FAMILIA.E5.P7.T2 — gravar, situação, abrir e apagar', () => {
  it('grava cifrado com a AAD da linha; nada do que chega ao driver contém a senha; o retorno é a situação, sem a senha', async () => {
    const db = smtpFakeDb()
    const status = await storeSmtpCredential({ pool: db.pool, keyring: RING }, 12, input())
    expect(status).toEqual({
      configured: true, host: 'smtp.exemplo.invalid', port: 587, security: 'starttls', username: 'nota@exemplo.invalid',
      senderAddress: 'nota@exemplo.invalid', updatedAt: '2026-11-25T12:00:00.000Z',
    })
    expect(JSON.stringify(status)).not.toContain(PASSWORD)
    expect(driverBytes(db).includes(Buffer.from(PASSWORD, 'utf8'))).toBe(false)
    const row = db.rows.get(12)!
    expect([row.version, row.iv!.length, row.tag!.length, row.cipher!.length]).toEqual([1, 12, 16, Buffer.byteLength(PASSWORD)])
    expect(RING.open({ cipher: row.cipher!, iv: row.iv!, tag: row.tag!, version: 1 }, smtpCredentialAad(12)).toString('utf8')).toBe(PASSWORD)
    expect(smtpCredentialAad(12)).toBe('tb_establishment_smtp_credential:12')
  })

  it('a situação nunca traz a senha nem a cifra; sem conta = não configurada', async () => {
    const db = smtpFakeDb()
    expect(await smtpCredentialStatus(db.pool, 12)).toEqual({
      configured: false, host: null, port: null, security: null, username: null, senderAddress: null, updatedAt: null,
    })
    await storeSmtpCredential({ pool: db.pool, keyring: RING }, 12, input())
    const status = await smtpCredentialStatus(db.pool, 12)
    expect(Object.keys(status).sort()).toEqual(['configured', 'host', 'port', 'security', 'senderAddress', 'updatedAt', 'username'])
    expect(JSON.stringify(status)).not.toMatch(/password|cipher|sealed/i)
  })

  it('abrir devolve a senha para UM envio, com os dados do transporte', async () => {
    const db = smtpFakeDb()
    await storeSmtpCredential({ pool: db.pool, keyring: RING }, 12, input({ security: 'tls', port: 465 }))
    expect(await openSmtpCredential({ pool: db.pool, keyring: RING }, 12)).toEqual({
      host: 'smtp.exemplo.invalid', port: 465, security: 'tls', username: 'nota@exemplo.invalid',
      senderAddress: 'nota@exemplo.invalid', password: PASSWORD,
    })
  })

  it('abrir pela conexão da transação de quem chama usa ESSA conexão', async () => {
    const db = smtpFakeDb()
    await storeSmtpCredential({ pool: db.pool, keyring: RING }, 12, input())
    await openSmtpCredential({ pool: db.pool, keyring: RING }, 12, { conn: db.conn as any })
    expect(db.viaConn).toHaveLength(1)
  })

  it('sem conta → 409 SMTP_CREDENTIAL_MISSING; conta apagada também', async () => {
    const db = smtpFakeDb()
    const deps = { pool: db.pool, keyring: RING }
    const missing = await failure(() => openSmtpCredential(deps, 12))
    expect([missing instanceof HttpError, missing.statusCode, missing.code]).toEqual([true, 409, ErrorCodes.SMTP_CREDENTIAL_MISSING])
    await storeSmtpCredential(deps, 12, input())
    expect(await clearSmtpCredential(deps, 12, 9)).toBe(true)
    expect((await failure(() => openSmtpCredential(deps, 12))).code).toBe(ErrorCodes.SMTP_CREDENTIAL_MISSING)
  })

  it('a cifra copiada para a linha de OUTRO estabelecimento não abre → 409 SMTP_CREDENTIAL_UNREADABLE, sem a senha no erro', async () => {
    const db = smtpFakeDb()
    const deps = { pool: db.pool, keyring: RING }
    await storeSmtpCredential(deps, 12, input())
    db.rows.set(13, { ...db.rows.get(12)! })                                 // cópia por SQL entre clientes
    const err = await failure(() => openSmtpCredential(deps, 13))
    expect([err.statusCode, err.code]).toEqual([409, ErrorCodes.SMTP_CREDENTIAL_UNREADABLE])
    expect(errorText(err)).not.toContain(PASSWORD)
    expect((await openSmtpCredential(deps, 12)).password).toBe(PASSWORD)     // a dona continua abrindo
  })

  it('cifra adulterada ou chave-mestra ERRADA com a mesma versão → SMTP_CREDENTIAL_UNREADABLE', async () => {
    const db = smtpFakeDb()
    await storeSmtpCredential({ pool: db.pool, keyring: RING }, 12, input())
    const wrong = MasterKeyRing.of({ 1: randomBytes(32) })
    expect((await failure(() => openSmtpCredential({ pool: db.pool, keyring: wrong }, 12))).code).toBe(ErrorCodes.SMTP_CREDENTIAL_UNREADABLE)
    const row = db.rows.get(12)!
    row.cipher = Buffer.from(row.cipher!); row.cipher[0] ^= 0xff
    expect((await failure(() => openSmtpCredential({ pool: db.pool, keyring: RING }, 12))).code).toBe(ErrorCodes.SMTP_CREDENTIAL_UNREADABLE)
  })

  it('a cifra do A1 (outra tabela do cofre) não abre como senha: a AAD leva o nome da tabela', async () => {
    const db = smtpFakeDb()
    await storeSmtpCredential({ pool: db.pool, keyring: RING }, 12, input())
    const asCertificate = RING.seal(PASSWORD, 'tb_establishment_certificate:12')
    Object.assign(db.rows.get(12)!, { cipher: asCertificate.cipher, iv: asCertificate.iv, tag: asCertificate.tag })
    expect((await failure(() => openSmtpCredential({ pool: db.pool, keyring: RING }, 12))).code).toBe(ErrorCodes.SMTP_CREDENTIAL_UNREADABLE)
  })

  it('chave-mestra ausente → 503 do cofre: ao gravar nada chega ao banco; ao abrir, o erro é o do cofre', async () => {
    const db = smtpFakeDb()
    const none = MasterKeyRing.of({})
    const onStore = await failure(() => storeSmtpCredential({ pool: db.pool, keyring: none }, 12, input()))
    expect([onStore.statusCode, onStore.code]).toEqual([503, ErrorCodes.FISCAL_MASTER_KEY_UNAVAILABLE])
    expect(db.sqls).toHaveLength(0)
    await storeSmtpCredential({ pool: db.pool, keyring: RING }, 12, input())
    const other = MasterKeyRing.of({ 2: randomBytes(32) })                    // anel sem a versão 1 que cifrou
    const onOpen = await failure(() => openSmtpCredential({ pool: db.pool, keyring: other }, 12))
    expect([onOpen.statusCode, onOpen.code]).toEqual([503, ErrorCodes.FISCAL_MASTER_KEY_UNAVAILABLE])
  })

  it('gravar de novo TROCA a conta (uma por estabelecimento) e revive a apagada; apagar zera a cifra', async () => {
    const db = smtpFakeDb()
    const deps = { pool: db.pool, keyring: RING }
    await storeSmtpCredential(deps, 12, input())
    const other = `outra-${randomBytes(12).toString('hex')}`
    await storeSmtpCredential(deps, 12, input({ host: 'mail.exemplo.invalid', password: other }))
    expect(db.rows.size).toBe(1)
    expect(await openSmtpCredential(deps, 12)).toMatchObject({ host: 'mail.exemplo.invalid', password: other })
    expect(await clearSmtpCredential(deps, 12, null)).toBe(true)
    expect(db.rows.get(12)).toMatchObject({ cipher: null, iv: null, tag: null, version: null, deleted: 'S' })
    expect(await clearSmtpCredential(deps, 12, null)).toBe(false)             // apagar de novo não apaga
    expect(await getSmtpCredential(db.pool, 12)).toBeNull()
    await storeSmtpCredential(deps, 12, input())
    expect((await openSmtpCredential(deps, 12)).password).toBe(PASSWORD)
  })

  it('linha viva sem cifra (motor sem o CHECK) nunca vira conta "sem senha": a leitura devolve ausente', async () => {
    const db = smtpFakeDb()
    await storeSmtpCredential({ pool: db.pool, keyring: RING }, 12, input())
    Object.assign(db.rows.get(12)!, { cipher: null })
    db.query.mockImplementationOnce(async () => [[{
      institutionId: 12, host: 'h.invalid', port: 587, security: 'starttls', username: 'u', senderAddress: 'a@b.invalid',
      cipher: null, iv: Buffer.alloc(12), tag: Buffer.alloc(16), version: 1, userId: null, updatedAt: null,
    }], []])
    expect(await getSmtpCredential(db.pool, 12)).toBeNull()
  })
})

describe('FAMILIA.E5.P7.T2 — a forma ao gravar (422 SMTP_CREDENTIAL_INVALID pelo campo, sem a senha)', () => {
  const cases: Array<[string, Partial<SmtpCredentialInput>, string]> = [
    ['host vazio', { host: '' }, 'host'],
    ['host com espaço', { host: 'smtp exemplo.invalid' }, 'host'],
    ['host começando por hífen', { host: '-smtp.invalid' }, 'host'],
    ['host terminando por ponto', { host: 'smtp.invalid.' }, 'host'],
    ['host com barra (URL)', { host: 'smtp://x.invalid' }, 'host'],
    ['host com 256 caracteres', { host: `${'a'.repeat(250)}.inval` }, 'host'],
    ['host que não é texto', { host: 25 as any }, 'host'],
    ['porta 0', { port: 0 }, 'port'],
    ['porta 65536', { port: 65536 }, 'port'],
    ['porta fracionária', { port: 587.5 }, 'port'],
    ['porta em texto', { port: '587' as any }, 'port'],
    ['segurança em maiúscula', { security: 'TLS' as any }, 'security'],
    ['segurança "none"', { security: 'none' as any }, 'security'],
    ['usuário vazio', { username: '' }, 'username'],
    ['usuário com quebra de linha', { username: 'a\r\nb' }, 'username'],
    ['usuário com 256 caracteres', { username: 'u'.repeat(256) }, 'username'],
    ['usuário com U+202E (inverte o texto na tela)', { username: 'adm\u202Enimda' }, 'username'],
    ['usuário com U+2028 (separador de linha)', { username: 'a\u2028b' }, 'username'],
    ['usuário com surrogate solto (seria gravado trocado)', { username: 'a\uD800b' }, 'username'],
    ['remetente sem @', { senderAddress: 'nota.exemplo.invalid' }, 'senderAddress'],
    ['remetente com dois @', { senderAddress: 'a@b@c.invalid' }, 'senderAddress'],
    ['remetente com nome e <>', { senderAddress: 'Nota <a@b.invalid>' }, 'senderAddress'],
    ['remetente com quebra de linha (injeção de cabeçalho)', { senderAddress: 'a@b.invalid\r\nBcc: x@y.invalid' }, 'senderAddress'],
    ['remetente com acento', { senderAddress: 'josé@b.invalid' }, 'senderAddress'],
    ['senha vazia', { password: '' }, 'password'],
    ['senha que não é texto', { password: 123456 as any }, 'password'],
    ['senha maior que o limite', { password: 'x'.repeat(SMTP_PASSWORD_MAX_BYTES + 1) }, 'password'],
    ['senha com surrogate solto (seria gravada trocada)', { password: `ab\uD800cd` }, 'password'],
    ['senha com o caractere nulo (separador do AUTH PLAIN)', { password: 'ab\u0000cd' }, 'password'],
    ['autor zero', { userId: 0 }, 'userId'],
  ]
  it.each(cases)('%s → recusa pelo campo, nada chega ao banco', async (_name, over, field) => {
    const db = smtpFakeDb()
    const err = await failure(() => storeSmtpCredential({ pool: db.pool, keyring: RING }, 12, input(over)))
    expect([err instanceof HttpError, err.statusCode, err.code]).toEqual([true, 422, ErrorCodes.SMTP_CREDENTIAL_INVALID])
    expect(err.fields.map((f: any) => f.field)).toEqual([field])
    expect(db.sqls).toHaveLength(0)
  })

  it('a mensagem de forma inválida nunca traz a senha (nem quando a senha é o campo recusado)', async () => {
    const db = smtpFakeDb()
    const long = `${PASSWORD}${'z'.repeat(SMTP_PASSWORD_MAX_BYTES)}`
    const err = await failure(() => storeSmtpCredential({ pool: db.pool, keyring: RING }, 12, input({ password: long, host: '' })))
    expect(err.fields.map((f: any) => f.field)).toEqual(['host', 'password'])
    expect(errorText(err)).not.toContain(PASSWORD)
  })

  it('os limites aceitos: senha de 512 bytes com acento e símbolo, porta 1 e 65535, host por IP', async () => {
    const db = smtpFakeDb()
    const deps = { pool: db.pool, keyring: RING }
    const edge = `çã€${randomBytes(8).toString('hex')}`.padEnd(SMTP_PASSWORD_MAX_BYTES - 7 + 3, 'k')
    expect(Buffer.byteLength(edge)).toBe(SMTP_PASSWORD_MAX_BYTES)
    await storeSmtpCredential(deps, 1, input({ password: edge, port: 1, host: '10.0.0.5' }))
    await storeSmtpCredential(deps, 2, input({ port: 65535, userId: null }))
    expect((await openSmtpCredential(deps, 1)).password).toBe(edge)
    expect(db.rows.get(1)!.cipher!.length).toBeLessThanOrEqual(1024)
  })

  it('L1 do gate: cada campo é lido UMA vez — um getter que muda o valor entre a conferência e a gravação não passa um host com CR/LF', async () => {
    const db = smtpFakeDb()
    let reads = 0
    const tricky = input()
    Object.defineProperty(tricky, 'host', { enumerable: true, get: () => (reads++ === 0 ? 'smtp.exemplo.invalid' : 'smtp.exemplo.invalid\r\nX: y') })
    await storeSmtpCredential({ pool: db.pool, keyring: RING }, 12, tricky)
    expect(reads).toBe(1)
    expect(db.rows.get(12)!.host).toBe('smtp.exemplo.invalid')
  })

  it('re-gate: entrada nula → 422 SMTP_CREDENTIAL_INVALID (antes de ler os campos uma vez só era um TypeError), nada chega ao banco', async () => {
    const db = smtpFakeDb()
    const deps = { pool: db.pool, keyring: RING }
    await expect(storeSmtpCredential(deps, 12, null as any)).rejects.toMatchObject({ statusCode: 422, code: ErrorCodes.SMTP_CREDENTIAL_INVALID })
    expect(db.sqls).toHaveLength(0)
  })

  it('re-gate: a tabela AUSENTE (1146) só vira "sem segredo" nas leituras do cofre — quem abre, grava ou lê a situação recebe o erro do banco', async () => {
    const noTable = Object.assign(new Error("Table doesn't exist"), { errno: 1146, code: 'ER_NO_SUCH_TABLE' })
    const db = smtpFakeDb({ failWith: noTable })
    const deps = { pool: db.pool, keyring: RING }
    await expect(openSmtpCredential(deps, 12)).rejects.toBe(noTable)
    await expect(storeSmtpCredential(deps, 12, input())).rejects.toBe(noTable)
    await expect(smtpCredentialStatus(db.pool, 12)).rejects.toBe(noTable)
    await expect(clearSmtpCredential(deps, 12, null)).rejects.toBe(noTable)
  })

  it('estabelecimento fora da forma falha alto antes de qualquer SQL', async () => {
    const db = smtpFakeDb()
    const deps = { pool: db.pool, keyring: RING }
    for (const id of [0, -1, 1.5, NaN, '12' as any, null as any]) {
      await expect(storeSmtpCredential(deps, id, input())).rejects.toThrow(/estabelecimento inválido/)
      await expect(openSmtpCredential(deps, id)).rejects.toThrow(/estabelecimento inválido/)
      await expect(smtpCredentialStatus(db.pool, id)).rejects.toThrow(/estabelecimento inválido/)
      await expect(clearSmtpCredential(deps, id, null)).rejects.toThrow(/estabelecimento inválido/)
    }
    expect(db.sqls).toHaveLength(0)
  })

  it('erro do BANCO na gravação: o que sobe não traz a senha (ela nunca chegou ao driver — só a cifra)', async () => {
    const driverError = (p: unknown[]) => Object.assign(new Error('Lock wait timeout exceeded'), { errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT', sql: `INSERT … ${p.join(', ')}` })
    const db = smtpFakeDb()
    db.query.mockImplementationOnce(async (_sql: string, p: any[] = []) => { throw driverError(p) })
    const err = await failure(() => storeSmtpCredential({ pool: db.pool, keyring: RING }, 12, input()))
    expect(err.errno).toBe(1205)
    expect(errorText(err)).not.toContain(PASSWORD)
  })
})

describe('FAMILIA.E5.P7.T2 — boot: o motor aplica os CHECKs da 009', () => {
  function probePool(refuse: (sql: string, p: any[]) => string | null) {
    const seen: any[][] = []
    const conn = {
      beginTransaction: jest.fn(), rollback: jest.fn(), release: jest.fn(),
      query: jest.fn(async (sql: string, p: any[] = []) => {
        seen.push(p)
        const constraint = refuse(sql, p)
        if (constraint) throw Object.assign(new Error(`CONSTRAINT \`${constraint}\` failed for \`fiscal_api\`.\`tb_establishment_smtp_credential\``), { errno: 4025 })
        return [{ affectedRows: 1 }, []]
      }),
    }
    return { pool: { getConnection: jest.fn(async () => conn) } as any, conn, seen }
  }
  // o motor de verdade, em miniatura: cada sonda viola UM CHECK só
  const engine = (_sql: string, p: any[]): string | null => {
    const [, port, security, cipher, iv, tag, version, deleted] = p
    if (!['tls', 'starttls'].includes(security)) return 'ck_establishment_smtp_credential_security_bin'
    if (!(port >= 1 && port <= 65535)) return 'ck_establishment_smtp_credential_port'
    if (!['N', 'S'].includes(deleted)) return 'ck_establishment_smtp_credential_deleted_bin'
    const all = cipher != null && iv != null && tag != null && version != null
    const none = cipher == null && iv == null && tag == null && version == null
    if (!((deleted === 'N' && all) || (deleted === 'S' && none))) return 'ck_establishment_smtp_credential_secret_presence'
    return null
  }

  it('motor que aplica os quatro CHECKs → sobe; as sondas usam PK negativa, cada uma a sua, e a transação é desfeita', async () => {
    const { pool, conn, seen } = probePool(engine)
    await assertSmtpCredentialDomainsEnforced(pool)
    const ids = seen.map(p => p[0])
    expect(ids).toEqual([-1, -2, -3, -4, -5, -6, -7])
    expect(conn.rollback).toHaveBeenCalledTimes(4)
    expect(seen.map(p => [p[2], p[1], p[7]])).toEqual([
      ['TLS', 587, 'N'], ['none', 587, 'N'], ['starttls', 0, 'N'], ['starttls', 587, 'n'], ['starttls', 587, 's'], ['starttls', 587, 'N'], ['starttls', 587, 'S'],
    ])
  })
  it('motor SEM CHECK (aceita tudo) → o boot recusa; CHECK _ci na segurança (aceita TLS) → recusa', async () => {
    await expect(assertSmtpCredentialDomainsEnforced(probePool(() => null).pool)).rejects.toThrow(/ACEITOU a segurança da conta de e-mail/)
    const ciSecurity = (sql: string, p: any[]) => (p[2] === 'TLS' ? null : engine(sql, p))
    await expect(assertSmtpCredentialDomainsEnforced(probePool(ciSecurity).pool)).rejects.toThrow(/ACEITOU a segurança da conta de e-mail fora do domínio \(TLS\)/)
  })
  it('sem o CHECK de presença → o boot recusa (não existe conta viva sem senha por construção)', async () => {
    const noPresence = (sql: string, p: any[]) => { const c = engine(sql, p); return c === 'ck_establishment_smtp_credential_secret_presence' ? null : c }
    await expect(assertSmtpCredentialDomainsEnforced(probePool(noPresence).pool)).rejects.toThrow(/ACEITOU a presença da senha cifrada/)
  })
})

describe('FAMILIA.E5.P7.T2 — cercas', () => {
  const piece = read('smtp-credential', 'smtp-credential.ts')
  const repository = read('smtp-credential', 'smtp-credential.repository.ts')

  it('a senha nunca vai a log nem a mensagem: a peça e o repositório não usam o logger/console e nenhum texto interpola a senha', () => {
    for (const code of [piece, repository]) {
      expect(stripComments(code)).not.toMatch(/logger|console\./)
      expect(code).not.toMatch(/\$\{[^}]*\b(password|plain|sealed\w*)\b[^}]*\}/)
    }
  })
  it('o repositório não conhece a senha em claro: só a cifra entra e sai', () => {
    expect(stripComments(repository)).not.toMatch(/\bpassword\b(?!_)/)          // só `password_cipher`/`password_iv`/`password_tag`
    expect(stripComments(repository)).not.toMatch(/keyring|\.open\(|\.seal\(/)
  })
  it('a senha em claro tem UMA saída: só `openSmtpCredential` abre o cofre nesta peça', () => {
    expect(stripComments(piece).match(/keyring\.open\(/g)).toHaveLength(1)
    const open = piece.slice(piece.indexOf('export async function openSmtpCredential'), piece.indexOf('export async function clearSmtpCredential'))
    expect(open).toMatch(/keyring\.open\(/)
    expect(open).toMatch(/plain\.fill\(0\)/)
  })
  it('sem transporte de e-mail no núcleo, sem porta padrão derivada da segurança e sem coluna de estado', () => {
    const pkg = JSON.parse(read('..', 'package.json'))
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(d => /mail|smtp/i.test(d))).toEqual([])
    for (const code of [piece, repository]) {
      expect(stripComments(code)).not.toMatch(/nodemailer|createTransport|require\(['"]net['"]\)|from ['"](net|tls)['"]/)
      expect(stripComments(code)).not.toMatch(/'(tls|starttls)'\s*\?\s*\d+/)
    }
    expect(SQL_009).not.toMatch(/`(active|status|auth_method)`/)
  })
  it('não lê o ERP nem a habilitação (a conta de e-mail não é emissão fiscal)', () => {
    for (const code of [piece, repository]) {
      expect(stripComments(code)).not.toMatch(/tb_establishment_issuer|assertCertificateWritable|erp\/facts|schemaName/)
    }
  })
  it('os três códigos estão no catálogo e a peça sai pelo barrel do núcleo', () => {
    for (const c of ['SMTP_CREDENTIAL_MISSING', 'SMTP_CREDENTIAL_INVALID', 'SMTP_CREDENTIAL_UNREADABLE'] as const) {
      expect(ErrorCodes[c]).toBe(c)
      expect(ErrorCatalog[c]).toEqual(expect.any(String))
    }
    expect(barrel.storeSmtpCredential).toBe(storeSmtpCredential)
    expect(barrel.openSmtpCredential).toBe(openSmtpCredential)
    expect(barrel.smtpCredentialStatus).toBe(smtpCredentialStatus)
    expect(barrel.clearSmtpCredential).toBe(clearSmtpCredential)
    expect(barrel.assertSmtpCredentialDomainsEnforced).toBe(assertSmtpCredentialDomainsEnforced)
    expect(barrel.SMTP_SECURITIES).toEqual(['tls', 'starttls'])
  })
})
