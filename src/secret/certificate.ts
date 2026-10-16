import forge from 'node-forge'
import { X509Certificate, createPrivateKey } from 'crypto'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'
import { FederalIdFact, isFederalIdFact, readFederalIdFact } from '../federal-id/federal-id'

/**
 * O CERTIFICADO A1 como fato (D-N5/D-N29/D-N31 — cópia fiel de `@shared/fiscal-issuer` +
 * `@shared/secret-store` do setes-api, sem o armazenamento): abrir o PKCS#12, escolher a folha,
 * ler metadados PÚBLICOS e validar o par. O `.pfx` e a senha existem só na chamada.
 */

export interface CertificateInfo {
  subject:        string
  issuer:         string
  notBefore:      string
  notAfter:       string
  /** Dias até expirar (negativo = expirado). */
  daysToExpire:   number
  fingerprint256: string
  expired:        boolean
  /** notBefore no futuro — o handshake diria CERT_NOT_YET_VALID (R2-4). */
  notYetValid:    boolean
  /** CNPJ do CN no padrão ICP-Brasil ("NOME:14 dígitos"); null quando o CN não traz. */
  cnpj:           string | null
}

/** Só o VALOR da RDN CN (R3-5: a regex antiga atravessava para OU/O). */
function cnValueOf(subject: string): string | null {
  const m = /(?:^|\n|, )CN=([^\n]*?)(?=(?:, [A-Z]+=)|\n|$)/.exec(subject)
  return m ? m[1] : null
}

export function cnpjFromSubject(subject: string): string | null {
  const m = /:(\d{14})(?!\d)/.exec(cnValueOf(subject) ?? '')
  return m ? m[1] : null
}

/** CPF do CN no padrão do e-CPF — R3-4: identificável como "não é este CNPJ". */
export function cpfFromSubject(subject: string): string | null {
  const m = /:(\d{11})(?!\d)/.exec(cnValueOf(subject) ?? '')
  return m ? m[1] : null
}

/** Metadados PÚBLICOS de um certificado PEM. */
export function certificateInfo(pem: Buffer | string, now: Date = new Date()): CertificateInfo {
  const cert = new X509Certificate(pem)
  const notAfter = new Date(cert.validTo)
  const days = Math.floor((notAfter.getTime() - now.getTime()) / 86_400_000)
  const subject = cert.subject.replace(/\n/g, ', ')
  return {
    subject,
    issuer:  cert.issuer.replace(/\n/g, ', '),
    notBefore: new Date(cert.validFrom).toISOString(),
    notAfter:  notAfter.toISOString(),
    daysToExpire: days,
    fingerprint256: cert.fingerprint256,
    expired: days < 0,
    notYetValid: new Date(cert.validFrom).getTime() > now.getTime(),
    cnpj: cnpjFromSubject(subject),
  }
}

export function looksLikePrivateKeyPem(content: Buffer | string): boolean {
  return /-----BEGIN (RSA |EC )?PRIVATE KEY-----[\s\S]+-----END (RSA |EC )?PRIVATE KEY-----/.test(content.toString())
}

/** A chave ABRE no OpenSSL? null = ok; string = motivo (write-only exige validar ANTES de gravar). */
export function validatePrivateKeyPem(content: Buffer | string): string | null {
  if (!looksLikePrivateKeyPem(content)) return 'Chave privada não está em PEM (-----BEGIN PRIVATE KEY-----)'
  try { createPrivateKey({ key: content.toString(), format: 'pem' }); return null }
  catch (e: any) { return `Chave privada ilegível (${String(e?.code ?? e?.message ?? 'PEM inválido')})` }
}

/** A chave é a deste certificado? (par mTLS coerente antes de ir ao fisco) */
export function keyMatchesCertificate(certPem: Buffer | string, keyPem: Buffer | string): boolean {
  try { return new X509Certificate(certPem).checkPrivateKey(createPrivateKey({ key: keyPem.toString(), format: 'pem' })) }
  catch { return false }
}

function invalidPfx(message: string): HttpError {
  return new HttpError(400, message, [{ field: 'pfx', message: 'PKCS#12 inválido' }], ErrorCodes.FISCAL_CERT_INVALID)
}

/**
 * Abre o PKCS#12 com a senha e devolve o certificado FOLHA (o que casa com a chave — a cadeia da
 * AC é ignorada) e a chave, ambos em PEM. Renovação que reaproveitou o par (dois certificados da
 * mesma chave) → fica o VIGENTE; empate = o que vence por último (ACHADO 6 do gate da Onda 3).
 */
