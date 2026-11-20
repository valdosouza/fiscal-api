import { SignedXml } from 'xml-crypto'
import { parseXml, elementsOf, attrOf, XmlNode } from '../xml/reader'

/**
 * Assinatura XMLDSig ENVELOPED no padrão do Sistema Nacional NFS-e (Manual
 * Integrado 2022 §6.1.4): Reference `#Id` do elemento assinado, transforms
 * enveloped-signature + C14N inclusiva, canonicalização C14N inclusiva,
 * KeyInfo só com X509Certificate do certificado FINAL (EndCertOnly), sem
 * KeyValue/SubjectName. A Signature entra como ÚLTIMO filho do PAI do elemento
 * assinado (DPS/infDPS → DPS; pedRegEvento/infPedReg → pedRegEvento).
 *
 * Algoritmo parametrizado: o manual de 2022 fixa rsa-sha1/sha1 e é o que o ADN
 * aceita hoje (padrão); sha256 fica pronto para quando o fisco virar — o
 * adaptador escolhe (D-N12: a 1ª sessão com o e-CNPJ confirma).
 */

export type SignAlgorithm = 'sha1' | 'sha256'

export const C14N_INCLUSIVE   = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
export const ENVELOPED        = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'
export const DSIG_NS          = 'http://www.w3.org/2000/09/xmldsig#'

const ALGORITHMS: Record<SignAlgorithm, { signature: string; digest: string }> = {
  sha1:   { signature: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',          digest: 'http://www.w3.org/2000/09/xmldsig#sha1' },
  sha256: { signature: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',   digest: 'http://www.w3.org/2001/04/xmlenc#sha256' },
}

export interface SignXmlOptions {
  /** Valor do atributo Id do elemento a assinar (ex.: 'DPS4106902…'). */
  referenceId: string
  cert: Buffer            // PEM (pode trazer cadeia — só o 1º certificado entra no KeyInfo)
  key:  Buffer            // PEM
  algorithm: SignAlgorithm
}

/** Primeiro bloco CERTIFICATE do PEM (EndCertOnly — a cadeia fica de fora). */
export function firstCertificatePem(pem: Buffer | string): string {
  const m = String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)
  if (!m) throw new Error('Certificado PEM sem bloco CERTIFICATE')
  return m[0]
}

function assertReferenceId(id: string): void {
  // vai dentro de um XPath com aspas simples; o Id do DPS/evento é alfanumérico por construção
  if (!/^[A-Za-z0-9]+$/.test(id)) throw new Error(`Id de referência inválido para assinatura: ${id}`)
}

/**
 * Assina `xml` em volta do elemento cujo atributo `Id` = `referenceId` e devolve
 * o XML com a Signature já posicionada. Lança se o Id não existir no XML.
 */
export function signXml(xml: string, opts: SignXmlOptions): string {
  assertReferenceId(opts.referenceId)
  const alg = ALGORITHMS[opts.algorithm]
  const target = `//*[@Id='${opts.referenceId}']`
  const sig = new SignedXml({
    privateKey: opts.key,
    publicCert: firstCertificatePem(opts.cert),
    signatureAlgorithm: alg.signature,
    canonicalizationAlgorithm: C14N_INCLUSIVE,
  })
  // xml-crypto lê o Id existente do nó e escreve URI="#<Id>" — nunca inventa um id
  sig.addReference({ xpath: target, transforms: [ENVELOPED, C14N_INCLUSIVE], digestAlgorithm: alg.digest, uri: `#${opts.referenceId}` })
  // location = PAI do elemento assinado, append → Signature vira o último filho dele
  sig.computeSignature(xml, { location: { reference: `${target}/..`, action: 'append' } })
  return sig.getSignedXml()
}

/**
 * D-NE195: os transforms aceitos — o enveloped e as QUATRO canonicalizações do padrão (inclusiva e exclusiva, com e sem comentários: o ADN
 * assina a NFS-e e os eventos com `xml-exc-c14n#WithComments`; o emitente e a NF-e com a inclusiva). XPath, XSLT, base64 e todo outro =
 * recusa (são os que ESCOLHEM o que é assinado — a porta do XSW). Arrays, nunca Set/Map (cerca `contrato.test.ts`).
 */
export const ACCEPTED_TRANSFORMS: readonly string[] = Object.freeze([   // imutável em execução (gate socrático M1 — a classe do NE1A-06)
  ENVELOPED,
  C14N_INCLUSIVE,
  'http://www.w3.org/TR/2001/REC-xml-c14n-20010315#WithComments',
  'http://www.w3.org/2001/10/xml-exc-c14n#',
  'http://www.w3.org/2001/10/xml-exc-c14n#WithComments',
])

/** Os atributos que o `xml-crypto` 6.3.2 aceita como identificador (`idAttributes`), em qualquer prefixo. */
const ID_ATTRIBUTES: readonly string[] = ['Id', 'ID', 'id']

/** O que a família pede ao `verifyXml` (D-NE194). */
export interface VerifyXmlOptions {
  /** Nome LOCAL do elemento assinado que a família vai ler (`infProt`, `infDPS`, `infNFSe`, `infEvento`…). */
  element: string
  /** O `Id` esperado, quando a família o conhece (o do `infProt` é opcional no XSD e escolhido pelo fisco — então opcional aqui). */
  id?: string
}

/** O trecho assinado: o `Id` do elemento e o XML CANÔNICO que a assinatura cobre (`getSignedReferences()` — D-NE183). */
export interface SignedPart {
  readonly id: string
  readonly xml: string
}

const localOf = (name: string): string => name.replace(/^[^:]*:/, '')
const dsigChildren = (el: XmlNode, name: string): XmlNode[] => {
  const out: XmlNode[] = []
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i]
    if (c.nodeType === 1 && c.localName === name && c.namespaceURI === DSIG_NS) out.push(c)
  }
  return out
}
/** Os elementos do documento com o identificador `id` em `Id`/`ID`/`id` (qualquer prefixo — como o `xml-crypto` procura). */
const elementsWithId = (all: XmlNode[], id: string): XmlNode[] => all.filter(e => {
  const attrs = e.attributes
  if (!attrs) return false
  for (let i = 0; i < attrs.length; i++) if (ID_ATTRIBUTES.includes(localOf(attrs[i].name)) && attrs[i].value === id) return true
  return false
})
/** As `Reference` da Signature (dentro do `SignedInfo`). */
const referencesOf = (sig: XmlNode): XmlNode[] => dsigChildren(sig, 'SignedInfo').flatMap(si => dsigChildren(si, 'Reference'))
/** O Id que a `Reference` aponta (`URI="#x"`), ou null se não for uma referência local por Id. */
const referencedId = (ref: XmlNode): string | null => {
  const uri = attrOf(ref, 'URI')
  return uri && uri.startsWith('#') && uri.length > 1 ? uri.slice(1) : null
}

