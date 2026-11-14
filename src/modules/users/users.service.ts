import logger from '@shared/logger/logger'
import { notifyInvite } from '@shared/user/invite-notice'
import type { UserInstitutionLink as CascadeLink } from '@shared/user'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { isOwnVendorInstitution } from '@shared/institution-interfaces'
import { DELEGABLE_SUPER_INTERFACES, isDelegableSuperInterface } from '@shared/auth/super-delegation'
import { ListQuery, PagedRows, PublicSearchCriterion, SearchCriterion, publicCriteria } from '@shared/list'
import { hashPassword } from '@shared/auth/password'
import { PRIVILEGE_VISUALIZAR } from '@shared/auth/privileges'
import {
  UserListRow, UserRow, UserCreateInput, UserUpdateInput, UserScope,
  UserInstitutionGrant, UserInstitutionLink, UserInterfacePrivileges,
  InstitutionLookupRow,
} from './users.interface'
import {
  listUsers, getUser, findLoginEmailOwner, insertUserCascade,
  updateUserCascade, userExists, userLinkedToInstitution,
  listInstitutionLinks, setInstitutionLinks, inviteToInstitution, withdrawInvite, findInviteNoticeData,
  findInstitutionSchema, listUserPrivileges, setUserPrivileges,
  listInterfaceCatalogPrivilegeIds, findInterfaceKey, listDelegableSuperPrivileges, listActiveUserLinks,
  USER_SEARCH_CRITERIA, listInstitutionLookup,
} from './users.repository'

/**
 * Regra do cadastro de Usuário. Garantias exigidas pelo módulo auth
 * (análise 2026-07-12): email de login ÚNICO no grupo 2, senha MD5
 * aplicada AQUI (@shared/auth/password), id = MAX+1 da tb_entity.
 *
 * INDEPENDÊNCIA de contexto (workflow do Valdo 2026-07-12): o MESMO
 * cadastro serve o Super (aba Usuários do Estabelecimento — alvo explícito)
 * e o admin do cliente (módulo Sistema — alvo FORÇADO para a institution
 * do JWT; ele nunca escolhe nem enxerga outros institutions).
 */

/** Escopo do não-super: sempre a própria institution. */
function scopeInstitution(scope: UserScope, requested: number | null): number | null {
  return scope.isSuper ? requested : scope.institutionId
}

async function assertInScope(scope: UserScope, userId: number): Promise<void> {
  if (scope.isSuper) return
  // 404 (não 403) para não vazar a existência de usuários de outros clientes.
  // D-PV19/D-UC2: o vínculo INATIVO com o próprio estabelecimento ainda é do admin — é exatamente o que ele reativa.
  if (!(await userLinkedToInstitutionAny(userId, scope.institutionId))) {
    throw new HttpError(404, 'Usuário não encontrado')
  }
}

/**
 * Editar a CONTA (login global): gate adversarial da D-PV11 (HIGH, 2026-10-18 — prompt_privilegios_interfaces.md §11.9). O admin
 * da Setes editava a conta do SUPER (senha, exclusão) e, com ela, concedia a si a delegação — furando a D-PV10 ("só o super tem
 * tudo") e a D-PV11 (b). D-PV12 (Valdo, fecha a Q-PV37): trocar senha é ROTINA do admin — ele mexe na conta de todos do próprio
 * estabelecimento, MENOS a do super (vínculo super vivo ou adormecido — re-prova do gate).
 * D-PV19 (Valdo 2026-10-20): a **A-PV13 MORREU** — a conta com vínculo com OUTRO estabelecimento deixa de ser só do Super (o dono
 * da credencial é o TITULAR do e-mail — D-UC3; cada estabelecimento gere o SEU vínculo e os privilégios no SEU schema). Sobra o
 * que a D-PV12 protege: o super. Limite registrado (Q-PV55): até a onda 0 do convidado (D-UC6 — o admin define só a senha INICIAL),
 * o admin de X troca a senha de um login que o Super também vinculou a Y — vínculo cruzado só o Super cria (`saveInstitutionLinks`).
 */
