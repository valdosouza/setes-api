import crypto from 'crypto'
import { ErrorCodes } from '@shared/errors/error-codes'
import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, PublicSearchCriterion, publicCriteria } from '@shared/list'
import logger from '@shared/logger/logger'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { sourceKindHasSync } from '@shared/catalog-owner'
import { invalidateSessionContextForInstitution } from '@shared/session-context'
import { runMigrationsForSchema } from '../../migrations/runner'
import {
  InstitutionInput, InstitutionListRow, InstitutionFull, SyncApiKeyRow, LegacyTransitionResult,
} from './institutions.interface'
import { md5Password } from '@shared/auth/password'
import { findLoginEmailOwner, insertUserCascade } from '@shared/user'
import {
  InstitutionAdminInput,
} from './institutions.interface'
import {
  listInstitutions, getInstitution, schemaNameExists, institutionExists,
  insertInstitutionCascade, updateInstitutionCascade,
  setInstitutionActive, deleteInstitution, insertDefaultFlags,
  grantStructuralInterfaces,
  getSyncApiKey, insertSyncApiKey, switchSyncApiKeyTx, endLegacyTransitionTx, getInstitutionFact,
  INSTITUTION_SEARCH_CRITERIA,
} from './institutions.repository'

export { INSTITUTION_SEARCH_CRITERIA }

/** Critérios da pesquisa avançada servidos ao app (D-BA2) — sem expressão SQL. */
export async function fetchInstitutionSearchCriteria(): Promise<PublicSearchCriterion[]> {
  return publicCriteria(INSTITUTION_SEARCH_CRITERIA)
}

export async function fetchInstitutions(query: ListQuery): Promise<PagedRows<InstitutionListRow>> {
  return listInstitutions(query)
}

export async function fetchInstitution(id: number): Promise<InstitutionFull> {
  const row = await getInstitution(id)
  if (!row) throw new HttpError(404, `Estabelecimento ${id} não encontrado`)
  return row
}

/** CPF/CNPJ/schema_name são UNIQUE — corrida no INSERT vira 409 legível. */
function dupEntryTo409(err: any): never {
  if (err?.code === 'ER_DUP_ENTRY') {
    throw new HttpError(409, 'Já existe um cadastro com este CPF, CNPJ ou schema')
  }
  throw err
}

/**
 * POST absorve o onboarding (decisão do Valdo, 2026-07-11 — o antigo
 * POST /api/admin/institutions foi aposentado):
 * 1. e-mail do admin livre ANTES de qualquer escrita (falhar cedo: a
 *    institution não pode nascer órfã por causa de um 409 de login);
 * 2. cadeia inteira em transação única (institution nasce active='N');
 * 3. feature flags padrão (gate técnico — decisão 17);
 * 4. APÓS o commit, provisiona o schema (runMigrationsForSchema) — DDL não
 *    tem rollback, então NUNCA dentro da transação;
 * 5. contrato das telas ESTRUTURAIS (A2 — a tabela vive no schema recém
 *    provisionado) e o PRIMEIRO ADMIN do cliente;
 * 6. só então marca active='S'. Se qualquer passo pós-commit falhar, a
 *    institution permanece active='N' e o erro volta ao app.
 *
 * O admin é OBRIGATÓRIO (decisão do Valdo, 2026-08-15 — A2): cliente nunca
 * existe sem dono. Antes disso o Super tinha de lembrar de criá-lo na aba
 * Usuários, e um cliente ativo sem nenhum usuário era estado alcançável.
 */
export async function createInstitution(
  input: InstitutionInput, schemaName: string, admin: InstitutionAdminInput,
  updatedBy: number | null = null
): Promise<{ id: number; schemaName: string; active: 'S' | 'N'; adminUserId: number }> {
  if (await schemaNameExists(schemaName)) {
    throw new HttpError(409, `Schema "${schemaName}" já está em uso`)
  }
  if (await findLoginEmailOwner(admin.email) !== null) {
    throw new HttpError(409, 'E-mail já usado como login de outro usuário',
      [{ field: 'admin.email', message: 'E-mail já usado como login de outro usuário' }])
  }

  let id: number
  try {
    id = await insertInstitutionCascade(input, schemaName, updatedBy)
  } catch (err) {
    dupEntryTo409(err)
  }

  await insertDefaultFlags(id)

  try {
    await runMigrationsForSchema(schemaName)
  } catch (err) {
    logger.error('Provisionamento do schema falhou — institution permanece inativa', {
      id, schemaName, err,
    })
    throw new HttpError(500,
      `Estabelecimento ${id} foi criado, mas o provisionamento do schema "${schemaName}" ` +
      `falhou — ele permanece INATIVO (active='N'). Corrija a causa e reative pela edição.`)
  }

  let adminUserId: number
  try {
    await grantStructuralInterfaces(schemaName, id)
    adminUserId = await insertUserCascade(
      { nameCompany: admin.nameCompany, nickTrade: admin.nickTrade,
        email: admin.email, active: 'S' },
      md5Password(admin.password),
      { institutionId: id, kind: 'admin' }
    )
  } catch (err) {
    logger.error('Onboarding do admin falhou — institution permanece inativa', {
      id, schemaName, err,
    })
    throw new HttpError(500,
      `Estabelecimento ${id} foi provisionado, mas o administrador inicial não pôde ser ` +
      `criado — ele permanece INATIVO (active='N'). Corrija a causa e reative pela edição.`)
  }

  await setInstitutionActive(id, 'S')
  return { id, schemaName, active: 'S', adminUserId }
}

