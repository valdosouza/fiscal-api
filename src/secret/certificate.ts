import forge from 'node-forge'
import { X509Certificate, createPrivateKey } from 'crypto'
import { HttpError } from '../errors/http-error'
import { ErrorCodes } from '../errors/error-codes'
import {
  CNPJ_FORM, CPF_FORM, FederalId, FederalIdFact, federalIdOf, isFederalIdFact, readFederalIdFact,
} from '../federal-id/federal-id'

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
  /**
   * LEGADO (D-CJ34): o CNPJ do titular quando a leitura por consenso fecha num CNPJ (`holder.state === 'found'` e `kind === 'cnpj'`);
   * null em qualquer outro caso. Fica pelo cofre (coluna `cnpj`) e pelos consumidores; o fato completo é o `holder`.
   */
  cnpj:           string | null
  /** O titular lido por CONSENSO das fontes (D-CJ6/D-CJ33): a inscrição, de onde veio, ou por que não fechou. */
  holder:         CertificateHolder
}

// ---------------------------------------------------------------------------------------------------------------------------------
// TITULAR do certificado por CONSENSO das fontes (D-CJ6 + D-CJ33, CNPJ.E4.P1). A inscrição do titular é FATO de campo NORMATIVO
// (DOC-ICP-04 v8.3, Anexo I), nunca do CN de exibição — o CN `RAZÃO:CNPJ` entra só como fonte LEGADA. Lê TODAS as fontes presentes:
// uma → ela; duas divergentes → incoerente; nenhuma → sem titular; campo presente em formato que não sabemos ler → não suportado
// (nunca "a primeira que casa vence", nunca aceite por suposição). O responsável (2.16.76.1.3.2/.4) e o CEI (.7) nunca são o titular:
// ter CPF no certificado não é ser e-CPF.
// ---------------------------------------------------------------------------------------------------------------------------------

/** otherName do titular PESSOA FÍSICA: 8 posições da data de nascimento + 11 do CPF + … (DOC-ICP-04 v8.3, Anexo I, item 8.5). */
export const ICP_OID_PF_HOLDER = '2.16.76.1.3.1'
/** otherName do titular PESSOA JURÍDICA: o CNPJ nas 14 posições (obrigatório com restrição no SE-S até 31/12/2028). */
export const ICP_OID_PJ_HOLDER = '2.16.76.1.3.3'
const OID_SERIAL_NUMBER = '2.5.4.5'
const OID_COMMON_NAME = '2.5.4.3'
const OID_SUBJECT_ALT_NAME = '2.5.29.17'

/** De onde a inscrição do titular foi lida. */
export type HolderSource = 'otherName-pf' | 'otherName-pj' | 'serialNumber' | 'cn'

export interface HolderReading { readonly source: HolderSource; readonly id: FederalId }

export type CertificateHolder =
  | { readonly state: 'found'; readonly id: FederalId; readonly sources: readonly HolderSource[] }
  | { readonly state: 'none' }
  | { readonly state: 'conflict'; readonly readings: readonly HolderReading[] }
  /** O campo existe, mas num formato que a leitura ainda não sabe ler (D-CJ33) — nunca vira titular por suposição. */
  | { readonly state: 'unsupported'; readonly source: HolderSource | 'der' }

/** Nome do campo para a mensagem ao usuário. */
export const HOLDER_SOURCE_LABEL: Readonly<Record<HolderSource | 'der', string>> = Object.freeze({
  'otherName-pf': 'OID 2.16.76.1.3.1 (titular pessoa física)',
  'otherName-pj': 'OID 2.16.76.1.3.3 (CNPJ do titular)',
  serialNumber:   'serialNumber do titular',
  cn:             'CN no padrão antigo "RAZÃO SOCIAL:CNPJ"',
  der:            'estrutura do certificado',
})

/** Leitura crua de uma fonte: a inscrição, ou `unsupported` (presente mas fora do formato que sabemos ler). */
type SourceRead = { source: HolderSource; id: FederalId } | { source: HolderSource; unsupported: true }

const CNPJ_MASKED = /^[0-9A-Z]{2}\.[0-9A-Z]{3}\.[0-9A-Z]{3}\/[0-9A-Z]{4}-[0-9]{2}$/