async function assertAccountManageable(scope: UserScope, userId: number): Promise<void> {
  if (scope.isSuper) return
  const links = await listActiveUserLinks(userId)
  // escopo: vínculo (vivo OU inativo — D-UC2: reativar é mexer no vínculo) com o próprio estabelecimento; 404 sem vazar existência
  if (!links.some(l => !l.deleted && l.institutionId === scope.institutionId)) {
    throw new HttpError(404, 'Usuário não encontrado')
  }
  // a conta do super (vínculo super vivo ou adormecido) só o Super altera — D-PV12
  if (links.some(l => l.kind === 'super')) {
    throw new HttpError(403, 'Esta conta tem vínculo de super — só o Super altera', [],
      ErrorCodes.USER_MANAGED_BY_SUPER)
  }
}

export { USER_SEARCH_CRITERIA }

/**
 * Critérios servidos ao app (D-BA2). D-BA24: "instituição" só para o Super. Parecer do
 * guardião (Onda 2): `kind` é atributo de VÍNCULO — sem vínculo em foco (Super sem
 * institutionId) não tem significado e não é servido; a rota recebe o MESMO
 * institutionId da lista (espelho da D-BA15).
 */
export function userSearchCriteriaFor(
  scope: UserScope, institutionId: number | null
): readonly SearchCriterion[] {
  const focus = scopeInstitution(scope, institutionId)
  return USER_SEARCH_CRITERIA.filter(c =>
    !(c.key === 'institution' && !scope.isSuper) && !(c.key === 'kind' && focus === null))
}

/** Gate adversarial (2026-10-03): o catálogo SERVIDO é o catálogo ACEITO — a lista compila
 *  contra a mesma lista branca filtrada; chave não servida = 400 "não existe nesta tela"
 *  (um admin não pesquisa "meus usuários também vinculados à instituição X"). */
export async function fetchUserSearchCriteria(
  scope: UserScope, institutionId: number | null
): Promise<PublicSearchCriterion[]> {
  return publicCriteria(userSearchCriteriaFor(scope, institutionId))
}

/** Lookup do critério "instituição" — só Super (D-BA24); admin recebe 403 explícito. */
export async function fetchInstitutionLookup(
  scope: UserScope, filter: string
): Promise<InstitutionLookupRow[]> {
  if (!scope.isSuper) throw new HttpError(403, 'Pesquisa por instituição é exclusiva do Super')
  return listInstitutionLookup(filter)
}

export async function fetchUsers(
  scope: UserScope, query: ListQuery, institutionId: number | null
): Promise<PagedRows<UserListRow>> {
  return listUsers(query, scopeInstitution(scope, institutionId))
}

/** `institutionId` = o vínculo em FOCO para o "ativo" (D-UC2): o admin tem o alvo forçado ao JWT; o super escolhe (ou nenhum). */
export async function fetchUser(scope: UserScope, id: number, institutionId: number | null = null): Promise<UserRow> {
  await assertInScope(scope, id)
  const user = await getUser(id, scopeInstitution(scope, institutionId))
  if (!user) throw new HttpError(404, 'Usuário não encontrado')
  return user
}

/**
 * Resultado do POST do cadastro. `existingLogin` = o e-mail já era login (D-UC12: a tela diz "utilizando cadastro já existente" e o
 * admin segue no mesmo formulário com os privilégios deste `id`); nada diz ONDE a pessoa tem vínculo nem o NOME dela (A-UC4).
 */
export interface CreateUserResult {
  id: number
  existingLogin?: true
  invite?: 'pending'
}

/**
 * Cadastro (D-UC4 — "o convite é a CRIAÇÃO interceptada"): e-mail sem login = criação de hoje (credencial + vínculo nascido
 * convidado e aceito — D-UC14); e-mail que JÁ é login = nenhuma credencial nova e NADA da credencial muda (nome, senha e ativo do
 * corpo são descartados — A-UC7), só o vínculo PENDENTE no estabelecimento do escopo (`inviteToInstitution`). Quem intercepta
 * vincula como `user` (A-UC3: só quem CRIA escolhe `admin`); o Super, que também passa pelo convite (D-UC16), escolhe o perfil.
 * O Super SEM estabelecimento não tem vínculo a interceptar: e-mail que já é login segue 409 (ficha do CONV.E2.P2, ponto 2).
 */
