import forge from 'node-forge'

/**
 * PKCS#12 REAL gerado no teste (node-forge): par RSA + certificado autoassinado com CN no padrão
 * ICP-Brasil ("RAZÃO SOCIAL:CNPJ") e uma AC "isca" na cadeia (a folha tem que ser a que casa com a chave).
 */
/** otherName do SubjectAltName: o node-forge não o codifica — o DER sai à mão (PrintableString, como no e-CNPJ real; ou outro tipo). */
export interface TestOtherName { oid: string; value: string; type?: number }

function subjectAltNameWithOtherNames(otherNames: TestOtherName[]): { id: string; value: forge.asn1.Asn1 } {
  const { asn1 } = forge
  return {
    id: '2.5.29.17',
    value: asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, otherNames.map(o =>
      asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(o.oid).getBytes()),
        asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
          asn1.create(asn1.Class.UNIVERSAL, o.type ?? asn1.Type.PRINTABLESTRING, false, o.value),
        ]),
      ]))),
  }
}

export function makePfx(opts: {
  cn: string; password: string; notAfter?: Date; notBefore?: Date
  /** Atributo `serialNumber` (2.5.4.5) do titular — perfil SE-S. */
  serialNumber?: string
  otherNames?: TestOtherName[]
}): { pfx: Buffer; certPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(1024)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = String(Date.now())
  cert.validity.notBefore = opts.notBefore ?? new Date(Date.now() - 86_400_000)
  cert.validity.notAfter = opts.notAfter ?? new Date(Date.now() + 365 * 86_400_000)
  const attrs: forge.pki.CertificateField[] = [{ name: 'commonName', value: opts.cn }, { name: 'countryName', value: 'BR' }, { name: 'organizationName', value: 'ICP-Brasil' }]
  if (opts.serialNumber !== undefined) attrs.push({ type: '2.5.4.5', value: opts.serialNumber, valueTagClass: forge.asn1.Type.PRINTABLESTRING } as unknown as forge.pki.CertificateField)   // o forge usa valueTagClass como o TIPO da string
  cert.setSubject(attrs); cert.setIssuer(attrs)
  if (opts.otherNames?.length) cert.setExtensions([subjectAltNameWithOtherNames(opts.otherNames)])
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
