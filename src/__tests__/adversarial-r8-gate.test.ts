/// <reference types="jest" />
// GATE ADVERSARIAL independente do DELTA da Rodada 8 (2026-10-13 — skill Infra-IA/skills-genericas/testar-adversarial.md;
// prompt_apis_fiscais_isoladas.md §7 D-F157/D-F167/D-F170). Alvo: núcleo `8704085..92811fc` — o resumo da janela do log do 401 com os
// kids MAIS FREQUENTES (Space-Saving, 16 contadores, linha própria só quando houve supressão — D-F170) e o token que não decodifica
// (corpo não-JSON) = 401 malformed, nunca 500 (correção do R7-ADV-01).
// Convenção: achado CONFIRMADO = `it.failing('[ACHADO R8-ADV-NN SEV] …')` (o teste descreve o comportamento CERTO e hoje falha);
// `it('[RESISTIU] …')` = o ataque foi barrado; `it('[FATO …]')` = comportamento atual registrado.
// Para LER a mensagem de um achado: ADV_SHOW=1 npx jest adversarial-r8-gate (roda os `failing` como `it` comum).
// Nada aqui toca banco: o log REAL (`authRejectLog`) com relógio e `warn` simulados; o middleware REAL + o `errorMiddleware` REAL do
// núcleo atrás de um express REAL numa porta efêmera (bytes crus no socket); tokens forjados por um anônimo ou assinados com a chave REAL.
import net from 'net'
import { AddressInfo } from 'net'
import crypto, { generateKeyPairSync } from 'crypto'
import express from 'express'
import { errorMiddleware } from '../http/http'
import { logger } from '../log/logger'
import { ProductTokenVerifier, ProductAuthError, productAuth, authRejectLog, AuthReject } from '../auth/product-jwt'

const failing: jest.It['failing'] = process.env.ADV_SHOW === '1' ? (it as any) : it.failing

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
const verifier = ProductTokenVerifier.of({ k1: pubPem })
const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const signRaw = (header: string, payload: string): string => {
  const x = `${b64u(header)}.${b64u(payload)}`
  return `${x}.${crypto.createSign('RSA-SHA256').update(x).sign(privateKey).toString('base64url')}`
}
const classOf = (tok: string): string => {
  try { verifier.verify(tok); return 'passou' } catch (e: any) { return e instanceof ProductAuthError ? e.authClass : `NÃO-HTTP:${e?.name}` }
}

type Top = { authClass: string; kid: string; count: number }
/** Roda um fluxo de recusas numa janela e fecha a janela com 1 recusa sem kid; devolve a linha dos kids mais frequentes. */
function windowOf(stream: AuthReject[], maxKids = 16): { top: Top[] | undefined; warn: jest.Mock } {
  const warn = jest.fn()
  let t = 0
  const log = authRejectLog({ warn }, 5, () => t, maxKids)
  for (const r of stream) log(r)
  t = 60_000
  log({ authClass: 'missing', route: 'GET /v1/nfse/x' })
  const top = warn.mock.calls.map(c => c[1]).find(m => m && m.topKids)?.topKids as Top[] | undefined
  return { top, warn }
}
const REAL = 'k2026-11'
const real = (): AuthReject => ({ authClass: 'unknown_kid', kid: REAL, route: 'GET /v1/nfse/x' })
let seq = 0
const forged = (): AuthReject => ({ authClass: 'unknown_kid', kid: `forjado${seq++}`, route: 'GET /v1/nfse/x' })
const hasReal = (top: Top[] | undefined) => !!top?.some(x => x.kid === REAL)

