/**
 * LEITOR de XML do fisco por PARSER — peça do núcleo da parte 2 da NE-1a, passo 7 (dívida N17; D-NE72 = Q-NE72 (a), Valdo 2026-10-12;
 * `prompt_onda_nfe_sefaz.md` §12.9.7/§12.9.7.3). Substitui a leitura por recorte textual (regex) das famílias — o próprio ACBr migrou o
 * leitor para parser e o que sobrou de recorte nele carrega correções por SEFAZ (`nfe-api/referencia-acbr/06`).
 *
 * D-NE72: no corpus REAL e nas fixtures BEM-FORMADAS a saída é IDÊNTICA à da regex (teste de paridade da família, com o leitor antigo
 * congelado como oráculo); nos casos ESTRANHOS o leitor RECUSA (`XmlUnreadableError`) e a família transforma a recusa no ambíguo pela causa
 * que já existe (`nfse-ilegivel`/`evento-ilegivel`) — falha FECHADO. Gates do delta (Valdo 2026-10-12, "pelas recomendações"):
 *  - D-NE85: valor VAZIO é AUSENTE (o leitor pula o elemento vazio e segue para o próximo com o nome — a forma do recorte para `<x/>`);
 *  - D-NE86: o nome LOCAL (NF-e) casa só nos NAMESPACES da família (o prefixo de CE/MG sim; SOAP e XMLDSig não);
 *  - D-NE87: CDATA é escolha do CAMPO — a leitura recusa por padrão; um campo que o leiaute põe em CDATA (qrCode da NFC-e) pede `cdata:
 *    'read'`; campo que decide voz nunca;
 *  - D-NE88: tetos ANTES do parse — 1 MB de texto e 64 níveis (`grande-demais`/`profundo-demais`; a família mapeia para a causa que existe);
 *  - D-NE90: onde o recorte lia errado XML bem-formado (marcação dentro de comentário, espaço antes do `>`, entidade de espaço na ponta,
 *    CR LF, entidade/espaço/`>` em atributo) o parser lê CERTO — divergência intencional.
 *
 * ESTRITO por GRAMÁTICA, numa varredura ÚNICA em ordem de documento ANTES do `@xmldom/xmldom` 0.8 (que é leniente — medido no passo 7:
 * aceita `&` solto, lixo fora da raiz, referência de caractere inválida como lixo, CDATA/PI sem fim, `<` em atributo…). Gate adversarial do
 * delta (N17-01): duas passadas independentes (CDATA, depois comentário) deixavam um `<![CDATA[` num comentário e um `]]>` noutro esconderem
 * o que estava entre eles — por isso UMA varredura que respeita comentário, CDATA, PI e tag na ordem em que aparecem.
 *
 * CONHECIMENTO NEGATIVO: (1) o `@xmldom` traz os tipos do DOM do navegador (`/// <reference lib="dom" />`) para a compilação INTEIRA de
 * quem o importa com tipos — aqui ele entra por `require` com tipos estruturais mínimos; (2) a mensagem da recusa NUNCA carrega trecho do
 * documento (D-F100: a resposta pode ser de um terceiro) — só o motivo e a posição.
 */
import { readonlySet } from '../util/readonly-set'

/** O nó como o leitor o enxerga (estrutural — sem os tipos globais do DOM). */
export interface XmlNode {
  readonly nodeType:     number
  readonly nodeName:     string
  readonly nodeValue:    string | null
  readonly localName?:   string | null
  readonly namespaceURI?: string | null
  readonly childNodes:   { readonly length: number; readonly [i: number]: XmlNode }
  readonly parentNode:   XmlNode | null
  readonly attributes?:  { readonly length: number; readonly [i: number]: { readonly name: string; readonly value: string } }
  getAttribute?(name: string): string | null
  hasAttribute?(name: string): boolean
}
export interface XmlDocument extends XmlNode { readonly documentElement: XmlNode | null }

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DOMParser } = require('@xmldom/xmldom') as {
  DOMParser: new (o: { errorHandler: Record<'warning' | 'error' | 'fatalError', (m: string) => void> }) => { parseFromString(s: string, mime: string): XmlDocument }
}

export const ELEMENT = 1
const TEXT = 3, CDATA = 4, PI = 7, COMMENT = 8

