/// <reference types="jest" />
// GATE ADVERSARIAL — delta da Rodada 7 do cadastro de produtos (2026-10-20; skill testar-adversarial.md; prompt_modulo_products.md
// "Rodada 7"). CERCAS ESTÁTICAS por varredura do `src` (quem escreve nas tabelas que o legado alimenta; quem chama as peças escritoras;
// quem escreve o enquadramento fiscal do serviço) + os achados da Rodada 6 que a Rodada 7 RESOLVEU por decisão:
//   · o ex-ACHADO HIGH (Q-PR52 → D-PR45): a Setes (L) enquadra o serviço do legado pelas rotas próprias — provado em
//     `adversarial-catalog-owner-r7.test.ts`;
//   · os ex-ACHADOS MEDIUM do religar e da 1ª ligação (Q-PR54/Q-PR55/Q-PR56) ficaram SEM OBJETO: não há religar — o dono é o fato
//     monotônico `source_kind` (D-PR47/D-PR48); o onboarding W/P recebe as categorias padrão da 073 e o L as recebe no ato.
// `it('[RESISTIU] …')` = a promessa vale. Substitui `adversarial-r6-gate.test.ts`.
import fs from 'fs'
import path from 'path'
import { LEGACY_OWNED_TABLES } from '../shared/catalog-owner'

const SRC = path.join(__dirname, '..')
const walk = (dir: string, out: string[] = []): string[] => {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) { if (f !== '__tests__' && f !== 'test-setup') walk(p, out); continue }
    if (p.endsWith('.ts')) out.push(p)
  }
  return out
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join('/')
const FILES = walk(SRC)
const read = (p: string) => fs.readFileSync(p, 'utf8')

