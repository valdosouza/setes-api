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
  InstitutionInput, InstitutionListRow, InstitutionFull, SyncApiKeyRow,
} from './institutions.interface'
import { hashPassword } from '@shared/auth/password'
import { findLoginEmailOwner, insertUserCascade } from '@shared/user'
import { inviteToInstitution, hasSuperLink } from '@shared/user/invite'
import { notifyInvite } from '@shared/user/invite-notice'
import {
  InstitutionAdminInput,
} from './institutions.interface'
import {
  listInstitutions, getInstitution, schemaNameExists, institutionExists,
  insertInstitutionCascade, updateInstitutionCascade, getInstitutionActivation,
  setInstitutionActive, deleteInstitution, insertDefaultFlags,
  grantStructuralInterfaces,
  getSyncApiKey, insertSyncApiKey, switchSyncApiKeyTx, getInstitutionFact,
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
 *
 * A-UC6 (CONV.E2.P4 — D-UC4/D-UC12/D-UC16): o e-mail do 1º admin que JÁ é
 * login não recebe mais 409 — nenhuma credencial nova, nada da credencial
 * muda (nome e senha do corpo são descartados), e o vínculo `admin` nasce
 * CONVITE pendente (inativo, o Super como convidante); o login do titular é
 * o aceite. A decisão 23 segue: o cliente nasce com o seu admin, aguardando
 * o aceite. O aviso por e-mail sai depois da ativação.
 */
export async function createInstitution(
  input: InstitutionInput, schemaName: string, admin: InstitutionAdminInput,
  updatedBy: number | null = null
): Promise<{ id: number; schemaName: string; active: 'S' | 'N'; adminUserId: number; adminInvite?: 'pending' }> {
  if (await schemaNameExists(schemaName)) {
    throw new HttpError(409, `Schema "${schemaName}" já está em uso`)
  }
  // lido ANTES de qualquer escrita (falhar cedo): sem login, a senha inicial é obrigatória; com login, vira convite (A-UC6)
  const owner = await findLoginEmailOwner(admin.email)
  // D-UC22 (Valdo, 2026-11-14): conta de SUPER não vira 1º admin de cliente pelo onboarding — o mesmo 409 genérico da D-UC17
  if (owner !== null && await hasSuperLink(owner)) {
    throw new HttpError(409, 'E-mail já usado como login de outro usuário',
      [{ field: 'admin.email', message: 'E-mail já usado como login de outro usuário' }])
  }
  if (owner === null && !admin.password) {
    throw new HttpError(400, 'Informe a senha inicial do administrador — o e-mail ainda não é login',
      [{ field: 'admin.password', message: 'Obrigatória para criar a credencial' }], ErrorCodes.VALIDATION_FAILED)
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

  // D-EA9: o hash (scrypt, assíncrono) do admin inicial calculado ANTES da cascata — nunca com conexão do pool presa
  const adminHash = owner === null ? await hashPassword(admin.password!) : null
  let adminUserId: number
  try {
    await grantStructuralInterfaces(schemaName, id)
    if (owner === null) {
      adminUserId = await insertUserCascade(
        { nameCompany: admin.nameCompany, nickTrade: admin.nickTrade,
          email: admin.email, active: 'S' },
        adminHash!,
        { institutionId: id, kind: 'admin', inviterId: updatedBy }
      )
    } else {
      await inviteToInstitution(owner, id, 'admin', updatedBy)
      adminUserId = owner
    }
  } catch (err) {
    logger.error('Onboarding do admin falhou — institution permanece inativa', {
      id, schemaName, err,
    })
    throw new HttpError(500,
      `Estabelecimento ${id} foi provisionado, mas o administrador inicial não pôde ser ` +
      `criado — ele permanece INATIVO (active='N'). Corrija a causa e reative pela edição.`)
  }

  await setInstitutionActive(id, 'S')
  if (owner !== null) {
    notifyInvite(owner, id)
    return { id, schemaName, active: 'S', adminUserId, adminInvite: 'pending' }
  }
  return { id, schemaName, active: 'S', adminUserId }
}

export async function editInstitution(
  id: number, input: InstitutionInput, updatedBy: number | null = null
): Promise<void> {
  if (!(await institutionExists(id))) {
    throw new HttpError(404, `Estabelecimento ${id} não encontrado`)
  }
  // Re-gate socrático da costura A1 (M1): voltar a ATIVO passa pelo MESMO provisionamento do onboarding — as migrations que chegaram
  // com o estabelecimento inativo (a 075, views do veredito: sem ela toda guarda e o menu daquele cliente dariam 500 até o restart).
  // DDL fora da transação e ANTES de gravar: se falhar, nada é gravado e a institution segue 'N'.
  if (input.active === 'S') {
    const state = await getInstitutionActivation(id)
    if (state && state.active !== 'S') {
      try {
        await runMigrationsForSchema(state.schemaName)
      } catch (err) {
        logger.error('Provisionamento na reativação falhou — institution permanece inativa', { id, schemaName: state.schemaName, err })
        throw new HttpError(500,
          `O provisionamento do schema "${state.schemaName}" falhou — o estabelecimento ${id} permanece INATIVO (active='N') e nada ` +
          'foi gravado. Corrija a causa e salve de novo.')
      }
    }
  }
  try {
    // a troca D → W cunha id de categoria padrão: reexecuta a transação INTEIRA em deadlock (o resto da cascade é idempotente)
    const outcome = await withDeadlockRetry('institutions/:id PUT', { institutionId: id }, 3,
      () => updateInstitutionCascade(id, input, updatedBy))
    if (outcome.sourceKindChanged) {
      invalidateSessionContextForInstitution(id)      // o bloco `context` do app passa a dizer o dono novo sem esperar o TTL
      logger.info('Origem dos cadastros TROCADA de ERP Desktop para Web (D-PR73/D-PR75)', {
        institutionId: id, actorUserId: updatedBy, defaultCategories: outcome.defaultCategories,
      })
    }
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
  // D-PR47/D-OI10: a chave só existe para quem tem o ERP Desktop como fonte (D) — W (nativo web, ou trocado de D para W) não tem sincronizador
  if (!sourceKindHasSync(institution.sourceKind)) {
    throw new HttpError(409, 'Estabelecimento nativo web não tem sincronizador — a chave só existe para D (ERP Desktop)',
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
    throw new HttpError(409, 'Estabelecimento nativo web não tem sincronizador — a chave só existe para D (ERP Desktop)',
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
    throw new HttpError(409, 'Estabelecimento nativo web não tem sincronizador para retomar — a chave só existe para D (ERP Desktop)',
      [{ field: 'active', message: `origem dos cadastros: ${outcome.sourceKind}` }], ErrorCodes.SYNC_KEY_NOT_FOR_SOURCE)
  }
  if (outcome.kind === 'switched') {
    logger.info(active === 'N' ? 'Sincronizador PAUSADO (chave inativa)' : 'Sincronizador retomado (chave ativa)',
      { institutionId: id, actorUserId, keys: outcome.keys })
  }
  return (await getSyncApiKey(id))!
}
