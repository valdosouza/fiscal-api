/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA da Rodada 6 (2026-10-13 — skill Infra-IA/skills-genericas/testar-adversarial.md;
// prompt_apis_fiscais_isoladas.md §7 D-F157, §22.20). Alvo: núcleo `01bba49..c0a8d35` — o `productAuth` loga a CLASSE de cada 401
// (missing · malformed · unknown_kid com o kid SANEADO · expired · invalid · no_identity · identity_mismatch), nunca o token, com limite
// POR CLASSE por minuto (`authRejectLog`).
// Convenção: achado CONFIRMADO = `it.failing('[ACHADO R6-ADV-NN SEV] …')` (o teste descreve o comportamento CERTO e hoje falha);
// `it('[RESISTIU] …')` = o ataque foi barrado; `it('[FATO …]')` = comportamento atual registrado (depende de decisão ou é cosmético).
// Para LER a mensagem de um achado: ADV_SHOW=1 npx jest adversarial-r6-gate (roda os `failing` como `it` comum).
// Nada aqui toca banco: o middleware REAL atrás de um express REAL numa porta efêmera, com bytes CRUS no socket (o cabeçalho exato).
import net from 'net'
import { AddressInfo } from 'net'
import { generateKeyPairSync } from 'crypto'
import express from 'express'
import jwt from 'jsonwebtoken'
import { HttpError } from '../errors/http-error'
import { ProductTokenVerifier, productAuth, authRejectLog, safeKid, AuthReject, AuthRejectClass } from '../auth/product-jwt'

const last = <T>(a: T[]): T => a[a.length - 1]
const failing: jest.It['failing'] = process.env.ADV_SHOW === '1' ? (it as any) : it.failing

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
// a chave do ATACANTE: qualquer um gera um par e assina com o kid que quiser — o kid é lido ANTES da assinatura
const evilPem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const verifier = ProductTokenVerifier.of({ k1: pubPem })
const claims = { institutionId: 3, userId: 7, role: 'admin', schemaName: 'setes_x' }
const sign = (c: object = claims, kid: any = 'k1', key = privPem) =>
  jwt.sign(c, key, { algorithm: 'RS256', header: { alg: 'RS256', kid } as any, expiresIn: '1h' })

/**
 * Token FORJADO com o cabeçalho em UTF-8 cru (o `jws` do jsonwebtoken codifica o cabeçalho em latin1 e estragaria o kid não-latin1):
 * o kid é decidido ANTES da assinatura — a do atacante é lixo.
 */
const b64u = (b: Buffer) => b.toString('base64url')
const forge = (kid: unknown) =>
  `${b64u(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }), 'utf8'))}.${b64u(Buffer.from(JSON.stringify(claims), 'utf8'))}.${b64u(Buffer.from('lixo'))}`

/** O app REAL: express + o middleware REAL do núcleo; [onReject] captura o que iria ao log. */
async function serve(onReject: (r: AuthReject) => void, check?: (p: any) => Promise<void>) {
  const app = express()
  app.use('/v1/nfse', productAuth(verifier, check, onReject), (_req, res) => { res.json({ ok: true }) })
  app.use((err: any, _req: any, res: any, _next: any) => { res.status(500).json({ error: 'interno' }) })
  const server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  const port = (server.address() as AddressInfo).port
  /** Envia os BYTES do pedido como estão (cabeçalhos crus) e devolve status + corpo. */
  const raw = (headers: string[], path = '/v1/nfse/x') => new Promise<{ status: number; body: string; text: string }>((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1')
    let buf = ''
    s.setEncoding('latin1')
    s.on('data', d => { buf += d })
    s.on('end', () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0)
      resolve({ status, body: buf.slice(buf.indexOf('\r\n\r\n') + 4), text: buf })
    })
    s.on('error', reject)
    s.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n${headers.map(h => h + '\r\n').join('')}\r\n`)
  })
  return { raw, close: () => new Promise(r => server.close(r)) }
}

// =================================================================================================
// 1. O kid do ATACANTE — no log e na FRASE devolvida (reflexão)
// =================================================================================================
describe('1 — D-F157: o kid hostil vai SANEADO ao log e à frase; o token nunca vai ao log', () => {
  const SHAPE = /^[A-Za-z0-9._?-]{0,64}$/
  it('[RESISTIU] kid com CRLF, NUL, aspas, <script>, RTL (U+202E), emoji, 10 mil caracteres e JSON escapado: log e frase só com [A-Za-z0-9._-]/? e ≤ 64; a resposta não quebra linha', async () => {
    const seen: AuthReject[] = []
    const srv = await serve(r => { seen.push(r) })
    try {
      const RLO = String.fromCharCode(0x202e)                                             // override bidi (sem o caractere cru no fonte)
      const kids = ['a\r\nX-Injected: 1', 'a\u0000b', 'k"};alert(1);//', '<script>x</script>', RLO + 'evil', '\uD83D\uDE00', 'K'.repeat(10_000), '\\u000d\\u000a']
      for (const kid of kids) {
        const tok = forge(kid)
        const r = await srv.raw([`Authorization: Bearer ${tok}`])
        const body = JSON.parse(r.body)
        const shown = /\(kid (.*)\)$/.exec(body.error)?.[1] ?? '?!'
        expect([r.status, SHAPE.test(shown), SHAPE.test(last(seen).kid ?? '')]).toEqual([401, true, true])
        expect(r.text.slice(0, r.text.indexOf('\r\n\r\n'))).not.toMatch(/X-Injected/)     // nenhum cabeçalho forjado na resposta
        expect(JSON.stringify(last(seen))).not.toContain(tok)                            // o token NUNCA vai ao log
        expect(last(seen).authClass).toBe('unknown_kid')
      }
    } finally { await srv.close() }
  })

  it('[CORRIGIDO — D-F165 (= Q-F173 (a))] kid que não é texto (número, objeto, lista, booleano) ou vazio = "malformed" com a frase "Token sem kid" (como o setes-api: kid obrigatório); o log vai SEM kid', async () => {
    const seen: AuthReject[] = []
    const srv = await serve(r => { seen.push(r) })
    try {
      const out: string[] = []
      for (const kid of [7, { a: 1 }, ['k1'], true, '']) {
        const r = await srv.raw([`Authorization: Bearer ${sign(claims, kid, evilPem)}`])
        out.push(`${JSON.parse(r.body).error}|${last(seen).kid ?? '∅'}`)
      }
      expect(out).toEqual(Array(5).fill('Token sem kid (a chave que o assinou)|∅'))
      expect(seen.map(s => s.authClass)).toEqual(Array(5).fill('malformed'))
    } finally { await srv.close() }
  })

  it('[RESISTIU] token gigante: acima do teto de cabeçalho do Node (16 KB) a recusa é 431 ANTES do express (nada ao log, nada processado); logo abaixo dele, 401 com a classe e sem o token no log', async () => {
    const seen: AuthReject[] = []
    const srv = await serve(r => { seen.push(r) })
    try {
      const huge = await srv.raw([`Authorization: Bearer ${'A'.repeat(20_000)}`])
      expect([huge.status, seen.length]).toEqual([431, 0])
      const big = 'eyJ' + 'A'.repeat(14_000)
      const r = await srv.raw([`Authorization: Bearer ${big}`])
      expect([r.status, seen.map(s => s.authClass)]).toEqual([401, ['malformed']])
      expect(JSON.stringify(seen)).not.toContain(big)
    } finally { await srv.close() }
  })
})

// =================================================================================================
// 2. O cabeçalho Authorization como chega de verdade
// =================================================================================================
describe('2 — D-F157: a CLASSE contra o cabeçalho cru', () => {
  it('[RESISTIU] espaços sobrando (`Bearer   <tok>   `) passam (trim do Node + do middleware); `Bearer` sem token e sem cabeçalho = missing', async () => {
    const seen: AuthReject[] = []
    const srv = await serve(r => { seen.push(r) })
    try {
      expect((await srv.raw([`Authorization: Bearer    ${sign()}    `])).status).toBe(200)
      expect((await srv.raw(['Authorization: Bearer '])).status).toBe(401)
      expect((await srv.raw([])).status).toBe(401)
      // o Node apara o espaço final do valor: `Bearer ` chega como `Bearer` — "token ausente" é a leitura certa
      expect(seen.map(s => s.authClass)).toEqual(['missing', 'missing'])
    } finally { await srv.close() }
  })

  it('[CORRIGIDO R6-ADV-03 LOW] o esquema em minúsculas (`bearer <token VÁLIDO>` — o esquema de autenticação é insensível a caixa, RFC 7235 §2.1) e um esquema estranho (`Token <tok>`) caem na classe "missing" ("Token ausente"): o log diz que NÃO veio token quando veio um — o suporte procura o problema no lugar errado (um proxy/cliente que reescreve a caixa vira "o app não manda o token"). Correção sugerida: cabeçalho presente com outro esquema = "malformed"', async () => {
    const seen: AuthReject[] = []
    const srv = await serve(r => { seen.push(r) })
    try {
      await srv.raw([`Authorization: bearer ${sign()}`])
      await srv.raw([`Authorization: Token ${sign()}`])
      expect(seen.map(s => s.authClass)).toEqual(['malformed', 'malformed'])
    } finally { await srv.close() }
  })

  it('[RESISTIU] o 401 do conferidor de identidade = identity_mismatch COM a institution; erro NÃO-HTTP do conferidor (banco fora) = next(err) → 500, nada no log do 401; a frase do kid desconhecido é a do saneado (nunca o cru)', async () => {
    const seen: AuthReject[] = []
    let mode: 'mismatch' | 'db' = 'mismatch'
    const srv = await serve(r => { seen.push(r) }, async () => {
      if (mode === 'mismatch') throw new HttpError(401, 'Token não corresponde', undefined, 'INSTITUTION_MISMATCH')
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    })
    try {
      const a = await srv.raw([`Authorization: Bearer ${sign()}`])
      mode = 'db'
      const b = await srv.raw([`Authorization: Bearer ${sign()}`])
      expect([a.status, b.status]).toEqual([401, 500])
      expect(seen).toEqual([{ authClass: 'identity_mismatch', kid: undefined, institutionId: 3, route: 'GET /v1/nfse/x' }])
    } finally { await srv.close() }
  })
})

// =================================================================================================
// 3. O LIMITE por classe por minuto sob rajada
// =================================================================================================
describe('3 — D-F157: o throttle do log sob rajada', () => {
  it('[RESISTIU] 70 mil recusas numa janela, nas 7 classes: no máximo 5 linhas por classe (35); na janela seguinte, UMA linha de "suprimidas" por classe com a conta EXATA; memória sem crescer com o volume (lista fechada de classes)', () => {
    const warn = jest.fn()
    let t = 1_000
    const log = authRejectLog({ warn }, 5, () => t)
    const classes: AuthRejectClass[] = ['missing', 'malformed', 'unknown_kid', 'expired', 'invalid', 'no_identity', 'identity_mismatch']
    for (let i = 0; i < 70_000; i++) log({ authClass: classes[i % 7], kid: `k${i}`, route: 'GET /x' })
    expect(warn).toHaveBeenCalledTimes(35)
    t += 60_000
    log({ authClass: 'missing', route: 'GET /x' })
    const summaries = warn.mock.calls.slice(35).filter(c => (c[1] as any).suppressed !== undefined).map(c => [(c[1] as any).authClass, (c[1] as any).suppressed])
    expect(summaries).toEqual(classes.map(c => [c, 9_995]))
  })

  it('[DECIDIDO D-F167 (= Q-F175 (b)) — era R6-ADV-01 LOW] o limite é só POR CLASSE: um anônimo forja tokens com kid à vontade (o kid é lido ANTES da assinatura — basta um par RSA qualquer) e 5 recusas "unknown_kid" por minuto ocupam a cota inteira; o kid REAL de uma rotação mal publicada (o caso para o qual a D-F157 existe — "o suporte só sabia pelo telefone") NÃO aparece em nenhuma linha, e o resumo da janela seguinte traz só a CONTA (sem os kids). Correção sugerida: a 1ª ocorrência de cada kid DISTINTO na janela vai ao log (conjunto limitado, ex.: 16) ou o resumo leva os kids distintos (saneados, limitados)', async () => {
    const warn = jest.fn()
    let t = 5_000
    const onReject = authRejectLog({ warn }, 5, () => t)
    const app = express()
    app.use('/v1/nfse', productAuth(verifier, undefined, onReject), (_req, res) => { res.json({ ok: true }) })
    const server = app.listen(0)
    await new Promise(r => server.once('listening', r))
    const port = (server.address() as AddressInfo).port
    const get = (tok: string) => new Promise<number>((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1'); let b = ''
      s.setEncoding('latin1'); s.on('data', d => { b += d }); s.on('error', reject)
      s.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(b)?.[1] ?? 0)))
      s.write(`GET /v1/nfse/x HTTP/1.1\r\nHost: x\r\nConnection: close\r\nAuthorization: Bearer ${tok}\r\n\r\n`)
    })
    try {
      for (let i = 0; i < 6; i++) await get(sign(claims, `ruido${i}`, evilPem))   // o anônimo: chave própria, kid inventado
      expect(await get(sign(claims, 'k2026-11', evilPem))).toBe(401)              // a sessão REAL com a chave nova ainda não publicada
      t += 60_000
      await get(sign(claims, 'ruido9', evilPem))                                 // a janela seguinte (traz o resumo)
      const logged = JSON.stringify(warn.mock.calls)
      expect(logged).toContain('k2026-11')
    } finally { await new Promise(r => server.close(r)) }
  })

  it('[CORRIGIDO R6-ADV-02 LOW] relógio que VOLTA (ajuste do NTP / da VM): a janela usa `Date.now()` e só vira quando `t - início >= 60 s` — com o relógio 1 h para trás, ela fica ABERTA por 1 h e toda recusa além da 5ª de cada classe some calada nesse tempo (o resumo só chega depois). Correção sugerida: `t < início` também abre janela nova (ou relógio monotônico — `performance.now()`)', () => {
    const warn = jest.fn()
    let t = 10_000_000
    const log = authRejectLog({ warn }, 5, () => t)
    for (let i = 0; i < 5; i++) log({ authClass: 'unknown_kid', kid: 'velho', route: 'GET /x' })
    t -= 3_600_000                                                            // o relógio volta 1 h
    for (let i = 0; i < 3; i++) { t += 61_000; log({ authClass: 'unknown_kid', kid: `novo${i}`, route: 'GET /x' }) }
    expect(JSON.stringify(warn.mock.calls)).toContain('novo0')
  })

  it('[FATO — decidido; R6-SOC-02 corrigido] o resumo das suprimidas só sai na 1ª recusa da janela SEGUINTE: rajada seguida de silêncio nunca é resumida; a recusa 3 h depois diz QUANDO a janela suprimida começou (não "no minuto anterior")', () => {
    const warn = jest.fn()
    let t = 0
    const log = authRejectLog({ warn }, 5, () => t)
    for (let i = 0; i < 8; i++) log({ authClass: 'expired', route: 'GET /x' })
    expect(warn).toHaveBeenCalledTimes(5)
    t += 3 * 3_600_000
    log({ authClass: 'expired', route: 'GET /x' })
    expect(warn.mock.calls[5][0]).toMatch(/3 recusa\(s\) "expired" suprimida\(s\) no minuto iniciado em 1970-01-01T00:00:00\.000Z/)
  })

  it('[RESISTIU] o log que LANÇA no meio do resumo nunca derruba a resposta e o log volta quando ele volta (a janela não fica presa)', async () => {
    let broken = true
    const lines: string[] = []
    let t = 0
    const onReject = authRejectLog({ warn: (m: string) => { if (broken) throw new Error('stderr fechado'); lines.push(m) } }, 1, () => t)
    const srv = await serve(r => onReject(r))
    try {
      expect((await srv.raw([])).status).toBe(401)
      expect((await srv.raw([])).status).toBe(401)
      t += 60_000
      expect((await srv.raw([])).status).toBe(401)                      // o resumo lança aqui
      broken = false
      expect((await srv.raw([])).status).toBe(401)
      expect(lines.length).toBeGreaterThan(0)
    } finally { await srv.close() }
  })

  it('[RESISTIU] safeKid: o saneamento é por unidade UTF-16 e o corte em 64 vem DEPOIS — nunca devolve mais que 64 nem caractere fora da lista', () => {
    for (const k of ['😀'.repeat(100), 'a'.repeat(65), '\n'.repeat(70), '']) {
      const s = safeKid(k)!
      expect([s.length <= 64, /^[A-Za-z0-9._?-]*$/.test(s)]).toEqual([true, true])
    }
    expect([safeKid(undefined), safeKid(null), safeKid(5)]).toEqual([undefined, undefined, undefined])
  })
})
