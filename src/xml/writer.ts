/**
 * ESCRITOR de XML — peça do núcleo da NE-4 (`fiscal-api:FAMILIA.E5.P4.T1`; D-NE214 = Q-NE214 (a), Valdo 2026-11-21,
 * `prompt_onda_nfe_sefaz.md` §22.5). Aditivo, ao lado do LEITOR estrito (`xml/reader.ts`): o que ele escreve, relido pelo leitor, devolve o
 * MESMO texto (a prova da T1). Sai do `escapeXml`/`el`/`grp` da nfse-api (`authority/dps-builder.ts`), que migra na janela dela; os
 * formatadores `TDec_*` ficam em cada família.
 *
 * Forma (parecer do guardião, ficha `projetos/fiscal-api/GERAL/ficha-familia-e5-p4-pecas-ne4.md` §5 T1):
 *  - `xmlElement` (OBRIGATÓRIO: vazio recusa) × `xmlOptionalElement` (vazio = nada — MOC 7.00 VG §4.2.1.3). Um `el` só que omite qualquer
 *    vazio deixaria sumir calado um campo obrigatório (a maquete que a peça evita por construção);
 *  - `xmlGroup` recebe os atributos como MAPA e os escapa — atributo como texto cru abriria injeção;
 *  - nome de elemento/atributo conferido (ASCII, um prefixo no máximo) — injeção pelo nome também recusa.
 *  - `isXsdTString`: o domínio `TString`/`TSString` dos leiautes (RF-NFE-35, RF-NFS-13) como predicado ÚNICO; o escritor NÃO o aplica
 *    (é a FAMÍLIA que sabe em que campo vale); a peça do responsável técnico o usa.
 *
 * Escape: os cinco caracteres (`'` → `&apos;`, a forma de hoje da nfse-api — o MOC usa `&#39;`, os dois são XML válido); no TEXTO, CR →
 * `&#xD;` (o parser normaliza CR cru para LF — sem isso o texto relido não seria o mesmo); no ATRIBUTO, também TAB e LF por referência (a
 * normalização de atributo os viraria espaço). Caractere fora do `Char` do XML 1.0 (o mesmo do leitor — `isXmlChar`) ou surrogate solto =
 * RECUSA, nunca troca calada.
 *
 * CONHECIMENTO NEGATIVO: a recusa NUNCA carrega o valor (pode ser um segredo, como o CSRT antes do hash) — só o motivo e o NOME do campo.
 * O leitor APARA as pontas do texto (`textOf`, `String.prototype.trim` — inclui NBSP): o que ele apara na ponta não volta igual — por isso o
 * `isXsdTString` recusa ponta que o `trim()` remove (o XSD sozinho aceitaria NBSP), e a família o aplica antes de escrever. Valor obrigatório
 * só com espaço é VAZIO (o leitor o leria como ausente). Ao migrar, a saída da NFS-e só muda onde havia CR, NEL ou U+2028 crus (agora por
 * referência) e caractere fora do XML 1.0 (agora recusa).
 */
import { isXmlChar } from './reader'

export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>'

/** Por que o escritor recusou — o motivo e o nome, nunca o valor. */
export type XmlUnwritableReason = 'caractere-invalido' | 'nome-invalido' | 'obrigatorio-vazio' | 'valor-nao-texto'

export class XmlUnwritableError extends Error {
  constructor(readonly reason: XmlUnwritableReason, readonly field: string | null = null) {
    super(`XML não escrito (${reason})${field === null ? '' : ` em ${field}`}`)
    this.name = 'XmlUnwritableError'
  }
}

/** Nome de elemento/atributo: ASCII, começa por letra ou `_`, um prefixo no máximo (`ds:Signature`, `xmlns:ds`). */
const XML_NAME = /^[A-Za-z_][A-Za-z0-9._-]*(?::[A-Za-z_][A-Za-z0-9._-]*)?$/

