import fs from 'fs'
import jwt, { JwtHeader } from 'jsonwebtoken'
import type { Request, Response, NextFunction } from 'express'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'
import { SCHEMA_RE } from '../db/schema'
import { logger as defaultLogger, Logger } from '../log/logger'

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

/**
 * D-F157 (= Q-F165 (a), Valdo 2026-10-13 — gate socrático da F2b, F2B-SOCD-01): a CLASSE de cada 401 do produto vai ao LOG — antes nenhum
 * rastro (o app mostra "sessão não aceita" e o suporte só sabia pelo telefone). NUNCA o token. O `kid` não é segredo (identifica a chave
 * pública) e vai SANEADO (`[A-Za-z0-9._-]`, até 64). A ordem da rotação do `JWT_KID` (publicar a pública aqui ANTES de o setes-api virar)
 * está em PADROES_BANCO §7.
 */
export type AuthRejectClass = 'missing' | 'malformed' | 'unknown_kid' | 'expired' | 'invalid' | 'no_identity' | 'identity_mismatch'

export class ProductAuthError extends HttpError {
  constructor(message: string, public readonly authClass: AuthRejectClass, public readonly kid?: string) {
    super(401, message, undefined, ErrorCodes.UNAUTHORIZED)
    this.name = 'ProductAuthError'
  }
}

/** O kid do cabeçalho é do ATACANTE até prova em contrário: só a forma segura vai ao log/mensagem. */
export const safeKid = (k: unknown): string | undefined =>
  typeof k === 'string' ? k.replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 64) : undefined

export interface AuthReject { authClass: AuthRejectClass; kid?: string; institutionId?: number; route: string }

/**
 * O log do 401 com LIMITE por classe por minuto (D-F157): até [perMinute] linhas por classe na janela; o excedente vira UMA linha de
 * "suprimidas" na 1ª recusa da janela seguinte. Throttle de LOG — nenhuma decisão depende dele (não é estado de controle; regra 3 do
 * núcleo). Contadores num objeto simples por classe (lista fechada).
 */
export function authRejectLog(log: Pick<Logger, 'warn'> = defaultLogger, perMinute = 5, now: () => number = Date.now): (r: AuthReject) => void {
  let windowStart = Number.NEGATIVE_INFINITY
  let counts: Partial<Record<AuthRejectClass, number>> = {}
  return r => {
    const t = now()
    if (t - windowStart >= 60_000) {
      for (const [cls, n] of Object.entries(counts) as [AuthRejectClass, number][]) {
        if (n > perMinute) log.warn(`401 do produto: ${n - perMinute} recusa(s) "${cls}" suprimida(s) no minuto anterior (D-F157)`, { authClass: cls, suppressed: n - perMinute })
      }
      windowStart = t
      counts = {}
    }
    const n = (counts[r.authClass] ?? 0) + 1
    counts[r.authClass] = n
    if (n > perMinute) return
    log.warn(`401 do produto: ${r.authClass} (D-F157)`, {
      authClass: r.authClass, route: r.route,
      ...(r.kid !== undefined ? { kid: r.kid } : {}),
      ...(r.institutionId !== undefined ? { institutionId: r.institutionId } : {}),
    })
  }
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
    const decoded = jwt.decode(token, { complete: true }) as { header: JwtHeader } | null
    if (!decoded) throw new ProductAuthError('Token inválido', 'malformed')
    const kid = decoded.header.kid ?? this.defaultKid
    const key = this.keys.get(kid)
    if (!key) {
      // D-F157: o kid (saneado) vai na frase — o suporte vê "chave desconhecida (kid X)" pelo código de origem do app (F2B-SOCD-07)
      const shown = safeKid(kid)
      throw new ProductAuthError(`Token assinado com chave desconhecida (kid ${shown})`, 'unknown_kid', shown)
    }
    let payload: any
    try {
      payload = jwt.verify(token, key, { algorithms: ['RS256'] })
    } catch (err: any) {
      if (err?.name === 'TokenExpiredError') throw new ProductAuthError('Token expirado', 'expired', safeKid(kid))
      throw new ProductAuthError('Token inválido', 'invalid', safeKid(kid))
    }
    const ok = payload && Number.isInteger(payload.institutionId) && payload.institutionId > 0
      && Number.isInteger(payload.userId) && payload.userId >= 0
      && typeof payload.role === 'string' && payload.role.length > 0
      && typeof payload.schemaName === 'string' && SCHEMA_RE.test(payload.schemaName)
    if (!ok) throw new ProductAuthError('Token sem a identidade da institution (token de seleção não serve aqui)', 'no_identity', safeKid(kid))
    return { institutionId: payload.institutionId, userId: payload.userId, role: payload.role, schemaName: payload.schemaName }
  }
}

/** Institution autenticada da requisição (posta pelo middleware). */
export function institutionOf(req: Request): InstitutionPayload {
  const inst = (req as any).institution as InstitutionPayload | undefined
  if (!inst) throw new HttpError(401, 'Não autenticado', undefined, ErrorCodes.UNAUTHORIZED)
  return inst
}

/** O log padrão do 401 (D-F157) — um por processo. */
const defaultAuthReject = authRejectLog()

/**
 * Middleware de autenticação. [check] (opcional) confere a identidade contra o banco — a fonte de
 * fatos garante que o `schemaName` do token é o da institution (defesa em profundidade). [onReject] = o log da CLASSE de cada 401
 * (D-F157; nunca o token); um 401 do [check] é "identity_mismatch". O log nunca derruba a resposta.
 */
export function productAuth(verifier: ProductTokenVerifier, check?: (p: InstitutionPayload) => Promise<void>,
  onReject: (r: AuthReject) => void = defaultAuthReject) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let payload: InstitutionPayload | undefined
    try {
      const header = req.headers.authorization
      if (!header?.startsWith('Bearer ')) throw new ProductAuthError('Token ausente', 'missing')
      payload = verifier.verify(header.slice(7).trim())
      if (check) await check(payload)
      ;(req as any).institution = payload
      next()
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 401) {
        try {
          onReject({
            authClass: err instanceof ProductAuthError ? err.authClass : 'identity_mismatch',
            kid: err instanceof ProductAuthError ? err.kid : undefined,
            institutionId: payload?.institutionId,
            route: `${req.method} ${req.baseUrl ?? ''}${req.path ?? ''}`,
          })
        } catch { /* o log nunca derruba a resposta */ }
      }
      if (err instanceof HttpError) {
        res.status(err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) })
        return
      }
      next(err)
    }
  }
}