/** D-NE88: tetos antes do parse (o DOM custa ~90× o texto). NFS-e real ≈ 10 KB e 12 níveis. */
export const MAX_XML_BYTES = 1024 * 1024
export const MAX_XML_DEPTH = 64

/** Por que o leitor recusou — a FAMÍLIA mapeia para a causa de ambíguo dela (nunca uma causa nova — D-F98). */
export type XmlRefusal = 'vazio' | 'grande-demais' | 'profundo-demais' | 'mal-formado' | 'doctype' | 'referencia-invalida' | 'caractere-invalido'
  | 'fora-da-raiz' | 'valor-nao-simples' | 'cdata' | 'grupo-vazio'

/** Recusa do leitor: o MOTIVO e, quando há, a POSIÇÃO — nunca conteúdo do documento (D-F100). */
export class XmlUnreadableError extends Error {
  constructor(readonly reason: XmlRefusal, readonly position: number | null = null) {
    super(`XML ilegível (${reason})${position === null ? '' : ` na posição ${position}`}`)
    this.name = 'XmlUnreadableError'
  }
}

/**
 * Como a FAMÍLIA lê o NOME: QUALIFICADO (exato, prefixo incluído — a NFS-e: o manual veda prefixo) ou LOCAL dentro dos NAMESPACES da família
 * (D-NE86 — a NF-e: o prefixo das SEFAZ CE/MG casa; o cabeçalho SOAP e a XMLDSig, não).
 */
export type XmlReadOptions =
  | { readonly match: 'qualified' }
  | { readonly match: 'local'; readonly namespaces: readonly string[] }

/** Leitura de UM campo (D-NE87): CDATA recusado por padrão; `cdata: 'read'` só onde o leiaute põe CDATA — nunca em campo que decide voz. */
export interface XmlFieldRead { readonly cdata?: 'refuse' | 'read' }

const PREDEFINED = readonlySet(['amp', 'lt', 'gt', 'quot', 'apos'])
/** Char do XML 1.0: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]. */
const validChar = (cp: number) => cp === 0x9 || cp === 0xA || cp === 0xD || (cp >= 0x20 && cp <= 0xD7FF)
  || (cp >= 0xE000 && cp <= 0xFFFD) || (cp >= 0x10000 && cp <= 0x10FFFF)
/** O MESMO `Char` do XML 1.0 para o ESCRITOR (`xml/writer.ts` — D-NE214): uma regra só, a que o leitor aplica. */
export const isXmlChar = (cp: number): boolean => validChar(cp)
/** Caractere CRU fora do Char do XML 1.0 (controle, NUL, U+FFFE/FFFF, surrogate solto). */
const RAW_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const XML_SPACE = /^[ \t\r\n]*$/

function assertChars(s: string, at: number): void {
  const m = RAW_INVALID.exec(s)
  if (m) throw new XmlUnreadableError('caractere-invalido', at + m.index)
}
/** As referências de um trecho de TEXTO ou de valor de ATRIBUTO: só as predefinidas e as de caractere válido; `&` solto é recusa. */
function assertReferences(s: string, at: number): void {
  for (const m of s.matchAll(/&([^;&<\s]*)(;?)/g)) {
    const [, name, semi] = m
    const pos = at + (m.index ?? 0)
    if (!semi || !name) throw new XmlUnreadableError('referencia-invalida', pos)
    if (name[0] === '#') {
      const cp = /^#x[0-9a-fA-F]+$/.test(name) ? parseInt(name.slice(2), 16) : /^#[0-9]+$/.test(name) ? parseInt(name.slice(1), 10) : NaN
      if (!Number.isFinite(cp) || !validChar(cp)) throw new XmlUnreadableError('referencia-invalida', pos)
    } else if (!PREDEFINED.has(name)) {
      throw new XmlUnreadableError('referencia-invalida', pos)
    }
  }
}

/**
 * A varredura ÚNICA da gramática (em ordem de documento): comentário (sem `--` dentro), CDATA (só dentro da raiz e fechado), PI (fechada; a
 * declaração `<?xml` só no início), nenhuma outra declaração `<!…` (DOCTYPE, ENTITY), tag com valores de atributo sem `<` cru e com
 * referências válidas, texto sem `]]>` e com referências válidas, nada além de espaço do XML fora da raiz, uma raiz só, profundidade ≤ teto.
 * Nomes, aspas e atributos duplicados ficam para o parser (que os acusa — recusa).
 */