function assertName(name: unknown): asserts name is string {
  // o nome vai na mensagem só quando é um nome válido de XML (nunca um valor arbitrário)
  if (typeof name !== 'string' || !XML_NAME.test(name)) throw new XmlUnwritableError('nome-invalido')
}

const TEXT_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\r': '&#xD;',
  // gate adversarial (MED-3): o @xmldom normaliza NEL e LINE SEPARATOR crus para LF (regra do XML 1.1) — por referência voltam intactos
  '\u0085': '&#x85;', ' ': '&#x2028;',
})
const ATTRIBUTE_ESCAPES: Readonly<Record<string, string>> = Object.freeze({ ...TEXT_ESCAPES, '\t': '&#x9;', '\n': '&#xA;' })

function escapeWith(s: unknown, table: Readonly<Record<string, string>>, field: string | null): string {
  if (typeof s !== 'string') throw new XmlUnwritableError('valor-nao-texto', field)
  let out = ''
  // `for…of` anda por PONTO DE CÓDIGO: o par de surrogates vira um astral válido; o surrogate solto chega sozinho e não é `Char`
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number
    if (!isXmlChar(cp)) throw new XmlUnwritableError('caractere-invalido', field)
    out += table[ch] ?? ch
  }
  return out
}

/** O texto como CONTEÚDO de elemento: os cinco caracteres e o CR escapados; caractere fora do XML 1.0 = recusa. */
export function escapeXmlText(s: string): string {
  return escapeWith(s, TEXT_ESCAPES, null)
}

/** Elemento OBRIGATÓRIO: valor `null`/`undefined`/`''` = recusa (campo obrigatório nunca some calado do documento). */
export function xmlElement(name: string, value: string | null | undefined): string {
  assertName(name)
  // só espaço também é vazio: o leitor apara e devolve AUSENTE (D-NE85) — gate adversarial (LOW-1)
  if (value === null || value === undefined || value === '' || (typeof value === 'string' && value.trim() === '')) {
    throw new XmlUnwritableError('obrigatorio-vazio', name)
  }
  return `<${name}>${escapeWith(value, TEXT_ESCAPES, name)}</${name}>`
}

/** Elemento OPCIONAL: valor `null`/`undefined`/`''` = nada (MOC 7.00 VG §4.2.1.3 — tag opcional vazia não vai). */
export function xmlOptionalElement(name: string, value: string | null | undefined): string {
  assertName(name)
  if (value === null || value === undefined || value === '') return ''
  return `<${name}>${escapeWith(value, TEXT_ESCAPES, name)}</${name}>`
}

/**
 * GRUPO: `inner` já é XML montado por estas peças (não é escapado de novo); os atributos vêm como mapa, na ordem das chaves, com o valor
 * escapado entre aspas duplas.
 */
export function xmlGroup(name: string, inner: string, attrs: Readonly<Record<string, string>> = {}): string {
  assertName(name)
  if (typeof inner !== 'string') throw new XmlUnwritableError('valor-nao-texto', name)
  let a = ''
  for (const [k, v] of Object.entries(attrs)) {
    assertName(k)
    a += ` ${k}="${escapeWith(v, ATTRIBUTE_ESCAPES, k)}"`
  }
  return `<${name}${a}>${inner}</${name}>`
}

/**
 * Domínio `TString` (NF-e, `tiposBasico_v4.00.xsd`) / `TSString` (NFS-e): só U+0020-U+00FF, sem espaço nas pontas, com [min, max]
 * caracteres — RF-NFE-35 / RF-NFS-13. Predicado ÚNICO do workspace; quem aplica é a família (e a peça do responsável técnico).
 */
export function isXsdTString(s: unknown, min: number, max: number): s is string {
  if (typeof s !== 'string' || s.length < min || s.length > max) return false
  // ponta: nem o espaço do XSD nem o que o `trim()` do leitor apara (NBSP U+00A0 está no domínio e sumiria na ida e volta — gate MED-4)
  if (s !== s.trim()) return false
  return /^[ -ÿ]*$/.test(s)
}
