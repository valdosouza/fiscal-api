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

/** Hosts em que o `http://` é aceito (o dev — `flutter run -d web-server`); fora deles, só `https://`. IPv6 fica de fora (a regra da
 *  D-F146 nunca o aceitou e o app do dev não o usa). */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1'])

/**
 * Por que [origin] NÃO é uma origem que o navegador manda (null = é). D-F146 (= Q-F154 (a), Valdo 2026-10-13) — a regra mora no NÚCLEO
 * (gate do delta da Rodada 4 da F2a, F2AR4-SOC-07/ADV-09: estava só no boot da nfse-api; a nfe-api teria de lembrar dela). A comparação
 * do `corsFor` é por IGUALDADE com a Origin do navegador, então só passa a forma CANÔNICA (`new URL(o).origin === o`): esquema e host em
 * minúsculas, sem porta padrão explícita (`:80`/`:443`), porta ≤ 65535, sem caminho nem barra final — e nada de curinga `*`.
 */
export function corsOriginProblem(origin: string): string | null {
  if (origin === '*') return 'curinga (* deixaria qualquer site com o token do usuário falar com a API fiscal)'
  let u: URL
  try { u = new URL(origin) } catch { return 'não é uma URL' }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'esquema fora de http/https'
  if (u.origin !== origin) return `fora da forma canônica (o navegador manda ${u.origin})`
  // o `new URL` aceita `*` e outros no host (a WHATWG não os proíbe): host = rótulos DNS (ou IPv4) — curinga de subdomínio não é origem
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(u.hostname)) return `host fora da forma DNS (${u.hostname})`
  if (u.protocol === 'http:' && !LOCAL_HOSTS.has(u.hostname)) return 'http:// só em localhost — fora dele, https://'
  return null
}

/**
 * D-F146: a LISTA de origens do app web (o navegador chama a API fiscal DIRETO — D-F4). O boot RECUSA lista vazia (o app cairia em
 * "Failed to fetch" sem diagnóstico) e qualquer item que não seja uma origem canônica (`corsOriginProblem`). Devolve a lista para o log.
 */
export function assertCorsOrigins(origins: readonly string[]): string {
  if (!origins.length) {
    throw new Error('CORS_ORIGINS vazia — declare a(s) origem(ns) do app web (dev: http://localhost:5051; produção: a origem do Plesk) — D-F146')
  }
  const bad = origins.map(o => [o, corsOriginProblem(o)] as const).filter(([, p]) => p)
  if (bad.length) {
    throw new Error(`CORS_ORIGINS com valor que não é uma ORIGEM canônica: ${bad.map(([o, p]) => `${o} (${p})`).join('; ')} — D-F146`)
  }
  return origins.join(', ')
}

/**
 * CORS por LISTA de origens (o build Flutter publicado no Plesk chama a API direto — D-F4/D-F9).
 * Origem fora da lista: sem cabeçalhos (o navegador bloqueia); requisição sem Origin (servidor,
 * curl) passa — a autenticação é o JWT, não o CORS. Item que não é origem canônica (inclusive `*`) RECUSA na montagem (D-F146 —
 * `corsOriginProblem`); lista vazia = nenhuma origem de navegador (o boot do serviço é quem exige a lista — `assertCorsOrigins`).
 */
export function corsFor(allowedOrigins: string[]): RequestHandler {
  const list = allowedOrigins.map(o => o.trim()).filter(Boolean)
  const bad = list.filter(o => corsOriginProblem(o))
  if (bad.length) throw new Error(`corsFor: origem(ns) fora da forma canônica ou curinga: ${bad.join(', ')} — D-F146`)
  const allowed = new Set(list)
  return (req, res, next) => {
    const origin = req.headers.origin
    if (origin && allowed.has(origin)) {
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
