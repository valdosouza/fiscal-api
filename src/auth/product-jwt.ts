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
 * chave pública com seu id; `kid` e `exp` OBRIGATÓRIOS desde a D-F165 — como no setes-api). HS256 é recusado por construção
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
  /** [alg] (saneado) vai só ao LOG da classe `invalid` — separa a falsificação HS256 de uma assinatura RS256 errada (R6-SOC-04). */
  constructor(message: string, public readonly authClass: AuthRejectClass, public readonly kid?: string, public readonly alg?: string) {
    super(401, message, undefined, ErrorCodes.UNAUTHORIZED)
    this.name = 'ProductAuthError'
  }
}

/** O kid do cabeçalho é do ATACANTE até prova em contrário: só a forma segura vai ao log/mensagem. */
export const safeKid = (k: unknown): string | undefined =>
  typeof k === 'string' ? k.replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 64) : undefined

export interface AuthReject { authClass: AuthRejectClass; kid?: string; alg?: string; institutionId?: number; route: string }

/** A rota vem do ATACANTE (caminho da URL): só ASCII visível e curta no log (gate socrático da Rodada 6, R6-SOC-03). */
const safeRoute = (r: string): string => r.replace(/[^\x20-\x7e]/g, '?').slice(0, 200)

/**
 * O log do 401 com LIMITE por classe por minuto (D-F157): até [perMinute] linhas por classe na janela; o excedente vira UMA linha de
 * "suprimidas" na 1ª recusa da janela seguinte. Throttle de LOG — nenhuma decisão depende dele (não é estado de controle; regra 3 do
 * núcleo). Contadores num objeto simples por classe (lista fechada).
 *
 * D-F167 (= Q-F175 (a→b), Valdo 2026-10-13 — gate adversarial da Rodada 6, R6-ADV-01): a 1ª ocorrência de cada KID DISTINTO (por classe)
 * na janela também vai ao log, ALÉM do limite por classe — o kid é lido antes da assinatura, então um anônimo com kids inventados ocupava a
 * cota de `unknown_kid` e o kid REAL de uma rotação mal publicada (o caso para o qual a D-F157 existe) sumia. Conjunto LIMITADO a
 * [maxKids] por janela (uma lista curta — memória fixa); passou disso, vale só o limite por classe.
 *
 * D-F170 (= Q-F178 (b), Valdo 2026-10-13 — gate socrático da Rodada 7, R7-SOC-01): 16 kids forjados no começo da janela esgotavam o
 * conjunto da D-F167 e o kid real sumia. O resumo da janela passa a listar os kids MAIS FREQUENTES — [maxKids] contadores pelo algoritmo
 * Space-Saving (memória fixa; a linha imprime o MÍNIMO GARANTIDO — `count − erro` do contador, D-F175): todo kid com MAIS DE 1/maxKids das recusas com kid da
 * janela fica na lista (com 16 contadores, > N/16 — gate socrático da Rodada 8, R8-SOC-01). Sai junto do resumo das suprimidas (só quando
 * houve supressão — sem ela, cada recusa já foi ao log). CONHECIMENTO NEGATIVO (limite conhecido): um kid não autenticado não se distingue
 * de um forjado com memória fixa — um atacante com ~16× o volume do kid real (distintos) ou com 16 kids REPETIDOS um pouco mais frequentes
 * que o real o esconde do log; o canal confiável do kid real é a frase do 401 que o app mostra (D-F157/F2B-SOCD-07).
 */