export async function createUser(
  scope: UserScope, input: UserCreateInput
): Promise<CreateUserResult> {
  const kind = input.kind ?? 'user'
  if (!scope.isSuper && kind === 'super') {
    throw new HttpError(400, 'Perfil não permitido',
      [{ field: 'kind', message: "Perfil 'super' é exclusivo da equipe Setes" }])
  }
  const institutionId = scopeInstitution(scope, input.institutionId ?? null)

  const owner = await findLoginEmailOwner(input.email)
  if (owner !== null) {
    if (institutionId === null) {
      throw new HttpError(409, 'E-mail já usado como login — escolha o estabelecimento para vincular o cadastro existente',
        [{ field: 'email', message: 'E-mail já usado como login' }])
    }
    // D-PV11/D-PV12 (gate adversarial, "criar com o e-mail do Super → 409"): a conta com vínculo de super (vivo ou adormecido) não é
    // interceptada pelo cadastro do cliente — segue a recusa de antes, com a mesma mensagem genérica (nada revela que é do Super)
    if (!scope.isSuper && (await listActiveUserLinks(owner)).some(l => l.kind === 'super')) {
      throw new HttpError(409, 'E-mail já usado como login de outro usuário',
        [{ field: 'email', message: 'E-mail já usado como login de outro usuário' }])
    }
    if (!scope.isSuper && kind !== 'user') {
      throw new HttpError(400, 'Com cadastro já existente o perfil é Usuário',
        [{ field: 'kind', message: 'Só quem cria a credencial escolhe Administrador (A-UC3)' }], ErrorCodes.INVITE_PROFILE_USER_ONLY)
    }
    const outcome = await inviteToInstitution(owner, institutionId, kind, scope.userId)
    if (outcome !== 'already-pending') notifyInvite(owner, institutionId, findInviteNoticeData)
    return { id: owner, existingLogin: true, invite: 'pending' }
  }

  if (!input.password) {
    throw new HttpError(400, 'Informe a senha inicial — o e-mail ainda não é login',
      [{ field: 'password', message: 'Obrigatória para criar a credencial' }], ErrorCodes.VALIDATION_FAILED)
  }
  const link: CascadeLink | null =
    institutionId !== null ? { institutionId, kind, inviterId: scope.userId } : null
  // D-EA9: o hash (scrypt, assíncrono) é calculado ANTES da transação da cascata — nunca com conexão do pool presa
  const id = await insertUserCascade(input, await hashPassword(input.password), link)
  return { id }
}


/**
 * D-PV19 (Valdo 2026-10-20; D-UC1…D-UC3 da frente do usuário convidado): o e-mail de LOGIN é imutável (a credencial é do
 * titular — trocar o e-mail é trocar o dono: 409 LOGIN_EMAIL_IMMUTABLE), a exclusão de usuário SAIU (nem soft delete), e
 * "ativo" é o VÍNCULO `tb_institution_has_user.active` com o estabelecimento alvo (admin = o do JWT; super = `institutionId`
 * do corpo — sem ele, com `active` presente, 400: não há vínculo a inativar).
 */
export async function editUser(
  scope: UserScope, id: number, input: UserUpdateInput
): Promise<void> {
  const current = await getUser(id)
  if (!current) throw new HttpError(404, 'Usuário não encontrado')
  await assertAccountManageable(scope, id)
  if (normalizeEmail(input.email) !== normalizeEmail(current.email ?? '')) {
    throw new HttpError(409, 'O e-mail de login não muda — a credencial é do titular (inative o vínculo e crie outro usuário)',
      [{ field: 'email', message: 'E-mail de login imutável' }], ErrorCodes.LOGIN_EMAIL_IMMUTABLE)
  }
  let linkInstitutionId: number | null = null
  if (input.active !== undefined) {
    linkInstitutionId = scopeInstitution(scope, input.institutionId ?? null)
    if (linkInstitutionId === null) {
      throw new HttpError(400, 'Informe o estabelecimento (institutionId) — "ativo" é do vínculo com o estabelecimento',
        [{ field: 'institutionId', message: 'Obrigatório para o super ao mexer no ativo' }], ErrorCodes.VALIDATION_FAILED)
    }
    if (!(await userLinkedToInstitutionAny(id, linkInstitutionId))) {
      throw new HttpError(400, 'Usuário sem vínculo com este estabelecimento — vincule antes de ativar/inativar',
        [{ field: 'institutionId', message: 'Sem vínculo' }], ErrorCodes.VALIDATION_FAILED)
    }
  }
  // re-gate socrático do P6 (LOW): o admin cujo vínculo é convite NUNCA aceito recebe INVITE_PENDING antes de qualquer outra regra — a
  // recusa da senha, logo abaixo, diria se a credencial tem senha (A-UC4)
  if (!scope.isSuper) {
    const own = (await listActiveUserLinks(id)).find(l => l.institutionId === scope.institutionId && !l.deleted)
    if (own && (own.invite === 'pending' || own.invite === 'withdrawn')) {
      throw new HttpError(409, 'Usuário aguardando aceite — enquanto isso, só retirar o convite', [], ErrorCodes.INVITE_PENDING)
    }
  }
  // D-PV48 (Valdo 2026-10-27): depois de criada a credencial, NINGUÉM troca a senha pelo cadastro — nem o admin, nem o Super — só o
  // titular, pela recuperação (D-PV47). A-PV23 (ratificada 2026-10-31): conta SEM senha (vinda do setes-sync) recebe a 1ª UMA vez — é a
  // criação da credencial. Recusa explícita, nunca ignora em silêncio.
  let hash: string | null = null
  if (input.password) {
    if (current.hasCredential) {
      throw new HttpError(409, 'Depois de criada a credencial, só o próprio usuário troca a senha — pelo "Esqueci minha senha"',
        [{ field: 'password', message: 'Senha definida só na criação da credencial (D-PV48)' }], ErrorCodes.PASSWORD_OWNER_ONLY)
    }
    hash = await hashPassword(input.password)   // D-EA9: antes da transação da cascata
  }
  await assertInviteRules(scope, id, current, input)
  await updateUserCascade(id, input, hash, linkInstitutionId)
}

