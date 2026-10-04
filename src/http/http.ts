import { randomBytes } from 'crypto'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { HttpError } from '../errors/http-error'
import { ErrorCodes, ErrorCatalog } from '../errors/error-codes'
import { contentionToHttpError } from '../db/tx'
import { logger } from '../log/logger'

/**
 * Borda HTTP comum às APIs fiscais. Envelope de erro IGUAL ao do setes-api
 * (`{ error, code?, ref?, fields? }` — Framework de Mensagens do produto): o app lê as duas APIs
 * com o mesmo tratador. Contenção (lock wait/deadlock que sobrou) = 409 RESOURCE_BUSY; erro técnico
 * = 500 com `ref` curto no log (o suporte rastreia pelo ref).
 */

export function sendOk(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ ok: true, data })
}

export function newCrashRef(): string {
  return randomBytes(4).toString('hex').toUpperCase()
}

export function sendError(res: Response, err: unknown, ctx: string): void {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.fields ? { fields: err.fields } : {}),
    })
    return
  }
  const busy = contentionToHttpError(err)
  if (busy) {
    res.status(busy.statusCode).json({ error: busy.message, code: busy.code })
    return
  }
  const ref = newCrashRef()
  logger.error(`Erro em ${ctx} [ref ${ref}]`, { err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err) })
  res.status(500).json({ error: 'Erro interno', code: ErrorCodes.INTERNAL, ref })
}

/** Rota assíncrona: qualquer erro vira o envelope (nunca promessa rejeitada solta no Express 4). */
export function route(ctx: string, fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res) => { fn(req, res).catch(err => sendError(res, err, ctx)) }
}

/**
 * Middleware de erro final. Erro do CORPO enviado pelo cliente (body-parser) é 4xx no envelope, nunca
 * 500 com ref (gate adversarial R3: charset latin1 / Content-Encoding br viravam crash do servidor, sem
 * token): JSON malformado → 400; grande demais → 413; charset/encoding não suportado → 415; qualquer
 * outro erro 4xx declarado pelo parser (`expose`) → o status dele. O resto pelo sendError.
 */
export function errorMiddleware(err: any, req: Request, res: Response, _next: NextFunction): void {
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'JSON malformado no corpo da requisição', code: ErrorCodes.VALIDATION_FAILED })
    return
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Corpo da requisição grande demais', code: ErrorCodes.VALIDATION_FAILED })
    return
  }
  if (err?.type === 'charset.unsupported' || err?.type === 'encoding.unsupported') {
    res.status(415).json({ error: ErrorCatalog.UNSUPPORTED_MEDIA_TYPE, code: ErrorCodes.UNSUPPORTED_MEDIA_TYPE })
    return
  }
  const status = Number(err?.status ?? err?.statusCode)
  if (typeof err?.type === 'string' && err?.expose === true && status >= 400 && status < 500) {
    res.status(status).json({ error: 'Corpo da requisição inválido', code: ErrorCodes.VALIDATION_FAILED })
    return
  }
  sendError(res, err, `${req.method} ${req.path}`)
}

/**
 * CORS por LISTA de origens (o build Flutter publicado no Plesk chama a API direto — D-F4/D-F9).
 * Origem fora da lista: sem cabeçalhos (o navegador bloqueia); requisição sem Origin (servidor,
 * curl) passa — a autenticação é o JWT, não o CORS.
 */
export function corsFor(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins.map(o => o.trim().replace(/\/$/, '')).filter(Boolean))
  return (req, res, next) => {
    const origin = req.headers.origin
    if (origin && (allowed.has(origin) || allowed.has('*'))) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      res.setHeader('Access-Control-Max-Age', '600')
    }
    if (req.method === 'OPTIONS') { res.status(204).end(); return }
    next()
  }
}