export function authRejectLog(log: Pick<Logger, 'warn'> = defaultLogger, perMinute = 5, now: () => number = Date.now, maxKids = 16): (r: AuthReject) => void {
  let windowStart = Number.NEGATIVE_INFINITY
  let counts: Partial<Record<AuthRejectClass, number>> = {}
  let logged: Partial<Record<AuthRejectClass, number>> = {}
  let kidsSeen: string[] = []
  let topKeys: string[] = []          // D-F170: Space-Saving — "classe:kid"
  let topCounts: number[] = []
  // D-F175 (= Q-F183 (b), Valdo 2026-10-13 — R8-ADV-01): o ERRO de cada contador (o mínimo herdado ao entrar no lugar de outro) — a linha
  // imprime `count − erro`, o mínimo GARANTIDO: o kid inventado visto uma vez aparece com ~1, o real com a sua contagem (antes os dois
  // apareciam com ~a mesma contagem herdada e o operador não sabia qual era o verdadeiro)
  let topErrors: number[] = []
  const countKid = (key: string): void => {
    const i = topKeys.indexOf(key)
    if (i >= 0) { topCounts[i] += 1; return }
    if (topKeys.length < maxKids) { topKeys.push(key); topCounts.push(1); topErrors.push(0); return }
    let m = 0
    for (let j = 1; j < topCounts.length; j++) if (topCounts[j] < topCounts[m]) m = j
    topKeys[m] = key
    topErrors[m] = topCounts[m]
    topCounts[m] += 1
  }
  return r => {
    const t = now()
    // relógio que VOLTA (NTP/VM) também abre janela nova — senão ela ficaria aberta e o excedente calado até o relógio alcançar (R6-ADV-02)
    if (t - windowStart >= 60_000 || t < windowStart) {
      // o resumo sai na 1ª recusa de uma janela SEGUINTE (pode ser horas depois): diz QUANDO a janela suprimida começou (R6-SOC-02)
      const since = Number.isFinite(windowStart) ? new Date(windowStart).toISOString() : null
      let anySuppressed = false
      for (const [cls, n] of Object.entries(counts) as [AuthRejectClass, number][]) {
        const suppressed = n - (logged[cls] ?? 0)
        if (suppressed > 0) {
          anySuppressed = true
          log.warn(`401 do produto: ${suppressed} recusa(s) "${cls}" suprimida(s) no minuto iniciado em ${since} (D-F157)`,
            { authClass: cls, suppressed, windowStartedAt: since })
        }
      }
      if (anySuppressed && topKeys.length) {
        const topKids = topKeys
          // D-F175: `count` = o mínimo GARANTIDO (a contagem real é ≥ ele); ordenado por ele
          .map((key, i) => ({ authClass: key.slice(0, key.indexOf(':')), kid: key.slice(key.indexOf(':') + 1), count: topCounts[i] - topErrors[i] }))
          .sort((a, b) => b.count - a.count)
        log.warn(`401 do produto: kids mais frequentes no minuto iniciado em ${since} (D-F170/D-F175 — contagem = mínimo garantido)`,
          { windowStartedAt: since, topKids })
      }
      windowStart = t
      counts = {}
      logged = {}
      kidsSeen = []
      topKeys = []
      topCounts = []
      topErrors = []
    }
    counts[r.authClass] = (counts[r.authClass] ?? 0) + 1
    // D-F167: 1ª ocorrência deste kid NESTA classe (o mesmo kid pode ser "expirado" para uns e "assinatura inválida" para outros)
    const kidKey = r.kid !== undefined ? `${r.authClass}:${r.kid}` : null
    if (kidKey !== null) countKid(kidKey)
    const firstOfKid = kidKey !== null && kidsSeen.length < maxKids && !kidsSeen.includes(kidKey)
    if (firstOfKid) kidsSeen.push(kidKey)
    if ((logged[r.authClass] ?? 0) >= perMinute && !firstOfKid) return
    logged[r.authClass] = (logged[r.authClass] ?? 0) + 1
    log.warn(`401 do produto: ${r.authClass} (D-F157)`, {
      authClass: r.authClass, route: safeRoute(r.route),
      ...(r.kid !== undefined ? { kid: r.kid } : {}),
      ...(r.alg !== undefined ? { alg: r.alg } : {}),
      ...(r.institutionId !== undefined ? { institutionId: r.institutionId } : {}),
    })
  }
}

export class ProductTokenVerifier {
  /** [defaultKid] só nomeia a 1ª chave da configuração (precisa existir) — não serve de fallback para token sem kid (D-F165). */
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

  /** A identidade do token (sem o `iat`) — o formato de sempre das rotas. */
  verify(token: string): InstitutionPayload {
    return this.verifyWithIat(token).payload
  }

