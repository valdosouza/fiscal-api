import forge from 'node-forge'

/**
 * PKCS#12 REAL gerado no teste (node-forge): par RSA + certificado autoassinado com CN no padrão
 * ICP-Brasil ("RAZÃO SOCIAL:CNPJ") e uma AC "isca" na cadeia (a folha tem que ser a que casa com a chave).
 */
export function makePfx(opts: { cn: string; password: string; notAfter?: Date; notBefore?: Date }): { pfx: Buffer; certPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(1024)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = String(Date.now())
  cert.validity.notBefore = opts.notBefore ?? new Date(Date.now() - 86_400_000)
  cert.validity.notAfter = opts.notAfter ?? new Date(Date.now() + 365 * 86_400_000)
  const attrs = [{ name: 'commonName', value: opts.cn }, { name: 'countryName', value: 'BR' }, { name: 'organizationName', value: 'ICP-Brasil' }]
  cert.setSubject(attrs); cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const caKeys = forge.pki.rsa.generateKeyPair(1024)
  const ca = forge.pki.createCertificate()
  ca.publicKey = caKeys.publicKey
  ca.serialNumber = '02'
  ca.validity.notBefore = new Date(Date.now() - 86_400_000)
  ca.validity.notAfter = new Date(Date.now() + 365 * 86_400_000)
  const caAttrs = [{ name: 'commonName', value: 'AC ISCA' }]
  ca.setSubject(caAttrs); ca.setIssuer(caAttrs)
  ca.sign(caKeys.privateKey, forge.md.sha256.create())
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [ca, cert], opts.password, { algorithm: '3des' })
  return { pfx: Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'), certPem: forge.pki.certificateToPem(cert) }
}
