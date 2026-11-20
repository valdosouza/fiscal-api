/// <reference types="jest" />
// FAMILIA.E5.P1 (NE-3 no núcleo — ficha `projetos/fiscal-api/GERAL/ficha-familia-e5-p1-teto-e-trecho-assinado.md` no Vault):
//  T1 — teto de 2 MB no `httpsRequest` COMUM (D-NE93/D-NE164): acima = ambíguo pela causa que já existe, nas duas famílias.
//  T2 — `verifyXml` devolve o TRECHO assinado do elemento que a família nomeia, ou nada (D-NE183/D-NE194/D-NE195).
import https from 'https'
import { AddressInfo } from 'net'
import forge from 'node-forge'
import {
  httpsRequest, authorityJson, transport, MAX_RESPONSE_BYTES, ResponseTooLargeError, isResponseTooLarge, responseTooLargeAmbiguous,
  AuthorityHttpError,
} from '../transport/https-json'
import { ambiguousCauseOf } from '../errors/ambiguous-cause'
import { ErrorCodes } from '../errors/error-codes'
import { logger } from '../log/logger'
import { SignedXml } from 'xml-crypto'
import { signXml, verifyXml, firstCertificatePem, ENVELOPED, C14N_INCLUSIVE, ACCEPTED_TRANSFORMS } from '../transport/xmldsig'
import { parseXml, elementsOf, textOf } from '../xml/reader'

/** Certificado do servidor LOCAL (SAN `localhost` e `127.0.0.1`) — o cliente confia nele pelo `ca` (nunca `rejectUnauthorized`). */
function serverCert(): { cert: string; key: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '0a'
  cert.validity.notBefore = new Date(Date.now() - 86_400_000)
  cert.validity.notAfter = new Date(Date.now() + 86_400_000)
  const attrs = [{ name: 'commonName', value: 'localhost' }]
  cert.setSubject(attrs); cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] },
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) }
}

