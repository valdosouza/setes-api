import { HttpError } from '@shared/errors/http-error'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { ListQuery, PagedRows, PublicSearchCriterion, publicCriteria } from '@shared/list'
import {
  BRAND_CATALOG, MEASURE_CATALOG, PACKAGE_CATALOG, CatalogItemInput, CatalogItemRow, createAndLinkCatalogItem,
} from '@shared/central-catalog'
import {
  MerchandiseListRow, MerchandiseFull, MerchandiseInput, MerchandiseLookupRow,
  TradeUnitsView, TradeUnitsInput, MerchandiseLinks,
} from './merchandise.interface'
import {
  listMerchandise, getMerchandise, insertMerchandise, updateMerchandise, softDeleteMerchandise,
  getTradeUnits, saveTradeUnits, getLinks,
  listCategoriesLookup, listFinancialPlansLookup, listPriceListsLookup,
  listBrandsLookup, listMeasuresLookup, listPackagesLookup,
  MERCHANDISE_SEARCH_CRITERIA,
} from './merchandise.repository'

/**
 * Regras do módulo merchandise: escopo SEMPRE da institution do JWT (hoje = a chave do grupo — D-PR24 regra 3, resolvida AQUI num
 * ponto só); kind ∈ {P, M} é invariante do repositório; FKs validadas na transação; 404 sem vazar; soft delete livre (D-PR11).
 * As transações que cunham id / trocam código / reescrevem os níveis reexecutam em deadlock (D-PR2 — `withDeadlockRetry`, 3×).
 */

export interface MerchandiseScope {
  schemaName:    string
  institutionId: number
}

const RETRIES = 3

export { MERCHANDISE_SEARCH_CRITERIA }

export async function fetchMerchandiseSearchCriteria(): Promise<PublicSearchCriterion[]> {
  return publicCriteria(MERCHANDISE_SEARCH_CRITERIA)
}

export async function fetchMerchandiseList(
  query: ListQuery, scope: MerchandiseScope
): Promise<PagedRows<MerchandiseListRow>> {
  return listMerchandise(query, scope.schemaName, scope.institutionId)
}

export async function fetchMerchandise(id: number, scope: MerchandiseScope): Promise<MerchandiseFull> {
  const found = await getMerchandise(id, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Produto ${id} não encontrado`)
  return found
}

export async function createMerchandise(input: MerchandiseInput, scope: MerchandiseScope): Promise<number> {
  return withDeadlockRetry('merchandise POST', { institutionId: scope.institutionId }, RETRIES,
    () => insertMerchandise(input, scope.schemaName, scope.institutionId))
}

export async function editMerchandise(id: number, input: MerchandiseInput, scope: MerchandiseScope): Promise<void> {
  const found = await withDeadlockRetry('merchandise PUT', { institutionId: scope.institutionId, id }, RETRIES,
    () => updateMerchandise(id, input, scope.schemaName, scope.institutionId))
  if (!found) throw new HttpError(404, `Produto ${id} não encontrado`)
}

export async function removeMerchandise(id: number, scope: MerchandiseScope): Promise<void> {
  const found = await softDeleteMerchandise(id, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Produto ${id} não encontrado`)
}

export async function fetchTradeUnits(id: number, scope: MerchandiseScope): Promise<TradeUnitsView> {
  const found = await getTradeUnits(id, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Produto ${id} não encontrado`)
  return found
}

export async function putTradeUnits(id: number, input: TradeUnitsInput, scope: MerchandiseScope): Promise<void> {
  const found = await withDeadlockRetry('merchandise/:id/trade-units PUT', { institutionId: scope.institutionId, id }, RETRIES,
    () => saveTradeUnits(id, input, scope.schemaName, scope.institutionId))
  if (!found) throw new HttpError(404, `Produto ${id} não encontrado`)
}

export async function fetchLinks(id: number, scope: MerchandiseScope): Promise<MerchandiseLinks> {
  const found = await getLinks(id, scope.schemaName, scope.institutionId)
  if (!found) throw new HttpError(404, `Produto ${id} não encontrado`)
  return found
}

export const fetchCategoriesLookup = (filter: string, scope: MerchandiseScope): Promise<MerchandiseLookupRow[]> =>
  listCategoriesLookup(filter, scope.schemaName, scope.institutionId)
export const fetchFinancialPlansLookup = (filter: string, scope: MerchandiseScope): Promise<MerchandiseLookupRow[]> =>
  listFinancialPlansLookup(filter, scope.schemaName, scope.institutionId)
export const fetchPriceListsLookup = (scope: MerchandiseScope): Promise<MerchandiseLookupRow[]> =>
  listPriceListsLookup(scope.schemaName, scope.institutionId)
export const fetchBrandsLookup = (filter: string, scope: MerchandiseScope): Promise<CatalogItemRow[]> =>
  listBrandsLookup(filter, scope.schemaName, scope.institutionId)
export const fetchMeasuresLookup = (filter: string, scope: MerchandiseScope): Promise<CatalogItemRow[]> =>
  listMeasuresLookup(filter, scope.schemaName, scope.institutionId)
export const fetchPackagesLookup = (filter: string, scope: MerchandiseScope): Promise<CatalogItemRow[]> =>
  listPackagesLookup(filter, scope.schemaName, scope.institutionId)

/**
 * "Criar na hora" (D-PR5/D-PR28): garante na central (dedupe) + vincula à institution. Cunha id por MAX+1 numa tabela da CENTRAL
 * (compartilhada entre clientes): criações simultâneas deadlockam no intervalo do fim da tabela (ADV-06 — 8 concorrentes: 1 ok, 7 ×
 * 1213) — a transação reexecuta como as demais que cunham id. Limite conhecido: a dedupe da medida pela abreviação não tem índice e trava
 * a tabela central inteira pelo tempo da transação (catálogo pequeno; criação rara e humana).
 */
const CATALOG_RETRIES = 5
const createCatalogItem = (spec: typeof BRAND_CATALOG, input: CatalogItemInput, scope: MerchandiseScope) =>
  withDeadlockRetry(`merchandise criar ${spec.table}`, { institutionId: scope.institutionId }, CATALOG_RETRIES,
    () => createAndLinkCatalogItem(spec, scope.schemaName, scope.institutionId, input))
export const createBrand = (input: CatalogItemInput, scope: MerchandiseScope) => createCatalogItem(BRAND_CATALOG, input, scope)
export const createMeasure = (input: CatalogItemInput, scope: MerchandiseScope) => createCatalogItem(MEASURE_CATALOG, input, scope)
export const createPackage = (input: CatalogItemInput, scope: MerchandiseScope) => createCatalogItem(PACKAGE_CATALOG, input, scope)
