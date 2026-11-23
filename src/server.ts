import app from './app'
import logger from '@shared/logger/logger'
import {
  assertIsolationLevel, assertRollbackOnTimeoutOff, assertSessionTimeZoneUtc, assertCheckConstraintsEnforced,
} from '@shared/db/connection'
import { detectLockWaitSupport } from '@shared/db/counters'
import { assertIbscbsCatalogSchema } from '@shared/ibscbs-classification'
import { assertIbscbsAssessmentChecks } from '@shared/ibscbs-assessment'
import { assertJwtKeys } from '@shared/auth/product-token'
import { assertPasswordResetReady, assertLoginLockReady } from '@modules/auth/auth.service'
import { assertMailerReady, assertOpsAlertReady, nodeEnvWarning } from '@shared/mailer/mailer'
import { assertPasswordPolicyReady } from '@shared/auth/password-policy'
import { assertFiscalVoiceReadable } from '@shared/fiscal-voice'
import { awaitingFamiliesBootNote } from '@shared/invoice/invoice-fiscal-effect'
import { assertInstitutionSourceKindSchema } from '@shared/catalog-owner'
import pool from '@shared/db/connection'
import { runMigrationsForAllInstitutions } from './migrations/runner'
import { assertF2aFreezeTriggers } from './migrations/f2a-freeze-triggers'
import { assertPrivilegeCatalog } from '@shared/auth/assert-privilege-catalog'
import { assertCatalogUniqueNames } from '@shared/auth/catalog-unique'
import { assertAccessViews, assertAccessSchemaViews } from '@shared/access'
import { assertInviteSchema, assertPasswordAuthorSchema } from '@shared/user/invite'
import { grantStructuralInterfacesToActive } from '@shared/institution-interfaces'
import { SETES_INSTITUTION_ID } from '@shared/auth/roles'
import { DELEGABLE_SUPER_INTERFACES } from '@shared/auth/delegable-interfaces'

const PORT = process.env.PORT ?? 3000

async function bootstrap() {
  try {
    // D-F13 (F2a A2): sem a chave RS256 o servidor NÃO sobe — nunca volta a aceitar HS256
    logger.info(`JWT do produto: ${assertJwtKeys()}`)
    if (process.env.JWT_SECRET) logger.warn('JWT_SECRET está no ambiente mas foi APOSENTADA (D-F13 — HS256 recusado): remova do .env')
    logger.info(`Isolamento da conexão: ${await assertIsolationLevel()}`)
    await detectLockWaitSupport()   // Q-A23: FOR UPDATE WAIT n no lock da institution
    logger.info(`innodb_rollback_on_timeout: ${await assertRollbackOnTimeoutOff()}`)   // L7
    logger.info(`Fuso da sessão do banco: ${await assertSessionTimeZoneUtc()}`)          // Q-TZ1
    logger.info(`CHECK do banco: ${await assertCheckConstraintsEnforced()}`)           // D-IB26
    logger.info(`Catálogo IBS/CBS (scripts 63/73): ${await assertIbscbsCatalogSchema()}`)   // D-IB36 · D-IB113
    logger.info(`Pedido de troca de senha (script 67): ${await assertPasswordResetReady()}`)   // Q-PV38
    logger.info(`Limite por conta do login (script 74): ${await assertLoginLockReady()}`)      // D-EA1/D-EA2/D-EA3
    logger.info(`Convite no vínculo (script 75): ${await assertInviteSchema()}`)                // D-UC14/D-UC15 · A-UC8
    logger.info(`Papel de quem definiu a senha (script 76): ${await assertPasswordAuthorSchema()}`)   // D-UC19
    logger.info(`Nomes únicos do catálogo (script 77): ${await assertCatalogUniqueNames()}`)          // D-PV43/D-PV63
  logger.info(`Política de senha: lista de senhas comuns com ${assertPasswordPolicyReady()} entradas`)   // D-EA5/A-EA9
    // Costura A1 da auth-api (D-AU3/D-UC9): as views centrais do veredito (script 70) — sem elas NENHUMA rota autentica
    logger.info(`Veredito de acesso (script 70): ${await assertAccessViews(SETES_INSTITUTION_ID, DELEGABLE_SUPER_INTERFACES)}`)
    // D-RS5: em produção (NODE_ENV=production) o SMTP é OBRIGATÓRIO — sem ele o setes-api NÃO sobe (o código de recuperação
    // nunca vai ao log de produção e o aviso ao dono da conta — D-RS4 — não pode morrer em silêncio). Em dev: só o resumo.
    const envWarning = nodeEnvWarning()
    if (envWarning) logger.warn(envWarning)
    logger.info(`E-mail (SMTP): ${assertMailerReady()}`)
    // D-EA4: em produção o e-mail da OPERAÇÃO (alarme do login) é OBRIGATÓRIO junto do SMTP — sem ele o setes-api NÃO sobe
    logger.info(`E-mail da operação (alarmes): ${assertOpsAlertReady()}`)
    // D-F113/D-F127 (F2a A3): a voz do fisco é LIDA no fiscal_api — sem a view de cada família que o ERP lê (ou sem o GRANT) o
    // setes-api NÃO sobe (nunca 500 na 1ª leitura da lista de OS). Ordem de deploy: nfse-api (as migrations das views) ANTES do
    // setes-api. D-NE245: a família que espera o plano de cancelamento não é conferida — e o log diz isso.
    logger.info(`Voz do fisco (views): ${await assertFiscalVoiceReadable(pool)}${awaitingFamiliesBootNote()}`)
    logger.info('Iniciando migrations...')
    await runMigrationsForAllInstitutions()
    // D-F135 (F2a): os gatilhos de TRAVA da f2a_fiscal_passivo conferidos pelo NOME em cada schema — faltando, o setes-api NÃO sobe
    logger.info(`Gatilhos de TRAVA da F2a: ${await assertF2aFreezeTriggers()}`)
    logger.info(`Origem dos cadastros W/D (072 + 081, D-PR47, D-OI10): ${await assertInstitutionSourceKindSchema()}`)
    // D-IB100 (D-IB26): o domínio da opção de apuração do IBS/CBS tem a guarda BINÁRIA do banco em cada schema — faltando, NÃO sobe
    logger.info(`Opção de apuração IBS/CBS (migration 077): ${await assertIbscbsAssessmentChecks()}`)
    // Costura A1 (D-AU3): as views POR SCHEMA do veredito (migration 075) — faltando num cliente, o setes-api NÃO sobe
    logger.info(`Veredito de acesso (075 por schema): ${await assertAccessSchemaViews()}`)
    // D-TM29/D-TM31: as telas ESTRUTURAIS concedidas a TODO estabelecimento ativo (só a que falta — A-TM11); erro de banco = NÃO sobe
    logger.info(`Telas estruturais (D-TM29): ${await grantStructuralInterfacesToActive()}`)
    // D-PV9: os pares (interface, privilégio) que o código consome conferidos contra o catálogo — faltando = ALARME, sobe assim mesmo
    logger.info(`Catálogo de privilégios: ${await assertPrivilegeCatalog()}`)
    logger.info('Migrations concluidas. Subindo servidor...')

    app.listen(PORT, () => {
      logger.info(`Setes API rodando na porta ${PORT}`)
    })
  } catch (err) {
    logger.error('Falha na inicializacao', { err })
    process.exit(1)
  }
}

bootstrap()
