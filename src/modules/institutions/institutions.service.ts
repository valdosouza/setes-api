import crypto from 'crypto'
import { ErrorCodes } from '@shared/errors/error-codes'
import { HttpError } from '@shared/errors/http-error'
import { ListQuery, PagedRows, PublicSearchCriterion, publicCriteria } from '@shared/list'
import logger from '@shared/logger/logger'
import { WebBornRows } from '@shared/sync-key'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { runMigrationsForSchema } from '../../migrations/runner'
import {
  InstitutionInput, InstitutionListRow, InstitutionFull, SyncApiKeyRow,
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
  getSyncApiKey, insertSyncApiKey, switchSyncApiKeyTx, getInstitutionSchema,
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
  const institution = await getInstitution(id)
  if (!institution) {
    throw new HttpError(404, `Estabelecimento ${id} não encontrado`)
  }
  const existing = await getSyncApiKey(id)
  if (existing) {
    throw new HttpError(409,
      'Este estabelecimento já possui uma chave de sincronização',
      [{ field: 'apiKey', message: 'chave já gerada — trocar exige intervenção manual' }])
  }
  const apiKey = crypto.randomBytes(24).toString('hex')
  const establishmentCode = institution.schemaName.toUpperCase()
  await insertSyncApiKey(id, apiKey, establishmentCode)
  logger.info('Chave de sincronização gerada', { institutionId: id, establishmentCode })
  return { apiKey, establishmentCode, active: 'S' }
}

/** Frase do aviso ao desligar (Q-PR46 (a), Rodada 6 de produtos — procedimento: parar o sincronizador ANTES). */
export const SYNC_OFF_NOTICE =
  'Pare o sincronizador do cliente ANTES de desligar a chave: o setes-sync aceita a chave por até 5 min (cache) e o que ele gravar '
  + 'nesse intervalo pode contar como nascido na web — e impedir religar.'

const WEB_BORN_LABEL: Record<WebBornRows['table'], string> = {
  tb_product: 'produto(s)/serviço(s)', tb_price_list: 'tabela(s) de preço', tb_category: 'categoria(s)',
}

/**
 * D-PR43 (Valdo 2026-10-18): a opção de DESATIVAR o sincronizador do estabelecimento — o caminho de saída do legado. Com a chave
 * desligada o setes-sync recusa o envio (401 — em até 5 min, pelo cache dele) e a guarda da D-PR32 libera NA HORA a escrita dos
 * cadastros na web. Rodada 6 de produtos:
 *  - desligar devolve o AVISO do procedimento (Q-PR46 (a)) e cria "Serviços" se o estabelecimento não tem categoria S viva (Q-PR49 (a));
 *  - religar devolve a MESMA chave, mas é RECUSADO (409 SYNC_KEY_WEB_ROWS) quando nasceu produto/serviço, tabela de preço ou categoria
 *    na web desde o desligamento — o legado as sobrescreveria sem aviso (Q-PR47 (a)); o que o legado tentou enviar no período ficou
 *    ESTACIONADO no sincronizador (D-SY13 do grupo do sync).
 * Repetir o estado atual não muda nada. Nunca apaga (PADROES §3.1); o ato fica no log com o autor (Q-PR48 (a)).
 */
export async function switchSyncApiKey(
  id: number, active: 'S' | 'N', actorUserId: number | null
): Promise<SyncApiKeyRow & { notice?: string; defaultServiceCategoryId?: number | null }> {
  const schemaName = await getInstitutionSchema(id)
  if (!schemaName) throw new HttpError(404, `Estabelecimento ${id} não encontrado`)
  // cunha id de categoria por MAX+1 (o "Serviços" do desligar) — reexecuta em deadlock como os outros cunhadores (D-PR2); o ato é idempotente
  const outcome = await withDeadlockRetry('institutions sync-api-key/active PUT', { institutionId: id }, 3,
    () => switchSyncApiKeyTx(id, schemaName, active))
  if (outcome.kind === 'missing') {
    throw new HttpError(404, 'Este estabelecimento não tem chave de sincronização', [{ field: 'active', message: 'sem chave gerada' }],
      ErrorCodes.SYNC_KEY_MISSING)
  }
  if (outcome.kind === 'web-rows') {
    const summary = outcome.rows
      .map(r => `${r.count} ${WEB_BORN_LABEL[r.table]} (id ${r.ids.join(', ')}${r.count > r.ids.length ? ', …' : ''})`)
      .join('; ')
    logger.warn('Religar o sincronizador RECUSADO — nasceram linhas na web desde o desligamento', {
      institutionId: id, actorUserId, since: outcome.since.toISOString(),
      rows: outcome.rows.map(r => ({ table: r.table, count: r.count })),
    })
    throw new HttpError(409,
      `Não dá para religar o sincronizador: desde o desligamento nasceram na web ${summary} — o legado os sobrescreveria sem aviso`,
      [{ field: 'active', message: summary }], ErrorCodes.SYNC_KEY_WEB_ROWS)
  }
  if (outcome.kind === 'switched') {
    logger.info(active === 'N' ? 'Sincronizador DESATIVADO' : 'Sincronizador reativado', { institutionId: id, actorUserId })
  }
  const row = (await getSyncApiKey(id))!
  if (active === 'S') return row
  return {
    ...row, notice: SYNC_OFF_NOTICE,
    defaultServiceCategoryId: outcome.kind === 'switched' ? outcome.defaultServiceCategoryId : null,
  }
}
