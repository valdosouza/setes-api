/** Erro de um campo específico no payload de resposta (decisão 20 Fase 2). */
export interface FieldError {
  field:   string
  message: string
  /** Valor ESPERADO quando o erro é de conferência numérica (Q-N3 da negociação,
   *  2026-09-07): a tela preenche/corrige sem fazer parse da prosa da mensagem.
   *  TEXTO na inscrição federal (D-CJ3, frente do CNPJ alfanumérico): a forma CANÔNICA do que foi enviado
   *  (ex.: '12ABC34501DE35' para '12.abc.345/01de-35') — a porta de escrita aceita só a canônica e diz qual é.
   *  NÃO é aditivo para o app anterior à onda 1: o `Failure` dele lê `expected` como `num?` e quebra com texto —
   *  setes-api e setes-app da onda 1 (`FailureField.expectedText`) publicam JUNTOS (gate de 2026-11-21). */
  expected?: number | string
}

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    /** Campos que causaram o erro — vão no payload `{ error, fields }`. */
    public fields?: FieldError[],
    /** Código do catálogo de erros conhecidos (R8 — error-codes.ts);
     *  vai no payload como `code` e na tb_crashlytics p/ agregação. */
    public code?: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
  /** Referência do alarme (tb_crashlytics) quando o erro TIPADO também é um evento técnico rastreável (D-F130 — voz do fisco
   *  ilegível): vai no payload como `ref`, como no 500. Aditivo — consumidores antigos ignoram. */
  ref?: string
}