function scanGrammar(s: string): void {
  const n = s.length
  let i = s.charCodeAt(0) === 0xFEFF ? 1 : 0
  const start = i
  let depth = 0, seenRoot = false, rootClosed = false
  const outside = () => !seenRoot || rootClosed
  while (i < n) {
    if (s[i] !== '<') {
      const next = s.indexOf('<', i)
      const end = next < 0 ? n : next
      const run = s.slice(i, end)
      if (outside()) { if (!XML_SPACE.test(run)) throw new XmlUnreadableError('fora-da-raiz', i) }
      else {
        if (run.includes(']]>')) throw new XmlUnreadableError('mal-formado', i + run.indexOf(']]>'))
        assertChars(run, i)
        assertReferences(run, i)
      }
      i = end
      continue
    }
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4)
      if (end < 0) throw new XmlUnreadableError('mal-formado', i)
      const body = s.slice(i + 4, end)
      if (body.includes('--') || body.endsWith('-')) throw new XmlUnreadableError('mal-formado', i)
      assertChars(body, i + 4)
      i = end + 3
      continue
    }
    if (s.startsWith('<![CDATA[', i)) {
      if (outside()) throw new XmlUnreadableError('fora-da-raiz', i)
      const end = s.indexOf(']]>', i + 9)
      if (end < 0) throw new XmlUnreadableError('mal-formado', i)
      assertChars(s.slice(i + 9, end), i + 9)
      i = end + 3
      continue
    }
    if (s.startsWith('<!', i)) throw new XmlUnreadableError(/^<!DOCTYPE/i.test(s.slice(i, i + 9)) ? 'doctype' : 'mal-formado', i)
    if (s.startsWith('<?', i)) {
      const end = s.indexOf('?>', i + 2)
      if (end < 0) throw new XmlUnreadableError('mal-formado', i)
      const target = /^<\?([^\s?]*)/.exec(s.slice(i, end))?.[1] ?? ''
      if (!target || (target.toLowerCase() === 'xml' && i !== start)) throw new XmlUnreadableError('mal-formado', i)
      assertChars(s.slice(i, end), i)
      i = end + 2
      continue
    }
    // tag de abertura, fechamento ou vazia — até o `>` que não está dentro de aspas
    const closing = s[i + 1] === '/'
    let k = i + 1, quote = ''
    for (; k < n; k++) {
      const c = s[k]
      if (quote) {
        if (c === quote) quote = ''
        else if (c === '<') throw new XmlUnreadableError('mal-formado', k)
      } else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
      else if (c === '<') throw new XmlUnreadableError('mal-formado', k)
    }
    if (k >= n) throw new XmlUnreadableError('mal-formado', i)
    const tag = s.slice(i, k + 1)
    assertChars(tag, i)
    for (const m of tag.matchAll(/"([^"]*)"|'([^']*)'/g)) assertReferences(m[1] ?? m[2] ?? '', i + (m.index ?? 0) + 1)
    if (closing) {
      depth--
      if (depth < 0) throw new XmlUnreadableError('mal-formado', i)
      if (depth === 0) rootClosed = true
    } else {
      if (rootClosed) throw new XmlUnreadableError('fora-da-raiz', i)
      seenRoot = true
      if (tag.endsWith('/>')) { if (depth === 0) rootClosed = true }
      else if (++depth > MAX_XML_DEPTH) throw new XmlUnreadableError('profundo-demais', i)
    }
    i = k + 1
  }
  if (!seenRoot || depth !== 0) throw new XmlUnreadableError('mal-formado', null)
}

/** Lê o documento INTEIRO, estrito (ver o cabeçalho). Recusa = `XmlUnreadableError` — nunca outra exceção. */
export function parseXml(xml: string): XmlDocument {
  if (typeof xml !== 'string' || !xml.trim()) throw new XmlUnreadableError('vazio')
  if (Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) throw new XmlUnreadableError('grande-demais')
  scanGrammar(xml)
  const body = xml.replace(/^﻿/, '')
  let problems = 0
  const report = () => { problems++ }
  let doc: XmlDocument
  try {
    doc = new DOMParser({ errorHandler: { warning: report, error: report, fatalError: report } }).parseFromString(body, 'text/xml')
  } catch {
    throw new XmlUnreadableError('mal-formado')                              // o @xmldom LANÇA em alguns casos (gate N17-03)
  }
  if (problems || !doc || !doc.documentElement) throw new XmlUnreadableError('mal-formado')
  let roots = 0
  for (let i = 0; i < doc.childNodes.length; i++) {
    const c = doc.childNodes[i]
    if (c.nodeType === ELEMENT) roots++
    else if (c.nodeType === TEXT ? !XML_SPACE.test(c.nodeValue ?? '') : c.nodeType !== PI && c.nodeType !== COMMENT) throw new XmlUnreadableError('fora-da-raiz')
  }
  if (roots !== 1) throw new XmlUnreadableError('fora-da-raiz')
  return doc
}

