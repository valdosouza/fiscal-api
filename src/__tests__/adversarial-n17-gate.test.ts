/// <reference types="jest" />
// GATE ADVERSARIAL do DELTA — passo 7 da NE-1a parte 2 (dívida N17: leitura de XML do fisco por PARSER — D-NE72; `prompt_onda_nfe_sefaz.md`
// §12.9.7.3) — NÚCLEO (fiscal-api: `xml/reader.ts` + `verifyXml`). Revisor independente — NÃO fez a entrega (testar-adversarial.md §4-6).
//
//  * ACHADOS (`it.failing('[SEV N17-xx] …')`) — o teste afirma o que a spec promete e FALHA no código atual (prova do bug);
//    o corretor troca `it.failing` por `it` depois de corrigir. NUNCA corrigir o teste para passar.
//  * RESISTIU (`it('resistiu: …')`) — ataques que não reproduziram bug (regressão).
//  * CONTEXTO (`it('contexto: …')`) — fixa o comportamento atual que fundamenta um achado ou uma QUESTÃO (Q-NE90…).
//
// Só fixtures SINTÉTICAS (nenhum XML do corpus real), nenhum socket, nenhum banco.
import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import forge from 'node-forge'
import { SignedXml } from 'xml-crypto'
import { parseXml, firstText, elementsOf, XmlUnreadableError, XmlReadOptions } from '../xml/reader'
import { signXml, verifyXml, firstCertificatePem } from '../transport/xmldsig'

const NFSE: XmlReadOptions = { match: 'qualified' }                      // D-NE87: o CDATA é escolha do CAMPO (recusa por padrão)
/** 'leu' | 'recusou' (XmlUnreadableError — o contrato da peça) | 'OUTRO: …' (exceção crua). */
const outcome = (fn: () => unknown): string => {
  try { fn(); return 'leu' } catch (e) { return e instanceof XmlUnreadableError ? 'recusou' : `OUTRO: ${(e as Error)?.constructor?.name}: ${(e as Error)?.message?.slice(0, 60)}` }
}
const reason = (fn: () => unknown): string => { try { fn(); return 'leu' } catch (e) { return e instanceof XmlUnreadableError ? e.reason : 'OUTRO' } }

/** O truque: um `<![CDATA[` DENTRO de um comentário e um `]]>` dentro de OUTRO comentário — o pré-filtro de referências apaga como "CDATA"
 *  tudo o que fica entre eles (as duas passadas de regex são independentes: a de CDATA roda antes da de comentário). */
const commentWrapped = (inner: string) => `<r><!-- <![CDATA[ --><v>${inner}</v><!-- ]]> --></r>`
const deep = (n: number) => '<a>'.repeat(n) + '<v>1</v>' + '</a>'.repeat(n)

// ===========================================================================
// [N17-01] MEDIUM — a camada ESTRITA é contornável: o pré-filtro de referências (`assertReferences`) apaga um trecho que começa num
// comentário como se fosse CDATA; `&` solto e referência de caractere inválida passam, e o @xmldom 0.8 as aceita CALADO.
// ===========================================================================
describe('[N17-01] pré-filtro de referências — CDATA aberto num comentário e fechado noutro', () => {
  it('contexto: SEM o truque a camada recusa (referência fora do Unicode, `&` solto, surrogate e caractere proibido)', () => {
    for (const v of ['&#x110000;', 'a & b', '&#xD800;', '&#0;']) expect([v, reason(() => parseXml(`<r><v>${v}</v></r>`))]).toEqual([v, 'referencia-invalida'])
  })
  it('[CORRIGIDO na sessão] [MEDIUM N17-01] referência fora do Unicode escondida pelo truque → o leitor devia RECUSAR (referencia-invalida) — hoje LÊ', () => {
    expect(reason(() => parseXml(commentWrapped('1&#x110000;')))).toBe('referencia-invalida')
  })
  it('[CORRIGIDO na sessão] [MEDIUM N17-01] `&` solto escondido pelo truque → o leitor devia RECUSAR (referencia-invalida) — hoje LÊ', () => {
    expect(reason(() => parseXml(commentWrapped('a & b')))).toBe('referencia-invalida')
  })
  it('[CORRIGIDO na sessão] [MEDIUM N17-01] referência a caractere proibido (&#0;, surrogate &#xD800;, &#xFFFE;) escondida pelo truque → devia RECUSAR', () => {
    for (const v of ['&#0;', '&#xD800;', '&#xFFFE;']) expect([v, reason(() => parseXml(commentWrapped(v)))]).toEqual([v, 'referencia-invalida'])
  })
  it('[CORRIGIDO na sessão] (era o contexto do N17-01: o leitor devolvia LIXO — surrogates soltos — com o truque) — a varredura ÚNICA da gramática recusa, como o recorte publicado LANÇAVA RangeError nesse valor (→ ambíguo no adaptador)', () => {
    expect(reason(() => firstText(parseXml(commentWrapped('1&#x110000;')), 'v', NFSE))).toBe('referencia-invalida')
    expect(reason(() => firstText(parseXml(commentWrapped('a & b')), 'v', NFSE))).toBe('referencia-invalida')
    expect(() => String.fromCodePoint(0x110000)).toThrow(RangeError)            // o que o `unescapeXml` do recorte fazia com o mesmo valor
  })
  it('resistiu [convertido — varredura única]: o mesmo truque NÃO esconde DOCTYPE nem entidade não predefinida (agora a varredura acusa a entidade antes do @xmldom)', () => {
    expect(reason(() => parseXml('<!DOCTYPE r><r><!-- <![CDATA[ --><v>1</v><!-- ]]> --></r>'))).toBe('doctype')
    expect(reason(() => parseXml(commentWrapped('&foo;')))).toBe('referencia-invalida')
  })
})