  /**
   * A identidade + o `iat` (segundos). D-EA7 (Valdo 2026-10-31, costura A1): a SESSÃO viva compara o `iat` com o instante em que a senha
   * foi definida (`vw_user_link.password_set_at`) — token sem `iat` inteiro = 401 (molde do `exp` — D-F165: sem ele a revogação seria
   * falha ABERTA).
   */
  verifyWithIat(token: string): { payload: InstitutionPayload; iat: number } {
    // gate adversarial da Rodada 7 (R7-ADV-01): o `jws` faz JSON.parse do corpo — corpo que não é JSON LANÇA (SyntaxError) e virava 500
    // com stack no log, sem o limite do log do 401 (o setes-api responde 401 ao mesmo token): token que não decodifica = malformado
    let decoded: { header: JwtHeader } | null
    try { decoded = jwt.decode(token, { complete: true }) as { header: JwtHeader } | null } catch { decoded = null }
    if (!decoded || typeof decoded.header !== 'object' || decoded.header === null) throw new ProductAuthError('Token inválido', 'malformed')
    // D-F165 (= Q-F173 (a), Valdo 2026-10-13 — gate socrático da Rodada 6, R6-SOC-05): `kid` OBRIGATÓRIO, como no setes-api (que sempre
    // assina com ele — F2A2-ADV-07); a chave "padrão" para token sem kid era uma 2ª regra: dois leitores, uma resposta
    const kid = decoded.header.kid
    if (typeof kid !== 'string' || kid.length === 0) throw new ProductAuthError('Token sem kid (a chave que o assinou)', 'malformed')
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
      throw new ProductAuthError('Token inválido', 'invalid', safeKid(kid), safeKid(decoded.header.alg))
    }
    // D-F165: validade OBRIGATÓRIA — token sem `exp` (só quem tem a chave privada forja) nunca vale para sempre (molde do setes-api)
    if (!Number.isFinite(payload?.exp)) throw new ProductAuthError('Token sem validade (exp)', 'invalid', safeKid(kid))
    const ok = payload && Number.isInteger(payload.institutionId) && payload.institutionId > 0
      && Number.isInteger(payload.userId) && payload.userId >= 0
      && typeof payload.role === 'string' && payload.role.length > 0
      && typeof payload.schemaName === 'string' && SCHEMA_RE.test(payload.schemaName)
    if (!ok) throw new ProductAuthError('Token sem a identidade da institution (token de seleção não serve aqui)', 'no_identity', safeKid(kid))
    if (!Number.isSafeInteger(payload.iat) || payload.iat <= 0) throw new ProductAuthError('Token sem o instante de emissão (iat)', 'invalid', safeKid(kid))
    return {
      payload: { institutionId: payload.institutionId, userId: payload.userId, role: payload.role, schemaName: payload.schemaName },
      iat: payload.iat,
    }
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
 * Costura A1 da auth-api (D-UC9/D-AU3, 2026-10-31): o [check] pode DEVOLVER a identidade a usar — a SESSÃO viva (`access.sessionOf`)
 * devolve o payload com o PERFIL VIVO no lugar do `role` do token (até a A2 o token ainda o leva, mas ninguém confia nele); ele recebe
 * o `iat` do token (D-EA7: troca de senha revoga o token anterior).
 */
export function productAuth(verifier: ProductTokenVerifier, check?: (p: InstitutionPayload, iat: number) => Promise<void | InstitutionPayload>,
  onReject: (r: AuthReject) => void = defaultAuthReject) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let payload: InstitutionPayload | undefined
    try {
      const header = req.headers.authorization
      // sem cabeçalho (ou só "Bearer") = ausente; cabeçalho com OUTRO esquema (`bearer`, `Token`…) veio e não serve = malformado — o log
      // não diz "não veio token" quando veio um (gate adversarial da Rodada 6, R6-ADV-03)
      if (!header || !header.trim() || header.trim() === 'Bearer') throw new ProductAuthError('Token ausente', 'missing')
      if (!header.startsWith('Bearer ')) throw new ProductAuthError('Esquema de autenticação inesperado — use "Bearer <token>"', 'malformed')
      const verified = verifier.verifyWithIat(header.slice(7).trim())
      payload = verified.payload
      if (check) payload = (await check(payload, verified.iat)) ?? payload
      ;(req as any).institution = payload
      next()
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 401) {
        try {
          onReject({
            authClass: err instanceof ProductAuthError ? err.authClass : 'identity_mismatch',
            kid: err instanceof ProductAuthError ? err.kid : undefined,
            alg: err instanceof ProductAuthError ? err.alg : undefined,
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