/**
 * Texto de um valor ASN.1 primitivo de string (PrintableString, UTF8String, IA5String, OCTET STRING legado…); null se não for texto.
 * `unicode`: aceita texto Unicode sem caracteres de controle (o CN tem razão social com acento — gates de 2026-11-18); sem ele, só ASCII
 * imprimível (campo de inscrição: bytes fora disso são formato desconhecido, nunca "limpos").
 */
function asn1Text(node: forge.asn1.Asn1, unicode = false): string | null {
  if (node.tagClass !== forge.asn1.Class.UNIVERSAL || node.constructed || typeof node.value !== 'string') return null
  const T = forge.asn1.Type
  let text: string
  try {
    switch (node.type as number) {
      case T.UTF8:      text = forge.util.decodeUtf8(node.value); break
      case T.BMPSTRING: text = Buffer.from(node.value, 'binary').swap16().toString('utf16le'); break
      case T.PRINTABLESTRING: case T.IA5STRING: case 20: /* T61String */ case T.OCTETSTRING: text = node.value; break
      default: return null
    }
  } catch { return null }
  return (unicode ? /^[^\x00-\x1F\x7F-\x9F]*$/u : /^[\x20-\x7E]*$/).test(text) ? text : null
}

/** CNPJ do titular por `serialNumber`/otherName: só a forma canônica exata (ou, no `serialNumber`, a máscara) e DV certo (D-CJ33). */
function cnpjExact(text: string, allowMask: boolean): FederalId | null {
  const canonical = CNPJ_FORM.test(text) ? text : allowMask && CNPJ_MASKED.test(text) ? text.replace(/[./-]/g, '') : null
  return canonical ? federalIdOf('cnpj', canonical) : null
}

function readSerialNumber(text: string | null): SourceRead {
  if (text !== null) {
    const cnpj = cnpjExact(text, true)
    if (cnpj) return { source: 'serialNumber', id: cnpj }
    const cpf = CPF_FORM.test(text) ? federalIdOf('cpf', text) : null
    if (cpf) return { source: 'serialNumber', id: cpf }
  }
  return { source: 'serialNumber', unsupported: true }
}

function readCn(node: forge.asn1.Asn1): SourceRead | null {
  const text = asn1Text(node, true)
  if (text === null) {
    // CN que não decodifica (UTF-8 quebrado, controle) mas cujos bytes TERMINAM numa inscrição: é fonte que não sabemos ler, nunca "sem
    // fonte" — senão a divergência dele com o OID se esconderia (gate adversarial de 2026-11-18)
    const raw = typeof node.value === 'string' ? node.value : ''
    return /:(?:[0-9A-Z]{12}[0-9]{2}|[0-9]{11})$/.test(raw) ? { source: 'cn', unsupported: true } : null
  }
  // A inscrição tem de ser o FIM do CN (no padrão antigo ela sempre é); o leitor anterior aceitava texto depois dela — mudança consciente
  // CN legado: o valor TERMINA em ":<inscrição>" — `RAZÃO SOCIAL:CNPJ` (e-CNPJ) ou `NOME:CPF` (e-CPF). Outro CN (o do SE-S é só a razão
  // social) não é fonte. Forma certa com DV errado é certificado que não fecha → não suportado (nunca "sem fonte").
  const cnpj = /:([0-9A-Z]{12}[0-9]{2})$/.exec(text)
  if (cnpj) { const id = federalIdOf('cnpj', cnpj[1]); return id ? { source: 'cn', id } : { source: 'cn', unsupported: true } }
  const cpf = /:([0-9]{11})$/.exec(text)
  if (cpf) { const id = federalIdOf('cpf', cpf[1]); return id ? { source: 'cn', id } : { source: 'cn', unsupported: true } }
  return null
}

