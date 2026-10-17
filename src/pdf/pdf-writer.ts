/**
 * Escritor da base de PDF (D-NE20/D-NE122/D-NE125): A4 (ou tamanho em cm), margens em cm, papéis de fonte e a PASSADA POR FOLHA — depois do
 * conteúdo, cada folha é revisitada sabendo o TOTAL (`bufferPages` do pdfkit). É o que permite à família escrever "Folha n/N" no topo de TODAS
 * as folhas (MOC 7.00 Anexo II 3.10.2) ou afirmar página única (NT 008 da NFS-e). A base não sabe de "Folha", de cabeçalho repetido nem de
 * estado do documento.
 *
 * Contrato do `sheetStart` (D-NE125, Valdo 2026-10-17): chamado ao ABRIR cada folha — inclusive as que o pdfkit abre sozinho no transbordo —
 * antes do conteúdo dela (desenho por baixo; o cabeçalho repetido da NE-5). Roda ISOLADO: fonte, corpo, cor, opacidade, matriz e o texto
 * encadeado da família voltam como estavam; o `y` em que ele PARAR fica sendo o começo do conteúdo da folha (é assim que o cabeçalho reserva o
 * espaço dele); o `x` volta. Os papéis de fonte (`fontRoles`) já existem na 1ª folha.
 *
 * Contrato de erro: erro de USO (fechar duas vezes, passada que abre folha, `sheetStart`/passada assíncronos, folhas já despejadas por
 * `flushPages`) LANÇA na hora, sincronamente; o PDF vem pela promessa de `end()`.
 */
import PDFDocument from 'pdfkit'
import { cmToPt } from './units'
import { registerFontRoles, type StandardFont } from './fonts'
import { isolated } from './state'

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
  /** Data gravada no PDF (padrão: agora) — fixar dá PDF reprodutível. */
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
const isThenable = (v: unknown): boolean => !!v && (typeof v === 'object' || typeof v === 'function') && typeof (v as { then?: unknown }).then === 'function'

export function createPdf(opts: CreatePdfOptions): PdfWriter {
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
  if (!(creationDate instanceof Date) || !Number.isFinite(creationDate.getTime())) throw new RangeError('base de PDF: data do documento inválida')

  const doc = new PDFDocument({
    size, layout: opts.layout ?? 'portrait', margins, bufferPages: true, autoFirstPage: false,
    info: { Title: opts.title, CreationDate: creationDate },
  })
  const chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
  if (opts.fontRoles !== undefined) registerFontRoles(doc, opts.fontRoles)
  let opened = 0
  let passing = false
  doc.on('pageAdded', () => {
    if (passing) return                                   // a passada não abre folha (conferido no fim dela)
    opened++
    const start = opts.sheetStart
    if (!start) return
    isolated(doc, () => {
      if (isThenable(start(doc, opened))) throw new Error('base de PDF: o sheetStart tem de ser síncrono (o desenho cairia depois da folha)')
    }, ['y'])
  })
  doc.addPage()

  let ended = false
  return {
    doc,
    end(sheetPass) {
      if (ended) throw new Error('base de PDF: o documento já foi fechado')
      ended = true
      const { start, count } = doc.bufferedPageRange()
      if (start !== 0 || count !== opened) {
        throw new Error('base de PDF: há folhas já despejadas (flushPages) — a passada por folha perderia o total')
      }
      if (sheetPass) {
        passing = true
        for (let i = start; i < start + count; i++) {
          doc.switchToPage(i)
          const x = doc.x, y = doc.y
          if (isThenable(sheetPass(doc, Object.freeze({ sheet: i - start + 1, total: count })))) {
            throw new Error('base de PDF: a passada por folha tem de ser síncrona (o desenho cairia depois do fim)')
          }
          doc.x = x; doc.y = y
        }
        passing = false
        if (doc.bufferedPageRange().count !== count) {
          throw new Error('base de PDF: a passada por folha abriu folha nova — o total que ela recebeu ficou errado')
        }
      }
      doc.end()
      return done
    },
  }
}
