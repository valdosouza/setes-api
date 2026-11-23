import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { ListQuery, PagedRows, PublicSearchCriterion, publicCriteria } from '@shared/list'
import { privilegeCatalogViolations, assertNoCatalogViolation, CatalogViolation } from '@shared/auth/privilege-catalog'
import { catalogUniqueViolated, retryOnDeadlock } from '@shared/auth/catalog-unique'
import { PrivilegeRow } from './privileges.interface'
import {
  listPrivileges, getPrivilege, insertPrivilege, updatePrivilege, deletePrivilege, privilegeIdsWithName,
  PRIVILEGE_SEARCH_CRITERIA,
} from './privileges.repository'

export { PRIVILEGE_SEARCH_CRITERIA }

/** Critérios da pesquisa avançada servidos ao app (D-BA2) — sem expressão SQL. */
export async function fetchPrivilegeSearchCriteria(): Promise<PublicSearchCriterion[]> {
  return publicCriteria(PRIVILEGE_SEARCH_CRITERIA)
}

export async function fetchPrivileges(query: ListQuery): Promise<PagedRows<PrivilegeRow>> {
  return listPrivileges(query)
}

export async function fetchPrivilege(id: number): Promise<PrivilegeRow> {
  const row = await getPrivilege(id)
  if (!row) throw new HttpError(404, `Privilégio ${id} não encontrado`)
  return row
}

/**
 * Cria privilégio com id gerado automaticamente (MAX+1 — sem padrão externo
 * tipo BACEN/IBGE, mesma decisão do cadastro de Interfaces — Valdo, 2026-07-11).
 */
export async function createPrivilege(description: string): Promise<{ id: number }> {
  assertNoCatalogViolation(privilegeCatalogViolations(null, description))   // D-PV15: nome consumido não se repete
  return retryOnDeadlock(async () => {                                      // o 1213 da corrida refaz conferência + gravação
    await assertNameFree(null, description)                                 // D-PV63: nem nome de outra linha, viva ou excluída
    try { return { id: await insertPrivilege(description) } } catch (err) { throw nameRaceToHttp(err, description) }
  })
}

/** Atualiza a description (o id nunca muda). */
export async function editPrivilege(id: number, description: string): Promise<void> {
  await fetchPrivilege(id) // garante existência
  // D-PV15 (= Q-PV17 (a)): o app compara o privilégio pelo NOME — renomear um consumido esconde o botão de todos
  assertNoCatalogViolation(privilegeCatalogViolations(id, description))
  await retryOnDeadlock(async () => {
    await assertNameFree(id, description)
    try { await updatePrivilege(id, description) } catch (err) { throw nameRaceToHttp(err, description) }
  })
}

export async function removePrivilege(id: number): Promise<void> {
  await fetchPrivilege(id)
  assertNoCatalogViolation(privilegeCatalogViolations(id, null))   // D-PV15: privilégio consumido não sai
  await deletePrivilege(id)
}

/**
 * D-PV63/A-PV28 (script 77): o nome do verbo é ÚNICO em TODAS as linhas — nome e id 1:1 para sempre (seeds por id fixo; app e view pelo
 * nome exato). Outra linha VIVA com o nome → 409 `PRIVILEGE_NAME_TAKEN`; só uma EXCLUÍDA → 409 `PRIVILEGE_NAME_RETIRED`, nomeando o id: a
 * tela NUNCA revive (as views reativariam de uma vez os pares e as concessões presos ao id, sem a lista da D-PV64) — a volta é por entrega.
 * É a mensagem amigável; o UNIQUE `uq_privilege_description` fecha a corrida (`nameRaceToHttp`).
 */
async function assertNameFree(selfId: number | null, description: string): Promise<void> {
  const others = (await privilegeIdsWithName(description)).filter(o => o.id !== selfId)
  const live = others.filter(o => !o.deleted).map(o => o.id)
  const retired = others.filter(o => o.deleted).map(o => o.id)
  const violations: CatalogViolation[] = []
  if (live.length) {
    violations.push({
      code: 'PRIVILEGE_NAME_TAKEN', field: 'description',
      message: `Já existe o privilégio "${description}" (id ${live.join(', ')}) — o nome do verbo é único (sem distinção de maiúsculas)`,
    })
  } else if (retired.length) {
    violations.push({
      code: 'PRIVILEGE_NAME_RETIRED', field: 'description',
      message: `"${description}" é o nome do privilégio EXCLUÍDO (id ${retired.join(', ')}) — a tela não o revive nem cria outro com o `
        + 'mesmo nome; a volta de um verbo excluído é por entrega (A-PV28)',
    })
  }
  assertNoCatalogViolation(violations)
}

/**
 * A CORRIDA (a conferência veio antes e não viu): o 1062 do UNIQUE do nome vira o 409 do nome repetido, nunca 500. O 1213 (dois POST
 * simultâneos — o MAX+1 não serializa no MariaDB) não passa por aqui: `retryOnDeadlock` refaz a conferência e a gravação.
 */
function nameRaceToHttp(err: unknown, description: string): unknown {
  if (catalogUniqueViolated(err) !== 'privilege-name') return err
  const message = `Já existe o privilégio "${description}" — o nome do verbo é único (gravado por outra operação agora)`
  return new HttpError(409, message, [{ field: 'description', message }], ErrorCodes.PRIVILEGE_NAME_TAKEN)
}
