/**
 * PEÇA @shared/ibscbs-calculation — o motor PRÓPRIO de IBS/CBS do item de mercadoria (D-IB132, Valdo 2026-11-23:
 * "motor próprio de cálculo", no molde do ERP Desktop; revê a D-IB11 — a Calculadora oficial não é o motor).
 * Ficha: `D:\Vault\projetos\setes-api\SUBJECT\FATURAMENTO\ficha-ibs-e9-p1-motor-ibscbs.md` (setes-api:IBS.E9.P1).
 *
 * - **Funções puras**: sem banco, sem I/O, sem relógio, sem import de outra peça (cerca `ibscbs-calculation-fence.test.ts`).
 *   Quem chama resolve os dados (regra casada, alíquotas da data, opção do estabelecimento) e passa por argumento.
 * - **Unidades**: dinheiro em centavos inteiros (quem chama converte com `toCents` do `@shared/money`); alíquota, redução e
 *   diferimento em milionésimos de fração (`ibscbsPpmFromPercent('8.7')` = 87000). Arredondamento meio para cima.
 * - **Nada de grau L ou N embutido**: a CBS de 2027 não é constante (sem linha na tabela, o resultado é
 *   `{ status: 'no-aliq' }`); o modo por fora × por dentro é argumento; apuração mista do Simples é recusada.
 * - **Erros**: entrada fora do contrato lança `IbscbsCalculationError` (com `code`), que NÃO é `HttpError` nem está no
 *   catálogo de erros: quem ligar a peça (IBS.E9.P3) decide o que responder — inclusive para `S` negativo, que o regular
 *   recusa e o Simples trata com piso em zero, e para `closes: false`, que os totais recusam.
 * - **Ninguém chama ainda**: a regra `tb_tax_rule_ibscbs`, o congelamento no item e a ligação no faturamento são do
 *   IBS.E9.P3. A recusa das opções 2 e 3 (`IBSCBS_ASSESSMENTS_SUPPORTED`, D-IB99) não muda por causa desta peça.
 * - Vetores neutros (os mesmos do ERP Desktop): `src/__tests__/vectors/ibscbs/`, conferidos por sha256.
 */
export * from './types'
export { ibscbsPpmFromPercent } from './arith'
export { IBSCBS_LEGAL_ALIQS, ibscbsAliqAt, calcIbscbsEffectiveAliq } from './aliqs'
export { calcIbscbsGrossBase } from './gross-base'
export { calcIbscbsInside, IBSCBS_INSIDE_MAX_GROSS_BASE_CENTS } from './inside'
export { calcIbscbsItem, ibscbsTaxAssessmentOf } from './item'
export { calcIbscbsSimplesBase, calcIbscbsSimplesValue, calcIbscbsSimplesItem } from './simples'
export type { IbscbsSimplesBaseComponents } from './simples'
export { ibscbsTotals, ibscbsSimplesTotals } from './totals'
