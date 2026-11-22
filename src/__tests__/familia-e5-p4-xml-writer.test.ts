// fiscal-api:FAMILIA.E5.P4.T1 — o ESCRITOR de XML do núcleo (D-NE214): o que ele escreve, relido pelo LEITOR estrito, devolve o MESMO texto.
// Ficha: projetos/fiscal-api/GERAL/ficha-familia-e5-p4-pecas-ne4.md §5 T1 e §6 ordem 1.
import {
  XML_DECLARATION, XmlUnwritableError, escapeXmlText, isXsdTString, xmlElement, xmlGroup, xmlOptionalElement,
} from '../xml/writer'
import { attrOf, firstElement, firstText, parseXml } from '../xml/reader'
import * as barrel from '../index'

const Q = { match: 'qualified' } as const
const reason = (fn: () => unknown): string => {
  try { fn(); return 'escreveu' } catch (e) { return e instanceof XmlUnwritableError ? e.reason : `OUTRO: ${(e as Error).message}` }
}
const roundTrip = (value: string): string | null =>
  firstText(parseXml(`${XML_DECLARATION}${xmlGroup('r', xmlElement('v', value))}`), 'v', Q)

describe('FAMILIA.E5.P4.T1 — escritor de XML (D-NE214)', () => {
  it('ida e volta: o leitor devolve EXATO o texto escrito (especiais no MEIO — o leitor apara as pontas)', () => {
    const casos = [
      'DIAS & DIAS', 'a<b>"c"\'d\'', 'ÁÇÕ ÿ', 'x😀y', 'a\rb', 'a\r\nb', 'a\tb', 'a\nb', '&amp;', ']]>', '<!-- x -->', 'a&#x41;b',
    ]
    for (const v of casos) expect(roundTrip(v)).toBe(v)
  })

  it('o escape é o de hoje da nfse-api (a saída da NFS-e não muda ao migrar) e o CR vira referência', () => {
    expect(escapeXmlText(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;')
    expect(escapeXmlText('a\rb')).toBe('a&#xD;b')
    expect(escapeXmlText('a\nb\tc')).toBe('a\nb\tc')
    expect(xmlElement('xNome', 'DIAS & DIAS')).toBe('<xNome>DIAS &amp; DIAS</xNome>')
  })

  it('caractere fora do XML 1.0 ou surrogate solto = RECUSA (nunca troca calada) — e a recusa não carrega o valor', () => {
    for (const v of ['a\u0000b', 'a\u0001b', 'a￾b', 'a￿b', 'a\uD800b', 'a\uDC00b', '\uD83D']) {
      expect(reason(() => escapeXmlText(v))).toBe('caractere-invalido')
      expect(reason(() => xmlElement('v', v))).toBe('caractere-invalido')
    }
    try { xmlElement('CSRT', 'SEGREDO\u0000') } catch (e) {
      expect((e as Error).message).not.toContain('SEGREDO')
      expect((e as XmlUnwritableError).field).toBe('CSRT')
    }
  })

  it('obrigatório vazio recusa; opcional vazio some', () => {
    expect(reason(() => xmlElement('a', ''))).toBe('obrigatorio-vazio')
    expect(reason(() => xmlElement('a', null))).toBe('obrigatorio-vazio')
    expect(reason(() => xmlElement('a', undefined))).toBe('obrigatorio-vazio')
    expect(xmlOptionalElement('a', '')).toBe('')
    expect(xmlOptionalElement('a', null)).toBe('')
    expect(xmlOptionalElement('a', undefined)).toBe('')
    expect(xmlOptionalElement('a', '0')).toBe('<a>0</a>')
    expect(reason(() => xmlElement('a', 5 as unknown as string))).toBe('valor-nao-texto')
  })

  it('atributos: mapa escapado pela peça; aspas, &, <, TAB, LF e CR relidos iguais', () => {
    const v = 'x"&<\ny\tz\rw\'q'
    const xml = xmlGroup('r', xmlElement('v', '1'), { Id: v, versao: '1.00' })
    expect(xml).toBe('<r Id="x&quot;&amp;&lt;&#xA;y&#x9;z&#xD;w&apos;q" versao="1.00"><v>1</v></r>')
    const r = firstElement(parseXml(xml), 'r', Q)!
    expect(attrOf(r, 'Id')).toBe(v)
    expect(attrOf(r, 'versao')).toBe('1.00')
    expect(reason(() => xmlGroup('r', '', { Id: 'a\u0000' }))).toBe('caractere-invalido')
  })

  it('nome de elemento/atributo conferido: injeção pelo nome = recusa', () => {
    for (const n of ['a b', 'a>', '1a', '', 'a"', 'a:b:c', '-a', 'á']) {
      expect(reason(() => xmlElement(n, 'x'))).toBe('nome-invalido')
      expect(reason(() => xmlOptionalElement(n, ''))).toBe('nome-invalido')
      expect(reason(() => xmlGroup(n, ''))).toBe('nome-invalido')
      expect(reason(() => xmlGroup('r', '', { [n]: 'x' }))).toBe('nome-invalido')
    }
    expect(xmlGroup('ds:Signature', '', { 'xmlns:ds': 'http://www.w3.org/2000/09/xmldsig#' }))
      .toBe('<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"></ds:Signature>')
  })

  it('um documento inteiro montado pelas peças é lido pelo leitor estrito (namespace, grupos aninhados, opcional ausente)', () => {
    const xml = XML_DECLARATION + xmlGroup('NFe',
      xmlGroup('infNFe', xmlGroup('ide', xmlElement('cUF', '41') + xmlOptionalElement('dhCont', null) + xmlElement('natOp', 'VENDA & CIA')),
        { Id: 'NFe41', versao: '4.00' }),
      { xmlns: 'http://www.portalfiscal.inf.br/nfe' })
    const doc = parseXml(xml)
    const L = { match: 'local', namespaces: ['http://www.portalfiscal.inf.br/nfe'] } as const
    expect(firstText(doc, 'natOp', L)).toBe('VENDA & CIA')
    expect(firstText(doc, 'cUF', L)).toBe('41')
    expect(firstElement(doc, 'dhCont', L)).toBeNull()
    expect(attrOf(firstElement(doc, 'infNFe', L)!, 'Id')).toBe('NFe41')
  })

  it('isXsdTString: U+0020-U+00FF, sem espaço nas pontas, comprimento', () => {
    expect(isXsdTString('Ação', 2, 60)).toBe(true)
    expect(isXsdTString('a b', 2, 60)).toBe(true)
    expect(isXsdTString(' a', 1, 60)).toBe(false)
    expect(isXsdTString('a ', 1, 60)).toBe(false)
    expect(isXsdTString('€', 1, 60)).toBe(false)
    expect(isXsdTString('“a”', 1, 60)).toBe(false)
    expect(isXsdTString('a\tb', 1, 60)).toBe(false)
    expect(isXsdTString('a', 2, 60)).toBe(false)
    expect(isXsdTString('x'.repeat(61), 2, 60)).toBe(false)
    expect(isXsdTString(5, 0, 60)).toBe(false)
  })

  it('sai pelo barrel do núcleo, ao lado do leitor', () => {
    expect(typeof barrel.xmlElement).toBe('function')
    expect(typeof barrel.parseXml).toBe('function')
    expect(barrel.XML_DECLARATION).toBe(XML_DECLARATION)
  })
})