describe('cerca por varredura — quem ESCREVE nas tabelas que o legado alimenta (LEGACY_OWNED_TABLES) e em tb_service_ibscbs', () => {
  it('[RESISTIU] só os 6 módulos guardados e as peças deles escrevem; nenhuma rota, controller, service de outro módulo ou script do src', () => {
    const T = '(' + [...LEGACY_OWNED_TABLES, 'tb_service_ibscbs'].join('|') + ')'
    const direct = new RegExp('(INSERT\\s+(?:IGNORE\\s+)?INTO|UPDATE|DELETE\\s+FROM|REPLACE\\s+INTO)\\s+[^\\s(]*\\b' + T + '\\b', 'gi')
    // ADV-R7-07: formas que a `direct` não vê — UPDATE multi-tabela (`UPDATE tb_x a JOIN tb_y b … SET b.…`), `DELETE b FROM tb_y b`,
    // lista de tabelas — qualquer literal SQL que COMEÇA com UPDATE/DELETE e cita a tabela antes de SET/WHERE
    const multi = new RegExp('[`\'"]\\s*(UPDATE|DELETE)\\b[^`\'";]*?\\b' + T + '\\b', 'gi')
    // a forma da CASA é `\`${schema}\`.tabela` (crase ESCAPADA dentro do template): a `multi` é aplicada ao texto SEM os prefixos de
    // schema (re-check adversarial R7, ADV-R7-07 — a classe `[^`'";]` parava na crase do prefixo antes de chegar ao nome da tabela)
    const stripSchema = (c: string) => c.replace(/\\`\$\{[^}]+\}\\`\./g, '')
    // autoteste da cerca (controle POSITIVO): as formas que ela promete ver
    for (const probe of [
      'UPDATE tb_order o JOIN tb_product p ON p.id = o.id SET p.description = ?',
      '`UPDATE \\`${s}\\`.tb_order o JOIN \\`${s}\\`.tb_product p ON p.id = o.id SET p.description = ?`',
      '`DELETE p FROM \\`${schemaName}\\`.tb_product p WHERE p.id = ?`',
      '`UPDATE \\`${s}\\`.tb_stock_balance b, \\`${s}\\`.tb_order o SET b.qty = 0 WHERE o.id = b.id`',
    ]) {
      multi.lastIndex = 0
      expect([probe.slice(0, 40), multi.test(stripSchema('`' + probe.replace(/^`|`$/g, '') + '`'))]).toEqual([probe.slice(0, 40), true])
    }
    const viaPlaceholder = /(INSERT\s+(?:IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+\?\?/i
    const tableLit = new RegExp('[`\'".]' + T + '[`\'"]', 'g')
    const writers: Record<string, string[]> = {}
    for (const p of FILES) {
      const c = read(p)
      const hits = new Set<string>()
      let m: RegExpExecArray | null
      direct.lastIndex = 0
      while ((m = direct.exec(c))) hits.add(m[2].toLowerCase())
      multi.lastIndex = 0
      const bare = stripSchema(c)
      while ((m = multi.exec(bare))) hits.add(m[2].toLowerCase())
      if (viaPlaceholder.test(c)) { tableLit.lastIndex = 0; while ((m = tableLit.exec(c))) hits.add(m[1].toLowerCase()) }
      if (hits.size) writers[rel(p)] = [...hits].sort()
    }
    expect(writers).toEqual({
      'modules/bank-accounts/bank-accounts.repository.ts':     ['tb_bank_account'],
      'modules/categories/categories.repository.ts':           ['tb_category'],
      'modules/financial-plans/financial-plans.repository.ts': ['tb_financial_plans'],
      'modules/merchandise/merchandise.repository.ts':         ['tb_merchandise', 'tb_merchandise_trade_unit', 'tb_product'],
      'modules/price-lists/price-lists.repository.ts':         ['tb_price_list'],
      'modules/services/services.repository.ts':               ['tb_product', 'tb_service', 'tb_service_ibscbs'],
      'shared/category-kind/index.ts':                         ['tb_category'],
      'shared/price/index.ts':                                 ['tb_price'],
    })
  })

  it('[RESISTIU] medida/embalagem (central) e os vínculos: o ÚNICO escritor é a peça @shared/central-catalog (INSERT pela spec), consumida só pelo merchandise; lista/saldo de estoque não têm escritor na web', () => {
    const mentions = (table: string) => FILES.filter(p => new RegExp('\\b' + table + '\\b').test(read(p))).map(rel).sort()
    const central = read(path.join(SRC, 'shared', 'central-catalog', 'index.ts'))
    expect(central).toMatch(/INSERT INTO setes_central\.\$\{spec\.table\}/)
    expect(central).toMatch(/INSERT INTO \\`\$\{s\}\\`\.\$\{spec\.linkTable\}/)
    expect(central).not.toMatch(/\bDELETE\s+FROM\b|\bREPLACE\s+INTO\b/i)
    expect(mentions('tb_institution_has_measure')).toEqual(['shared/catalog-owner/index.ts', 'shared/central-catalog/index.ts'])
    expect(mentions('tb_institution_has_package')).toEqual(['shared/catalog-owner/index.ts', 'shared/central-catalog/index.ts'])
    expect(mentions('tb_measure')).toEqual(['modules/merchandise/merchandise.repository.ts', 'shared/catalog-owner/index.ts', 'shared/central-catalog/index.ts'])
    expect(mentions('tb_package')).toEqual(['modules/merchandise/merchandise.repository.ts', 'shared/catalog-owner/index.ts', 'shared/central-catalog/index.ts'])
    expect(mentions('tb_stock_list')).toEqual(['shared/catalog-owner/index.ts'])
    expect(mentions('tb_stock_balance')).toEqual(['shared/catalog-owner/index.ts'])
    const importers = FILES.filter(p => /from '@shared\/central-catalog'/.test(read(p))).map(rel).sort()
    expect(importers.length).toBeGreaterThan(0)
    expect(importers.every(f => f.startsWith('modules/merchandise/'))).toBe(true)
  })

  it('[RESISTIU] as peças escritoras só são chamadas por quem deve: syncProductPrices pelos 2 cadastros guardados; ensureDefaultCategory(s) só pelo ato (institutions) e pela própria peça; nada chama a chave para decidir dono', () => {
    const importers = (needle: RegExp) => FILES.filter(p => needle.test(read(p))).map(rel).sort()
    expect(importers(/\bsyncProductPrices\b/)).toEqual(['modules/merchandise/merchandise.repository.ts', 'modules/services/services.repository.ts', 'shared/price/index.ts'])
    expect(importers(/\bensureDefaultCategor(y|ies)\b/)).toEqual(['modules/institutions/institutions.repository.ts', 'shared/category-kind/index.ts'])
    // em CÓDIGO (não em comentário): nenhuma chamada/importação das peças da Rodada 6 sobrou
    expect(importers(/\b(hasActiveSyncKey|assertNoActiveSyncKey|webBornSince)\(|@shared\/sync-key|sync-write\.guard|ErrorCodes\.(SYNC_MANAGED_CATALOG|SYNC_KEY_WEB_ROWS)/)).toEqual([])
    // a chave do sincronizador só é LIDA/ESCRITA (SQL) pelo módulo institutions, que a administra — nunca por guarda ou cadastro (D-PR47: é só autenticação)
    expect(importers(/setes_central\.tb_sync_api_key/)).toEqual(['modules/institutions/institutions.repository.ts'])
  })
})

describe('D-PR45 — cerca do ENQUADRAMENTO FISCAL do serviço: um escritor por fato, chamado só de onde deve', () => {
  const repo = read(path.join(SRC, 'modules', 'services', 'services.repository.ts'))

  it('[RESISTIU] tb_service (regra de ISS + NBS) e tb_service_ibscbs têm exatamente DOIS escritores (upsertServiceRule, syncServiceClassification), privados do repositório', () => {
    const insertsService = repo.match(/INSERT INTO \\`\$\{schemaName\}\\`\.tb_service\b/g) ?? []
    const insertsIbscbs = repo.match(/INSERT INTO \\`\$\{schemaName\}\\`\.tb_service_ibscbs\b/g) ?? []
    const updatesService = repo.match(/UPDATE \\`\$\{schemaName\}\\`\.tb_service\b/g) ?? []
    const updatesIbscbs = repo.match(/UPDATE \\`\$\{schemaName\}\\`\.tb_service_ibscbs\b/g) ?? []
    expect([insertsService.length, insertsIbscbs.length, updatesService.length, updatesIbscbs.length]).toEqual([1, 1, 1, 1])
    expect(repo).toMatch(/\nasync function upsertServiceRule\(/)
    expect(repo).toMatch(/\nasync function syncServiceClassification\(/)
    expect(repo).not.toMatch(/export async function (upsertServiceRule|syncServiceClassification)/)
  })

  it('[RESISTIU] os dois escritores são chamados de exatamente 4 lugares: insertService, updateService (PUT guardado) e as duas rotas próprias', () => {
    const calls = (name: string) => (repo.match(new RegExp('\\bawait ' + name + '\\(', 'g')) ?? []).length
    expect([calls('upsertServiceRule'), calls('syncServiceClassification')]).toEqual([3, 3])
    for (const fn of ['insertService', 'updateService', 'updateServiceTaxRule', 'updateServiceFiscalClassification']) {
      expect(repo).toMatch(new RegExp('export async function ' + fn + '\\('))
    }
    const body = (fn: string) => repo.slice(repo.indexOf(`export async function ${fn}(`), repo.indexOf('\n}\n', repo.indexOf(`export async function ${fn}(`)))
    expect(body('updateServiceTaxRule')).toMatch(/lockServiceRow[\s\S]*assertServiceTaxRuleRef[\s\S]*upsertServiceRule/)
    expect(body('updateServiceTaxRule')).not.toMatch(/syncServiceClassification|tb_product\s+SET/)
    expect(body('updateServiceFiscalClassification')).toMatch(/lockServiceRow[\s\S]*assertClassificationIfChanged[\s\S]*syncServiceClassification/)
    expect(body('updateServiceFiscalClassification')).not.toMatch(/upsertServiceRule|tb_product\s+SET/)
  })

  it('[RESISTIU] as rotas próprias vivem SÓ em services.fiscal.routes.ts (2 PUT, cada uma com o privilégio ALTERAR) e o gateway as monta ANTES da guarda', () => {
    const fiscal = read(path.join(SRC, 'modules', 'services', 'services.fiscal.routes.ts'))
    expect(fiscal.match(/router\.(get|post|put|delete|patch)\(/g)).toEqual(['router.put(', 'router.put('])
    expect(fiscal).toMatch(/requirePrivilege\('services', PRIVILEGE_ALTERAR\)/)
    expect(fiscal).toMatch(/router\.put\('\/:id\/tax-rule', alterar, controller\.updateTaxRule\)/)
    expect(fiscal).toMatch(/router\.put\('\/:id\/ibscbs', alterar, controller\.updateIbscbs\)/)
    const mainRoutes = read(path.join(SRC, 'modules', 'services', 'services.routes.ts'))
    expect(mainRoutes).not.toMatch(/tax-rule'|ibscbs'/)
    const gateway = read(path.join(SRC, 'gateway', 'router.ts'))
    const a = gateway.indexOf("router.use('/services', servicesFiscalRoutes)")
    const b = gateway.indexOf("router.use('/services', catalogOwnerGuard, servicesRoutes)")
    expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a)
    const c = gateway.indexOf("router.use('/bank-accounts', bankAccountsChannelRoutes)")
    const d = gateway.indexOf("router.use('/bank-accounts', catalogOwnerGuard, bankAccountsRoutes)")
    expect(c).toBeGreaterThan(-1); expect(d).toBeGreaterThan(c)
    expect(gateway.match(/catalogOwnerGuard,/g)).toHaveLength(6)
  })
})

describe('o fato é MONOTÔNICO e só o ato o muda — cercas no código do módulo institutions e na migration', () => {
  const repo = read(path.join(SRC, 'modules', 'institutions', 'institutions.repository.ts'))

  it('[RESISTIU] só UM UPDATE de source_kind em todo o src (o ato), com `source_kind = L AND transition_ended_at IS NULL` NO COMANDO e affectedRows conferido; a sonda do boot só INSERE linhas de prova desfeitas', () => {
    const files = FILES.filter(p => /SET\s+source_kind\s*=/.test(read(p))).map(rel).sort()
    expect(files).toEqual(['modules/institutions/institutions.repository.ts'])
    const piece = read(path.join(SRC, 'shared', 'catalog-owner', 'index.ts'))
    const probeFn = piece.slice(piece.indexOf('export async function assertInstitutionSourceKindSchema'))
    expect(probeFn).toMatch(/finally \{\s*await conn\.rollback\(\)/)                                                     // sempre desfeita
    expect(repo.match(/SET source_kind = \?/g)).toHaveLength(1)
    expect(repo).toMatch(/SET source_kind = \?, transition_ended_at = NOW\(\), transition_ended_by = \?, transition_end_reason = \?, updated_at = NOW\(\)\s+WHERE id = \? AND source_kind = 'L' AND transition_ended_at IS NULL/)
    expect(repo).toMatch(/Number\(upd\.affectedRows\) !== 1/)
    // o INSERT da institution leva o fato declarado; a edição só CONFERE (409), nunca grava
    expect(repo).toMatch(/INSERT INTO setes_central\.tb_institution \(id, schema_name, source_kind, active, created_at, updated_at\)/)
    expect(repo).toMatch(/SOURCE_KIND_IMMUTABLE/)
    expect(repo).not.toMatch(/UPDATE setes_central\.tb_institution SET [^\n]*source_kind/)
  })

  it('[RESISTIU] a migration 072 é re-executável por schema (guardas information_schema + ADD CONSTRAINT IF NOT EXISTS), backfill só nas NULL, NOT NULL sem DEFAULT, CHECK binário nomeado; a 073 cria categorias só para W/P', () => {
    const m072 = read(path.join(SRC, 'migrations', 'sql', '072_institution_source_kind.sql'))
    // TODO DDL guardado (gate socrático R7): 2 ADD COLUMN + MODIFY por is_nullable + CHECKs por CHECK_CONSTRAINTS → zero ALTER no re-run
    expect(m072.match(/information_schema\.columns/g)).toHaveLength(3)
    expect(m072.match(/information_schema\.CHECK_CONSTRAINTS/g)).toHaveLength(1)
    expect(m072.match(/PREPARE stmt_\w+ FROM @ddl/g)).toHaveLength(4)
    expect(m072).not.toMatch(/^ALTER TABLE/m)                                                  // nenhum ALTER solto
    expect(m072).toMatch(/WHERE i\.`source_kind` IS NULL/)
    expect(m072).toMatch(/MODIFY COLUMN `source_kind` CHAR\(1\) NOT NULL COMMENT/)
    expect(m072).not.toMatch(/NOT NULL DEFAULT/)
    expect(m072).toMatch(/ADD CONSTRAINT IF NOT EXISTS `ck_institution_source_kind` CHECK \(`source_kind` COLLATE utf8mb4_bin IN \(''W'', ''L'', ''P''\)\)/)
    expect(m072).toMatch(/ADD CONSTRAINT IF NOT EXISTS `ck_institution_transition_ended` CHECK \(`transition_ended_at` IS NULL OR `source_kind` COLLATE utf8mb4_bin <> ''L''\)/)
    const m073 = read(path.join(SRC, 'migrations', 'sql', '073_default_categories.sql'))
    expect(m073.match(/i\.source_kind COLLATE utf8mb4_bin IN \('W', 'P'\)/g)).toHaveLength(2)
    expect(m073).not.toMatch(/tb_sync_api_key/)
    expect(fs.existsSync(path.join(SRC, 'migrations', 'sql', '072_default_categories.sql'))).toBe(false)
  })

  it('[RESISTIU] o boot confere a coluna, os CHECKs pelo NOME e sonda o motor (PADROES §11 regra 11) DEPOIS das migrations', () => {
    const server = read(path.join(SRC, 'server.ts'))
    const a = server.indexOf('await runMigrationsForAllInstitutions()')
    const b = server.indexOf('assertInstitutionSourceKindSchema()')
    expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a)
    const piece = read(path.join(SRC, 'shared', 'catalog-owner', 'index.ts'))
    expect(piece).toMatch(/information_schema\.CHECK_CONSTRAINTS/)
    expect(piece).toMatch(/CK_INSTITUTION_SOURCE_KIND = 'ck_institution_source_kind'/)
    expect(piece).toMatch(/CK_INSTITUTION_TRANSITION_ENDED = 'ck_institution_transition_ended'/)
    expect(piece).toMatch(/refuses\('X', 'NULL', false, CK_INSTITUTION_SOURCE_KIND\)/)            // fora do domínio
    expect(piece).toMatch(/refuses\('l', 'NULL', false, CK_INSTITUTION_SOURCE_KIND\)/)            // a minúscula de um válido
    expect(piece).toMatch(/refuses\('L', 'NOW\(\)', true, CK_INSTITUTION_TRANSITION_ENDED\)/)     // "L com data" (com autor e motivo — isola a 072)
    expect(piece).toMatch(/refuses\('W', 'NOW\(\)', false, CK_INSTITUTION_TRANSITION_AUTHOR\)/)   // o ato sem autor nem motivo (079 — D-PR53)
    expect(piece).toMatch(/BOOT_PROBE_ID = -1/)                                                   // PK própria — nunca a linha da Setes
    expect(piece).not.toMatch(/UPDATE setes_central\.tb_institution/)
    expect(piece).toMatch(/err\?\.errno === 4025 \|\| err\?\.errno === 3819/)
  })
})
