import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, PublicSearchCriterion, publicCriteria } from '@shared/list'
import {
  CatalogConfigRow, listCatalogConfigs, validateConfigContent,
  invalidateInterfaceConfigCatalog,
} from '@shared/interface-config'
import {
  interfaceCatalogViolations, assertNoCatalogViolation, CatalogViolation, requiredPairsOf,
  consumedPrivileges, InterfaceCatalogState, CONFIGURE_PRIVILEGE,
} from '@shared/auth/privilege-catalog'
import { catalogUniqueViolated, retryOnDeadlock } from '@shared/auth/catalog-unique'
import { ErrorCodes } from '@shared/errors/error-codes'
import { InterfaceRow, InterfaceInput, InterfaceConfigInput } from './interfaces.interface'
import {
  listInterfaces, getInterface, insertInterface, updateInterface,
  deleteInterface, syncInterfacePrivileges, interfaceIdsWithKey, interfaceHasConfigOrField,
  upsertInterfaceConfig, interfaceConfigExists, softDeleteInterfaceConfig,
  INTERFACE_SEARCH_CRITERIA,
} from './interfaces.repository'

export { INTERFACE_SEARCH_CRITERIA }

/** Critérios da pesquisa avançada servidos ao app (D-BA2) — sem expressão SQL. */
export async function fetchInterfaceSearchCriteria(): Promise<PublicSearchCriterion[]> {
  return publicCriteria(INTERFACE_SEARCH_CRITERIA)
}

export async function fetchInterfaces(query: ListQuery): Promise<PagedRows<InterfaceRow>> {
  return listInterfaces(query)
}

export async function fetchInterface(id: number): Promise<InterfaceRow> {
  const row = await getInterface(id)
  if (!row) throw new HttpError(404, `Interface ${id} não encontrada`)
  return row
}

/**
 * Cria interface com id gerado automaticamente (MAX+1 — sem padrão externo
 * tipo BACEN/IBGE, decisão do Valdo 2026-07-11) e grava os vínculos de
 * privilégio em tb_interface_has_privilege.
 */
export async function createInterface(
  input: InterfaceInput,
  privilegeIds: number[]
): Promise<{ id: number }> {
  const id = await retryOnDeadlock(async () => {   // o 1213 da corrida refaz conferência + gravação (MAX+1 não serializa no MariaDB)
    await assertCatalogKept(null, input, privilegeIds, null)   // D-PV15: a tela nasce com os pares que o código/menu exigem
    try { return await insertInterface(input) } catch (err) { throw keyRaceToHttp(err, input.i18nKey) }
  })
  if (privilegeIds.length > 0) {
    await syncInterfacePrivileges(id, privilegeIds)
  }
  return { id }
}

/** Atualiza os campos (id nunca muda) e sincroniza os vínculos de privilégio. */
export async function editInterface(
  id: number,
  input: InterfaceInput,
  privilegeIds: number[]
): Promise<void> {
  const before = await fetchInterface(id) // garante existência
  await retryOnDeadlock(async () => {
    await assertCatalogKept(before, input, privilegeIds, id)   // D-PV15 (= Q-PV17 (a)) + D-PV42 (a chave não se renomeia)
    try { await updateInterface(id, input) } catch (err) { throw keyRaceToHttp(err, input.i18nKey) }
  })
  await syncInterfacePrivileges(id, privilegeIds)
}

export async function removeInterface(id: number): Promise<void> {
  const before = await fetchInterface(id)
  const consumed = consumedPrivileges()   // D-PV14: a lista à mão ∪ a tabela do roteador (montado antes de qualquer requisição)
  // D-PV15/D-PV42: interface que o código usa não sai. Conhecimento negativo (D-PV45 + script 77, PRIV.E7.P1): o "conserto de DUPLICATA"
  // (deixar sair a linha cuja chave seguia viva e equivalente em OUTRA linha) SAIU do código — o UNIQUE `uq_interface_i18n_key_live`
  // não deixa existir duas vivas com a mesma chave; não o traga de volta.
  assertNoCatalogViolation(interfaceCatalogViolations(await catalogStateOf(before), null, consumed))
  await deleteInterface(id)
}

/**
 * A CORRIDA com outra gravação (a conferência do service veio antes e não viu): o 1062 do UNIQUE da chave (script 77) vira o MESMO 409
 * da chave repetida, nunca 500. Outro erro segue como veio; o 1213 (dois POST simultâneos) é refeito por `retryOnDeadlock`.
 */
function keyRaceToHttp(err: unknown, key: string | null | undefined): unknown {
  if (catalogUniqueViolated(err) !== 'interface-key') return err
  const message = `Já existe outra interface viva com a chave "${key ?? ''}" — a chave tem de ser única (gravada por outra operação agora)`
  return new HttpError(409, message, [{ field: 'i18nKey', message }], ErrorCodes.INTERFACE_KEY_IN_USE)
}

/** O estado da linha para a guarda — com o fato "tem config/campo no catálogo" (REGRA do CONFIGURAR e chave presa — D-PV25/D-PV42). */
async function catalogStateOf(row: InterfaceRow): Promise<InterfaceCatalogState & { id: number }> {
  return { ...row, configurable: await interfaceHasConfigOrField(row.id) }
}