export async function editInstitution(
  id: number, input: InstitutionInput, updatedBy: number | null = null
): Promise<void> {
  if (!(await institutionExists(id))) {
    throw new HttpError(404, `Estabelecimento ${id} não encontrado`)
  }
  try {
    await updateInstitutionCascade(id, input, updatedBy)
  } catch (err) {
    dupEntryTo409(err)
  }
}

export async function removeInstitution(id: number): Promise<void> {
  if (!(await institutionExists(id))) {
    throw new HttpError(404, `Estabelecimento ${id} não encontrado`)
  }
  await deleteInstitution(id)
}

// ---------------------------------------------------------------------
// Chave de sincronização (tb_sync_api_key — D12: uma chave por
// estabelecimento, a MESMA em todos os terminais dele; o Sincronizador a
// envia no header X-Api-Key e a setes-sync resolve institution + schema)
// ---------------------------------------------------------------------

export async function fetchSyncApiKey(id: number): Promise<SyncApiKeyRow | null> {
  if (!(await institutionExists(id))) {
    throw new HttpError(404, `Estabelecimento ${id} não encontrado`)
  }
  return getSyncApiKey(id)
}

/**
 * Gera a chave quando NÃO existe (crypto, 48 hex). Regenerar de propósito
 * não tem endpoint: trocaria a chave de uma instalação em produção —
 * intervenção manual consciente no banco se um dia for preciso.
 */
export async function generateSyncApiKey(id: number): Promise<SyncApiKeyRow> {
  const institution = await getInstitutionFact(id)
  if (!institution) {
    throw new HttpError(404, `Estabelecimento ${id} não encontrado`)
  }
  // D-PR47: a chave só existe para quem TEM fonte externa (L ou P) — W (nativo web, ou L encerrado para W) não tem sincronizador
  if (!sourceKindHasSync(institution.sourceKind)) {
    throw new HttpError(409, 'Estabelecimento nativo web não tem sincronizador — a chave só existe para L e P',
      [{ field: 'apiKey', message: `origem dos cadastros: ${institution.sourceKind}` }], ErrorCodes.SYNC_KEY_NOT_FOR_SOURCE)
  }
  const existing = await getSyncApiKey(id)
  if (existing) {
    throw new HttpError(409,
      'Este estabelecimento já possui uma chave de sincronização',
      [{ field: 'apiKey', message: 'chave já gerada — trocar exige intervenção manual' }])
  }
  const apiKey = crypto.randomBytes(24).toString('hex')
  const establishmentCode = institution.schemaName.toUpperCase()
  // as conferências acima são a resposta rápida; as que DECIDEM repetem DENTRO da transação (ADV-R7-03: o ato pode comitar no meio)
  const outcome = await insertSyncApiKey(id, apiKey, establishmentCode)
  if (outcome.kind === 'missing') throw new HttpError(404, `Estabelecimento ${id} não encontrado`)
  if (outcome.kind === 'not-for-source') {
    throw new HttpError(409, 'Estabelecimento nativo web não tem sincronizador — a chave só existe para L e P',
      [{ field: 'apiKey', message: `origem dos cadastros: ${outcome.sourceKind}` }], ErrorCodes.SYNC_KEY_NOT_FOR_SOURCE)
  }
  if (outcome.kind === 'exists') {
    throw new HttpError(409,
      'Este estabelecimento já possui uma chave de sincronização',
      [{ field: 'apiKey', message: 'chave já gerada — trocar exige intervenção manual' }])
  }
  logger.info('Chave de sincronização gerada', { institutionId: id, establishmentCode })
  return { apiKey, establishmentCode, active: 'S' }
}

/**
 * Interruptor da chave (D-PR43; Rodada 7 — D-PR48 item 1): só PAUSA de emergência, reversível. Com a chave pausada o setes-sync recusa o
 * envio (D-SY13 — em até 5 min, pelo cache dele; o sincronizador fica INATIVO até "Ativar sincronia"). O dono do catálogo NÃO muda: é o
 * fato `source_kind` (D-PR47). Repetir o estado atual não muda nada. Nunca apaga (PADROES §3.1); o ato fica no log com o autor.
 */