// ===========================================================================
// [N17-03] LOW — "Recusa = XmlUnreadableError" (contrato da peça): há entradas em que a exceção sai CRUA
// ===========================================================================
describe('[N17-03] contrato da recusa', () => {
  it('[CORRIGIDO na sessão] [LOW N17-03] CDATA depois da raiz: o @xmldom LANÇA "Hierarchy request error" (Error cru) — a recusa devia ser XmlUnreadableError', () => {
    expect(outcome(() => parseXml('<r><v>1</v></r><![CDATA[x]]>'))).toBe('recusou')
  })
  it('[CORRIGIDO na sessão] [LOW N17-03] documento com 30 000 níveis: `elementsOf` (recursivo) estoura a PILHA (RangeError) — devia recusar (XmlUnreadableError) ou ler', () => {
    // D-NE88: o teto de 64 níveis recusa ANTES do parse; e o `elementsOf` passou a ser iterativo
    expect(outcome(() => firstText(parseXml(deep(30000)), 'v', NFSE))).toBe('recusou')
  })
  it('[CORRIGIDO na sessão] (era o contexto do N17-03: CDATA antes da raiz era LIDO e depois LANÇAVA cru) — fora da raiz, CDATA é recusa nos dois lados', () => {
    expect(outcome(() => parseXml('<![CDATA[x]]><r><v>1</v></r>'))).toBe('recusou')
    expect(outcome(() => parseXml('<r><v>1</v></r><![CDATA[x]]>'))).toBe('recusou')
  })
})

// ===========================================================================
// [N17-06] LOW — "ESTRITO por cima do @xmldom": o que o @xmldom 0.8 aceita CALADO e a camada não pega. Mesma saída do recorte publicado
// (sem regressão de voz) — mas o cabeçalho da peça promete recusar o mal-formado.
// ===========================================================================
describe('[N17-06] mal-formado que passa calado', () => {
  const NOT_WELL_FORMED: [string, string][] = [
    ['caractere de CONTROLE literal no valor (U+0001)', '<r><v>a\u0001b</v></r>'],
    ['NUL literal no valor', '<r><v>a\u0000b</v></r>'],
    ['surrogate SOLTO literal no valor', '<r><v>a\uD800b</v></r>'],
    ['U+FFFE literal no valor (não é Char do XML 1.0)', '<r><v>a￾b</v></r>'],
    ['`<` literal dentro de valor de atributo', '<r a="x<y"><v>1</v></r>'],
    ['`]]>` em texto fora de CDATA', '<r><v>a]]>b</v></r>'],
    ['`--` dentro de comentário', '<r><!-- a -- b --><v>1</v></r>'],
    ['declaração XML fora do início (dentro da raiz)', '<r><?xml version="1.0"?><v>1</v></r>'],
    ['declaração de entidade fora de DOCTYPE', '<!ENTITY x "y"><r><v>1</v></r>'],
    ['CDATA antes da raiz', '<![CDATA[x]]><r><v>1</v></r>'],
    ['CDATA SEM fim dentro de um elemento', '<r><v>1</v><w><![CDATA[x</w></r>'],
    ['NBSP (não é espaço do XML) antes da raiz', ' <r><v>1</v></r>'],
  ]
  it.each(NOT_WELL_FORMED)('[CORRIGIDO na sessão] [LOW N17-06] %s → o leitor ESTRITO devia recusar', (_l, xml) => {
    expect(outcome(() => parseXml(xml))).toBe('recusou')
  })
})