/**
 * Convite e nome no PUT (setes-api:CONV.E2.P2 — A-UC7, A-UC8, D-UC15):
 *   - o admin cujo vínculo com a pessoa é convite NUNCA aceito não edita a credencial (só retira o convite): 409 INVITE_PENDING;
 *   - ninguém ativa um convite pendente pelo cadastro (só o login do titular — A-UC8): 409 INVITE_PENDING (o CHECK do 75 recusaria);
 *   - o nome é da pessoa: com vínculo ATIVO em outro estabelecimento, só o Super o altera — 409 USER_NAME_MANAGED_BY_SUPER.
 */
async function assertInviteRules(scope: UserScope, id: number, current: UserRow, input: UserUpdateInput): Promise<void> {
  const links = await listActiveUserLinks(id)
  const target = input.active !== undefined ? scopeInstitution(scope, input.institutionId ?? null) : null
  const targetLink = target !== null ? links.find(l => l.institutionId === target && !l.deleted) : undefined
  // A-UC8: vínculo NUNCA aceito — pendente OU retirado — só ativa pelo aceite (o login do titular); nem o Super o ativa pelo cadastro.
  // (Fixture do CONV.E2.P6: o retirado passava, porque o CHECK do 75 só recusa o PENDENTE ativo.)
  if (input.active === 'S' && (targetLink?.invite === 'pending' || targetLink?.invite === 'withdrawn')) {
    throw new HttpError(409, 'Vínculo nunca aceito — só o login do titular o ativa (depois de um novo convite, se foi retirado)', [],
      ErrorCodes.INVITE_PENDING)
  }
  if (scope.isSuper) return
  const own = links.find(l => l.institutionId === scope.institutionId && !l.deleted)
  if (own && (own.invite === 'pending' || own.invite === 'withdrawn')) {
    throw new HttpError(409, 'Usuário aguardando aceite — enquanto isso, só retirar o convite', [], ErrorCodes.INVITE_PENDING)
  }
  const sameName = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim() === (b ?? '').trim()
  const renaming = !sameName(input.nameCompany, current.nameCompany) || !sameName(input.nickTrade, current.nickTrade)
  // A-UC7: quem INTERCEPTA nunca altera o nome; quem CRIOU o corrige enquanto não houver vínculo ativo em outro estabelecimento; depois,
  // só o Super. (Gates do CONV.E2.P6, X1: sem olhar quem criou, o estabelecimento convidado renomeava a pessoa depois que o criador
  // inativava o próprio vínculo.)
  if (renaming && (!own?.creator || links.some(l => l.alive && l.institutionId !== scope.institutionId))) {
    throw new HttpError(409, 'O nome é da pessoa — só quem criou o cadastro o corrige, e só enquanto ele não estiver ativo em outro estabelecimento',
      [{ field: 'nameCompany', message: 'Nome da credencial (A-UC7)' }], ErrorCodes.USER_NAME_MANAGED_BY_SUPER)
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Vínculo EXISTENTE (vivo ou inativo, não excluído) — o alvo do "ativo" pode estar inativo (é exatamente o que se reativa). */
async function userLinkedToInstitutionAny(userId: number, institutionId: number): Promise<boolean> {
  const links = await listActiveUserLinks(userId)
  return links.some(l => l.institutionId === institutionId && !l.deleted)
}

// ---------------------------------------------------------------------
// Vínculos multi-institution: EXCLUSIVOS do Super (o admin do cliente não
// enxerga outros institutions — o vínculo dele é implícito no POST).
// ---------------------------------------------------------------------

function assertSuper(scope: UserScope): void {
  if (!scope.isSuper) {
    throw new HttpError(403, 'Gestão de vínculos multi-institution é exclusiva da equipe Setes')
  }
}

export async function fetchInstitutionLinks(
  scope: UserScope, userId: number
): Promise<UserInstitutionGrant[]> {
  assertSuper(scope)
  if (!(await userExists(userId))) throw new HttpError(404, 'Usuário não encontrado')
  return listInstitutionLinks(userId)
}

export async function saveInstitutionLinks(
  scope: UserScope, userId: number, links: UserInstitutionLink[]
): Promise<void> {
  assertSuper(scope)
  if (!(await userExists(userId))) throw new HttpError(404, 'Usuário não encontrado')
  const invited = await setInstitutionLinks(userId, links, scope.userId)
  for (const institutionId of invited) notifyInvite(userId, institutionId, findInviteNoticeData)
}

/**
 * Retirar o convite ainda não aceito (D-UC15 — `CONV.E2.P2.T4`): o admin retira no PRÓPRIO estabelecimento (alvo forçado ao JWT);
 * o Super informa o estabelecimento. Só convite pendente; senão 409 INVITE_NOT_PENDING (a mesma resposta para usuário de outro
 * cliente — nada se revela).
 */
export async function withdrawUserInvite(
  scope: UserScope, userId: number, institutionId: number | null
): Promise<void> {
  const target = scopeInstitution(scope, institutionId)
  if (target === null) {
    throw new HttpError(400, 'Informe o estabelecimento (institutionId) do convite',
      [{ field: 'institutionId', message: 'Obrigatório para o super' }], ErrorCodes.VALIDATION_FAILED)
  }
  await withdrawInvite(userId, target)
  logger.info('Convite retirado', { userId, institutionId: target, byUserId: scope.userId })
}

// ---------------------------------------------------------------------
// Privilégios de acesso (workflow ACL 2026-07-12): definidos POR
// INSTITUTION (tb_user_has_privilege vive no schema do cliente).
// Perfis: super/admin operam sem ACL (menu por perfil); o REGULAR só
// enxerga (VISUALIZAR) e opera o que for concedido aqui.
// ---------------------------------------------------------------------

interface PrivilegeTarget { institutionId: number; schemaName: string }

/** Alvo: super escolhe o institution; admin é FORÇADO ao do JWT. */
async function resolvePrivilegeTarget(
  scope: UserScope, requested: number | null
): Promise<PrivilegeTarget> {
  if (!scope.isSuper) {
    return { institutionId: scope.institutionId, schemaName: scope.schemaName }
  }
  if (requested === null) {
    throw new HttpError(400, 'Informe o estabelecimento (institutionId)',
      [{ field: 'institutionId', message: 'Obrigatório para o super' }])
  }
  const schemaName = await findInstitutionSchema(requested)
  if (schemaName === null) throw new HttpError(404, 'Estabelecimento não encontrado')
  return { institutionId: requested, schemaName }
}

async function assertUserLinkedTo(
  userId: number, target: PrivilegeTarget
): Promise<void> {
  if (!(await userLinkedToInstitution(userId, target.institutionId))) {
    throw new HttpError(400,
      'Usuário sem vínculo ativo com este estabelecimento — vincule antes de definir privilégios')
  }
}

/**
 * D-PV5 (Valdo 2026-10-18 — prompt_privilegios_interfaces.md): telas do PERFIL admin — `users` (quem tem a tela concede
 * privilégio a si mesmo: escalada) e `establishment` (regime e configuração fiscal — D41 "só Admin"). Seguem no
 * `adminGuard`; o catálogo delas (A-PV4) serve só aos botões do admin/super — o cadastro de privilégios NUNCA as oferece.
 */
export const ADMIN_PROFILE_INTERFACE_KEYS: readonly string[] = ['users', 'establishment']

export async function fetchUserPrivileges(
  scope: UserScope, userId: number, institutionId: number | null
): Promise<UserInterfacePrivileges[]> {
  if (!(await userExists(userId))) throw new HttpError(404, 'Usuário não encontrado')
  const target = await resolvePrivilegeTarget(scope, institutionId)
  await assertUserLinkedTo(userId, target)
  const rows = await listUserPrivileges(target.schemaName, target.institutionId, userId,
    [...ADMIN_PROFILE_INTERFACE_KEYS, ...DELEGABLE_SUPER_INTERFACES])
  // D-PV11 (b): a tela do Super delegável só aparece quando quem edita é o SUPER e o usuário é da Setes (D-PV37: predicado único)
  if (!scope.isSuper || !isOwnVendorInstitution(target.institutionId)) return rows
  return rows.concat(await listDelegableSuperPrivileges(target.schemaName, target.institutionId, userId, DELEGABLE_SUPER_INTERFACES))
}

export async function saveUserPrivileges(
  scope: UserScope, userId: number, interfaceId: number,
  privilegeIds: number[], institutionId: number | null
): Promise<void> {
  if (!(await userExists(userId))) throw new HttpError(404, 'Usuário não encontrado')
  const target = await resolvePrivilegeTarget(scope, institutionId)
  await assertUserLinkedTo(userId, target)

  // Interface inexistente ou EXCLUÍDA do catálogo não se concede (falha fechado — gate socrático da D-PV11: soft-deletar a tela
  // delegável não pode abrir a trava abaixo)
  const found = await findInterfaceKey(interfaceId)
  if (!found || found.deleted) {
    throw new HttpError(400, 'Interface inexistente ou excluída do catálogo',
      [{ field: 'privilegeIds', message: `Interface ${interfaceId} fora do catálogo` }], ErrorCodes.VALIDATION_FAILED)
  }
  const key = found.key
  // D-PV5: as telas do perfil admin (Usuários, Meu Estabelecimento) não se concedem — nem a listagem as mostra.
  if (key !== null && ADMIN_PROFILE_INTERFACE_KEYS.includes(key)) {
    throw new HttpError(400, 'Esta tela é do perfil administrador — não se concede por privilégio',
      [{ field: 'privilegeIds', message: `A tela ${key} segue o perfil admin (não tem privilégio por usuário)` }],
      ErrorCodes.PRIVILEGE_ADMIN_PROFILE)
  }

  // D-PV11 (b)/(c): tela do Super delegável — SÓ o Super libera, e só para usuário da Setes (o admin nunca concede, nem a si)
  if (isDelegableSuperInterface(key) && (!scope.isSuper || !isOwnVendorInstitution(target.institutionId))) {
    throw new HttpError(403, 'Esta tela do Super só o Super libera, e só para usuário da Setes',
      [{ field: 'privilegeIds', message: `A tela ${key} é delegável só pelo Super` }], ErrorCodes.SUPER_DELEGATION_SUPER_ONLY)
  }

  // Só privilégios DEFINIDOS no catálogo da interface (tb_interface_has_privilege).
  const catalog = new Set(await listInterfaceCatalogPrivilegeIds(interfaceId))
  const invalid = privilegeIds.filter(id => !catalog.has(id))
  if (invalid.length > 0) {
    throw new HttpError(400, 'Privilégio não definido para esta interface',
      [{ field: 'privilegeIds', message: `Fora do catálogo da interface: ${invalid.join(', ')}` }])
  }

  // D-PV57/D-PV58 (Valdo 2026-10-31, "Todos"): todo verbo escolhido para o usuário numa interface leva o VISUALIZAR da MESMA interface —
  // inclusive o CONFIGURAR. A lista gravada é a autoridade (D-PV59: lista vazia = sem a tela). D-PV60: só na ESCRITA — nenhuma concessão
  // antiga é corrigida por script; corrige quando o admin salvar de novo esta tela deste usuário.
  const granted = withVisualizar(privilegeIds, catalog)
  await setUserPrivileges(target.schemaName, target.institutionId, userId, interfaceId, granted)
}

/** D-PV58: lista com qualquer verbo e sem o VISUALIZAR → o VISUALIZAR entra (quando o catálogo da interface o tem — D-PV51). */
export function withVisualizar(privilegeIds: readonly number[], catalog: ReadonlySet<number>): number[] {
  const ids = [...new Set(privilegeIds)]
  if (ids.length > 0 && !ids.includes(PRIVILEGE_VISUALIZAR) && catalog.has(PRIVILEGE_VISUALIZAR)) ids.push(PRIVILEGE_VISUALIZAR)
  return ids
}
