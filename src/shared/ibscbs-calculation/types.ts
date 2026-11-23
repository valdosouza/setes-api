/**
 * Tipos da peça @shared/ibscbs-calculation (D-IB132). Convenção da peça inteira:
 * dinheiro em CENTAVOS inteiros não negativos; alíquota, redução e diferimento em MILIONÉSIMOS de fração
 * (8,7% = 87000; 0,05% = 500; 60% = 600000); datas `AAAA-MM-DD`.
 */

export type IbscbsTax = 'IBS_UF' | 'IBS_MUN' | 'CBS'

/** Linha da tabela datada de alíquotas. `validUntil` nulo = em aberto. */
export interface IbscbsAliqLine {
  tax: IbscbsTax
  validFrom: string
  validUntil: string | null
  ppm: number
}

/** Onde um tributo é apurado: no regime regular (grupo calculado aqui), no DAS do Simples ou em nenhum (MEI). */
export type IbscbsTaxAssessment = 'regular' | 'das' | 'none'

/** A opção de apuração do Simples (`regApIBSCBSSN`) ou, DITO por quem chama, que o emitente não é do Simples. */
export type IbscbsSimplesOption = 'not-simples' | '1' | '2' | '3'

export interface IbscbsAssessmentByTax {
  ibs: IbscbsTaxAssessment
  cbs: IbscbsTaxAssessment
}

/** Um valor por tributo (IBS da UF, IBS do município e CBS). */
export interface IbscbsByTax<T> {
  ibsUf: T
  ibsMun: T
  cbs: T
}

/** Componentes do `S` do item (RF-BC-03); ausente = 0. */
export interface IbscbsGrossBaseComponents {
  vProd?: number
  vServ?: number
  vFrete?: number
  vSeg?: number
  vOutro?: number
  vII?: number
  vIS?: number
  vDesc?: number
  vPIS?: number
  vCOFINS?: number
  vICMS?: number
  vICMSUFDest?: number
  vFCP?: number
  vFCPUFDest?: number
  vICMSMono?: number
  vISSQN?: number
}

/** Resultado da conta por dentro, em centavos. */
export interface IbscbsInsideResult {
  baseCents: number
  ibsUfCents: number
  ibsMunCents: number
  cbsCents: number
  /** Centavos ajustados dentro da tolerância de 0,01 da NT (0 = nenhum). */
  adjustedCents: number
  /** `base + IBS UF + IBS Mun + CBS = S`. */
  closes: boolean
}

/**
 * `outside`: o IBS/CBS fica por fora, `vBC = S`. `inside`: o preço já contém o IBS/CBS e o `vBC` é tirado de `S`
 * (conta por dentro, RF-PRC-02 a 04). Quem escolhe o modo é o produtor da nota — a peça não decide.
 */
export type IbscbsCalcMode = 'outside' | 'inside'

export interface IbscbsItemInput {
  /** O `S` do item (`calcIbscbsGrossBase`). */
  grossBaseCents: number
  mode: IbscbsCalcMode
  assessment: IbscbsAssessmentByTax
  /** Alíquota nominal de cada tributo; `null` = sem linha vigente (`ibscbsAliqAt`). */
  aliqs: IbscbsByTax<number | null>
  /** `pRedAliq` por tributo; ausente = sem redução. */
  reductions?: Partial<IbscbsByTax<number>>
  /** `pDif` por tributo; ausente = sem diferimento. */
  deferrals?: Partial<IbscbsByTax<number>>
}

export interface IbscbsTaxValue {
  aliqPpm: number
  reductionPpm: number
  /** `pAliqEfet` (igual à nominal quando não há redução). */
  effectiveAliqPpm: number
  deferralPpm: number
  /** `vDif`. */
  deferredCents: number
  /** Valor do tributo, já sem o diferido. */
  valueCents: number
}

export type IbscbsItemResult =
  | { status: 'no-aliq'; tax: IbscbsTax }
  | {
      status: 'calculated'
      mode: IbscbsCalcMode
      /** `vBC`. */
      baseCents: number
      ibsUf: IbscbsTaxValue
      ibsMun: IbscbsTaxValue
      cbs: IbscbsTaxValue
      /** `vIBS` = IBS da UF + IBS do município. */
      ibsCents: number
      /** Só na conta por dentro: ajuste de centavo e fechamento; por fora, 0 e `true`. */
      adjustedCents: number
      closes: boolean
    }

export type IbscbsItemCalculated = Extract<IbscbsItemResult, { status: 'calculated' }>

export interface IbscbsTotals {
  baseCents: number
  ibsUfDeferredCents: number
  ibsUfCents: number
  ibsMunDeferredCents: number
  ibsMunCents: number
  ibsCents: number
  cbsDeferredCents: number
  cbsCents: number
}

/** Alíquotas efetivas do Simples (`pIBSSN`, `pCBSSN`); `null` = não informada. */
export interface IbscbsSimplesAliqs {
  ibs: number | null
  cbs: number | null
}

export type IbscbsSimplesItemResult =
  | { status: 'no-aliq'; tax: 'IBS' | 'CBS' }
  | { status: 'calculated'; baseCents: number; ibsCents: number; cbsCents: number }

export type IbscbsSimplesItemCalculated = Extract<IbscbsSimplesItemResult, { status: 'calculated' }>

export interface IbscbsSimplesTotals {
  baseCents: number
  ibsCents: number
  cbsCents: number
}

export type IbscbsCalculationErrorCode =
  | 'INVALID_CENTS'
  | 'INVALID_PPM'
  | 'INVALID_DATE'
  | 'INVALID_PERCENT'
  | 'INVALID_INPUT'
  | 'INVALID_MODE'
  | 'INVALID_TAX'
  | 'AMBIGUOUS_ALIQ_LINE'
  | 'GROSS_BASE_ABOVE_LIMIT'
  | 'ASSESSMENT_NOT_SUPPORTED'

/** Erro de uso da peça (entrada fora do contrato). Não é erro HTTP: quem chama decide o que responder. */
export class IbscbsCalculationError extends Error {
  constructor(public readonly code: IbscbsCalculationErrorCode, message: string) {
    super(message)
    this.name = 'IbscbsCalculationError'
  }
}
