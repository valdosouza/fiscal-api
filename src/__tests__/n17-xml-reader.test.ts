/// <reference types="jest" />
// N17 (parte 2 da NE-1a, passo 7 — D-NE72 = Q-NE72 (a)) + gates do delta (D-NE85…D-NE90, Valdo 2026-10-12): o LEITOR de XML do núcleo por
// PARSER, ESTRITO por GRAMÁTICA numa varredura ÚNICA antes do `@xmldom/xmldom` 0.8 (que é leniente — medido). Nome QUALIFICADO × LOCAL nos
// namespaces da família (D-NE86); CDATA por CAMPO (D-NE87); valor vazio = ausente (D-NE85); tetos de 1 MB e 64 níveis (D-NE88).
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import {
  parseXml, firstText, firstElement, textOf, attrOf, elementsOf, nameIs, attributeCount, childElementCount, contains, XmlUnreadableError,
  XmlReadOptions, MAX_XML_BYTES, MAX_XML_DEPTH,
} from '../xml/reader'

const NFSE: XmlReadOptions = { match: 'qualified' }
const NFE: XmlReadOptions = { match: 'local', namespaces: ['http://www.portalfiscal.inf.br/nfe'] }
const refusal = (fn: () => unknown): string => { try { fn(); return 'leu' } catch (e) { return e instanceof XmlUnreadableError ? e.reason : `OUTRO: ${(e as Error).message}` } }

describe('parseXml — estrito por gramática', () => {
  it('lê o bem-formado (declaração no início, BOM, comentário e PI fora da raiz, espaços do XML em volta, PI com `&`, `<!DOCTYPE` como TEXTO de comentário)', () => {
    for (const s of ['<a><b>x</b></a>', '<?xml version="1.0" encoding="UTF-8"?>\n<a/>', '﻿<a/>', '<!-- c --><a/><!-- d -->\n', '  \n<a/>  \n',
      '<a><?p a & b?><v>1</v></a>', '<a><!-- <!DOCTYPE x> --><v>1</v></a>', '<a x="1 &amp; 2" y=\'a > b\'/>']) {
      expect([s, refusal(() => parseXml(s))]).toEqual([s, 'leu'])
    }
  })
  it('RECUSA o mal-formado que o @xmldom aceitaria calado — com o MOTIVO', () => {
    const cases: [string, string][] = [
      ['', 'vazio'], ['   ', 'vazio'],
      ['<!DOCTYPE a [<!ENTITY e "boom">]><a>&e;</a>', 'doctype'], ['<!doctype a><a/>', 'doctype'], ['<!ENTITY x "y"><a/>', 'mal-formado'],
      ['<a>x & y</a>', 'referencia-invalida'], ['<a>&foo;</a>', 'referencia-invalida'], ['<a>&amp</a>', 'referencia-invalida'],
      ['<a>&#x110000;</a>', 'referencia-invalida'], ['<a>&#0;</a>', 'referencia-invalida'], ['<a>&#xD800;</a>', 'referencia-invalida'], ['<a>&#x;</a>', 'referencia-invalida'],
      ['<a b="&#0;"/>', 'referencia-invalida'], ['<a b="x & y"/>', 'referencia-invalida'],
      ['<a>a\u0001b</a>', 'caractere-invalido'], ['<a>a\u0000b</a>', 'caractere-invalido'], ['<a>a\uD800b</a>', 'caractere-invalido'], ['<a>a￾b</a>', 'caractere-invalido'],
      ['lixo<a/>', 'fora-da-raiz'], ['<a/>lixo', 'fora-da-raiz'], ['<a/><b/>', 'fora-da-raiz'], ['<!-- c -->lixo<a/>', 'fora-da-raiz'], [' <a/>', 'fora-da-raiz'],
      ['<![CDATA[x]]><a/>', 'fora-da-raiz'], ['<a/><![CDATA[x]]>', 'fora-da-raiz'],
      ['<a><b>x</a>', 'mal-formado'], ['<a b="1" b="2"/>', 'mal-formado'], ['<a b=1/>', 'mal-formado'], ['<a b="x<y"/>', 'mal-formado'],
      ['<a>a]]>b</a>', 'mal-formado'], ['<a><!-- a -- b --></a>', 'mal-formado'], ['<a><?xml version="1.0"?></a>', 'mal-formado'], [' <?xml version="1.0"?><a/>', 'mal-formado'],
      ['<a><b><![CDATA[x</b></a>', 'mal-formado'], ['<a><?pi sem fim</a>', 'mal-formado'], ['<a><!-- sem fim</a>', 'mal-formado'], ['<a>', 'mal-formado'],
    ]
    for (const [s, why] of cases) expect([s, refusal(() => parseXml(s))]).toEqual([s, why])
  })
  it('o truque do gate (N17-01): `<![CDATA[` num comentário e `]]>` noutro NÃO esconde nada — a varredura respeita a ordem do documento', () => {
    for (const v of ['1&#x110000;', 'a & b', '&#0;', '&#xD800;', '&#xFFFE;']) {
      expect([v, refusal(() => parseXml(`<r><!-- <![CDATA[ --><v>${v}</v><!-- ]]> --></r>`))]).toEqual([v, 'referencia-invalida'])
    }
  })
  it('D-NE88: tetos ANTES do parse — mais de 1 MB de texto (UTF-8) é `grande-demais`; mais de 64 níveis é `profundo-demais` (sem estourar a pilha)', () => {
    expect([MAX_XML_BYTES, MAX_XML_DEPTH]).toEqual([1024 * 1024, 64])
    const big = `<a>${'x'.repeat(MAX_XML_BYTES)}</a>`
    expect(refusal(() => parseXml(big))).toBe('grande-demais')
    const deep = (n: number) => '<a>'.repeat(n) + '<v>1</v>' + '</a>'.repeat(n)
    expect(refusal(() => parseXml(deep(MAX_XML_DEPTH - 1)))).toBe('leu')
    expect(refusal(() => parseXml(deep(MAX_XML_DEPTH)))).toBe('profundo-demais')
    expect(refusal(() => parseXml(deep(30000)))).toBe('profundo-demais')
  })
  it('D-F100: a recusa NUNCA carrega trecho do documento — só o motivo e a posição', () => {
    const secret = '12345678909'
    for (const s of [`<a>${secret} & x</a>`, `<a>&${secret};</a>`, `<a b="${secret}" b="1"/>`, `<a>&#x${secret};</a>`, `lixo${secret}<a/>`]) {
      try { parseXml(s); throw new Error('leu') } catch (e) {
        expect(e).toBeInstanceOf(XmlUnreadableError)
        expect([s, (e as Error).message.includes(secret)]).toEqual([s, false])
      }
    }
  })
})