/**
 * D-NE183 + D-NE194 + D-NE195 (FAMILIA.E5.P1.T2): **lê só o que foi assinado**. Verifica a assinatura do elemento que a família nomeia com
 * o certificado DADO (o KeyInfo é ignorado — quem verifica escolhe em quem confia) e devolve o `Id` e o TRECHO canônico assinado; quem lê
 * campo que decide voz lê SÓ desse trecho (pelo leitor estrito), e o ELO com a pergunta (a chave lida de dentro dele) é da família.
 * Recusa = `null`, nunca exceção:
 *  - documento ilegível pelo leitor estrito; certificado sem bloco PEM;
 *  - não há EXATAMENTE UMA Signature XMLDSig cuja Reference aponte para um elemento de nome local `element` (o `procNFe` traz a do emitente
 *    no `infNFe` e a do fisco no `infProt` — a família escolhe pelo elemento, nunca pela ordem do documento);
 *  - a Signature não declara o namespace nela mesma (a forma de sempre — D-NE72); mais de uma `Reference`; Id com caractere fora de
 *    `[A-Za-z0-9_.-]`; o Id aparece mais de uma vez em `Id`/`ID`/`id`; o Id esperado (se dado) é outro;
 *  - transform fora do `ACCEPTED_TRANSFORMS`, repetido, ou mais de dois;
 *  - a assinatura não confere, ou o `xml-crypto` não devolve exatamente um trecho.
 * CONHECIMENTO NEGATIVO (gates de 2026-11-20): (1) o elemento é escolhido pelo nome LOCAL — o namespace é conferido pela família ao ler
 * o trecho (modo `local` com os namespaces dela); (2) dois elementos assinados com o MESMO nome local (o `infEvento` do pedido e o do
 * retorno no `procEventoNFe`) = recusa, mesmo com `id` — a D-NE194 conta as candidatas antes; (3) o `xml-crypto` 6.3.2 canoniza a
 * SignedInfo com os namespaces dos ancestrais da PRIMEIRA SignedInfo em ordem de documento, qualquer que seja (`findAncestorNs`): quando
 * as assinaturas têm ancestrais com namespaces diferentes (um `procNFe` cujo `NFe` declara `xmlns:xsi`; o envelope SOAP em volta do
 * retorno), a que não é a primeira não verifica (falha FECHADO — nunca aceita a mais). REGRA para as famílias: verificar o documento já
 * RECORTADO do envelope pelo leitor estrito, uma assinatura por documento sempre que der; (4) a C14N transforma
 * CDATA em texto — no trecho, a recusa de CDATA da D-NE87 não se aplica (o conteúdo é o assinado).
 */
export function verifyXml(signedXml: string, certPem: Buffer | string, opts: VerifyXmlOptions): SignedPart | null {
  try {
    if (!opts || typeof opts.element !== 'string' || !opts.element) return null
    const all = elementsOf(parseXml(signedXml))
    const named = (id: string) => elementsWithId(all, id).some(e => e.localName === opts.element)
    const candidates = all.filter(e => e.localName === 'Signature' && e.namespaceURI === DSIG_NS
      && referencesOf(e).some(r => { const id = referencedId(r); return id !== null && named(id) }))
    if (candidates.length !== 1) return null
    const sig = candidates[0]
    if (attrOf(sig, 'xmlns') !== DSIG_NS) return null
    const refs = referencesOf(sig)
    if (refs.length !== 1) return null
    const id = referencedId(refs[0])
    if (id === null || !/^[A-Za-z0-9_.-]+$/.test(id)) return null
    if (elementsWithId(all, id).length !== 1) return null
    if (opts.id !== undefined && opts.id !== id) return null
    const transforms = dsigChildren(refs[0], 'Transforms').flatMap(ts => dsigChildren(ts, 'Transform')).map(t => attrOf(t, 'Algorithm') ?? '')
    if (transforms.length > 2 || transforms.some((a, i) => !ACCEPTED_TRANSFORMS.includes(a) || transforms.indexOf(a) !== i)) return null
    const v = new SignedXml({ publicCert: firstCertificatePem(certPem) })
    v.loadSignature(sig as any)                                  // o nó do MESMO @xmldom que o xml-crypto usa (tipos do DOM fora do núcleo)
    if (v.checkSignature(signedXml) !== true) return null
    const parts = v.getSignedReferences()
    if (parts.length !== 1 || typeof parts[0] !== 'string') return null
    return { id, xml: parts[0] }
  } catch {
    return null
  }
}
