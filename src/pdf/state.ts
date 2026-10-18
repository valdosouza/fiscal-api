/**
 * Isolamento do estado do pdfkit (gates da NE-1b, 2026-10-17 — HIGH provado pelos dois revisores; D-NE125/D-NE128).
 *
 * CONHECIMENTO NEGATIVO: no pdfkit 0.20.2 o `save()`/`restore()` guarda só a MATRIZ (q/Q no PDF + `_ctmStack`). Fonte, corpo, espaçamento de
 * linha, cor, posição e o texto ENCADEADO (`continued`) da família vivem no objeto JS (`_font`, `_fontSize`, `_fontSource`, `_fontFamily`,
 * `_lineGap`, `_fillColor`, `_wrapper`, `_textOptions`, `x`, `y` — `_strokeColor` NÃO existe nesta versão) e o quebrador de linha REAPLICA
 * `_fillColor` depois de abrir folha. Código que mexe nisso sem devolver faz o texto da família continuar no estilo dele. E o `q` NÃO limpa o
 * estado gráfico — só o guarda: quem desenha herda a cor/opacidade que o conteúdo deixou (por isso o `neutral`).
 * Estes nomes são INTERNOS do pdfkit — a versão é exata no package.json (D-NE124) e trocá-la exige os testes dos gates (A1/A2, D1–D8).
 *
 * Interno da base (não sai pela superfície `fiscal-api/pdf`).
 */
const TEXT_STATE = ['_font', '_fontSize', '_fontSource', '_fontFamily', '_lineGap', '_fillColor', '_wrapper', '_textOptions', 'x', 'y'] as const
export type KeptState = 'y'

export interface IsolateOptions {
  /** O que fica como o código isolado deixou (o `sheetStart` deixa o `y` como começo do conteúdo — D-NE125). */
  readonly keep?: readonly KeptState[]
  /** Envolve em q/Q e confere o equilíbrio (padrão true); a MEDIDA de texto não desenha e não precisa (D-NE129). */
  readonly graphics?: boolean
  /**
   * Estado de entrada NEUTRO = o de uma folha nova (re-gate S3): preto opaco, traço de 1 pt contínuo, Helvetica 12, espaçamento 0 — o
   * `sheetStart` e a passada não herdam o fim do conteúdo. (Não zera lineCap/lineJoin/miterLimit nem recorte: recorte só vive dentro de
   * `save()`, e `save()` aberto na abertura de folha ou no fim do conteúdo é erro de uso — D-NE134 / gate L3.)
   */
  readonly neutral?: boolean
  /** Quem roda (para a mensagem de erro de uso). */
  readonly who?: string
}

/**
 * A fonte-padrão `font` ainda É a fonte-padrão no documento (gate final F-L2/socrático L1): o `doc.font(nome)` do pdfkit consulta o registro
 * (`_registeredFonts`) e o cache (`_fontFamilies`) ANTES das fontes-padrão — `doc.registerFont('Times-Roman', 'Symbol')` ou um
 * `doc.font('Symbol', 'Times-Roman')` faria a porta desenhar Symbol. Recusa legível antes de desenhar.
 */
export function assertStandardFontIntact(doc: PDFKit.PDFDocument, font: string): void {
  const d = doc as unknown as { _registeredFonts?: Record<string, unknown>; _fontFamilies?: Record<string, { name?: string } | undefined> }
  const registered = !!d._registeredFonts && Object.prototype.hasOwnProperty.call(d._registeredFonts, font)
  const cached = d._fontFamilies && Object.prototype.hasOwnProperty.call(d._fontFamilies, font) ? d._fontFamilies[font] : undefined
  if (registered || (cached && cached.name !== font)) {
    throw new RangeError(`fontes da base: o nome da fonte-padrão "${font}" foi sobreposto no pdfkit (registerFont/font por fora) — a porta não desenha (D-NE126)`)
  }
}

/** Marca das guardas instaladas pelo `isolated` (aponta para a função que cada uma envolve) — a limpeza chama a ORIGINAL, sem passar por elas. */
const GUARD = Symbol('fiscal-api/pdf:guarda-do-isolated')
type Guarded = ((this: unknown) => unknown) & { [GUARD]?: () => unknown }
const rawOf = (fn: Guarded): (() => unknown) => {
  let f: Guarded | undefined = fn
  while (f && f[GUARD]) f = f[GUARD] as Guarded
  return f as () => unknown
}

/**
 * Roda `run` com o estado da família guardado: o texto encadeado dela fica FORA, o estado gráfico do PDF volta pelo q/Q e o estado JS volta
 * campo a campo (menos o `keep`). Erro de USO dentro dele — `restore()` a mais ou na folha errada (barrados NA HORA pelas guardas — gates R7-M1 e
 * F-L4), `save()` sem `restore()` (gate D3), terminar noutra folha (gate D4) — é corrigido para o PDF continuar balanceado (cada `save()` extra
 * fecha na folha em que foi aberto) e LANÇA com mensagem da base; o erro de quem rodou sobe sem ser trocado.
 */
