/** Erro de um campo específico no payload de resposta (decisão 20 da Fase 2 do produto). */
export interface FieldError {
  field:   string
  message: string
  /** Valor ESPERADO quando o erro é de conferência numérica — a tela corrige sem ler a prosa. */
  expected?: number
}

/**
 * Erro HTTP com o envelope da casa `{ error, code?, ref?, fields? }` (Framework de Mensagens do
 * produto, R2/R8). Mesma forma do setes-api — o app trata as duas APIs com o mesmo leitor.
 */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public fields?: FieldError[],
    public code?: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}