// ===========================================================================
// contexto [N17-07] — recusas A MAIS (bem-formado recusado): falha FECHADO, sem consequência de voz
// ===========================================================================
describe('[N17-07] bem-formado recusado', () => {
  it('[CORRIGIDO na sessão] (era o contexto do N17-07: bem-formado recusado) — PI com `&` e `<!DOCTYPE` como TEXTO de comentário são LIDOS (a varredura respeita PI e comentário)', () => {
    expect(reason(() => parseXml('<r><?p a & b?><v>1</v></r>'))).toBe('leu')
    expect(reason(() => parseXml('<r><!-- <!DOCTYPE x> --><v>1</v></r>'))).toBe('leu')
  })
})

// ===========================================================================
// RESISTIU — o que a camada estrita pega de verdade
// ===========================================================================
describe('resistiu — a camada estrita', () => {
  const EV = '<evento><infEvento Id="EVT1"><dhProc>2026-10-10T18:43:05-03:00</dhProc><infPedReg><chNFSe>1</chNFSe><e101101><cMotivo>1</cMotivo><xMotivo>x</xMotivo></e101101></infPedReg></infEvento></evento>'
  it('resistiu: documento TRUNCADO em qualquer ponto é recusado (o recorte publicado lia o que sobrava — inclusive um e101101 sem fim)', () => {
    for (let i = 20; i < EV.length - 1; i += 7) expect([i, outcome(() => parseXml(EV.slice(0, i)))]).toEqual([i, 'recusou'])
    expect(outcome(() => parseXml(EV))).toBe('leu')
  })
  it('resistiu: XXE/expansão — DOCTYPE com subconjunto interno, em minúsculas, com BOM na frente; entidade declarada fora de DOCTYPE não expande (o uso é recusado)', () => {
    for (const s of ['<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>', '<!doctype r><r/>', '﻿<!DOCTYPE r><r/>']) expect([s, outcome(() => parseXml(s))]).toEqual([s, 'recusou'])
    expect(outcome(() => parseXml('<!ENTITY x "boom"><r><v>&x;</v></r>'))).toBe('recusou')
  })
  it('resistiu: atributo duplicado, sem aspas, aspas trocadas, sem valor; nome de elemento inválido; fechamento trocado; lixo/NUL depois da raiz', () => {
    for (const s of ['<r a="1" a="2"/>', '<r a=1/>', `<r a="1'/>`, '<r a/>', '<r><1v>1</1v></r>', '<r><:v/></r>', '<r><v>1</x></r>', '<r/>\u0000', '<r/>x', '<r/><r/>']) {
      expect([s, outcome(() => parseXml(s))]).toEqual([s, 'recusou'])
    }
  })
  it('resistiu: referência DECIMAL com zeros à esquerda e hexa válidas decodificam; `&lt` sem `;` e `&#;` são recusadas', () => {
    expect(firstText(parseXml('<r><v>&#00065;&#x42;</v></r>'), 'v', NFSE)).toBe('AB')
    expect(reason(() => parseXml('<r><v>&lt</v></r>'))).toBe('referencia-invalida')
    expect(reason(() => parseXml('<r><v>&#;</v></r>'))).toBe('referencia-invalida')
  })
  it('resistiu [convertido — D-NE88: teto de 64 níveis]: 1 000 níveis são recusados antes do parse; `elementsOf` (iterativo) em ordem de documento até o teto', () => {
    expect(reason(() => parseXml(deep(1000)))).toBe('profundo-demais')
    expect(elementsOf(parseXml(deep(60))).length).toBe(61)
  })
})

