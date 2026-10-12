/// <reference types="jest" />
// N17 (parte 2 da NE-1a, passo 7 — D-NE72): o `verifyXml` do núcleo pelo LEITOR (parser estrito) × o recorte por regex como estava publicado
// (ORÁCULO abaixo, extraído literalmente do commit 27d2aa6 pelo roteiro do passo 7 — nunca editar à mão). Mesmo resultado nas assinaturas
// geradas no teste e no CORPUS REAL do dev (DPS assinados pelo A1 da Setes, NFS-e e eventos assinados pelo fisco — com o certificado do
// próprio KeyInfo); nos casos estranhos o leitor recusa (false — nunca lança).
import fs from 'fs'
import path from 'path'
import forge from 'node-forge'
import { SignedXml } from 'xml-crypto'
import { signXml, verifyXml, firstCertificatePem } from '../transport/xmldsig'

function legacy_verifyXml(signedXml: string, certPem: Buffer | string): boolean {
  try {
    const m = signedXml.match(/<Signature[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#"[^>]*>[\s\S]*?<\/Signature>/)
    if (!m) return false
    const v = new SignedXml({ publicCert: firstCertificatePem(certPem) })
    v.loadSignature(m[0])
    return v.checkSignature(signedXml) === true
  } catch {
    return false
  }
}

function keyPair() {
  const keys = forge.pki.rsa.generateKeyPair(1024)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date(Date.now() - 86_400_000)
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000)
  cert.setSubject([{ name: 'commonName', value: 'TESTE:12345678000199' }]); cert.setIssuer([{ name: 'commonName', value: 'TESTE:12345678000199' }])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return { cert: Buffer.from(forge.pki.certificateToPem(cert)), key: Buffer.from(forge.pki.privateKeyToPem(keys.privateKey)) }
}
const WORKSPACE = path.resolve(__dirname, '..', '..', '..')
const walkXml = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? walkXml(path.join(dir, d.name)) : d.name.endsWith('.xml') ? [path.join(dir, d.name)] : []))
/** O certificado do 1º KeyInfo do documento, em PEM (o corpus real: quem assinou). */
const keyInfoPem = (xml: string): string | null => {
  const b64 = /<X509Certificate>([^<]+)<\/X509Certificate>/.exec(xml)?.[1]
  return b64 ? `-----BEGIN CERTIFICATE-----\n${b64.replace(/\s+/g, '').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n` : null
}

describe('N17 — verifyXml pelo leitor × o recorte publicado (oráculo)', () => {
  const a = keyPair(), b = keyPair()
  const XML = '<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infDPS Id="DPS1"><nDPS>1</nDPS><xDesc>a &amp; b</xDesc></infDPS></DPS>'
  it('MESMO resultado nas fixtures BEM-FORMADAS: assinada (sha1 e sha256), adulterada, outro certificado, sem assinatura', () => {
    const cases: [string, string, Buffer][] = []
    for (const algorithm of ['sha1', 'sha256'] as const) {
      const signed = signXml(XML, { referenceId: 'DPS1', cert: a.cert, key: a.key, algorithm })
      cases.push([`assinada ${algorithm}`, signed, a.cert], [`outro certificado ${algorithm}`, signed, b.cert],
        [`adulterada ${algorithm}`, signed.replace('<nDPS>1</nDPS>', '<nDPS>2</nDPS>'), a.cert])
    }
    cases.push(['sem assinatura', XML, a.cert])
    const got = cases.map(([l, x, c]) => [l, verifyXml(x, c), legacy_verifyXml(x, c)])
    expect(got.map(([l, n, o]) => [l, n === o])).toEqual(cases.map(([l]) => [l, true]))
    expect(got.filter(([l]) => String(l).startsWith('assinada')).map(([, n]) => n)).toEqual([true, true])
  })
  it('MESMO resultado no CORPUS REAL do dev (DPS do A1 da Setes; NFS-e e eventos do fisco) — com o certificado do próprio KeyInfo', () => {
    const files = [...walkXml(path.join(WORKSPACE, 'setes-api', 'storage')), ...walkXml(path.join(WORKSPACE, 'nfse-api', 'storage-smoke'))]
    if (!files.length) return                                      // fora do dev (sem o corpus) não há o que comparar
    let compared = 0
    for (const f of files) {
      const xml = fs.readFileSync(f, 'utf8')
      const pem = keyInfoPem(xml)
      if (!pem) continue
      // as assinaturas reais VERIFICAM (não só empatam com o oráculo)
      expect([path.basename(f).replace(/\d{20,}/, '<k>'), verifyXml(xml, pem), legacy_verifyXml(xml, pem)]).toEqual([path.basename(f).replace(/\d{20,}/, '<k>'), true, true])
      compared++
    }
    expect(compared).toBeGreaterThanOrEqual(8)
  })
  it('[DECIDIDO — D-NE72] o estranho: documento ilegível para o leitor estrito dá false (o recorte ainda podia achar a assinatura); a Signature que só HERDA o namespace segue sem verificação nos dois', () => {
    const signed = signXml(XML, { referenceId: 'DPS1', cert: a.cert, key: a.key, algorithm: 'sha1' })
    const trailing = signed + 'lixo'
    expect([verifyXml(trailing, a.cert), legacy_verifyXml(trailing, a.cert)]).toEqual([false, true])
    const inherited = signed.replace('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">', '<Signature>').replace('<DPS xmlns="http://www.sped.fazenda.gov.br/nfse"', '<DPS xmlns="http://www.w3.org/2000/09/xmldsig#"')
    expect([verifyXml(inherited, a.cert), legacy_verifyXml(inherited, a.cert)]).toEqual([false, false])
  })
})
