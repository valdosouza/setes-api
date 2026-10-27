import { InstitutionPayload } from '@shared/types/express'
import { catalogOwnerOf } from '@shared/catalog-owner'
import { existsSalesman, readSourceKind } from './session-context.repository'
import { SessionContext } from './session-context.types'

/**
 * Resolução do SessionContext com cache TTL (molde field-config/flag.service
 * — decisão 17): o fato é recalculado no máximo a cada TTL, sem defasar o
 * token de 24h nem obrigar relogin quando o papel muda.
 */

const TTL_MS = Number(process.env.SESSION_CONTEXT_CACHE_TTL_MS ?? 60_000)

interface CacheEntry { expires: number; data: SessionContext }
const cache = new Map<string, CacheEntry>()

function cacheKey(institutionId: number, userId: number): string {
  return `${institutionId}:${userId}`
}

export async function getSessionContext(
  payload: InstitutionPayload
): Promise<SessionContext> {
  const key = cacheKey(payload.institutionId, payload.userId)
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.data

  const isSalesman = await existsSalesman(
    payload.schemaName, payload.institutionId, payload.userId
  )
  // D-PR47: o fato do estabelecimento (hoje = a institution; com @shared/group, a fundadora) — o ato "encerrar a transição" invalida
  // o cache da institution inteira (`invalidateSessionContextForInstitution`); a guarda lê o fato ao vivo, nunca por aqui
  const sourceKind = (await readSourceKind(payload.institutionId)) ?? null
  const data: SessionContext = { isSalesman, sourceKind, catalogOwner: sourceKind ? catalogOwnerOf(sourceKind) : null }
  cache.set(key, { expires: Date.now() + TTL_MS, data })
  return data
}

export function invalidateSessionContext(institutionId: number, userId: number): void {
  cache.delete(cacheKey(institutionId, userId))
}

/** O fato da institution mudou para TODOS os usuários dela (o ato "encerrar a transição" — D-PR48). */
export function invalidateSessionContextForInstitution(institutionId: number): void {
  const prefix = `${institutionId}:`
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k)
}
