import { Request, Response } from 'express'
import logger from '@shared/logger/logger'
import { handleError, parseBody, parseId } from '@shared/http/controller-utils'
import { parseListQuery, pagedEnvelope } from '@shared/list'
import { assertClientRequired } from '@shared/field-config'
import {
  merchandiseDto, tradeUnitsDto, catalogItemDto, measureItemDto, packageItemDto, MERCHANDISE_FIELD_PATHS,
} from './merchandise.dto'
import * as service from './merchandise.service'

/** Escopo SEMPRE do JWT — hoje a chave do grupo = a institution da sessão (D-PR24). */
function scopeOf(req: Request): service.MerchandiseScope {
  const { schemaName, institutionId } = req.institution!
  return { schemaName, institutionId }
}

export async function list(req: Request, res: Response): Promise<void> {
  try {
    const query = await parseListQuery(req, 'merchandise', service.MERCHANDISE_SEARCH_CRITERIA)
    res.json(pagedEnvelope(query, await service.fetchMerchandiseList(query, scopeOf(req))))
  } catch (err) {
    handleError(res, err, 'merchandise GET')
  }
}

export async function searchCriteria(_req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await service.fetchMerchandiseSearchCriteria() })
  } catch (err) {
    handleError(res, err, 'merchandise/search-criteria GET')
  }
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await service.fetchMerchandise(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'merchandise/:id GET')
  }
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseBody(merchandiseDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'merchandise', body, MERCHANDISE_FIELD_PATHS)
    const id = await service.createMerchandise(body, scopeOf(req))
    logger.info('Produto criado', { institutionId: req.institution!.institutionId, id })
    res.status(201).json({ ok: true, data: { id } })
  } catch (err) {
    handleError(res, err, 'merchandise POST')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(merchandiseDto, req, res)
  if (body === null) return
  try {
    await assertClientRequired(req.institution!, 'merchandise', body, MERCHANDISE_FIELD_PATHS)
    await service.editMerchandise(id, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'merchandise/:id PUT')
  }
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    await service.removeMerchandise(id, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'merchandise/:id DELETE')
  }
}

export async function getTradeUnits(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await service.fetchTradeUnits(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'merchandise/:id/trade-units GET')
  }
}

export async function putTradeUnits(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  const body = parseBody(tradeUnitsDto, req, res)
  if (body === null) return
  try {
    await service.putTradeUnits(id, body, scopeOf(req))
    res.json({ ok: true })
  } catch (err) {
    handleError(res, err, 'merchandise/:id/trade-units PUT')
  }
}

export async function links(req: Request, res: Response): Promise<void> {
  const id = parseId(req, res)
  if (id === null) return
  try {
    res.json({ ok: true, data: await service.fetchLinks(id, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'merchandise/:id/links GET')
  }
}

const filterOf = (req: Request): string => String(req.query.filter ?? '')

export async function categoriesLookup(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await service.fetchCategoriesLookup(filterOf(req), scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'merchandise/categories GET')
  }
}

export async function financialPlansLookup(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await service.fetchFinancialPlansLookup(filterOf(req), scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'merchandise/financial-plans GET')
  }
}

export async function priceListsLookup(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await service.fetchPriceListsLookup(scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'merchandise/price-lists GET')
  }
}

export async function brandsLookup(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await service.fetchBrandsLookup(filterOf(req), scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'merchandise/brands GET')
  }
}

export async function measuresLookup(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await service.fetchMeasuresLookup(filterOf(req), scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'merchandise/measures GET')
  }
}

export async function packagesLookup(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, data: await service.fetchPackagesLookup(filterOf(req), scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'merchandise/packages GET')
  }
}

export async function createBrand(req: Request, res: Response): Promise<void> {
  const body = parseBody(catalogItemDto, req, res)
  if (body === null) return
  try {
    res.status(201).json({ ok: true, data: await service.createBrand(body, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'merchandise/brands POST')
  }
}

export async function createMeasure(req: Request, res: Response): Promise<void> {
  const body = parseBody(measureItemDto, req, res)
  if (body === null) return
  try {
    res.status(201).json({ ok: true, data: await service.createMeasure(body, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'merchandise/measures POST')
  }
}

export async function createPackage(req: Request, res: Response): Promise<void> {
  const body = parseBody(packageItemDto, req, res)
  if (body === null) return
  try {
    res.status(201).json({ ok: true, data: await service.createPackage(body, scopeOf(req)) })
  } catch (err) {
    handleError(res, err, 'merchandise/packages POST')
  }
}