// ===========================================================================
// (d) verifyXml — "nunca lança e só verifica a assinatura de verdade"
// ===========================================================================
/** ORÁCULO do núcleo — o `verifyXml` por recorte como estava publicado (cópia LITERAL do `n17-xmldsig.test.ts`, que o extraiu do 27d2aa6). */
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
  cert.setSubject([{ name: 'commonName', value: 'GATE:12345678000199' }]); cert.setIssuer([{ name: 'commonName', value: 'GATE:12345678000199' }])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return { cert: Buffer.from(forge.pki.certificateToPem(cert)), key: Buffer.from(forge.pki.privateKeyToPem(keys.privateKey)) }
}

describe('(d) verifyXml', () => {
  const a = keyPair()
  const XML = '<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infDPS Id="DPS1"><nDPS>1</nDPS><xDesc>a &amp; b</xDesc></infDPS></DPS>'
  const signed = signXml(XML, { referenceId: 'DPS1', cert: a.cert, key: a.key, algorithm: 'sha1' })
  const sigBlock = signed.slice(signed.indexOf('<Signature'), signed.indexOf('</Signature>') + '</Signature>'.length)
  const both = (x: unknown, c: Buffer = a.cert) => [verifyXml(x as string, c), legacy_verifyXml(x as string, c)]

  it('resistiu: NUNCA lança — vazio, não-string, DOCTYPE, CDATA depois da raiz (o @xmldom lança cru — o try segura), 30 000 níveis (RangeError), lixo depois da raiz, certificado ilegível', () => {
    const weird: unknown[] = ['', '   ', null, undefined, 42, {}, '<!DOCTYPE DPS>' + signed.replace(/^<\?xml[^>]*>/, ''), signed + '<![CDATA[x]]>', deep(30000), signed + 'lixo']
    for (const w of weird) expect(() => verifyXml(w as string, a.cert)).not.toThrow()
    expect(weird.map(w => verifyXml(w as string, a.cert))).toEqual(weird.map(() => false))
    expect(verifyXml(signed, 'não é PEM')).toBe(false)
    expect(verifyXml(signed, a.cert)).toBe(true)
  })
  it('resistiu: adulteração DENTRO do elemento assinado, Signature com prefixo (`ds:`), duas Signatures com a 1ª adulterada → false (igual ao recorte)', () => {
    expect(both(signed.replace('<nDPS>1</nDPS>', '<nDPS>2</nDPS>'))).toEqual([false, false])
    const prefixed = signed.replace(/<(\/?)(Signature|SignedInfo|CanonicalizationMethod|SignatureMethod|Reference|Transforms|Transform|DigestMethod|DigestValue|SignatureValue|KeyInfo|X509Data|X509Certificate)\b/g, '<$1ds:$2')
      .replace('<ds:Signature xmlns="http://www.w3.org/2000/09/xmldsig#"', '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"')
    expect(both(prefixed)).toEqual([false, false])
    const tampered = sigBlock.replace(/<DigestValue>[^<]*<\/DigestValue>/, '<DigestValue>AAAA</DigestValue>')
    expect(both(signed.replace(sigBlock, `${tampered}${sigBlock}`))).toEqual([false, false])
  })
  it('resistiu: duas CÓPIAS da mesma Signature (mesmo SignatureValue) → false nos dois (o xml-crypto 6.3.2 recusa — anti-wrapping)', () => {
    expect(both(signed.replace('</DPS>', `${sigBlock}</DPS>`))).toEqual([false, false])
  })
  it('contexto: Signature dentro de COMENTÁRIO antes da real — o recorte pegava a do comentário (false); o leitor pega a real (true) — divergência a favor', () => {
    expect(both(signed.replace('<infDPS', `<!-- ${sigBlock.replace(/<SignatureValue>[^<]*/, '<SignatureValue>AAAA')} --><infDPS`))).toEqual([true, false])
  })
  it('contexto: a assinatura cobre SÓ o elemento referenciado (#Id) — conteúdo FORA dele (irmão novo no DPS) e Signature fora do lugar verificam true nos dois; `verifyXml` não tem consumidor em produção (só testes) — quem passar a usá-lo para validar o fisco tem de ler do nó ASSINADO', () => {
    expect(both(signed.replace('</infDPS>', '</infDPS><xFora>injetado</xFora>'))).toEqual([true, true])
    const moved = signed.replace(sigBlock, '').replace('<infDPS', `${sigBlock}<infDPS`)
    expect(both(moved)).toEqual([true, true])
  })
  it('contexto: xmlns da Signature com referência de caractere (`xmldsig&#35;`) — o leitor verifica (true), o recorte não achava (false); aspas simples idem', () => {
    expect(both(signed.replace('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">', '<Signature xmlns="http://www.w3.org/2000/09/xmldsig&#35;">'))).toEqual([true, false])
    expect(both(signed.replace('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">', `<Signature xmlns='http://www.w3.org/2000/09/xmldsig#'>`))).toEqual([true, false])
  })
})

