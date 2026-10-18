/**
 * A MARCA do documento da base (D-NE127, Valdo 2026-10-17 — Q-NE127 (a)): o `createPdf` marca o documento que cria e as portas que recebem
 * documento (`drawBars`, `drawMatrix`, `drawWatermark`, `registerFontRoles`, `writeText`, `measureText`) recusam documento sem a marca — a base
 * só desenha em documento do MESMO pdfkit que ela fixou (D-NE124: "um motor"), cujos internos o isolamento conhece.
 *
 * A marca é um SÍMBOLO privado no próprio objeto (nenhuma coleção em memória — regra do núcleo cego) e carrega o REGISTRO DE PAPÉIS da base
 * (gate adversarial D14: `writeText` conferia o registro do pdfkit, onde `doc.registerFont` direto põe até a fonte Symbol).
 *
 * Interno da base (não sai pela superfície `fiscal-api/pdf`).
 */
const BASE_DOCUMENT = Symbol('fiscal-api/pdf:documento-da-base')

export interface BaseDocumentState {
  /** Papel → fonte-padrão, só o que passou por `registerFontRoles` (objeto sem protótipo). */
  readonly roles: Record<string, string>
}

export function markBaseDocument(doc: PDFKit.PDFDocument): void {
  Object.defineProperty(doc, BASE_DOCUMENT, {
    value: Object.freeze({ roles: Object.create(null) as Record<string, string> }),
    enumerable: false, configurable: false, writable: false,
  })
}

/**
 * O estado da marca — só como propriedade PRÓPRIA do objeto (re-gate S5: pela cadeia de protótipo, `Object.create(doc)` passava). A marca protege
 * contra ENGANO (documento de outra cópia do pdfkit, objeto qualquer), não contra fraude: quem copia o símbolo por reflexão para outro objeto
 * passa pela porta — e nada desenha fora do documento da base mesmo assim.
 */
export function baseDocument(doc: PDFKit.PDFDocument): BaseDocumentState {
  const own = !!doc && typeof doc === 'object' && Object.prototype.hasOwnProperty.call(doc, BASE_DOCUMENT)
  const state = own ? (doc as unknown as Record<symbol, BaseDocumentState | undefined>)[BASE_DOCUMENT] : undefined
  if (!state) throw new RangeError('base de PDF: o documento não foi criado pelo createPdf da base (D-NE127)')
  return state
}