export function pkcs12ToPem(pfx: Buffer, password: string): { certPem: string; keyPem: string } {
  let p12: forge.pkcs12.Pkcs12Pfx
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')))
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password)
  } catch {
    throw invalidPfx('Arquivo não é um PKCS#12 válido ou a senha está incorreta')
  }
  const oids = forge.pki.oids
  const keyBags = [
    ...(p12.getBags({ bagType: oids.pkcs8ShroudedKeyBag })[oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: oids.keyBag })[oids.keyBag] ?? []),
  ]
  const key = keyBags.find(b => b.key)?.key as forge.pki.rsa.PrivateKey | undefined
  if (!key) throw invalidPfx('PKCS#12 sem chave privada')
  const certs = (p12.getBags({ bagType: oids.certBag })[oids.certBag] ?? [])
    .map(b => b.cert).filter((c): c is forge.pki.Certificate => !!c)
  const matching = certs.filter(c => {
    const pub = c.publicKey as forge.pki.rsa.PublicKey
    return !!pub?.n && pub.n.compareTo(key.n) === 0 && pub.e.compareTo(key.e) === 0
  })
  const now = Date.now()
  const validNow = (c: forge.pki.Certificate) => c.validity.notBefore.getTime() <= now && now <= c.validity.notAfter.getTime()
  const leaf = [...matching].sort((a, b) =>
    Number(validNow(b)) - Number(validNow(a)) || b.validity.notAfter.getTime() - a.validity.notAfter.getTime())[0]
  if (!leaf) throw invalidPfx('PKCS#12 sem certificado correspondente à chave privada')
  return { certPem: forge.pki.certificateToPem(leaf), keyPem: forge.pki.privateKeyToPem(key) }
}

/**
 * Valida o par INTEIRO aberto do `.pfx` antes de qualquer gravação (invariante "cofre = último par
 * válido"): certificado legível, chave abre, chave casa, vigente, e — sem procuração (D-N12) — o
 * e-CNPJ do PRÓPRIO emitente (D-N29/D-N29b, R3-4, Q-N29 fail-closed). Devolve os metadados.
 */
/**
 * O CNPJ do estabelecimento contra o qual o A1 é conferido: o FATO lido no ERP em três estados (D-CJ2 — ausente ≠ inválido ≠ válido),
 * ou o valor cru (lido aqui pela mesma peça; nunca mutilado — o antigo "tira o que não é dígito" fazia `PC3D315K000193` virar `3315000193`).
 */
export type ExpectedCnpj = FederalIdFact | string | null

export function validateIssuerPair(certPem: string, keyPem: string, expectedCnpj: ExpectedCnpj): CertificateInfo {
  let info: CertificateInfo
  try { info = certificateInfo(certPem) } catch { throw invalidPfx('Certificado do PKCS#12 ilegível') }
  const why = validatePrivateKeyPem(keyPem)
  if (why) throw invalidPfx(why)
  if (!keyMatchesCertificate(certPem, keyPem)) throw invalidPfx('A chave privada não corresponde ao certificado')
  if (info.expired) {
    throw new HttpError(409, `Certificado digital A1 expirou em ${info.notAfter.slice(0, 10)} — renove e envie o novo`,
      [{ field: 'pfx', message: 'Expirado' }], ErrorCodes.FISCAL_CERT_EXPIRED)
  }
  if (info.notYetValid) {
    throw new HttpError(409, `Certificado digital A1 só vale a partir de ${info.notBefore.slice(0, 10)} — envie quando estiver vigente`,
      [{ field: 'pfx', message: 'Ainda não vigente' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  // gate adversarial da onda 0 (LOW): o fato é reconhecido pela FORMA (`isFederalIdFact`) — um objeto/array qualquer é lido pela peça
  // (inválido → 422), nunca acessado como fato (TypeError → 500)
  const fact = isFederalIdFact(expectedCnpj) ? expectedCnpj : readFederalIdFact('cnpj', expectedCnpj)
  // fail-closed (gate adversarial L-cofre): sem o CNPJ do estabelecimento no ERP não há com o que conferir o A1
  if (fact.state === 'absent') {
    throw new HttpError(422, 'Estabelecimento sem CNPJ no cadastro — complete o Meu Estabelecimento antes de enviar o A1 (o certificado é conferido contra ele)',
      [{ field: 'emitter.cnpj', message: 'Estabelecimento sem CNPJ' }], ErrorCodes.FISCAL_EMITTER_INCOMPLETE)
  }
  // D-CJ2: CNPJ que EXISTE mas não fecha (forma/DV) não é "sem CNPJ" — o diagnóstico diz o que corrigir
  if (fact.state === 'invalid') {
    throw new HttpError(422, 'CNPJ do estabelecimento inválido no cadastro — corrija no Meu Estabelecimento antes de enviar o A1 (o certificado é conferido contra ele)',
      [{ field: 'emitter.cnpj', message: 'CNPJ inválido no cadastro' }], ErrorCodes.FISCAL_EMITTER_INCOMPLETE)
  }
  const expected = fact.id.value
  if (info.cnpj && info.cnpj !== expected) {
    throw new HttpError(409, `Certificado do CNPJ ${info.cnpj} — o estabelecimento é ${expected}; o A1 tem que ser do emitente`,
      [{ field: 'pfx', message: 'CNPJ do certificado ≠ CNPJ do estabelecimento' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  if (!info.cnpj && cpfFromSubject(info.subject)) {
    throw new HttpError(409, 'Certificado é um e-CPF — sem procuração (D-N12) o A1 tem que ser o e-CNPJ do emitente',
      [{ field: 'pfx', message: 'e-CPF não serve para o emitente' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  if (!info.cnpj) {
    throw new HttpError(409, 'Certificado sem CNPJ no CN (padrão ICP-Brasil "RAZÃO SOCIAL:CNPJ") — o A1 tem que ser o e-CNPJ do emitente',
      [{ field: 'pfx', message: 'Não é um e-CNPJ' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  return info
}