/**
 * D-PV15 (= Q-PV17 (a), Valdo 2026-10-18) + D-PV42 (= Q-PV50 (a), Valdo 2026-10-20): a tela Interfaces recusa (409, nomeando o
 * consumidor) o que recriaria o C1 na hora — tirar do catálogo um par que o código opera ou que uma regra/reserva exige (inclusive o PUT
 * sem `privilegeIds`, que zera os vínculos), trocar a chave de uma interface que JÁ TEM chave (identificador técnico — não se renomeia),
 * a tela sem VISUALIZAR, ou a chave REPETIDA em outra interface viva (a resolução por `i18n_key` pega uma linha só — com duas, o par pode
 * estar numa e o botão olhar a outra). Integridade do catálogo, não autorização: vale também para o super (A-PV14).
 * D-PV63/A-PV28 (script 77): a chave de uma interface EXCLUÍDA também é recusada (409 `INTERFACE_KEY_RETIRED`, nomeando o id) — o banco a
 * aceitaria (o UNIQUE é só das vivas), mas id novo deixaria contratos e concessões no id velho, e reviver traria tudo de volta sem a
 * lista da D-PV64: a volta é por entrega. Esta conferência é a mensagem amigável; o UNIQUE fecha a corrida (`keyRaceToHttp`).
 */
async function assertCatalogKept(
  before: InterfaceRow | null, input: InterfaceInput, privilegeIds: number[], selfId: number | null,
): Promise<void> {
  const consumed = consumedPrivileges()
  const beforeState = before ? await catalogStateOf(before) : null
  const keyChanged = !before || (before.i18nKey ?? '') !== (input.i18nKey ?? '')   // exata — o app procura a rota pela chave exata
  const violations: CatalogViolation[] = interfaceCatalogViolations(beforeState, {
    i18nKey: input.i18nKey, kind: input.kind, groupDefault: input.groupDefault, privilegeIds,
    configurable: beforeState?.configurable ?? false,                 // as configs/campos são da linha (pelo id); na criação, nenhum
  }, consumed)
  // a chave repetida só se confere quando a chave é NOVA nesta linha (a de uma linha existente não se renomeia — D-PV42)
  if (input.i18nKey && keyChanged) {
    const others = (await interfaceIdsWithKey(input.i18nKey)).filter(other => other.id !== selfId)
    const live = others.filter(o => !o.deleted).map(o => o.id)
    const retired = others.filter(o => o.deleted).map(o => o.id)
    if (live.length) {
      violations.push({
        code: 'INTERFACE_KEY_IN_USE', field: 'i18nKey',
        message: `Já existe outra interface viva com a chave "${input.i18nKey}" (id ${live.join(', ')}) — a chave tem de ser única`,
      })
    } else if (retired.length) {
      violations.push({
        code: 'INTERFACE_KEY_RETIRED', field: 'i18nKey',
        message: `A chave "${input.i18nKey}" é da interface EXCLUÍDA (id ${retired.join(', ')}) — a tela não a revive nem a reaproveita; `
          + 'a volta de uma interface excluída é por entrega (A-PV28)',
      })
    }
  }
  assertNoCatalogViolation(violations)
}

// ---------------------------------------------------------------------
// Catálogo de CONFIGURAÇÕES da interface (Framework de Configurações,
// decisões 6 e 7): cadastrado pelo Super na seção "Configurações" da tela
// de Interfaces; o painel do cliente nasce dele sem tela artesanal.
// ---------------------------------------------------------------------

export async function fetchInterfaceConfigs(id: number): Promise<CatalogConfigRow[]> {
  await fetchInterface(id) // garante existência
  return listCatalogConfigs(id)
}

export async function saveInterfaceConfig(
  id: number, name: string, input: InterfaceConfigInput
): Promise<void> {
  await fetchInterface(id)

  if (input.kind === 'Options' && !input.options) {
    throw new HttpError(400, 'Configuração inválida',
      [{ field: 'options', message: 'kind Options exige a lista de opções' }])
  }
  const error = validateConfigContent(input.kind, input.options ?? null, input.defaultContent)
  if (error !== null) {
    throw new HttpError(400, 'Default incompatível com o kind',
      [{ field: 'defaultContent', message: error }])
  }

  await upsertInterfaceConfig(id, name, input)
  invalidateInterfaceConfigCatalog(id)
}

export async function removeInterfaceConfig(id: number, name: string): Promise<{ retiredConfigure: boolean }> {
  const row = await fetchInterface(id)
  if (!(await interfaceConfigExists(id, name))) {
    throw new HttpError(404, 'Configuração não encontrada no catálogo desta interface')
  }
  // D-PV65: a última config leva o CONFIGURAR junto — salvo se ele segue EXIGIDO sem config (código, `general-configs`, reserva): a MESMA
  // peça que diz o que o catálogo não pode perder (`requiredPairsOf`, sem a regra "tem config")
  const stillRequired = requiredPairsOf(row.i18nKey, { screen: false, configurable: false })
    .some(r => r.privilege === CONFIGURE_PRIVILEGE)
  const result = await softDeleteInterfaceConfig(id, name, !stillRequired)
  invalidateInterfaceConfigCatalog(id)
  return result
}