describe('T1 — teto de 2 MB no transporte comum (D-NE93/D-NE164)', () => {
  const pem = serverCert()
  /** O que o servidor responde, por caminho: status, tamanho do corpo e se declara `Content-Length`. */
  const ROUTES: Record<string, { status: number; bytes: number; declare?: number }> = {
    '/exato':        { status: 200, bytes: MAX_RESPONSE_BYTES },
    '/um-a-mais':    { status: 200, bytes: MAX_RESPONSE_BYTES + 1 },
    '/grande-500':   { status: 500, bytes: MAX_RESPONSE_BYTES + 4096 },
    '/enorme':       { status: 200, bytes: 64 * 1024 * 1024 },
    '/declarado':    { status: 200, bytes: 10, declare: MAX_RESPONSE_BYTES + 1 },
    '/json':         { status: 200, bytes: 0 },
  }
  let server: https.Server
  let base = ''
  let aborted = 0
  beforeAll(async () => {
    server = https.createServer({ cert: pem.cert, key: pem.key }, (req, res) => {
      const r = ROUTES[req.url ?? '']
      if (!r) { res.writeHead(404); res.end(); return }
      if (req.url === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return }
      res.on('close', () => { if (!res.writableFinished) aborted++ })
      if (r.declare !== undefined) {
        // cabeçalho de propósito acima do teto (o corpo nem chega a ser lido)
        res.writeHead(r.status, { 'content-length': String(r.declare) })
        if (req.method === 'HEAD') { res.end(); return }
        res.write('x'.repeat(r.bytes))
        return                                                    // nunca termina: o cliente tem de cortar sozinho
      }
      // contagem: corpo em PEDAÇOS, sem `Content-Length` (chunked) — só a contagem de bytes do cliente pode recusar
      res.writeHead(r.status, { 'content-type': 'text/plain' })
      const piece = Buffer.alloc(64 * 1024, 0x61)
      let left = r.bytes
      const pump = (): void => {
        while (left > 0) {
          const n = Math.min(left, piece.length)
          left -= n
          if (!res.write(n === piece.length ? piece : piece.subarray(0, n))) { res.once('drain', pump); return }
        }
        res.end()
      }
      pump()
    })
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
    base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => { await new Promise<void>(ok => server.close(() => ok())) })
  beforeEach(() => { jest.spyOn(logger, 'warn').mockImplementation(() => logger); jest.spyOn(logger, 'error').mockImplementation(() => logger) })
  afterEach(() => jest.restoreAllMocks())

  const call = (p: string) => ({ url: `${base}${p}`, method: 'GET' as const, ca: pem.cert })

  it('exatamente 2 MB passa (o teto é inclusivo) e o corpo vem inteiro', async () => {
    const r = await httpsRequest(call('/exato'))
    expect(r.status).toBe(200)
    expect(Buffer.byteLength(r.text)).toBe(MAX_RESPONSE_BYTES)
    expect(MAX_RESPONSE_BYTES).toBe(2_097_152)
  })

  it('caminho da NF-e (o `httpsRequest` cru — D-NE184): 2 MB + 1 byte, em pedaços e sem `Content-Length`, rejeita com `ResponseTooLargeError` (depois do aperto de mão, com o status que chegou) ', async () => {
    const err = await httpsRequest(call('/um-a-mais')).then(() => null, e => e)
    expect(err).toBeInstanceOf(ResponseTooLargeError)
    expect(isResponseTooLarge(err)).toBe(true)
    expect([err.code, err.afterHandshake, err.authorityStatus]).toEqual(['FISCAL_RESPONSE_TOO_LARGE', true, 200])
  })

  it('corpo enorme (64 MB): a recusa vem no teto e a conexão CAI — o servidor não consegue terminar de mandar (nada além de 2 MB se junta)', async () => {
    const before = aborted
    const err = await httpsRequest(call('/enorme')).then(() => null, e => e)
    expect(isResponseTooLarge(err)).toBe(true)
    for (let i = 0; i < 50 && aborted === before; i++) await new Promise(ok => setTimeout(ok, 20))
    expect(aborted).toBe(before + 1)
  })

  it('`Content-Length` declarado acima do teto rejeita sem esperar o corpo (o servidor nunca termina — sem o corte o teste pendura)', async () => {
    const err = await httpsRequest(call('/declarado')).then(() => null, e => e)
    expect(isResponseTooLarge(err)).toBe(true)
    expect(err.authorityStatus).toBe(200)
  })

  it('caminho da NFS-e (`authorityJson` contra o servidor real): acima do teto = 502 FISCAL_AUTHORITY_UNKNOWN_RESPONSE, causa `envelope-ilegivel`, corpo VAZIO — também com status 500 (a D-NE93 não distingue)', async () => {
    for (const [p, status] of [['/um-a-mais', 200], ['/grande-500', 500], ['/declarado', 200]] as const) {
      const err = await authorityJson(call(p), 'teste').then(() => null, e => e)
      expect(err).toBeInstanceOf(AuthorityHttpError)
      expect([p, err.statusCode, err.code, ambiguousCauseOf(err), err.authorityStatus, err.body])
        .toEqual([p, 502, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE, 'envelope-ilegivel', status, ''])
    }
    // e a resposta normal segue igual
    expect((await authorityJson(call('/json'), 'teste')).data).toEqual({ ok: true })
  })

  it('o ramo do teto vem ANTES dos outros: o erro nunca vira credencial (409) nem indisponível (503), mesmo pelo transporte injetado', async () => {
    const real = transport.request
    try {
      transport.request = async () => { throw new ResponseTooLargeError(201) }
      const err = await authorityJson({ url: 'https://exemplo.invalid/x', method: 'POST' }, 'injetado').then(() => null, e => e)
      expect([err.statusCode, ambiguousCauseOf(err), err.authorityStatus]).toEqual([502, 'envelope-ilegivel', 201])
    } finally { transport.request = real }
  })

  it('a peça da NF-e (`responseTooLargeAmbiguous`) dá o MESMO erro que o `authorityJson` — uma regra, dois caminhos', () => {
    const e = responseTooLargeAmbiguous(new ResponseTooLargeError(200), 'soap')
    expect([e.statusCode, e.code, ambiguousCauseOf(e), e.authorityStatus, e.body])
      .toEqual([502, ErrorCodes.FISCAL_AUTHORITY_UNKNOWN_RESPONSE, 'envelope-ilegivel', 200, ''])
    expect(e.message).not.toMatch(/SSL|certificate|PEM/i)
  })

  it('[gates 2026-11-20] o erro do teto vale também pelo `code` (outra cópia do pacote / transporte injetado) — nunca 503', async () => {
    const real = transport.request
    try {
      transport.request = async () => { throw Object.assign(new Error('x'), { code: 'FISCAL_RESPONSE_TOO_LARGE', afterHandshake: true, authorityStatus: 200 }) }
      const err = await authorityJson({ url: 'https://exemplo.invalid/x', method: 'GET' }, 'injetado').then(() => null, e => e)
      expect([err.statusCode, ambiguousCauseOf(err), err.authorityStatus]).toEqual([502, 'envelope-ilegivel', 200])
    } finally { transport.request = real }
  })

  it('[gates 2026-11-20] HEAD declara o tamanho de um corpo que não vem — o `Content-Length` acima do teto não recusa', async () => {
    const r = await httpsRequest({ ...call('/declarado'), method: 'HEAD' })
    expect(r.status).toBe(200)
  })
})

// ===========================================================================
// T2 — o `verifyXml` devolve o TRECHO assinado do elemento pedido, ou nada (D-NE183/D-NE194/D-NE195)
// ===========================================================================
function keyPair(cn: string) {
  const keys = forge.pki.rsa.generateKeyPair(1024)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date(Date.now() - 86_400_000)
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000)
  cert.setSubject([{ name: 'commonName', value: cn }]); cert.setIssuer([{ name: 'commonName', value: cn }])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return { cert: Buffer.from(forge.pki.certificateToPem(cert)), key: Buffer.from(forge.pki.privateKeyToPem(keys.privateKey)) }
}
const EXC_C14N_COMMENTS = 'http://www.w3.org/2001/10/xml-exc-c14n#WithComments'
/** Assina com transforms/canonicalização à escolha — o `signXml` fixa a C14N inclusiva; o ADN usa a exclusiva com comentários. */
function signWith(xml: string, id: string, kp: { cert: Buffer; key: Buffer }, transforms: string[], canon = C14N_INCLUSIVE): string {
  const sig = new SignedXml({ privateKey: kp.key, publicCert: firstCertificatePem(kp.cert),
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: canon })
  sig.addReference({ xpath: `//*[@Id='${id}']`, transforms, digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256', uri: `#${id}` })
  sig.computeSignature(xml, { location: { reference: `//*[@Id='${id}']/..`, action: 'append' } })
  return sig.getSignedXml()
}
/** A verificação SEM as travas do núcleo (o `xml-crypto` cru) — para provar o que só a trava recusa. */
function rawCheck(xml: string, cert: Buffer): boolean {
  try {
    const block = xml.slice(xml.indexOf('<Signature'), xml.indexOf('</Signature>') + '</Signature>'.length)
    const v = new SignedXml({ publicCert: firstCertificatePem(cert) })
    v.loadSignature(block)
    return v.checkSignature(xml) === true
  } catch { return false }
}
const fieldOf = (fragment: string, name: string): string | null => {
  const el = elementsOf(parseXml(fragment), true).find(e => e.localName === name)
  return el ? textOf(el) : null
}

describe('T2 — trecho assinado (D-NE183/D-NE194/D-NE195)', () => {
  const emitter = keyPair('EMITENTE:12345678000199')
  const authority = keyPair('FISCO:00394460005887')
  const DPS = '<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infDPS Id="DPS1"><nDPS>7</nDPS></infDPS></DPS>'
  const signed = signXml(DPS, { referenceId: 'DPS1', cert: emitter.cert, key: emitter.key, algorithm: 'sha1' })
  const CH = '41261112345678000199550010000000071000000075'
  // a forma do `procNFe`: a assinatura do EMITENTE no `infNFe` e a do FISCO no `infProt` (com a chave) — duas no mesmo documento
  const PROC = '<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">'
    + `<NFe><infNFe Id="NFe${CH}"><ide><nNF>7</nNF></ide></infNFe></NFe><protNFe versao="4.00"><infProt Id="ID141260000000001">`
    + `<tpAmb>2</tpAmb><chNFe>${CH}</chNFe><nProt>141260000000001</nProt><cStat>100</cStat></infProt></protNFe></nfeProc>`
  const proc = signXml(signXml(PROC, { referenceId: `NFe${CH}`, cert: emitter.cert, key: emitter.key, algorithm: 'sha1' }),
    { referenceId: 'ID141260000000001', cert: authority.cert, key: authority.key, algorithm: 'sha1' })

  it('o elemento assinado devolve `{ id, xml }` e o trecho é legível pelo leitor estrito do núcleo', () => {
    const part = verifyXml(signed, emitter.cert, { element: 'infDPS' })
    expect(part?.id).toBe('DPS1')
    expect(fieldOf(part!.xml, 'nDPS')).toBe('7')
    expect(part!.xml).not.toMatch(/Signature/)                    // a assinatura não faz parte do trecho
    expect(verifyXml(signed, emitter.cert, { element: 'infDPS', id: 'DPS1' })?.id).toBe('DPS1')
  })

  it('procNFe: a família escolhe PELO ELEMENTO — o `infProt` com o certificado do fisco devolve o trecho e a CHAVE sai de dentro dele (o elo é da família); com o do emitente, nada; o `infNFe` com o do emitente', () => {
    const prot = verifyXml(proc, authority.cert, { element: 'infProt' })
    expect([prot?.id, fieldOf(prot!.xml, 'chNFe'), fieldOf(prot!.xml, 'cStat')]).toEqual(['ID141260000000001', CH, '100'])
    expect(verifyXml(proc, emitter.cert, { element: 'infProt' })).toBeNull()
    expect(verifyXml(proc, emitter.cert, { element: 'infNFe' })?.id).toBe(`NFe${CH}`)
    expect(verifyXml(proc, authority.cert, { element: 'infNFe' })).toBeNull()
    // o Id do infProt é opcional e do fisco: sem `id` funciona; com `id` diferente, nada
    expect(verifyXml(proc, authority.cert, { element: 'infProt', id: 'ID999' })).toBeNull()
  })

  it('o trecho NÃO leva o que está fora do elemento assinado (o irmão injetado verifica, mas não aparece) — nem a 2ª chave posta fora', () => {
    const injected = proc.replace('</infProt>', '</infProt><chNFe>99999999999999999999999999999999999999999999</chNFe>')
    const part = verifyXml(injected, authority.cert, { element: 'infProt' })
    expect(part).not.toBeNull()
    expect(part!.xml).not.toMatch(/9{44}/)
    expect(fieldOf(part!.xml, 'chNFe')).toBe(CH)
  })

  it('nada: adulterado, outro certificado, elemento errado, `id` esperado diferente, sem opções, certificado ilegível', () => {
    expect(verifyXml(signed.replace('<nDPS>7</nDPS>', '<nDPS>8</nDPS>'), emitter.cert, { element: 'infDPS' })).toBeNull()
    expect(verifyXml(signed, authority.cert, { element: 'infDPS' })).toBeNull()
    expect(verifyXml(signed, emitter.cert, { element: 'infNFSe' })).toBeNull()
    expect(verifyXml(signed, emitter.cert, { element: 'infDPS', id: 'DPS2' })).toBeNull()
    expect(verifyXml(signed, emitter.cert, undefined as any)).toBeNull()
    expect(verifyXml(signed, emitter.cert, { element: '' })).toBeNull()
    expect(verifyXml(signed, 'não é PEM', { element: 'infDPS' })).toBeNull()
  })

  it('nada: DUAS assinaturas no mesmo elemento, DUAS `Reference`, Id duplicado (também em `ID`/`id` e com prefixo)', () => {
    const twice = signXml(signed, { referenceId: 'DPS1', cert: emitter.cert, key: emitter.key, algorithm: 'sha1' })
    expect(verifyXml(twice, emitter.cert, { element: 'infDPS' })).toBeNull()
    const ref = signed.slice(signed.indexOf('<Reference'), signed.indexOf('</Reference>') + '</Reference>'.length)
    expect(verifyXml(signed.replace(ref, ref + ref), emitter.cert, { element: 'infDPS' })).toBeNull()
    for (const dup of ['<x Id="DPS1"/>', '<x ID="DPS1"/>', '<x id="DPS1"/>', '<x xmlns:w="urn:w" w:Id="DPS1"/>']) {
      expect([dup, verifyXml(signed.replace('</infDPS>', `</infDPS>${dup}`), emitter.cert, { element: 'infDPS' })]).toEqual([dup, null])
    }
  })

  it('D-NE195: as C14N do padrão verificam — a exclusiva com comentários (a do ADN) inclusive', () => {
    for (const canon of [C14N_INCLUSIVE, 'http://www.w3.org/2001/10/xml-exc-c14n#', EXC_C14N_COMMENTS]) {
      const x = signWith(DPS, 'DPS1', authority, [ENVELOPED, canon], canon)
      expect([canon, verifyXml(x, authority.cert, { element: 'infDPS' })?.id]).toEqual([canon, 'DPS1'])
    }
  })

  it('nada pelos transforms que só a TRAVA recusa (o `xml-crypto` cru aceita): repetido e três; e transform desconhecido', () => {
    const repeated = signWith(DPS, 'DPS1', authority, [ENVELOPED, ENVELOPED, C14N_INCLUSIVE])
    const three = signWith(DPS, 'DPS1', authority, [ENVELOPED, C14N_INCLUSIVE, EXC_C14N_COMMENTS])
    for (const [label, x] of [['repetido', repeated], ['três', three]] as const) {
      expect([label, rawCheck(x, authority.cert), verifyXml(x, authority.cert, { element: 'infDPS' })]).toEqual([label, true, null])
    }
    const xpath = signed.replace(`Algorithm="${ENVELOPED}"`, 'Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"')
    expect(verifyXml(xpath, emitter.cert, { element: 'infDPS' })).toBeNull()
  })

  it('[gates 2026-11-20] a lista de transforms é imutável em execução; Id fora de `[A-Za-z0-9_.-]` é recusa que só a trava faz', () => {
    expect(Object.isFrozen(ACCEPTED_TRANSFORMS)).toBe(true)
    expect(() => (ACCEPTED_TRANSFORMS as string[]).push('http://www.w3.org/TR/1999/REC-xpath-19991116')).toThrow()
    const odd = signWith(DPS.replace('Id="DPS1"', 'Id="DPS:1"'), 'DPS:1', authority, [ENVELOPED, C14N_INCLUSIVE])
    expect([rawCheck(odd, authority.cert), verifyXml(odd, authority.cert, { element: 'infDPS' })]).toEqual([true, null])
  })

  it('[CONHECIDO — gates 2026-11-20, falha FECHADO] dois elementos assinados com o MESMO nome local (o `infEvento` do pedido e o do retorno no `procEventoNFe`) = recusa, mesmo com `id`', () => {
    const EV = '<procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><evento versao="1.00"><infEvento Id="ID1101114126"><tpEvento>110111</tpEvento></infEvento></evento>'
      + '<retEvento versao="1.00"><infEvento Id="ID141260000000002"><cStat>135</cStat></infEvento></retEvento></procEventoNFe>'
    const both = signXml(signXml(EV, { referenceId: 'ID1101114126', cert: emitter.cert, key: emitter.key, algorithm: 'sha1' }),
      { referenceId: 'ID141260000000002', cert: authority.cert, key: authority.key, algorithm: 'sha1' })
    expect(verifyXml(both, authority.cert, { element: 'infEvento' })).toBeNull()
    expect(verifyXml(both, authority.cert, { element: 'infEvento', id: 'ID141260000000002' })).toBeNull()
    // controle: o motivo é a CONTAGEM — só com a assinatura do retorno, o mesmo elemento verifica
    const onlyRet = signXml(EV, { referenceId: 'ID141260000000002', cert: authority.cert, key: authority.key, algorithm: 'sha1' })
    expect(verifyXml(onlyRet, authority.cert, { element: 'infEvento' })?.id).toBe('ID141260000000002')
  })

  it('[CONHECIDO — gates 2026-11-20, falha FECHADO; xml-crypto 6.3.2 `findAncestorNs`] procNFe cujo `NFe` declara namespace com prefixo: a assinatura do fisco no `infProt` não verifica (nunca aceita a mais)', () => {
    // como no mundo real: o fisco assina o `protNFe` SOZINHO; o `nfeProc` é montado depois
    const NS = 'http://www.portalfiscal.inf.br/nfe'
    const prot = signXml(`<protNFe xmlns="${NS}" versao="4.00"><infProt Id="ID141260000000001"><tpAmb>2</tpAmb><chNFe>${CH}</chNFe>`
      + '<cStat>100</cStat></infProt></protNFe>', { referenceId: 'ID141260000000001', cert: authority.cert, key: authority.key, algorithm: 'sha1' })
    const assemble = (nfeOpen: string) => {
      const nfe = signXml(`${nfeOpen}<infNFe Id="NFe${CH}"><ide><nNF>7</nNF></ide></infNFe></NFe>`,
        { referenceId: `NFe${CH}`, cert: emitter.cert, key: emitter.key, algorithm: 'sha1' })
      return `<nfeProc xmlns="${NS}" versao="4.00">${nfe}${prot}</nfeProc>`
    }
    const plain = assemble(`<NFe xmlns="${NS}">`)
    const withXsi = assemble(`<NFe xmlns="${NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`)
    expect(verifyXml(plain, authority.cert, { element: 'infProt' })?.id).toBe('ID141260000000001')   // controle
    expect(verifyXml(withXsi, emitter.cert, { element: 'infNFe' })?.id).toBe(`NFe${CH}`)
    expect(verifyXml(withXsi, authority.cert, { element: 'infProt' })).toBeNull()                   // o conhecido: falha fechado
    // a falha acompanha a ORDEM (a 1ª SignedInfo do documento): com o protNFe na frente, é a do emitente que deixa de verificar
    const swapped = withXsi.replace(/(<NFe [\s\S]*<\/NFe>)(<protNFe[\s\S]*<\/protNFe>)/, '$2$1')
    expect(swapped).not.toBe(withXsi)
    expect(verifyXml(swapped, authority.cert, { element: 'infProt' })?.id).toBe('ID141260000000001')
    expect(verifyXml(swapped, emitter.cert, { element: 'infNFe' })).toBeNull()
  })
})