// =================================================================================================
// 1. D-F170 — Space-Saving sob padrões adversariais
// =================================================================================================
describe('1 — D-F170: os kids mais frequentes contra quem manda volume', () => {
  failing('[LIMITE CONHECIDO — D-F173 (= Q-F181 (a)) — era R8-ADV-01 LOW] a GARANTIA escrita no JSDoc do `authRejectLog` ("todo kid com mais de 1/(maxKids+1) das recusas com kid fica na lista") é falsa: o Space-Saving com k contadores só garante quem tem MAIS DE 1/k (a soma dos contadores é N, o mínimo ≤ N/k e o despejado tem frequência ≤ mínimo). Contraexemplo exato: o kid real com 50 recusas no começo da janela e 751 kids inventados distintos depois (16 req/s por um minuto) — o real tem 50/801 = 6,24 % (> 1/17 = 5,88 %) e SOME da linha "kids mais frequentes". Correção sugerida: a frase passa a dizer "mais de 1/16" (e o resto do R8-ADV-01)', () => {
    const s: AuthReject[] = []
    for (let i = 0; i < 50; i++) s.push(real())
    for (let i = 0; i < 751; i++) s.push(forged())
    const { top } = windowOf(s)
    expect(50 / 801).toBeGreaterThan(1 / 17)
    expect(hasReal(top)).toBe(true)
  })

  failing('[LIMITE CONHECIDO — D-F173 (= Q-F181 (a)) — era R8-ADV-01 LOW] a promessa da D-F170 no JSDoc e no commit ("o de uma rotação mal publicada … vence QUALQUER volume de kids inventados") não vale: um anônimo que manda 16 kids inventados DISTINTOS para cada recusa do kid real (intercalados — o kid é lido antes da assinatura, não precisa de chave) tira o kid real da linha. Com o kid real em 100 recusas/min bastam 1.600 recusas/min (~27 req/s, nenhuma credencial) — e o volume do atacante cresce LINEAR com o tráfego real, não "com CADA kid inventado" (o que a recomendação da Q-F178 supôs: o novato do Space-Saving herda o mínimo + 1, então kid visto UMA vez entra com a contagem de quem foi despejado). Correção sugerida (Q-F181-ADV-01): documentar o limite real (> 1/16 das recusas com kid; um volume ≥ 15× do real o esconde — e o próprio resumo das suprimidas o denuncia) e, para a linha não mentir, guardar o ERRO de cada contador (Space-Saving clássico: `count − erro` = mínimo garantido) e imprimir o garantido', () => {
    const s: AuthReject[] = []
    for (let i = 0; i < 100; i++) { s.push(real()); for (let j = 0; j < 16; j++) s.push(forged()) }
    const { top } = windowOf(s)
    expect(hasReal(top)).toBe(true)
  })

  it('[FATO — base do R8-ADV-01] o limite é o do algoritmo: intercalado 1:15 (6,25 % — acima de 1/16) o kid real FICA; 1:16 (5,88 %) ele SAI; rajada de 1.500 inventados DEPOIS de 100 recusas reais ele fica, 1.600 ele sai. E a linha não separa a contagem HERDADA da real: no 1:15 o kid real aparece com ~100 e cada inventado (visto UMA vez) também com ~100 — o operador não tem como saber qual é o kid de verdade só pela linha', () => {
    const run = (ratio: number) => { const s: AuthReject[] = []; for (let i = 0; i < 100; i++) { s.push(real()); for (let j = 0; j < ratio; j++) s.push(forged()) } return windowOf(s).top }
    const burst = (n: number) => { const s: AuthReject[] = []; for (let i = 0; i < 100; i++) s.push(real()); for (let i = 0; i < n; i++) s.push(forged()); return windowOf(s).top }
    expect([hasReal(run(15)), hasReal(run(16)), hasReal(burst(1500)), hasReal(burst(1600))]).toEqual([true, false, true, false])
    const top = run(15)!
    const realCount = top.find(x => x.kid === REAL)!.count
    const forgedCounts = top.filter(x => x.kid !== REAL).map(x => x.count)
    expect(realCount).toBeGreaterThanOrEqual(100)                                     // nunca subestima (correto)
    expect(Math.max(...forgedCounts)).toBeGreaterThanOrEqual(realCount - 2)           // inventados (vistos 1×) com contagem do MESMO tamanho
    expect(top).toHaveLength(16)
  })

  it('[RESISTIU] 1 milhão de recusas numa janela com kids inventados distintos: memória fixa (16 contadores, 16 linhas de kid distinto + 5 da classe), a linha final tem ≤ 16 entradas e é curta; a contagem do resumo das suprimidas é EXATA; leva segundos, não minutos', () => {
    const s0 = Date.now()
    const warn = jest.fn()
    let t = 0
    const log = authRejectLog({ warn }, 5, () => t, 16)
    for (let i = 0; i < 1_000_000; i++) log({ authClass: 'unknown_kid', kid: `f${i}`, route: 'GET /x' })
    expect(warn).toHaveBeenCalledTimes(16)
    t = 60_000
    log({ authClass: 'missing', route: 'GET /x' })
    const metas = warn.mock.calls.map(c => c[1])
    expect(metas[16]).toEqual({ authClass: 'unknown_kid', suppressed: 1_000_000 - 16, windowStartedAt: new Date(0).toISOString() })
    expect(metas[17].topKids.length).toBe(16)
    expect(JSON.stringify(metas[17]).length).toBeLessThan(2_000)
    expect(metas[17].topKids.reduce((a: number, x: Top) => a + x.count, 0)).toBe(1_000_000)    // Space-Saving: a soma dos contadores = N
    expect(Date.now() - s0).toBeLessThan(30_000)
  })

  it('[RESISTIU] o kid na linha dos mais frequentes chega SANEADO pelo verificador (CRLF, aspas, NUL, RTL, 10 mil caracteres, ":" que tentaria colidir a chave "classe:kid") — só `[A-Za-z0-9._?-]` até 64; a classe da entrada é sempre uma da lista fechada; kids que viram o MESMO texto saneado somam no mesmo contador (não abrem 2)', async () => {
    const seen: AuthReject[] = []
    const app = express()
    app.use('/v1/nfse', productAuth(verifier, undefined, r => { seen.push(r) }), (_q, res) => { res.json({ ok: true }) })
    app.use(errorMiddleware)
    const server = app.listen(0)
    await new Promise(r => server.once('listening', r))
    const port = (server.address() as AddressInfo).port
    const hit = (tok: string) => new Promise<number>((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1')
      let buf = ''
      s.setEncoding('latin1')
      s.on('data', d => { buf += d })
      s.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0)))
      s.on('error', reject)
      s.write(`GET /v1/nfse/x HTTP/1.1\r\nHost: x\r\nConnection: close\r\nAuthorization: Bearer ${tok}\r\n\r\n`)
    })
    const hostile = ['a\r\nX-Inj: 1', 'b"};x', 'c\u0000d', '‮k1', 'H'.repeat(10_000), 'invalid:k1', 'expired:x', 'k:1', 'k?1']
    try {
      for (const kid of hostile) {
        const tok = `${b64u(JSON.stringify({ alg: 'RS256', kid }))}.${b64u('{}')}.${b64u('x')}`
        expect(await hit(tok)).toBe(401)
      }
    } finally { await new Promise(r => server.close(r)) }
    const warn = jest.fn()
    let t = 0
    const log = authRejectLog({ warn }, 0, () => t, 16)                                   // perMinute 0: tudo vira supressão (força a linha)
    for (const r of seen) log(r)
    for (let i = 0; i < 20; i++) log(r20(i))
    t = 60_000
    log({ authClass: 'missing', route: 'GET /x' })
    const top = warn.mock.calls.map(c => c[1]).find(m => m && m.topKids).topKids as Top[]
    for (const x of top) {
      expect(['missing', 'malformed', 'unknown_kid', 'expired', 'invalid', 'no_identity', 'identity_mismatch']).toContain(x.authClass)
      expect(x.kid).toMatch(/^[A-Za-z0-9._?-]{1,64}$/)
    }
    expect(top.filter(x => x.kid === 'k?1')).toEqual([{ authClass: 'unknown_kid', kid: 'k?1', count: 2 }])   // "k:1" e "k?1" = o mesmo texto
    function r20(i: number): AuthReject { return { authClass: 'expired', kid: `e${i % 3}`, route: 'GET /x' } }
  })

  it('[RESISTIU] relógio que VOLTA no meio de uma janela com kids: a janela velha sai com o resumo E a linha dos kids DELA (início dela), a nova começa com os contadores zerados — nada de uma janela vaza para a outra; janela sem nenhuma supressão não gera a linha', () => {
    const warn = jest.fn()
    let t = 1_000_000
    const log = authRejectLog({ warn }, 5, () => t, 16)
    for (let i = 0; i < 30; i++) log({ authClass: 'unknown_kid', kid: i % 2 ? 'velhoA' : 'velhoB', route: 'GET /x' })
    t = 400_000                                                                                         // VOLTOU
    for (let i = 0; i < 3; i++) log({ authClass: 'unknown_kid', kid: 'novo', route: 'GET /x' })
    t = 470_000
    log({ authClass: 'missing', route: 'GET /x' })
    const tops = warn.mock.calls.map(c => c[1]).filter(m => m && m.topKids)
    expect(tops).toEqual([{ windowStartedAt: new Date(1_000_000).toISOString(), topKids: [
      { authClass: 'unknown_kid', kid: 'velhoB', count: 15 }, { authClass: 'unknown_kid', kid: 'velhoA', count: 15 }] }])
  })
})

