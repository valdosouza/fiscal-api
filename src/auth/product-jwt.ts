import fs from 'fs'
import jwt, { JwtHeader } from 'jsonwebtoken'
import type { Request, Response, NextFunction } from 'express'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'
import { SCHEMA_RE } from '../db/schema'

/**
 * Autenticação pelo LOGIN DO PRODUTO (D-F13): o setes-api assina o JWT em RS256; as APIs fiscais
 * só têm a(s) chave(s) PÚBLICA(S) — conseguem verificar, nunca forjar. Rotação por `kid` (cada
 * chave pública com seu id; token sem `kid` usa a padrão). HS256 é recusado por construção
 * (`algorithms: ['RS256']`). Payload = o mesmo do setes-api (PADROES_BANCO §7).
 */

export interface InstitutionPayload {
  institutionId: number
  userId:        number
  role:          string
  schemaName:    string
}

/** Institution da Setes (decisão 14 da Fase 2 — hard coded igual ao setes-api). */
export const SETES_INSTITUTION_ID = 1

export function isSuper(p?: InstitutionPayload | null): boolean {
  return p?.institutionId === SETES_INSTITUTION_ID && p?.role === 'super'
}

/** Admin da PRÓPRIA institution (super também passa) — "admin passa" (D32 do produto). */
export function isAdmin(p?: InstitutionPayload | null): boolean {
  return isSuper(p) || p?.role === 'admin'
}

export class ProductTokenVerifier {
  constructor(private readonly keys: Map<string, string>, private readonly defaultKid: string) {
    if (!keys.has(defaultKid)) throw new Error(`Chave pública padrão '${defaultKid}' ausente`)
  }

  /**
   * JWT_PUBLIC_KEYS = "kid1=<caminho.pem>,kid2=<caminho.pem>" (padrão = a 1ª) · ou
   * JWT_PUBLIC_KEY_PATH = "<caminho.pem>" (kid 'default').
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): ProductTokenVerifier {
    const keys = new Map<string, string>()
    let first: string | null = null
    const list = String(env.JWT_PUBLIC_KEYS ?? '').trim()
    if (list) {
      for (const part of list.split(',').map(s => s.trim()).filter(Boolean)) {
        const i = part.indexOf('=')
        if (i <= 0) throw new Error('JWT_PUBLIC_KEYS mal formada — use "kid=caminho.pem,…"')
        const kid = part.slice(0, i).trim()
        keys.set(kid, fs.readFileSync(part.slice(i + 1).trim(), 'utf8'))
        first ??= kid
      }
    } else if (env.JWT_PUBLIC_KEY_PATH) {
      keys.set('default', fs.readFileSync(env.JWT_PUBLIC_KEY_PATH, 'utf8'))
      first = 'default'
    }
    if (!first) throw new Error('Configure JWT_PUBLIC_KEYS ou JWT_PUBLIC_KEY_PATH (chave pública RS256 do setes-api — D-F13)')
    return new ProductTokenVerifier(keys, first)
  }

  static of(publicKeys: Record<string, string>, defaultKid?: string): ProductTokenVerifier {
    const keys = new Map(Object.entries(publicKeys))
    return new ProductTokenVerifier(keys, defaultKid ?? Object.keys(publicKeys)[0])
  }

  verify(token: string): InstitutionPayload {
    const unauthorized = (msg: string) => new HttpError(401, msg, undefined, ErrorCodes.UNAUTHORIZED)
    const decoded = jwt.decode(token, { complete: true }) as { header: JwtHeader } | null
    if (!decoded) throw unauthorized('Token inválido')
    const kid = decoded.header.kid ?? this.defaultKid
    const key = this.keys.get(kid)
    if (!key) throw unauthorized('Token assinado com chave desconhecida')
    let payload: any
    try {
      payload = jwt.verify(token, key, { algorithms: ['RS256'] })
    } catch (err: any) {
      throw unauthorized(err?.name === 'TokenExpiredError' ? 'Token expirado' : 'Token inválido')
    }
    const ok = payload && Number.isInteger(payload.institutionId) && payload.institutionId > 0
      && Number.isInteger(payload.userId) && payload.userId >= 0
      && typeof payload.role === 'string' && payload.role.length > 0
      && typeof payload.schemaName === 'string' && SCHEMA_RE.test(payload.schemaName)
    if (!ok) throw unauthorized('Token sem a identidade da institution (token de seleção não serve aqui)')
    return { institutionId: payload.institutionId, userId: payload.userId, role: payload.role, schemaName: payload.schemaName }
  }
}

/** Institution autenticada da requisição (posta pelo middleware). */
export function institutionOf(req: Request): InstitutionPayload {
  const inst = (req as any).institution as InstitutionPayload | undefined
  if (!inst) throw new HttpError(401, 'Não autenticado', undefined, ErrorCodes.UNAUTHORIZED)
  return inst
}

/**
 * Middleware de autenticação. [check] (opcional) confere a identidade contra o banco — a fonte de
 * fatos garante que o `schemaName` do token é o da institution (defesa em profundidade).
 */
export function productAuth(verifier: ProductTokenVerifier, check?: (p: InstitutionPayload) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const header = req.headers.authorization
      if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'Token ausente', undefined, ErrorCodes.UNAUTHORIZED)
      const payload = verifier.verify(header.slice(7).trim())
      if (check) await check(payload)
      ;(req as any).institution = payload
      next()
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) })
        return
      }
      next(err)
    }
  }
}