describe('CERCA do N17 — nenhuma leitura de XML por RECORTE em produção (núcleo e famílias)', () => {
  const WORKSPACE = path.resolve(__dirname, '..', '..', '..')
  const walk = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? (d.name === '__tests__' || d.name === 'node_modules' ? [] : walk(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []))
  /**
   * Leitura com cara de TAG, pelo AST (gate do delta N17-09: a 1ª versão via só literal/`new RegExp` começando por `<letra`): regex literal,
   * `RegExp(…)` com ou sem `new` (texto do argumento INTEIRO — concatenação e template incluídos), com `<` também escrito como `\x3c`,
   * `<` ou `[<]`, seguido de espaço opcional e de letra, `/`, `${`, aspas ou `+`; e `split`/`indexOf`/`lastIndexOf`/`includes`/
   * `startsWith`/`endsWith`/`search`/`match`/`replace` com um literal que começa por `<letra` ou `</letra`.
   */
  const tagReads = (code: string): string[] => {
    const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const out: string[] = []
    const norm = (s: string) => s.replace(/\\x3c|\\u003c|\[<\]/gi, '<')
    const TAG = /<(?:\\s[*+?]?)?(?:\\\/|\/)?(?:[A-Za-z]|\$\{|['"`]|\s*\+)/
    const STR_METHODS = /^(?:split|indexOf|lastIndexOf|includes|startsWith|endsWith|search|match|matchAll|replace|replaceAll)$/
    const visit = (n: ts.Node): void => {
      if (n.kind === ts.SyntaxKind.RegularExpressionLiteral && TAG.test(norm(n.getText(sf)))) out.push(n.getText(sf).slice(0, 60))
      if ((ts.isNewExpression(n) || ts.isCallExpression(n)) && n.expression.getText(sf) === 'RegExp' && n.arguments?.length
        && TAG.test(norm(n.arguments.map(a => a.getText(sf)).join(',')))) out.push(n.getText(sf).slice(0, 60))
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && STR_METHODS.test(n.expression.name.text) && n.arguments[0]
        && (ts.isStringLiteral(n.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(n.arguments[0])) && /^<\/?[A-Za-z]/.test(n.arguments[0].text)) out.push(n.getText(sf).slice(0, 60))
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return out
  }
  /**
   * Exceções NOMEADAS: o saneamento do HTML de gateway nas mensagens de erro (texto para pessoa — nunca valor fiscal); e as duas da
   * ferramenta de CARGA da nfse-api (DEPLOY.E3.P1 — não é produção, nunca entra no `dist`): o fisco FALSO lê o Id do DPS do pedido que ele
   * mesmo recebe, e o `semear` troca o marcador `<SENHA_FISCAL_API>` do SQL de GRANT (texto, não XML). FAMILIA.E5.P1.T4, Valdo 2026-11-20.
   */
  const ALLOWED: Record<string, number> = {
    'fiscal-api/src/transport/https-json.ts': 1,
    'nfse-api/scripts/carga/fisco-falso.ts': 1,
    'nfse-api/scripts/carga/semear.ts': 1,
    // exceção NOMEADA (FAMILIA.E5.P4.T5, Valdo 2026-11-22 "Sim, destrave"): a validação XSD LOCAL da nfe-api (NFE.E4.P3.T1, 6e5b4ca — D-NE181,
    // D-NE211) lê por recorte só texto NOSSO, nunca resposta do fisco: o `schemaLocation` dos XSD conferidos por hash (MANIFESTO.json) e o
    // trecho `detEvento` da mensagem que ELA montou, antes de validar — nada que decida voz
    'nfe-api/src/authority/xsd.ts': 4,
  }
  it('a cerca não é cega (inclusive às formas que o gate do delta mostrou), não acusa o que não é recorte, e o código real só tem a exceção nomeada', () => {
    const caught = [
      'const m = xml.match(/<infDPS\\b[^>]*\\sId="([^"]*)"/)', 'const r = new RegExp(`<${name}>`)',
      'const v = xml.match(/<\\s*cStat>([^<]*)</)?.[1]', 'const v = xml.match(/[<]cStat>([^<]*)/)?.[1]', 'const v = xml.match(/\\x3ccStat>([^<]*)/)?.[1]',
      'const v = xml.match(RegExp(`<${name}>([^<]*)`))?.[1]', "const v = xml.match(new RegExp('<' + name + '>([^<]*)'))?.[1]",
      "const v = xml.split('<cStat>')[1].split('</cStat>')[0]", "const v = xml.slice(xml.indexOf('<cStat>') + 7, xml.indexOf('</cStat>'))",
    ]
    expect(caught.map(c => [c, tagReads(c).length > 0])).toEqual(caught.map(c => [c, true]))
    expect(tagReads("s.replace(/[&<>\"']/g, f); /^\\s*</.test(x); /<!DOCTYPE/i.test(x); s.startsWith('<!--', i); s.indexOf('<', i); /&([^;&<\\s]*)(;?)/g")).toEqual([])
    const files = [...walk(path.join(WORKSPACE, 'fiscal-api', 'src')), ...walk(path.join(WORKSPACE, 'nfse-api', 'src')),
      ...walk(path.join(WORKSPACE, 'nfse-api', 'scripts')), ...walk(path.join(WORKSPACE, 'nfe-api', 'src'))]
    expect(files.length).toBeGreaterThan(30)
    const hits: Record<string, number> = {}
    for (const f of files) { const n = tagReads(fs.readFileSync(f, 'utf8')).length; if (n) hits[path.relative(WORKSPACE, f).replace(/\\/g, '/')] = n }
    expect(hits).toEqual(ALLOWED)
  })
})

describe('leitura — o modo da FAMÍLIA e do CAMPO', () => {
  it('ordem de DOCUMENTO (a ordem das tags de abertura, iterativa) e o 1º elemento com o nome; o documento inclui a raiz', () => {
    const doc = parseXml('<r><a><x>1</x></a><x>2</x><b><x>3</x></b></r>')
    expect(elementsOf(doc).map(e => e.nodeName)).toEqual(['r', 'a', 'x', 'x', 'b', 'x'])
    expect(firstText(doc, 'x', NFSE)).toBe('1')
    expect(firstText(firstElement(doc, 'b', NFSE)!, 'x', NFSE)).toBe('3')
    expect(firstElement(doc, 'r', NFSE)?.nodeName).toBe('r')
    expect(firstText(doc, 'nada', NFSE)).toBeNull()
  })
  it('D-NE85: valor VAZIO é AUSENTE — o leitor pula o vazio (auto-fechado, explícito ou só espaço) e segue para o próximo com o nome; nenhum = null', () => {
    const doc = parseXml('<r><x/><x></x><x>  </x><x>4</x><y/><z></z></r>')
    expect([firstText(doc, 'x', NFSE), firstText(doc, 'y', NFSE), firstText(doc, 'z', NFSE)]).toEqual(['4', null, null])
    expect(textOf(firstElement(doc, 'y', NFSE)!)).toBe('')
    expect([childElementCount(firstElement(doc, 'r', NFSE)!), childElementCount(firstElement(doc, 'y', NFSE)!)]).toEqual([6, 0])
  })
  it('valor = TEXTO SIMPLES aparado (entidades decodificadas); filho, comentário ou PI = recusa; CDATA = recusa, salvo no CAMPO que pede (D-NE87)', () => {
    const doc = parseXml('<r><t>  a &amp; b  </t><f><g/></f><c>x<!--c-->y</c><p>x<?pi z?>y</p><d><![CDATA[ q ]]></d></r>')
    expect(firstText(doc, 't', NFSE)).toBe('a & b')
    for (const n of ['f', 'c', 'p']) expect([n, refusal(() => firstText(doc, n, NFSE))]).toEqual([n, 'valor-nao-simples'])
    expect(refusal(() => firstText(doc, 'd', NFSE))).toBe('cdata')
    expect(firstText(doc, 'd', NFSE, { cdata: 'read' })).toBe('q')                     // só o CAMPO que pede
    const nfe = parseXml('<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><cStat><![CDATA[100]]></cStat><qrCode><![CDATA[https://x?p=1&q=2]]></qrCode></NFe>')
    expect(refusal(() => firstText(nfe, 'cStat', NFE))).toBe('cdata')                  // campo que decide voz nunca lê CDATA (a família não lê por padrão)
    expect(firstText(nfe, 'qrCode', NFE, { cdata: 'read' })).toBe('https://x?p=1&q=2') // o qrCode da NFC-e pede
  })
  it('D-NE86: nome QUALIFICADO (NFS-e — `<ns:x>` não é `<x>`) × LOCAL só nos NAMESPACES da família (NF-e — o prefixo casa; SOAP e XMLDSig não)', () => {
    const NFE_NS = 'http://www.portalfiscal.inf.br/nfe'
    const doc = parseXml(`<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Header><nfeCabecMsg xmlns="${NFE_NS}wsdl"><cUF>99</cUF></nfeCabecMsg></env:Header>` +
      `<env:Body><n:retEnviNFe xmlns:n="${NFE_NS}"><n:cUF>41</n:cUF><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><Reference>R</Reference></Signature></n:retEnviNFe></env:Body></env:Envelope>`)
    expect(firstText(doc, 'cUF', NFE)).toBe('41')                                      // o cUF do cabeçalho SOAP (outro namespace) não casa
    expect(firstText(doc, 'Reference', NFE)).toBeNull()                                // nem a XMLDSig
    expect([firstText(doc, 'cUF', NFSE), firstText(doc, 'n:cUF', NFSE)]).toEqual(['99', '41'])
    const el = firstElement(doc, 'cUF', NFE)!
    expect([nameIs(el, 'cUF', NFSE), nameIs(el, 'cUF', NFE)]).toEqual([false, true])
  })
  it('atributos: decodificados pelo parser, aspas simples ou duplas; ausente = null; contagem; ancestral', () => {
    const doc = parseXml(`<r><a Id="X&amp;1" k='v'/><b/><c><d/></c></r>`)
    const a = firstElement(doc, 'a', NFSE)!
    expect([attrOf(a, 'Id'), attrOf(a, 'k'), attrOf(a, 'z'), attributeCount(a), attributeCount(firstElement(doc, 'b', NFSE)!)]).toEqual(['X&1', 'v', null, 2, 0])
    expect([contains(firstElement(doc, 'c', NFSE)!, firstElement(doc, 'd', NFSE)!), contains(a, firstElement(doc, 'd', NFSE)!)]).toEqual([true, false])
  })
})