export async function switchSyncApiKey(id: number, active: 'S' | 'N', actorUserId: number | null): Promise<SyncApiKeyRow> {
  if (!(await institutionExists(id))) throw new HttpError(404, `Estabelecimento ${id} não encontrado`)
  const outcome = await switchSyncApiKeyTx(id, active)
  if (outcome.kind === 'missing') {
    throw new HttpError(404, 'Este estabelecimento não tem chave de sincronização', [{ field: 'active', message: 'sem chave gerada' }],
      ErrorCodes.SYNC_KEY_MISSING)
  }
  if (outcome.kind === 'not-for-source') {
    throw new HttpError(409, 'Estabelecimento nativo web não tem sincronizador para retomar — a chave só existe para L e P',
      [{ field: 'active', message: `origem dos cadastros: ${outcome.sourceKind}` }], ErrorCodes.SYNC_KEY_NOT_FOR_SOURCE)
  }
  if (outcome.kind === 'switched') {
    logger.info(active === 'N' ? 'Sincronizador PAUSADO (chave inativa)' : 'Sincronizador retomado (chave ativa)',
      { institutionId: id, actorUserId, keys: outcome.keys })
  }
  return (await getSyncApiKey(id))!
}

/**
 * ENCERRAR A TRANSIÇÃO do desktop legado (D-PR48/D-PR49 — ato ÚNICO e IRREVERSÍVEL do Super, tela Institutions): L → W (cliente sem
 * PDV) ou L → P (cliente com PDV — os PDVs passam a receber o catálogo da web). Grava `transition_ended_at`, muda o fato, cria as
 * categorias padrão que faltarem e, no destino W, inativa a chave do sincronizador em definitivo; no destino P a chave fica (é a dos
 * PDVs — A-PR4/Q-PR60) e o servidor desktop passa a ser recusado pelo FATO no setes-sync (`SYNC_TRANSITION_ENDED` — contrato com o grupo
 * do sync). O motivo e o autor vão ao log (Q-PR48 (a); coluna própria = Q-PR59). Reexecuta em deadlock (cunha id de categoria).
 */
/**
 * BARREIRA INTERINA (A-PR5 — gate socrático da Rodada 7; questão Q-PR62 ao Valdo): o destino P deixa a chave viva para os PDVs (A-PR4) e
 * conta com o setes-sync RECUSAR o servidor desktop pelo FATO (`SYNC_TRANSITION_ENDED`) — contrato que ainda não existe. Até lá, L → P
 * abriria DOIS escritores no catálogo (o desktop pela chave viva + a web, agora dona) — exatamente o que a guarda existe para impedir; e o
 * ato é irreversível. Destino W já vale (a chave fica inativa e o setes-sync a recusa pela pausa). Liberar P = tirar daqui quando o contrato
 * for honrado (ou decisão do Valdo em contrário).
 */
export const OPEN_TRANSITION_DESTINATIONS: ReadonlySet<'W' | 'P'> = new Set<'W' | 'P'>(['W'])

export async function endLegacyTransition(
  id: number, destination: 'W' | 'P', reason: string, actorUserId: number | null
): Promise<LegacyTransitionResult> {
  if (!OPEN_TRANSITION_DESTINATIONS.has(destination)) {
    throw new HttpError(409,
      `Destino ${destination} ainda não disponível: o sincronizador precisa honrar o fato da origem dos cadastros antes (contrato SYNC_TRANSITION_ENDED) — por enquanto só W`,
      [{ field: 'destination', message: `destinos abertos: ${[...OPEN_TRANSITION_DESTINATIONS].join(', ')}` }],
      ErrorCodes.LEGACY_TRANSITION_DESTINATION_PENDING)
  }
  const outcome = await withDeadlockRetry('institutions end-legacy-transition POST', { institutionId: id }, 3,
    () => endLegacyTransitionTx(id, destination))
  if (outcome.kind === 'missing') throw new HttpError(404, `Estabelecimento ${id} não encontrado`)
  if (outcome.kind === 'not-applicable') {
    // o instante não vai na prosa (PADROES §10: instante na zona é da fronteira do app) — vai tipado em fields[]
    const fields = [{ field: 'destination', message: `origem atual: ${outcome.sourceKind}` }]
    if (outcome.transitionEndedAt) fields.push({ field: 'transitionEndedAt', message: outcome.transitionEndedAt })
    throw new HttpError(409,
      outcome.transitionEndedAt
        ? `A transição deste estabelecimento já foi encerrada (origem atual: ${outcome.sourceKind}) — o ato é único`
        : `Encerrar a transição só vale para estabelecimento em transição do legado (origem atual: ${outcome.sourceKind})`,
      fields, ErrorCodes.LEGACY_TRANSITION_NOT_APPLICABLE)
  }
  invalidateSessionContextForInstitution(id)      // o bloco `context` do app passa a dizer o dono novo sem esperar o TTL
  const fact = (await getInstitutionFact(id))!
  logger.info('Transição do legado ENCERRADA', {
    institutionId: id, schemaName: outcome.schemaName, destination, reason, actorUserId,
    transitionEndedAt: fact.transitionEndedAt, defaultCategories: outcome.defaultCategories,
    syncKeysInactivated: outcome.syncKeysInactivated,
  })
  return {
    sourceKind: fact.sourceKind, transitionEndedAt: fact.transitionEndedAt,
    defaultCategories: outcome.defaultCategories, syncKeysInactivated: outcome.syncKeysInactivated,
  }
}
