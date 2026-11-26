import { Request, Response } from 'express'
import { handleError, parseBody } from '@shared/http/controller-utils'
import { ErrorCodes } from '@shared/errors/error-codes'
import { assertClientRequired } from '@shared/field-config'
import { isIsoDate } from '@shared/ibscbs-assessment'
import {
  establishmentUpdateDto, ibscbsAssessmentCreateDto, ibscbsAssessmentChangeDto, IBSCBS_ASSESSMENT_CATALOG_FIELDS,
  simplesRateCreateDto, simplesRateChangeDto,
} from './establishment.dto'
import {
  fetchEstablishment, editEstablishment,
  fetchIbscbsAssessments, registerIbscbsAssessment, editIbscbsAssessment, deleteIbscbsAssessment,
  fetchSimplesRates, registerSimplesRate, editSimplesRate, deleteSimplesRate,
} from './establishment.service'

/**
 * Controller do módulo establishment — NUNCA lê req.params.id: o
 * institutionId vem SEMPRE de req.institution (JWT validado pelo
 * adminGuard, montado no gateway). Elimina IDOR por construção — não há
 * nenhum caminho de código que aceite um id vindo da URL/body.
 */

export async function get(req: Request, res: Response): Promise<void> {
  try {
    const { institutionId, schemaName } = req.institution!
    res.json({ ok: true, data: await fetchEstablishment(institutionId, schemaName) })
  } catch (err) {
    handleError(res, err, 'establishment GET')
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const body = parseBody(establishmentUpdateDto, req, res)
  if (body === null) return
  try {
    const { institutionId, schemaName } = req.institution!
    const data = await editEstablishment(
      institutionId, schemaName, body, req.institution?.userId ?? null)
    res.json({ ok: true, data })
  } catch (err) {
    handleError(res, err, 'establishment PUT')
  }
}

// ---------------------------------------------------------------------------
// Sub-recurso OPÇÃO DE APURAÇÃO DO IBS/CBS (D-IB99/D-IB100). Institution SEMPRE do token; o único parâmetro de rota é a
// DATA de início (identidade da linha do PRÓPRIO estabelecimento — nunca um id de outro).
// ---------------------------------------------------------------------------

/** :validFrom inválido = 400 com fields[] (nunca chega ao SQL — sem modo estrito viraria '0000-00-00'). */
function parseValidFrom(req: Request, res: Response): string | null {
  const v = req.params.validFrom
  if (!isIsoDate(v)) {
    res.status(400).json({ error: 'Data de início inválida', code: ErrorCodes.VALIDATION_FAILED,
      fields: [{ field: 'validFrom', message: 'Data inválida (AAAA-MM-DD)' }] })
    return null
  }
  return v
}

export async function listIbscbsAssessments(req: Request, res: Response): Promise<void> {
  try {
    const { institutionId, schemaName } = req.institution!
    res.json({ ok: true, data: await fetchIbscbsAssessments(institutionId, schemaName) })
  } catch (err) {
    handleError(res, err, 'establishment ibscbs-assessments GET')
  }
}

export async function createIbscbsAssessment(req: Request, res: Response): Promise<void> {
  const body = parseBody(ibscbsAssessmentCreateDto, req, res)
  if (body === null) return
  try {
    const { institutionId, schemaName, userId } = req.institution!
    await assertClientRequired(req.institution!, 'establishment', body, {}, IBSCBS_ASSESSMENT_CATALOG_FIELDS)
    res.status(201).json({ ok: true, data: await registerIbscbsAssessment(institutionId, schemaName, userId, body) })
  } catch (err) {
    handleError(res, err, 'establishment ibscbs-assessments POST')
  }
}

export async function changeIbscbsAssessment(req: Request, res: Response): Promise<void> {
  const validFrom = parseValidFrom(req, res)
  if (validFrom === null) return
  const body = parseBody(ibscbsAssessmentChangeDto, req, res)
  if (body === null) return
  try {
    const { institutionId, schemaName, userId } = req.institution!
    await assertClientRequired(req.institution!, 'establishment', { ...body, validFrom }, {}, IBSCBS_ASSESSMENT_CATALOG_FIELDS)
    res.json({ ok: true, data: await editIbscbsAssessment(institutionId, schemaName, userId, { validFrom, ...body }) })
  } catch (err) {
    handleError(res, err, 'establishment ibscbs-assessments PUT')
  }
}

export async function removeIbscbsAssessment(req: Request, res: Response): Promise<void> {
  const validFrom = parseValidFrom(req, res)
  if (validFrom === null) return
  try {
    const { institutionId, schemaName, userId } = req.institution!
    res.json({ ok: true, data: await deleteIbscbsAssessment(institutionId, schemaName, userId, validFrom) })
  } catch (err) {
    handleError(res, err, 'establishment ibscbs-assessments DELETE')
  }
}

// Percentual do Simples no IBS/CBS (IBS.E9.P5, D-IB138): o mês da URL é conferido pela peça (400 IBSCBS_SIMPLES_RATE_INVALID).

export async function listSimplesRatesHandler(req: Request, res: Response): Promise<void> {
  try {
    const { institutionId, schemaName } = req.institution!
    res.json({ ok: true, data: await fetchSimplesRates(institutionId, schemaName) })
  } catch (err) {
    handleError(res, err, 'establishment simples-rates GET')
  }
}

export async function createSimplesRateHandler(req: Request, res: Response): Promise<void> {
  const body = parseBody(simplesRateCreateDto, req, res)
  if (body === null) return
  try {
    const { institutionId, schemaName, userId } = req.institution!
    res.status(201).json({ ok: true, data: await registerSimplesRate(institutionId, schemaName, userId, body) })
  } catch (err) {
    handleError(res, err, 'establishment simples-rates POST')
  }
}

export async function changeSimplesRateHandler(req: Request, res: Response): Promise<void> {
  const body = parseBody(simplesRateChangeDto, req, res)
  if (body === null) return
  try {
    const { institutionId, schemaName, userId } = req.institution!
    res.json({ ok: true, data: await editSimplesRate(institutionId, schemaName, userId, { competence: req.params.competence, ...body }) })
  } catch (err) {
    handleError(res, err, 'establishment simples-rates PUT')
  }
}

export async function removeSimplesRateHandler(req: Request, res: Response): Promise<void> {
  try {
    const { institutionId, schemaName, userId } = req.institution!
    res.json({ ok: true, data: await deleteSimplesRate(institutionId, schemaName, userId, req.params.competence) })
  } catch (err) {
    handleError(res, err, 'establishment simples-rates DELETE')
  }
}
