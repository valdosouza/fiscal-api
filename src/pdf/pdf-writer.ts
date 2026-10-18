/**
 * Escritor da base de PDF (D-NE20/D-NE122/D-NE125/D-NE128): A4 (ou tamanho em cm), margens em cm, papéis de fonte e a PASSADA POR FOLHA — depois
 * do conteúdo, cada folha é revisitada sabendo o TOTAL (`bufferPages` do pdfkit). É o que permite à família escrever "Folha n/N" no topo de TODAS
 * as folhas (MOC 7.00 Anexo II 3.10.2) ou afirmar página única (NT 008 da NFS-e). A base não sabe de "Folha", de cabeçalho repetido nem de
 * estado do documento. O documento sai MARCADO como da base (D-NE127).
 *
 * Contrato do `sheetStart` (D-NE125, Valdo 2026-10-17): chamado ao ABRIR cada folha — inclusive as que o pdfkit abre sozinho no transbordo —
 * antes do conteúdo dela (desenho por baixo; o cabeçalho repetido da NE-5). ENTRA com o estado de uma FOLHA NOVA (Helvetica 12, preto opaco, traço
 * de 1 pt contínuo, espaçamento 0 — o cabeçalho sai igual em toda folha, re-gates D7/S3) e roda ISOLADO: fonte, corpo, espaçamento, cor, opacidade, matriz e o texto encadeado da família
 * voltam como estavam; o `y` em que ele PARAR fica sendo o começo do conteúdo da folha (é assim que o cabeçalho reserva o espaço dele) e tem de
 * deixar lugar para ao menos uma linha (re-gate D5); o `x` volta. Não pode abrir folha (cabeçalho maior que a folha — re-gate N4), terminar
 * noutra folha nem deixar `save()` sem `restore()` (re-gates D3/D4). Os papéis de fonte (`fontRoles`) já existem na 1ª folha.
 * A passada por folha roda ISOLADA do mesmo jeito, sem manter nada (D-NE128).
 *
 * Contrato de erro: erro de USO (fechar duas vezes, passada que abre folha, `sheetStart`/passada assíncronos, folhas já despejadas por
 * `flushPages`, as violações acima) LANÇA na hora, sincronamente; o PDF vem pela promessa de `end()`.
 */
import PDFDocument from 'pdfkit'
import { cmToPt } from './units'
import { registerFontRoles, type StandardFont } from './fonts'
import { markBaseDocument } from './base-document'
import { guardSheetSwitch, isolated } from './state'

export interface PdfSheetInfo {
  /** Ordem da folha, 1…total. */
  readonly sheet: number
  readonly total: number
}

export interface CreatePdfOptions {
  /** 'A4' (padrão) ou o papel em cm (o MOC admite de A4 a Ofício II). */
  readonly paper?: 'A4' | { readonly widthCm: number; readonly heightCm: number }
  readonly layout?: 'portrait' | 'landscape'
  /** Margens em cm — um valor para os quatro lados ou cada lado. */
  readonly marginCm: number | { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }
  readonly title: string
  /** Data gravada no PDF (padrão: agora; ano de 0 a 9999) — fixar dá PDF reprodutível. */
  readonly creationDate?: Date
  /** Papéis de fonte (papel → fonte-padrão) registrados ANTES da 1ª folha — o `sheetStart` já pode usá-los (D-NE125). */
  readonly fontRoles?: Readonly<Record<string, StandardFont>>
  /** Chamado ao ABRIR cada folha (1…), antes do conteúdo dela — ver o contrato no cabeçalho. */
  readonly sheetStart?: (doc: PDFKit.PDFDocument, sheet: number) => void
}

export interface PdfWriter {
  readonly doc: PDFKit.PDFDocument
  /** Fecha o documento: roda `sheetPass` em cada folha (com o total) e devolve o PDF. Só uma vez. */
  end(sheetPass?: (doc: PDFKit.PDFDocument, info: PdfSheetInfo) => void): Promise<Buffer>
}

const positive = (n: number, what: string): number => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new RangeError(`base de PDF: ${what} inválido`)
  return n
}

/** Função síncrona que devolveu promessa = erro de uso; a promessa é OBSERVADA para nunca virar `unhandledRejection` (re-gate D9). */
function refuseThenable(result: unknown, message: string): void {
  if (!result || (typeof result !== 'object' && typeof result !== 'function')) return
  const then = (result as { then?: unknown }).then
  if (typeof then !== 'function') return
  try { then.call(result, undefined, () => undefined) } catch { /* thenable quebrado: nada a observar */ }
  throw new Error(message)
}

