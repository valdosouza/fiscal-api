/**
 * Escritor da base de PDF (D-NE20/D-NE122): A4 (ou tamanho em cm), margens em cm e a PASSADA POR FOLHA — depois do conteúdo, cada folha é
 * revisitada sabendo o TOTAL (`bufferPages` do pdfkit). É o que permite à família escrever "Folha n/N" no topo de TODAS as folhas (MOC 7.00
 * Anexo II 3.10.2) ou afirmar página única (NT 008 da NFS-e). A base não sabe de "Folha", de cabeçalho repetido nem de estado do documento.
 *
 * `sheetStart` desenha ANTES do conteúdo de cada folha (ex.: marca d'água por baixo); `end(sheetPass)` desenha POR CIMA, já com o total.
 */
import PDFDocument from 'pdfkit'
import { cmToPt } from './units'

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
  /** Chamado ao ABRIR cada folha (1…), antes do conteúdo dela. */
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

export function createPdf(opts: CreatePdfOptions): PdfWriter {
  const m = typeof opts.marginCm === 'number'
    ? { top: opts.marginCm, right: opts.marginCm, bottom: opts.marginCm, left: opts.marginCm } : opts.marginCm
  const margins = {
    top: cmToPt(positive(m?.top, 'margem')), right: cmToPt(positive(m?.right, 'margem')),
    bottom: cmToPt(positive(m?.bottom, 'margem')), left: cmToPt(positive(m?.left, 'margem')),
  }
  const paper = opts.paper ?? 'A4'
  const size: string | [number, number] = paper === 'A4' ? 'A4'
    : [cmToPt(positive(paper.widthCm, 'papel')), cmToPt(positive(paper.heightCm, 'papel'))]
  if (typeof opts.title !== 'string' || opts.title.trim() === '') throw new RangeError('base de PDF: título obrigatório')

  const doc = new PDFDocument({
    size, layout: opts.layout ?? 'portrait', margins, bufferPages: true, autoFirstPage: false,
    info: { Title: opts.title, CreationDate: opts.creationDate ?? new Date() },
  })
  const chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
  let opened = 0
  let passing = false
  doc.on('pageAdded', () => {
    if (passing) return                                   // a passada não abre folha (conferido no fim dela)
    opened++
    opts.sheetStart?.(doc, opened)
  })
  doc.addPage()

  let ended = false
  return {
    doc,
    end(sheetPass) {
      if (ended) throw new Error('base de PDF: o documento já foi fechado')
      ended = true
      const { start, count } = doc.bufferedPageRange()
      if (sheetPass) {
        passing = true
        for (let i = start; i < start + count; i++) {
          doc.switchToPage(i)
          const x = doc.x, y = doc.y
          sheetPass(doc, Object.freeze({ sheet: i - start + 1, total: count }))
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