export function isolated<T>(doc: PDFKit.PDFDocument, run: () => T, opts: IsolateOptions = {}): T {
  const d = doc as unknown as Record<string, any>
  const saved = TEXT_STATE.map(k => d[k])
  const graphics = opts.graphics ?? true
  const page = doc.page
  const sheets = (d._pageBuffer as unknown[]).length
  const who = opts.who ?? 'o desenho'
  d._wrapper = null
  d._textOptions = null
  let depth = 0
  let ours: unknown = null
  const hadOwnRestore = Object.prototype.hasOwnProperty.call(d, 'restore')
  const hadOwnSave = Object.prototype.hasOwnProperty.call(d, 'save')
  const previousRestore = d.restore as Guarded
  const previousSave = d.save as Guarded
  /** A folha de cada `save()` feito DENTRO do isolado (gate final F-L4: um `save()` noutra folha não se fecha nesta). */
  const savedOn: unknown[] = []
  if (graphics) {
    doc.save(); depth = d._ctmStack.length; ours = d._ctmStack[depth - 1]                // a ENTRADA do nosso save (um array novo por save)
    const guardedSave: Guarded = function guardedSave() {
      const r = previousSave.call(doc)
      savedOn.push(doc.page)
      return r
    }
    // gate R7-M1: `restore()` a MAIS barrado NA HORA, antes de emitir o `Q` — acusar depois não desfaz o que vazou para o resto da folha
    const guardedRestore: Guarded = function guardedRestore() {
      if (d._ctmStack.length <= depth) throw new Error(`base de PDF: ${who} deu restore() a mais (fecharia o estado que não abriu)`)
      if (savedOn.length > 0 && savedOn[savedOn.length - 1] !== doc.page) {
        throw new Error(`base de PDF: ${who} deu restore() noutra folha (o save() correspondente foi feito em outra folha)`)
      }
      const r = previousRestore.call(doc)
      savedOn.pop()
      return r
    }
    guardedSave[GUARD] = previousSave
    guardedRestore[GUARD] = previousRestore
    d.save = guardedSave
    d.restore = guardedRestore
  }
  let result: T | undefined
  let failure: { error: unknown } | null = null
  try {
    if (opts.neutral) doc.fillColor('#000000', 1).strokeColor('#000000', 1).lineWidth(1).undash().font('Helvetica').fontSize(12).lineGap(0)
    result = run()
  } catch (error) {
    failure = { error }                                  // o erro de quem rodou sobe DEPOIS da limpeza — nunca trocado pelo de uso
  }
  if (graphics) {
    if (hadOwnRestore) d.restore = previousRestore; else delete d.restore
    if (hadOwnSave) d.save = previousSave; else delete d.save
  }
  const rawSave = rawOf(d.save as Guarded)
  const rawRestore = rawOf(d.restore as Guarded)
  const switchTo = (p: unknown): void => {
    const index = (d._pageBuffer as unknown[]).indexOf(p)
    if (index >= 0 && doc.page !== p) doc.switchToPage(d._pageBufferStart + index)
  }
  let misuse: string | null = null
  if (doc.page !== page) {
    misuse = (d._pageBuffer as unknown[]).length !== sheets
      ? 'abriu folha nova — o total que ela recebeu ficou errado' : 'terminou noutra folha (switchToPage sem voltar)'
  }
  if (graphics) {
    if (d._ctmStack.length > depth) misuse = misuse ?? 'deixou save() sem restore()'
    else if (d._ctmStack.length < depth || d._ctmStack[depth - 1] !== ours) misuse = misuse ?? 'deu restore() a mais (fechou o estado que não abriu)'
    // cada save() extra fecha NA FOLHA em que foi aberto (gate R7-L3b / socrático L2 — nunca um `Q` na folha errada)
    while (d._ctmStack.length > depth) {
      switchTo(savedOn.length > 0 ? savedOn.pop() : doc.page)
      rawRestore.call(doc)
    }
  }
  switchTo(page)
  if (graphics) {
    while (d._ctmStack.length < depth) rawSave.call(doc)      // restore() a mais que escapou da guarda (desvio deliberado): rebalanceia
    rawRestore.call(doc)
  }
  const keep = (opts.keep ?? []) as readonly string[]
  TEXT_STATE.forEach((k, i) => { if (!keep.includes(k)) d[k] = saved[i] })
  if (failure) throw failure.error
  if (misuse) throw new Error(`base de PDF: ${who} ${misuse}`)
  return result as T
}