/** Os ELEMENTOS descendentes de [scope] em ORDEM DE DOCUMENTO (a ordem das tags de abertura) — iterativo (gate N17-03). [self] inclui o scope. */
export function elementsOf(scope: XmlNode, self = false): XmlNode[] {
  const out: XmlNode[] = []
  if (self && scope.nodeType === ELEMENT) out.push(scope)
  const stack: XmlNode[] = []
  const pushChildren = (n: XmlNode) => { for (let i = n.childNodes.length - 1; i >= 0; i--) if (n.childNodes[i].nodeType === ELEMENT) stack.push(n.childNodes[i]) }
  pushChildren(scope)
  while (stack.length) {
    const el = stack.pop()!
    out.push(el)
    pushChildren(el)
  }
  return out
}

/** O nome do elemento casa com [name] pelo modo da família (D-NE86). */
export function nameIs(el: XmlNode, name: string, opts: XmlReadOptions): boolean {
  if (opts.match === 'qualified') return el.nodeName === name
  return (el.localName ?? el.nodeName.replace(/^[^:]*:/, '')) === name && opts.namespaces.includes(el.namespaceURI ?? '')
}

/** Quantos atributos o elemento tem (`<e101101>` sem atributo é a forma que o leiaute fixa). */
export function attributeCount(el: XmlNode): number {
  return el.attributes?.length ?? 0
}

/** Os filhos ELEMENTO do elemento — o GRUPO sem nenhum é vazio (D-NE85: grupo que decide voz vazio = recusa, na família). */
export function childElementCount(el: XmlNode): number {
  let c = 0
  for (let i = 0; i < el.childNodes.length; i++) if (el.childNodes[i].nodeType === ELEMENT) c++
  return c
}

/** O atributo [name] do elemento (já decodificado pelo parser); null se ausente. */
export function attrOf(el: XmlNode, name: string): string | null {
  return el.hasAttribute?.(name) ? (el.getAttribute?.(name) ?? null) : null
}

/**
 * O VALOR de um elemento — TEXTO SIMPLES aparado: filho elemento, comentário ou instrução de processamento = recusa; CDATA = recusa, salvo
 * no campo que pede (D-NE87). Vazio = ''.
 */
export function textOf(el: XmlNode, field: XmlFieldRead = {}): string {
  let s = ''
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i]
    if (c.nodeType === TEXT) s += c.nodeValue ?? ''
    else if (c.nodeType === CDATA) {
      if (field.cdata !== 'read') throw new XmlUnreadableError('cdata')
      s += c.nodeValue ?? ''
    } else throw new XmlUnreadableError('valor-nao-simples')
  }
  return s.trim()
}

/** O 1º elemento [name] entre os descendentes de [scope] (o documento inclui a raiz) que passa em [where]. */
export function firstElement(scope: XmlNode, name: string, opts: XmlReadOptions, where: (el: XmlNode) => boolean = () => true): XmlNode | null {
  return elementsOf(scope, false).find(el => nameIs(el, name, opts) && where(el)) ?? null
}

/**
 * O VALOR do 1º elemento [name] entre os descendentes de [scope] que NÃO está vazio — D-NE85: o vazio é AUSENTE (pula para o próximo com
 * o nome; nenhum = null); recusa se o valor não é texto simples.
 */
export function firstText(scope: XmlNode, name: string, opts: XmlReadOptions, field: XmlFieldRead = {}): string | null {
  for (const el of elementsOf(scope, false)) {
    if (!nameIs(el, name, opts)) continue
    const v = textOf(el, field)
    if (v !== '') return v
  }
  return null
}

/** [a] contém [b] (é ancestral)? */
export function contains(a: XmlNode, b: XmlNode): boolean {
  for (let p = b.parentNode; p; p = p.parentNode) if (p === a) return true
  return false
}
