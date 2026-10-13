/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA da Rodada 7 (2026-10-13 — skill Infra-IA/skills-genericas/testar-adversarial.md;
// prompt_apis_fiscais_isoladas.md §7 D-F165/D-F167, §22.22). Alvo: núcleo `c0a8d35..8704085` — o verificador exige `kid` e `exp`
// (D-F165), o log do 401 mostra a 1ª ocorrência de cada kid DISTINTO por classe na janela (D-F167, conjunto ≤ 16), resumo das suprimidas
// com o início da janela (R6-SOC-02), rota ASCII ≤ 200 (R6-SOC-03), `alg` no log da classe invalid (R6-SOC-04), relógio que volta abre
// janela nova (R6-ADV-02) e outro esquema = malformed (R6-ADV-03).
// Convenção: achado CONFIRMADO = `it.failing('[ACHADO R7-ADV-NN SEV] …')` (o teste descreve o comportamento CERTO e hoje falha);
// `it('[RESISTIU] …')` = o ataque foi barrado; `it('[FATO …]')` = comportamento atual registrado (decidido, ou depende de decisão).
// Para LER a mensagem de um achado: ADV_SHOW=1 npx jest adversarial-r7-gate (roda os `failing` como `it` comum).
// Nada aqui toca banco: o middleware REAL (e o `errorMiddleware` REAL do núcleo) atrás de um express REAL numa porta efêmera, com os
// bytes CRUS no socket; tokens assinados com a chave REAL (o que só o setes-api faz) ou forjados por um anônimo (assinatura lixo).
import net from 'net'
import { AddressInfo } from 'net'
import crypto, { generateKeyPairSync } from 'crypto'
import express from 'express'
import jwt from 'jsonwebtoken'
import { errorMiddleware } from '../http/http'
import { logger } from '../log/logger'
import { ProductTokenVerifier, ProductAuthError, productAuth, authRejectLog, AuthReject } from '../auth/product-jwt'

const failing: jest.It['failing'] = process.env.ADV_SHOW === '1' ? (it as any) : it.failing

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
const evilPem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
const verifier = ProductTokenVerifier.of({ k1: pubPem })
const claims = { institutionId: 3, userId: 7, role: 'admin', schemaName: 'setes_x' }
const b64u = (b: Buffer) => b.toString('base64url')

/**
 * Assina os BYTES do cabeçalho e do corpo como estão (o `jwt.sign` recusa `exp` que não é número — quem tem a chave privada não passa
 * pela biblioteca obrigatoriamente). [key] = a REAL por padrão; a do atacante quando a assinatura é lixo.
 */
function signRaw(header: object, payloadJson: string, key = privPem): string {
  const h = b64u(Buffer.from(JSON.stringify(header), 'utf8'))
  const p = b64u(Buffer.from(payloadJson, 'utf8'))
  const s = crypto.createSign('RSA-SHA256').update(`${h}.${p}`).sign(key)
  return `${h}.${p}.${b64u(s)}`
}
const realWith = (exp: string) => signRaw({ alg: 'RS256', typ: 'JWT', kid: 'k1' }, `{"institutionId":3,"userId":7,"role":"admin","schemaName":"setes_x","exp":${exp}}`)
const forge = (header: object, payloadText: string) =>
  `${b64u(Buffer.from(JSON.stringify(header), 'utf8'))}.${b64u(Buffer.from(payloadText, 'utf8'))}.${b64u(Buffer.from('lixo'))}`

/** O app REAL: express + o middleware REAL + o errorMiddleware REAL do núcleo; [onReject] captura o que iria ao log do 401. */
async function serve(onReject: (r: AuthReject) => void) {
  const app = express()
  app.use('/v1/nfse', productAuth(verifier, undefined, onReject), (_req, res) => { res.json({ ok: true }) })
  app.use(errorMiddleware)
  const server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  const port = (server.address() as AddressInfo).port
  const raw = (headers: string[], path = '/v1/nfse/x') => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1')
    let buf = ''
    s.setEncoding('latin1')
    s.on('data', d => { buf += d })
    s.on('end', () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0), body: buf.slice(buf.indexOf('\r\n\r\n') + 4) }))
    s.on('error', reject)
    s.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n${headers.map(h => h + '\r\n').join('')}\r\n`)
  })
  return { raw, close: () => new Promise(r => server.close(r)) }
}

const classOf = (fn: () => unknown): [string, string] => {
  try { fn(); return ['passou', ''] } catch (e: any) { return [e instanceof ProductAuthError ? e.authClass : `NÃO-HTTP:${e?.name}`, e?.message] }
}

// =================================================================================================
// 1. D-F165 — kid e exp obrigatórios; a ORDEM das checagens
// =================================================================================================
describe('1 — D-F165: kid e exp contra tipos estranhos e a ordem das checagens', () => {
  it('[RESISTIU] `exp` de tipo estranho assinado com a chave REAL: texto, null, booleano, lista, objeto = invalid; 1e400 (vira Infinity no JSON.parse) = "sem validade"; negativo, zero e o instante já passado = expired; nada vira 500', () => {
    const cases: [string, [string, string]][] = [
      ['"9999999999"', ['invalid', 'Token inválido']],
      ['null', ['invalid', 'Token inválido']],
      ['true', ['invalid', 'Token inválido']],
      ['[9999999999]', ['invalid', 'Token inválido']],
      ['{}', ['invalid', 'Token inválido']],
      ['1e400', ['invalid', 'Token sem validade (exp)']],
      ['-1', ['expired', 'Token expirado']],
      ['0', ['expired', 'Token expirado']],
      [String(Math.floor(Date.now() / 1000) - 1), ['expired', 'Token expirado']],
    ]
    for (const [exp, expected] of cases) expect([exp, classOf(() => verifier.verify(realWith(exp)))]).toEqual([exp, expected])
    expect(classOf(() => verifier.verify(realWith(String(Math.floor(Date.now() / 1000) + 3600))))).toEqual(['passou', ''])
  })

  it('[RESISTIU] a ordem não vira oráculo: sem exp com a assinatura LIXO = "Token inválido" (a frase "sem validade" só depois da assinatura certa); sem kid = "sem kid" com qualquer assinatura (a regra é pública, nada secreto); kid desconhecido = unknown_kid antes da assinatura (o kid não é segredo — D-F157)', () => {
    const noExpEvil = signRaw({ alg: 'RS256', kid: 'k1' }, JSON.stringify(claims), evilPem)
    expect(classOf(() => verifier.verify(noExpEvil))).toEqual(['invalid', 'Token inválido'])
    const noExpReal = signRaw({ alg: 'RS256', kid: 'k1' }, JSON.stringify(claims))
    expect(classOf(() => verifier.verify(noExpReal))).toEqual(['invalid', 'Token sem validade (exp)'])
    expect(classOf(() => verifier.verify(signRaw({ alg: 'RS256' }, JSON.stringify(claims), evilPem)))[0]).toBe('malformed')
    expect(classOf(() => verifier.verify(signRaw({ alg: 'RS256', kid: 'kX' }, JSON.stringify(claims), evilPem)))[0]).toBe('unknown_kid')
  })

  it('[RESISTIU] kid com nome de propriedade de objeto (`__proto__`, `constructor`, `toString`, `hasOwnProperty`, `valueOf`) = unknown_kid (o mapa é `Map`, sem protótipo); kid de tipo estranho (0, false, null, [], {}, "") = malformed "sem kid"; nenhum vira 500', () => {
    for (const kid of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect([kid, classOf(() => verifier.verify(forge({ alg: 'RS256', kid }, JSON.stringify(claims))))[0]]).toEqual([kid, 'unknown_kid'])
    }
    for (const kid of [0, false, null, [], {}, '']) {
      expect([kid, classOf(() => verifier.verify(forge({ alg: 'RS256', kid }, JSON.stringify(claims))))]).toEqual([kid, ['malformed', 'Token sem kid (a chave que o assinou)']])
    }
  })

  it('[RESISTIU] cabeçalho do JWT que não é objeto (número, texto, lista, `null`) ou que não é JSON = malformed "Token inválido" (o `jws` devolve null ou o kid lido é undefined) — sem 500', () => {
    const rawHeader = (h: string) => `${b64u(Buffer.from(h))}.${b64u(Buffer.from(JSON.stringify(claims)))}.${b64u(Buffer.from('x'))}`
    for (const h of ['5', '"txt"', '[1,2]', 'null', 'não-json', '{"kid":']) {
      const [cls] = classOf(() => verifier.verify(rawHeader(h)))
      expect([h, cls]).toEqual([h, 'malformed'])
    }
  })

  it('[CORRIGIDO R7-ADV-01 MEDIUM] cabeçalho `{"typ":"JWT"}` + corpo que NÃO é JSON (um anônimo, assinatura lixo, 3 partes base64url válidas): o `jws.decode` faz `JSON.parse` do corpo quando `typ === "JWT"` e LANÇA SyntaxError — o `jwt.decode` do `verify()` está FORA do try (o `jwt.verify` da biblioteca o protege; o nosso decode prévio não). Efeito: o `productAuth` repassa o erro não-HTTP (`next(err)`) → `errorMiddleware` → 500 "Erro interno" com ref, `logger.error` com o STACK (e um trecho do corpo do atacante na mensagem do JSON.parse) a CADA requisição — o throttle do log do 401 (D-F157/D-F167) não vale para ele (nem a classe vai ao log do 401). O setes-api devolve 401 para o MESMO token (o `authMiddleware` dele converte o não-HTTP em 401) — dois leitores, duas respostas. Correção sugerida: `try { jwt.decode(...) } catch { throw new ProductAuthError("Token inválido", "malformed") }` (o mesmo desfecho do token que não decodifica)', async () => {
    const seen: AuthReject[] = []
    const errorLog = jest.spyOn(logger, 'error').mockImplementation(() => undefined)
    const srv = await serve(r => { seen.push(r) })
    try {
      const tok = forge({ typ: 'JWT', alg: 'RS256', kid: 'k1' }, 'nao-e-json-' + 'A'.repeat(40))
      const results: number[] = []
      for (let i = 0; i < 20; i++) results.push((await srv.raw([`Authorization: Bearer ${tok}`])).status)
      // o comportamento CERTO: 401 malformed, no log do 401 (throttled), NENHUM log de erro interno
      expect(results.every(s => s === 401)).toBe(true)
      expect(seen.length).toBe(20)
      expect(seen.every(r => r.authClass === 'malformed')).toBe(true)
      expect(errorLog).not.toHaveBeenCalled()
    } finally {
      await srv.close()
      errorLog.mockRestore()
    }
  })

  it.skip('[SUPERADO pelo R7-ADV-01 corrigido — agora 401 malformed no log do 401, nenhum 500] o FATO de antes: 20 requisições anônimas com esse token = 20 respostas 500 `INTERNAL` com ref + 20 `logger.error` com stack (sem throttle) e ZERO linhas no log do 401; a mensagem logada traz um trecho do corpo do atacante', async () => {
    const seen: AuthReject[] = []
    const errorLog = jest.spyOn(logger, 'error').mockImplementation(() => undefined)
    const srv = await serve(r => { seen.push(r) })
    try {
      const tok = forge({ typ: 'JWT', alg: 'RS256', kid: 'k1' }, 'nao-e-json-' + 'A'.repeat(40))
      const out: { status: number; body: string }[] = []
      for (let i = 0; i < 20; i++) out.push(await srv.raw([`Authorization: Bearer ${tok}`]))
      expect(out.map(o => o.status)).toEqual(Array(20).fill(500))
      expect(JSON.parse(out[0].body)).toMatchObject({ error: 'Erro interno', code: 'INTERNAL' })
      expect(seen).toHaveLength(0)
      expect(errorLog).toHaveBeenCalledTimes(20)
      const meta = errorLog.mock.calls[0][1] as any
      expect(meta.err.stack).toMatch(/SyntaxError/)
      expect(meta.err.message).toMatch(/nao-e-json/)
      // sem `typ: "JWT"` o mesmo corpo vira payload texto e é recusado certo (malformed não — o kid existe: invalid pela assinatura)
      const semTyp = await srv.raw([`Authorization: Bearer ${forge({ alg: 'RS256', kid: 'k1' }, 'nao-e-json')}`])
      expect(semTyp.status).toBe(401)
    } finally {
      await srv.close()
      errorLog.mockRestore()
    }
  })

  it('[FATO — limite conhecido, igual ao setes-api] `exp` FINITO gigante (1e15 s ≈ ano 33.658) assinado com a chave real é aceito — "nunca vale para sempre" na prática; o setes-api também aceita (dois leitores, uma resposta). Só quem tem a chave privada forja; o risco real é um bug de assinatura (ex.: `exp` em milissegundos) — ver Q-F178-ADV-03', () => {
    expect(classOf(() => verifier.verify(realWith('1e15')))).toEqual(['passou', ''])
    expect(classOf(() => verifier.verify(realWith(String(Date.now() + 3_600_000))))).toEqual(['passou', ''])   // "exp em ms": ~56 mil anos
  })
})

// =================================================================================================
// 2. D-F167 — o kid DISTINTO no log sob rajada
// =================================================================================================
describe('2 — D-F167: o conjunto de kids (≤ 16) sob ataque', () => {
  it('[DECIDIDO D-F170 (= Q-F178 (b)) — era R7-ADV-02 LOW] o conjunto de 16 kids é preenchido por QUEM CHEGA PRIMEIRO na janela: um anônimo manda 16 kids inventados no início de cada minuto (16 req/min — antes da D-F167 bastavam 5) e o kid REAL de uma rotação mal publicada — recusado MIL vezes na mesma janela — não aparece em nenhuma linha do log nem no resumo da janela seguinte (que traz só a CONTA). A D-F167 prometia "o kid real sempre aparece" (Rec. da Q-F175); o teto torna a promessa barata de quebrar. Correção sugerida (Q-F178-ADV-01): o resumo das suprimidas leva os kids mais frequentes da janela (contagem por kid num conjunto limitado com substituição do menos frequente — "space-saving", k = 16) — o kid de uma rotação quebrada é o de TODOS os usuários e domina; o atacante teria de superar o tráfego real com CADA kid inventado', () => {
    const warn = jest.fn()
    let t = 0
    const log = authRejectLog({ warn }, 5, () => t, 16)
    for (let i = 0; i < 16; i++) log({ authClass: 'unknown_kid', kid: `inventado${i}`, route: 'GET /v1/nfse/x' })
    for (let i = 0; i < 1000; i++) log({ authClass: 'unknown_kid', kid: 'k2026-11', route: 'GET /v1/nfse/x' })
    t = 60_000
    log({ authClass: 'missing', route: 'GET /v1/nfse/x' })
    const everything = JSON.stringify(warn.mock.calls)
    expect(everything).toContain('k2026-11')
  })

  it('[FATO — base do R7-ADV-02] hoje: as 16 linhas são dos inventados, o kid real (1000×) some, e o resumo diz só "1000 suprimidas" — e o conjunto é COMUM às classes: os 16 `unknown_kid` também calam a 1ª ocorrência de um kid conhecido em `invalid` quando a cota de `invalid` já está cheia', () => {
    const warn = jest.fn()
    let t = 0
    const log = authRejectLog({ warn }, 5, () => t, 16)
    for (let i = 0; i < 16; i++) log({ authClass: 'unknown_kid', kid: `inventado${i}`, route: 'GET /x' })
    for (let i = 0; i < 1000; i++) log({ authClass: 'unknown_kid', kid: 'k2026-11', route: 'GET /x' })
    for (let i = 0; i < 5; i++) log({ authClass: 'invalid', kid: 'k1', alg: 'HS256', route: 'GET /x' })   // 1ª de invalid:k1 já não entra no conjunto (cheio); cota de invalid enche
    log({ authClass: 'invalid', kid: 'k2026-10', alg: 'RS256', route: 'GET /x' })                        // a pública ERRADA publicada: calada
    expect(warn.mock.calls.filter(c => c[1].authClass === 'unknown_kid').map(c => c[1].kid)).toEqual(Array.from({ length: 16 }, (_, i) => `inventado${i}`))
    expect(warn.mock.calls.filter(c => c[1].authClass === 'invalid').map(c => c[1].kid)).toEqual(['k1', 'k1', 'k1', 'k1', 'k1'])
    t = 60_000
    log({ authClass: 'missing', route: 'GET /x' })
    const summaries = warn.mock.calls.filter(c => 'suppressed' in c[1]).map(c => c[1])
    expect(summaries).toEqual([
      { authClass: 'unknown_kid', suppressed: 1000, windowStartedAt: new Date(0).toISOString() },
      { authClass: 'invalid', suppressed: 1, windowStartedAt: new Date(0).toISOString() },
    ])
  })

  it('[RESISTIU] 100 mil kids distintos numa janela: só 16 linhas (memória fixa — o conjunto não cresce), o resumo seguinte conta EXATO (100.000 − 16), a janela seguinte zera o conjunto (um kid novo volta a aparecer), e kid com ":" não colide entre classes (o saneamento troca ":" por "?")', () => {
    const warn = jest.fn()
    let t = 0
    const log = authRejectLog({ warn }, 5, () => t, 16)
    for (let i = 0; i < 100_000; i++) log({ authClass: 'unknown_kid', kid: `f${i}`, route: 'GET /x' })
    expect(warn).toHaveBeenCalledTimes(16)
    t = 61_000
    log({ authClass: 'unknown_kid', kid: 'f0', route: 'GET /x' })
    expect(warn.mock.calls[16][1]).toEqual({ authClass: 'unknown_kid', suppressed: 99_984, windowStartedAt: new Date(0).toISOString() })
    expect(warn.mock.calls[17][1].topKids).toHaveLength(16)                                  // D-F170: a linha dos kids mais frequentes (16 contadores)
    expect(warn.mock.calls[18][1].kid).toBe('f0')
    // o kid do log chega SANEADO pelo verificador (safeKid) — ":" nunca sobrevive; a chave do conjunto "classe:kid" não colide
    const srvKid = classOf(() => verifier.verify(forge({ alg: 'RS256', kid: 'invalid:k1' }, JSON.stringify(claims))))
    expect(srvKid).toEqual(['unknown_kid', 'Token assinado com chave desconhecida (kid invalid?k1)'])
  })

  it('[RESISTIU] resumo EXATO com classes misturadas e o relógio que VOLTA no meio: cada janela resume só o que não foi ao log, com o início DELA; nenhuma classe com tudo logado gera resumo', () => {
    const warn = jest.fn()
    let t = 1_000_000
    const log = authRejectLog({ warn }, 5, () => t, 16)
    for (let i = 0; i < 7; i++) log({ authClass: 'missing', route: 'GET /x' })
    for (let i = 0; i < 3; i++) log({ authClass: 'malformed', route: 'GET /x' })
    for (let i = 0; i < 20; i++) log({ authClass: 'unknown_kid', kid: `z${i}`, route: 'GET /x' })
    t = 500_000                                                                                       // relógio VOLTOU: janela nova
    log({ authClass: 'expired', kid: 'k1', route: 'GET /x' })
    const s1 = warn.mock.calls.filter(c => 'suppressed' in c[1]).map(c => c[1])
    expect(s1).toEqual([
      { authClass: 'missing', suppressed: 2, windowStartedAt: new Date(1_000_000).toISOString() },
      { authClass: 'unknown_kid', suppressed: 4, windowStartedAt: new Date(1_000_000).toISOString() },
    ])
    for (let i = 0; i < 9; i++) log({ authClass: 'expired', kid: 'k1', route: 'GET /x' })            // 10 expired:k1 → 5 logadas
    t = 560_000
    log({ authClass: 'missing', route: 'GET /x' })
    const s2 = warn.mock.calls.filter(c => 'suppressed' in c[1]).map(c => c[1]).slice(2)
    expect(s2).toEqual([{ authClass: 'expired', suppressed: 5, windowStartedAt: new Date(500_000).toISOString() }])
  })

  it('[RESISTIU] `alg` hostil (CRLF, aspas, 10 mil caracteres) no token de kid conhecido vai SANEADO e curto ao log da classe invalid; a rota com bytes de controle sai ASCII ≤ 200', async () => {
    const seen: AuthReject[] = []
    const srv = await serve(r => { seen.push(r) })
    try {
      for (const alg of ['RS256\r\nX-Inj: 1', 'a"};x', 'H'.repeat(10_000)]) {
        const tok = forge({ alg, kid: 'k1' }, JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + 600 }))
        const r = await srv.raw([`Authorization: Bearer ${tok}`])
        const last = seen[seen.length - 1]
        expect([r.status, last.authClass, /^[A-Za-z0-9._?-]{1,64}$/.test(last.alg ?? '')]).toEqual([401, 'invalid', true])
      }
    } finally { await srv.close() }
    const warn = jest.fn()
    authRejectLog({ warn })({ authClass: 'missing', route: 'GET /v1/nfse/\u0000\u001b[31m' + 'ÿ'.repeat(500) })
    expect(warn.mock.calls[0][1].route).toMatch(/^[\x20-\x7e]{1,200}$/)
  })
})
