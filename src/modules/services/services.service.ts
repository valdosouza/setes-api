import { HttpError } from '@shared/errors/http-error'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { todayFor } from '@shared/time-zone'
import {
  CodeLookupRow, listNbsLookup, listClassificationsLookup, listPlaceIndicatorsLookup,
} from '@shared/ibscbs-classification'
import { ListQuery, PagedRows, PublicSearchCriterion, publicCriteria } from '@shared/list'
import {
  ServiceListRow, ServiceFull, ServiceInput, ServiceLookupRow, ServiceFiscalClassificationInput,
} from './services.interface'
import {
  listServices, getService, insertService, updateService, softDeleteService,
  updateServiceTaxRule, updateServiceFiscalClassification,
  listCategoriesLookup, listFinancialPlansLookup, listPriceListsLookup,
  listServiceTaxRulesLookup,
  SERVICE_SEARCH_CRITERIA,
} from './services.repository'

/**
 * Regras do módulo services: escopo SEMPRE da institution do JWT; kind='S'
 * é invariante do repositório (mercadoria é invisível aqui — D5); FKs
 * validadas na transação (400); 404 sem vazar; soft delete livre (usos
 * históricos ficam pelos JOINs).
 */

export interface ServiceScope {
  schemaName:    string
  institutionId: number
  /** Autor (JWT) — gravado na classificação IBS/CBS do serviço. */
  userId?:       number
}

export { SERVICE_SEARCH_CRITERIA }

/** Critérios da pesquisa avançada servidos ao app (D-BA2) — sem expressão SQL. */
export async function fetchServiceSearchCriteria(): Promise<PublicSearchCriterion[]> {
  return publicCriteria(SERVICE_SEARCH_CRITERIA)
}

export async function fetchServices(
  query: ListQuery, scope: ServiceScope
): Promise<PagedRows<ServiceListRow>> {
  return listServices(query, scope.schemaName, scope.institutionId)
}

export async function fetchService(
  id: number, scope: ServiceScope
): Promise<ServiceFull> {
  const today = await todayFor(scope.schemaName, scope.institutionId)
  const service = await getService(id, scope.schemaName, scope.institutionId, today)
  if (!service) throw new HttpError(404, `Serviço ${id} não encontrado`)
  return service
}

/** D-PR2: quem cunha id / troca código reexecuta a transação em deadlock (o faturamento trava `tb_service_ibscbs` e depois a
 *  institution; o create trava a institution e depois grava `tb_service_ibscbs` — o ciclo cai num dos dois e a vítima repete). */
const RETRIES = 3

export async function createService(
  input: ServiceInput, scope: ServiceScope
): Promise<number> {
  return withDeadlockRetry('services POST', { institutionId: scope.institutionId }, RETRIES,
    () => insertService(input, scope.schemaName, scope.institutionId, scope.userId ?? null))
}

export async function editService(
  id: number, input: ServiceInput, scope: ServiceScope
): Promise<void> {
  const found = await withDeadlockRetry('services PUT', { institutionId: scope.institutionId, id }, RETRIES,
    () => updateService(id, input, scope.schemaName, scope.institutionId, scope.userId ?? null))
  if (!found) throw new HttpError(404, `Serviço ${id} não encontrado`)
}

/** D-PR45: o vínculo serviço → regra de ISS pela rota própria (fora da guarda do dono do catálogo). */
export async function editServiceTaxRule(
  id: number, serviceTaxRuleId: number | null, scope: ServiceScope
): Promise<void> {
  const found = await withDeadlockRetry('services/:id/tax-rule PUT', { institutionId: scope.institutionId, id }, RETRIES,
    () => updateServiceTaxRule(id, serviceTaxRuleId, scope.schemaName, scope.institutionId))
  if (!found) throw new HttpError(404, `Serviço ${id} não encontrado`)
}

/** D-PR45: a presunção IBS/CBS pela rota própria (fora da guarda do dono do catálogo). */
export async function editServiceIbscbs(
  id: number, input: ServiceFiscalClassificationInput, scope: ServiceScope
): Promise<void> {
  const found = await withDeadlockRetry('services/:id/ibscbs PUT', { institutionId: scope.institutionId, id }, RETRIES,
    () => updateServiceFiscalClassification(id, input, scope.schemaName, scope.institutionId, scope.userId ?? null))
  if (!found) throw new HttpError(404, `Serviço ${id} não encontrado`)
}

export async function removeService(
  id: number, scope: ServiceScope
): Promise<void> {
  const found = await softDeleteService(id, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Serviço ${id} não encontrado`)
}

export async function fetchCategoriesLookup(
  filter: string, scope: ServiceScope
): Promise<ServiceLookupRow[]> {
  // Q-PR49 (a) (Rodada 6 de produtos): pelo FATO — só kind 'S' quando o estabelecimento tem categoria S viva; senão as P (o legado não
  // marca categoria de serviço). Substitui a regra pelo MODO (ter chave do sincronizador) da D-PR41 original: com a guarda da D-PR41
  // revista o sincronizado nem cria serviço na web, e desligar a chave já não esvazia a lista (o ato cria "Serviços").
  return listCategoriesLookup(filter, scope.schemaName, scope.institutionId)
}

export async function fetchFinancialPlansLookup(
  filter: string, scope: ServiceScope
): Promise<ServiceLookupRow[]> {
  return listFinancialPlansLookup(filter, scope.schemaName, scope.institutionId)
}

export async function fetchServiceTaxRulesLookup(
  filter: string, scope: ServiceScope
): Promise<ServiceLookupRow[]> {
  return listServiceTaxRulesLookup(filter, scope.schemaName, scope.institutionId)
}

export async function fetchPriceListsLookup(
  scope: ServiceScope
): Promise<ServiceLookupRow[]> {
  return listPriceListsLookup(scope.schemaName, scope.institutionId)
}

// Fase IBS/CBS (D-IB6) — listas de apoio do formulário, servidas pelo PRÓPRIO módulo (o app fala
// só com /api/services). Catálogo central; classificação filtrada pela vigência de HOJE do
// estabelecimento e pela aceitação na NFS-e (peça @shared/ibscbs-classification).

export async function fetchNbsLookup(filter: string): Promise<CodeLookupRow[]> {
  return listNbsLookup(filter)
}

export async function fetchIbscbsClassificationsLookup(
  filter: string, scope: ServiceScope
): Promise<CodeLookupRow[]> {
  const today = await todayFor(scope.schemaName, scope.institutionId)
  return listClassificationsLookup(filter, today)
}

export async function fetchIbscbsPlaceIndicatorsLookup(filter: string): Promise<CodeLookupRow[]> {
  return listPlaceIndicatorsLookup(filter)
}
