import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'

/**
 * Cofre CIFRADO do `fiscal_api` (D-F16): AES-256-GCM com chave-mestra fora do banco e fora do
 * repositório (variável de ambiente; KMS entra atrás desta mesma interface). Versão da chave em
 * cada registro → rotação sem reescrever tudo de uma vez (reabre com a antiga, regrava com a nova).
 *
 * AAD = identidade do registro (`<tabela>:<chave>`): um texto cifrado copiado para a linha de outro
 * estabelecimento NÃO abre (troca de A1 entre clientes por SQL fica impossível de passar calada).
 *
 * Configuração:
 *   FISCAL_MASTER_KEYS = "1:<base64 32 bytes>,2:<base64 32 bytes>"  (a MAIOR versão cifra)
 *   FISCAL_MASTER_KEY  = "<base64 32 bytes>"                         (atalho = versão 1)
 */

export interface SealedSecret {
  cipher:  Buffer
  iv:      Buffer
  tag:     Buffer
  version: number
}

export class MasterKeyRing {
  private constructor(private readonly keys: Map<number, Buffer>) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): MasterKeyRing {
    const keys = new Map<number, Buffer>()
    const list = String(env.FISCAL_MASTER_KEYS ?? '').trim()
    if (list) {
      for (const part of list.split(',').map(s => s.trim()).filter(Boolean)) {
        const m = /^(\d+):(.+)$/.exec(part)
        if (!m) throw new Error('FISCAL_MASTER_KEYS mal formada — use "versão:base64,…"')
        keys.set(Number(m[1]), MasterKeyRing.decodeKey(m[2], `versão ${m[1]}`))
      }
    } else if (env.FISCAL_MASTER_KEY) {
      keys.set(1, MasterKeyRing.decodeKey(env.FISCAL_MASTER_KEY, 'versão 1'))
    }
    return new MasterKeyRing(keys)
  }

  /** Para testes e scripts: anel com chaves dadas. */
  static of(entries: Record<number, Buffer>): MasterKeyRing {
    const keys = new Map<number, Buffer>()
    for (const [v, k] of Object.entries(entries)) {
      if (k.length !== 32) throw new Error(`Chave-mestra versão ${v} precisa de 32 bytes`)
      keys.set(Number(v), k)
    }
    return new MasterKeyRing(keys)
  }

  private static decodeKey(b64: string, label: string): Buffer {
    const k = Buffer.from(b64.trim(), 'base64')
    if (k.length !== 32) throw new Error(`Chave-mestra ${label}: precisa de 32 bytes em base64 (veio ${k.length})`)
    return k
  }

  get currentVersion(): number | null {
    return this.keys.size ? Math.max(...this.keys.keys()) : null
  }

  hasVersion(v: number): boolean {
    return this.keys.has(v)
  }

  private unavailable(what: string): HttpError {
    return new HttpError(503, `Chave-mestra do cofre indisponível (${what}) — configure FISCAL_MASTER_KEYS`,
      undefined, ErrorCodes.FISCAL_MASTER_KEY_UNAVAILABLE)
  }

  seal(plain: Buffer | string, aad: string): SealedSecret {
    const version = this.currentVersion
    if (version === null) throw this.unavailable('nenhuma chave configurada')
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', this.keys.get(version)!, iv)
    c.setAAD(Buffer.from(aad, 'utf8'))
    const cipher = Buffer.concat([c.update(Buffer.isBuffer(plain) ? plain : Buffer.from(plain, 'utf8')), c.final()])
    return { cipher, iv, tag: c.getAuthTag(), version }
  }

  open(sealed: SealedSecret, aad: string): Buffer {
    const key = this.keys.get(sealed.version)
    if (!key) throw this.unavailable(`versão ${sealed.version} ausente`)
    const d = createDecipheriv('aes-256-gcm', key, sealed.iv)
    d.setAAD(Buffer.from(aad, 'utf8'))
    d.setAuthTag(sealed.tag)
    return Buffer.concat([d.update(sealed.cipher), d.final()])
  }

  /** /health: a chave atual cifra e decifra um vetor (nunca expõe nada). */
  selfTest(): boolean {
    try {
      const probe = 'fiscal-api:health'
      return this.open(this.seal(probe, 'health'), 'health').toString('utf8') === probe
    } catch {
      return false
    }
  }
}