function readOtherName(oid: string, node: forge.asn1.Asn1 | undefined): SourceRead | null {
  const text = node ? asn1Text(node, oid === ICP_OID_PF_HOLDER) : null
  if (oid === ICP_OID_PJ_HOLDER) {
    const id = text === null ? null : cnpjExact(text, false)
    return id ? { source: 'otherName-pj', id } : { source: 'otherName-pj', unsupported: true }
  }
  if (oid === ICP_OID_PF_HOLDER) {
    // 8 da data de nascimento + 11 do CPF; o resto (NIS, RG, órgão — pode ter acento) não é do titular-inscrição e não é conferido
    const id = text !== null && /^[0-9]{19}/.test(text) ? federalIdOf('cpf', text.slice(8, 19)) : null
    return id ? { source: 'otherName-pf', id } : { source: 'otherName-pf', unsupported: true }
  }
  return null   // responsável (.2/.4), CEI (.7) e qualquer outro otherName: nunca o titular
}

/** As fontes presentes no DER do certificado (titular `serialNumber`/CN e os otherNames do SubjectAltName). Lança se o DER não fecha. */
function readHolderSources(der: Buffer): SourceRead[] {
  const { asn1 } = forge
  const root = asn1.fromDer(forge.util.createBuffer(der.toString('binary')), true)   // estrito; a 1.4 já recusa bytes sobrando (parseAllBytes)
  const tbs = (root.value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[]
  const hasVersion = tbs[0].tagClass === asn1.Class.CONTEXT_SPECIFIC && tbs[0].type === 0
  const subject = tbs[(hasVersion ? 1 : 0) + 4].value as forge.asn1.Asn1[]
  const reads: SourceRead[] = []
  for (const rdn of subject) {
    for (const atv of rdn.value as forge.asn1.Asn1[]) {
      const [oidNode, valueNode] = atv.value as forge.asn1.Asn1[]
      const oid = asn1.derToOid(oidNode.value as string)
      if (oid === OID_SERIAL_NUMBER) reads.push(readSerialNumber(asn1Text(valueNode)))
      else if (oid === OID_COMMON_NAME) { const r = readCn(valueNode); if (r) reads.push(r) }
    }
  }
  const extsWrapper = tbs.find(n => n.tagClass === asn1.Class.CONTEXT_SPECIFIC && n.type === 3)
  const exts = extsWrapper ? ((extsWrapper.value as forge.asn1.Asn1[])[0].value as forge.asn1.Asn1[]) : []
  for (const ext of exts) {
    const parts = ext.value as forge.asn1.Asn1[]
    if (asn1.derToOid(parts[0].value as string) !== OID_SUBJECT_ALT_NAME) continue
    const names = asn1.fromDer(parts[parts.length - 1].value as string, true)   // estrito; a 1.4 já recusa bytes sobrando (parseAllBytes)
    // SubjectAltName fora da forma (não é SEQUENCE; otherName primitivo; tipo que não é OID) é DER que não fecha — nunca pulado em silêncio
    if (names.tagClass !== asn1.Class.UNIVERSAL || names.type !== asn1.Type.SEQUENCE || !names.constructed) throw new Error('SAN fora da forma')
    for (const gn of names.value as forge.asn1.Asn1[]) {
      if (gn.tagClass !== asn1.Class.CONTEXT_SPECIFIC || gn.type !== 0) continue   // só otherName [0]
      if (!gn.constructed) throw new Error('otherName primitivo')
      const [typeId, explicit] = gn.value as forge.asn1.Asn1[]
      if (!typeId || typeId.tagClass !== asn1.Class.UNIVERSAL || typeId.type !== asn1.Type.OID) throw new Error('otherName sem OID')
      const oid = asn1.derToOid(typeId.value as string)
      const inner = Array.isArray(explicit?.value) ? (explicit.value as forge.asn1.Asn1[])[0] : undefined
      const r = readOtherName(oid, inner)
      if (r) reads.push(r)
    }
  }
  return reads
}

/** O titular por consenso (D-CJ6/D-CJ33) a partir do certificado já aberto. Nunca lança: DER que não fecha é `unsupported`. */
export function certificateHolder(cert: X509Certificate): CertificateHolder {
  let reads: SourceRead[]
  try { reads = readHolderSources(cert.raw) } catch { return { state: 'unsupported', source: 'der' } }
  const bad = reads.find(r => 'unsupported' in r)
  if (bad) return { state: 'unsupported', source: bad.source }
  const readings = reads.filter((r): r is HolderReading => 'id' in r)
  if (readings.length === 0) return { state: 'none' }
  const first = readings[0].id
  if (readings.some(r => r.id.kind !== first.kind || r.id.value !== first.value)) return { state: 'conflict', readings }
  return { state: 'found', id: first, sources: readings.map(r => r.source).filter((s, i, all) => all.indexOf(s) === i) }
}

/** Só o VALOR da RDN CN (R3-5: a regex antiga atravessava para OU/O). */
function cnValueOf(subject: string): string | null {
  const m = /(?:^|\n|, )CN=([^\n]*?)(?=(?:, [A-Z]+=)|\n|$)/.exec(subject)
  return m ? m[1] : null
}

/** LEGADO (C1): CNPJ numérico do CN. O titular é o `certificateHolder` (D-CJ6/D-CJ33); fica exportado por compatibilidade. */
export function cnpjFromSubject(subject: string): string | null {
  const m = /:(\d{14})(?!\d)/.exec(cnValueOf(subject) ?? '')
  return m ? m[1] : null
}

/** LEGADO (C2): CPF do CN no padrão do e-CPF. O PF × PJ vem do `certificateHolder`; fica exportado por compatibilidade. */
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
  const holder = certificateHolder(cert)
  return {
    subject,
    issuer:  cert.issuer.replace(/\n/g, ', '),
    notBefore: new Date(cert.validFrom).toISOString(),
    notAfter:  notAfter.toISOString(),
    daysToExpire: days,
    fingerprint256: cert.fingerprint256,
    expired: days < 0,
    notYetValid: new Date(cert.validFrom).getTime() > now.getTime(),
    cnpj: holder.state === 'found' && holder.id.kind === 'cnpj' ? holder.id.value : null,
    holder,
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
  const holder = info.holder
  // D-CJ6/D-CJ33: o titular por CONSENSO das fontes — cada recusa diz a fonte, nunca "não é um e-CNPJ" quando o limite é nosso
  if (holder.state === 'unsupported') {
    throw new HttpError(409, `A leitura do titular do certificado ainda não reconhece o formato do campo ${HOLDER_SOURCE_LABEL[holder.source]} `
      + '— o certificado não foi aceito por suposição; fale com o suporte (o A1 pode não precisar ser trocado)',
      [{ field: 'pfx', message: 'Formato do titular não suportado' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  if (holder.state === 'conflict') {
    // CPF nunca na mensagem; dois CPFs diferentes viram "CPF 1"/"CPF 2" para a divergência continuar legível
    const cpfs = holder.readings.filter(r => r.id.kind === 'cpf').map(r => r.id.value).filter((v, i, all) => all.indexOf(v) === i)
    const said = holder.readings.map(r => `${HOLDER_SOURCE_LABEL[r.source]} = ${r.id.kind === 'cnpj' ? r.id.value
      : cpfs.length > 1 ? `um CPF (${cpfs.indexOf(r.id.value) + 1})` : 'um CPF'}`).join('; ')
    throw new HttpError(409, `Certificado incoerente: as fontes do titular divergem (${said}) — peça à AC um certificado novo`,
      [{ field: 'pfx', message: 'Certificado incoerente' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  if (holder.state === 'none') {
    throw new HttpError(409, 'Certificado sem a inscrição do titular (nem OID 2.16.76.1.3.3, nem serialNumber, nem CN "RAZÃO SOCIAL:CNPJ") '
      + '— o A1 tem que ser o e-CNPJ do emitente',
      [{ field: 'pfx', message: 'Sem a inscrição do titular' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  if (holder.id.kind === 'cpf') {
    throw new HttpError(409, 'Certificado é um e-CPF — sem procuração (D-N29) o A1 tem que ser o e-CNPJ do emitente',
      [{ field: 'pfx', message: 'e-CPF não serve para o emitente' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  if (holder.id.value !== expected) {
    throw new HttpError(409, `Certificado do CNPJ ${holder.id.value} — o estabelecimento é ${expected}; o A1 tem que ser do emitente`,
      [{ field: 'pfx', message: 'CNPJ do certificado ≠ CNPJ do estabelecimento' }], ErrorCodes.FISCAL_CERT_INVALID)
  }
  return info
}