// =================================================================================================
// 2. O token que não decodifica — todas as formas (correção do R7-ADV-01)
// =================================================================================================
describe('2 — tokens que não decodificam: sempre uma classe do 401, nunca 500', () => {
  const H = JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: 'k1' })
  const H2 = JSON.stringify({ alg: 'RS256', kid: 'k1' })
  const deep = (n: number) => '['.repeat(n) + ']'.repeat(n)
  const forms: Record<string, string> = {
    'typ JWT + corpo lista': `${b64u(H)}.${b64u('[1,2]')}.${b64u('x')}`,
    'typ JWT + corpo número': `${b64u(H)}.${b64u('5')}.${b64u('x')}`,
    'typ JWT + corpo null': `${b64u(H)}.${b64u('null')}.${b64u('x')}`,
    'typ JWT + corpo texto JSON': `${b64u(H)}.${b64u('"s"')}.${b64u('x')}`,
    'typ JWT + corpo não-JSON': `${b64u(H)}.${b64u('nao-json')}.${b64u('x')}`,
    'typ JWT + corpo vazio': `${b64u(H)}..${b64u('x')}`,
    'typ JWT + corpo aninhado 5.000 níveis': `${b64u(H)}.${b64u(deep(5000))}.${b64u('x')}`,
    'cabeçalho aninhado 5.000 níveis': `${b64u('{"a":' + deep(5000) + ',"kid":"k1"}')}.${b64u('{}')}.${b64u('x')}`,
    'cabeçalho com BOM': `${b64u('﻿' + H2)}.${b64u('{}')}.${b64u('x')}`,
    'cabeçalho lista': `${b64u('[1]')}.${b64u('{}')}.${b64u('x')}`,
    'cabeçalho número': `${b64u('7')}.${b64u('{}')}.${b64u('x')}`,
    'cabeçalho null': `${b64u('null')}.${b64u('{}')}.${b64u('x')}`,
    '1 parte': b64u(H),
    '2 partes': `${b64u(H)}.${b64u('{}')}`,
    '4 partes': `${b64u(H)}.${b64u('{}')}.${b64u('x')}.${b64u('y')}`,
    'base64 padrão (+ e /)': `${Buffer.from(H).toString('base64')}.${b64u('{}')}.${b64u('x')}`,
    'base64 com "="': `${b64u(H)}=.${b64u('{}')}.${b64u('x')}`,
    'assinatura vazia': `${b64u(H)}.${b64u('{}')}.`,
    'só pontos': '..',
    'unicode na assinatura': `${b64u(H)}.${b64u('{}')}.é`,
    'alg none com kid conhecido': `${b64u(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${b64u('{}')}.`,
    'REAL: corpo lista': signRaw(H, '[1]'),
    'REAL: corpo null': signRaw(H, 'null'),
    'REAL: corpo número': signRaw(H, '7'),
    'REAL: corpo não-JSON com typ': signRaw(H, 'nao-json'),
    'REAL: corpo não-JSON sem typ': signRaw(H2, 'nao-json'),
  }

  it('[RESISTIU] 26 formas (corpo/cabeçalho não-JSON, lista, número, null, aninhado 5.000 níveis, BOM, partes a mais/menos, base64 inválido, assinatura vazia, `alg: none`, e os corpos estranhos ASSINADOS com a chave real): toda uma vira ProductAuthError (`malformed` ou `invalid`) — nenhuma escapa como erro não-HTTP', () => {
    const out = Object.fromEntries(Object.entries(forms).map(([k, tok]) => [k, classOf(tok)]))
    for (const [k, c] of Object.entries(out)) expect([k, ['malformed', 'invalid'].includes(c)]).toEqual([k, true])
  })

  it('[RESISTIU] as mesmas 26 formas pela PORTA REAL (express + `productAuth` + `errorMiddleware`, bytes crus): 26 × 401 com `UNAUTHORIZED`, 26 entradas no log do 401, ZERO `logger.error` (nada de stack nem trecho do corpo do atacante no log de erro interno)', async () => {
    const seen: AuthReject[] = []
    const errorLog = jest.spyOn(logger, 'error').mockImplementation(() => undefined)
    const app = express()
    app.use('/v1/nfse', productAuth(verifier, undefined, r => { seen.push(r) }), (_q, res) => { res.json({ ok: true }) })
    app.use(errorMiddleware)
    const server = app.listen(0)
    await new Promise(r => server.once('listening', r))
    const port = (server.address() as AddressInfo).port
    const hit = (tok: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1')
      let buf = ''
      s.setEncoding('latin1')
      s.on('data', d => { buf += d })
      s.on('end', () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0), body: buf.slice(buf.indexOf('\r\n\r\n') + 4) }))
      s.on('error', reject)
      s.write(`GET /v1/nfse/x HTTP/1.1\r\nHost: x\r\nConnection: close\r\nAuthorization: Bearer ${tok}\r\n\r\n`)
    })
    try {
      const results: [string, number, string][] = []
      for (const [k, tok] of Object.entries(forms)) {
        const r = await hit(tok)
        let code = ''
        try { code = JSON.parse(r.body).code } catch { code = `corpo:${r.body.slice(0, 30)}` }
        results.push([k, r.status, code])
      }
      expect(results.filter(r => r[1] !== 401 || r[2] !== 'UNAUTHORIZED')).toEqual([])
      expect(seen).toHaveLength(Object.keys(forms).length)
      expect(errorLog).not.toHaveBeenCalled()
    } finally {
      await new Promise(r => server.close(r))
      errorLog.mockRestore()
    }
  })
})