export function createPdf(options: CreatePdfOptions): PdfWriter {
  const opts = Object.freeze({ ...(options ?? {}) }) as CreatePdfOptions      // lidas UMA vez (a classe do A12/R7-L5)
  if (opts.sheetStart !== undefined && typeof opts.sheetStart !== 'function') throw new RangeError('base de PDF: sheetStart tem de ser função')
  const m = typeof opts?.marginCm === 'number'
    ? { top: opts.marginCm, right: opts.marginCm, bottom: opts.marginCm, left: opts.marginCm } : opts?.marginCm
  const margins = {
    top: cmToPt(positive(m?.top, 'margem')), right: cmToPt(positive(m?.right, 'margem')),
    bottom: cmToPt(positive(m?.bottom, 'margem')), left: cmToPt(positive(m?.left, 'margem')),
  }
  const paper = opts.paper ?? 'A4'
  if (paper !== 'A4' && (typeof paper !== 'object' || paper === null)) throw new RangeError('base de PDF: papel inválido')
  const size: string | [number, number] = paper === 'A4' ? 'A4'
    : [cmToPt(positive(paper.widthCm, 'papel')), cmToPt(positive(paper.heightCm, 'papel'))]
  if (typeof opts.title !== 'string' || opts.title.trim() === '') throw new RangeError('base de PDF: título obrigatório')
  const creationDate = opts.creationDate ?? new Date()
  if (!(creationDate instanceof Date) || !Number.isFinite(creationDate.getTime())
    || creationDate.getUTCFullYear() < 0 || creationDate.getUTCFullYear() > 9999) {      // re-gate D13: o PDF só grava 4 dígitos de ano
    throw new RangeError('base de PDF: data do documento inválida')
  }

  const doc = new PDFDocument({
    size, layout: opts.layout ?? 'portrait', margins, bufferPages: true, autoFirstPage: false,
    info: { Title: opts.title, CreationDate: creationDate },
  })
  markBaseDocument(doc)
  guardSheetSwitch(doc)                                      // D-NE138: trocar de folha com save() aberto = erro de uso
  const chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
  if (opts.fontRoles !== undefined) registerFontRoles(doc, opts.fontRoles)
  let opened = 0
  let passing = false
  let starting = false
  /**
   * A causa do erro de uso que deixou o documento INVÁLIDO — a folha que ficou ÓRFÃ ou SEM o `sheetStart`: o `sheetStart` que abre folha (re-gate
   * S6/R7-L3a: o `end()` culpava o flushPages e o documento nunca fechava) e o `save()` aberto atravessando a quebra (D-NE134 — a folha nova fica
   * sem cabeçalho; gate final F-L3). Os demais erros de uso sobem na hora e o documento ainda fecha.
   */
  let broken: string | null = null
  doc.on('pageAdded', () => {
    if (passing) return                                   // a passada não abre folha (conferido no fim dela)
    if (starting) {
      broken = broken ?? 'o sheetStart abriu folha (o que ele escreve não cabe na folha)'
      throw new Error(`base de PDF: ${broken}`)
    }
    opened++
    // D-NE134 (Valdo 2026-10-17 — gate R7-L4): o `addPage` do pdfkit reinicia a matriz mas NÃO a pilha de `save()` — pilha não vazia na
    // abertura da folha é `save()` da FAMÍLIA atravessando a quebra (um recorte que deixaria o "Folha n/N" invisível, q/Q desbalanceado)
    if ((doc as unknown as { _ctmStack: unknown[] })._ctmStack.length > 0) {
      broken = broken ?? 'há save() aberto atravessando a quebra de folha (a folha nova ficou sem o sheetStart)'
      throw new Error('base de PDF: há save() aberto atravessando a quebra de folha (feche com restore() antes do conteúdo que transborda — D-NE134)')
    }
    const start = opts.sheetStart
    if (!start) return
    starting = true
    try {
      isolated(doc, () => {
        refuseThenable(start(doc, opened), 'base de PDF: o sheetStart tem de ser síncrono (o desenho cairia depois da folha)')
      }, { keep: ['y'], neutral: true, who: 'o sheetStart' })
    } finally {
      starting = false
    }
    const room = doc.page.height - doc.page.margins.bottom - doc.currentLineHeight(true)
    if (!Number.isFinite(doc.y) || doc.y < 0 || doc.y > room) {                         // re-gate D5: finito, na folha e com lugar para 1 linha
      throw new Error('base de PDF: o sheetStart deixou o y fora da área útil (sem lugar para o conteúdo da folha)')
    }
  })
  doc.addPage()

  let ended = false
  return {
    doc,
    end(sheetPass) {
      if (ended) throw new Error('base de PDF: o documento já foi fechado')
      if (broken) throw new Error(`base de PDF: o documento ficou inválido e não fecha — ${broken} (monte de novo)`)
      // socrático L3: `save()` (com recorte) aberto no FIM do conteúdo deixaria a passada dentro dele — o "Folha n/N" invisível
      if ((doc as unknown as { _ctmStack: unknown[] })._ctmStack.length > 0) {
        throw new Error('base de PDF: há save() aberto no fim do conteúdo — feche com restore() antes do end()')
      }
      ended = true
      const { start, count } = doc.bufferedPageRange()
      if (start !== 0 || count !== opened) {
        throw new Error('base de PDF: há folhas já despejadas (flushPages) — a passada por folha perderia o total')
      }
      if (sheetPass) {
        passing = true
        try {
          for (let i = start; i < start + count; i++) {
            doc.switchToPage(i)
            isolated(doc, () => {
              doc.x = doc.page.margins.left                  // a passada entra na posição de uma folha nova (re-gate S3)
              doc.y = doc.page.margins.top
              refuseThenable(sheetPass(doc, Object.freeze({ sheet: i - start + 1, total: count })),
                'base de PDF: a passada por folha tem de ser síncrona (o desenho cairia depois do fim)')
            }, { neutral: true, who: 'a passada por folha' })
          }
        } finally {
          passing = false
        }
        if (doc.bufferedPageRange().count !== count) {
          throw new Error('base de PDF: a passada por folha abriu folha nova — o total que ela recebeu ficou errado')
        }
      }
      doc.end()
      return done
    },
  }
}