// ===========================================================================
// (e) CERCA — o predicado da cerca (`n17-xml-reader.test.ts`) só vê regex que começa por `<letra`/`</`/`<${`
// ===========================================================================
describe('[N17-09] pontos cegos da cerca', () => {
  /** Cópia LITERAL do predicado da cerca (`n17-xml-reader.test.ts`, `tagRegexes`) — para medir o que ela NÃO vê. */
  const tagRegexes = (code: string): string[] => {
    const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const out: string[] = []
    const TAG = /<(?:\\\/|\/)?(?:[A-Za-z]|\$\{)/
    const visit = (n: ts.Node): void => {
      if (n.kind === ts.SyntaxKind.RegularExpressionLiteral && TAG.test(n.getText(sf))) out.push(n.getText(sf).slice(0, 60))
      if (ts.isNewExpression(n) && n.expression.getText(sf) === 'RegExp' && n.arguments?.[0] && TAG.test(n.arguments[0].getText(sf))) out.push(n.getText(sf).slice(0, 60))
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return out
  }
  it('contexto [LOW N17-09 — CORRIGIDO na sessão na cerca `n17-xml-reader.test.ts` (`tagReads` pega todas estas formas); esta cópia é do predicado ANTIGO, para registro]: leituras por recorte que a cerca NÃO pegava — `<\\s*`, classe `[<]`, escape `\\x3c`, RegExp SEM `new`, RegExp montada por concatenação, `split`/`indexOf` de tag', () => {
    const blind = [
      'const v = xml.match(/<\\s*cStat>([^<]*)</)?.[1]',
      'const v = xml.match(/[<]cStat>([^<]*)/)?.[1]',
      'const v = xml.match(/\\x3ccStat>([^<]*)/)?.[1]',
      'const v = xml.match(RegExp(`<${name}>([^<]*)`))?.[1]',
      "const v = xml.match(new RegExp('<' + name + '>([^<]*)'))?.[1]",
      "const v = xml.split('<cStat>')[1].split('</cStat>')[0]",
      "const v = xml.slice(xml.indexOf('<cStat>') + 7, xml.indexOf('</cStat>'))",
    ]
    expect(blind.map(c => [c, tagRegexes(c)])).toEqual(blind.map(c => [c, []]))
    expect(tagRegexes('const v = xml.match(/<cStat>([^<]*)/)')).toHaveLength(1)     // a forma "clássica" a cerca pega
  })
  it('resistiu: o código de PRODUÇÃO hoje não tem nenhuma das formas cegas acima (varredura textual de núcleo + nfse-api src/scripts)', () => {
    const WORKSPACE = path.resolve(__dirname, '..', '..', '..')
    const walk = (dir: string): string[] => (!fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
      d.isDirectory() ? (d.name === '__tests__' || d.name === 'node_modules' ? [] : walk(path.join(dir, d.name))) : d.name.endsWith('.ts') ? [path.join(dir, d.name)] : []))
    const BLIND = /<\\s\*|\[<\]|\\x3c|(?<!new )RegExp\(`<|'<' \+|(?:split|indexOf|lastIndexOf|includes)\(['"`]<\/?[A-Za-z]/
    const files = [...walk(path.join(WORKSPACE, 'fiscal-api', 'src')), ...walk(path.join(WORKSPACE, 'nfse-api', 'src')), ...walk(path.join(WORKSPACE, 'nfse-api', 'scripts'))]
    expect(files.length).toBeGreaterThan(30)
    const hits = files.filter(f => BLIND.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(WORKSPACE, f).replace(/\\/g, '/'))
    expect(hits).toEqual([])
  })
})
