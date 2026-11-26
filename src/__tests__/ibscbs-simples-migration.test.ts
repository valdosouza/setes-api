/// <reference types="jest" />
// IBS.E9.P5 — migration 084 e seed 80: o percentual do mês, a atividade (cAtivSN) e o item do Simples no DAS.
// A migration não é aplicada aqui: o teste lê o arquivo e cerca a FORMA decidida (D-IB9, D-IB138 a D-IB141, D-NE248).
import fs from 'fs'
import path from 'path'
import { validateConfigContent } from '../shared/interface-config/interface-config.service'

const MIGRATION = path.join(__dirname, '..', 'migrations', 'sql', '084_ibscbs_simples_das.sql')
const SQL_DIR = path.resolve(process.env.SQL_DIR ?? path.join(__dirname, '../../../sql'))
const CANONICAL = path.join(SQL_DIR, '03_schema_cliente_ddl.sql')
const SEED = path.join(SQL_DIR, '80_ibscbs_simples_start_config_seed.sql')

const sqlOf = (file: string): string =>
  fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

function createOf(sql: string, table: string): string {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS \`${table}\``)
  if (start < 0) throw new Error(`CREATE TABLE de ${table} não achado`)
  return sql.slice(start, sql.indexOf(';', start) + 1)
}

const columnsOf = (create: string): string[] =>
  create.split('\n').map(l => l.trim()).filter(l => l.startsWith('`')).map(l => l.slice(1, l.indexOf('`', 1)))

const AUDIT = ['created_at', 'updated_at', 'deleted']
const TABLES = ['tb_establishment_simples_rate', 'tb_order_item_ibscbs_simples']

describe('migration 084 — IBS/CBS do Simples no DAS', () => {
  const sql = sqlOf(MIGRATION)

  it('é re-executável: só CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS e ADD CONSTRAINT IF NOT EXISTS', () => {
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean)
    expect(statements[0]).toBe('SELECT 1 FROM `setes_central`.`tb_institution` LIMIT 0')
    for (const s of statements.slice(1)) {
      if (s.startsWith('CREATE TABLE')) expect(s.startsWith('CREATE TABLE IF NOT EXISTS')).toBe(true)
      else {
        expect(s.startsWith('ALTER TABLE')).toBe(true)
        expect(s).toMatch(/ADD (COLUMN|CONSTRAINT) IF NOT EXISTS/)
      }
    }
    expect(sql).not.toMatch(/DROP |TRUNCATE|DELETE FROM|^s*UPDATE /m)
  })

  it('tb_establishment_simples_rate: um percentual por estabelecimento e mês, IBS e CBS separados (D-IB138), sem anexo', () => {
    const create = createOf(sql, 'tb_establishment_simples_rate')
    expect(columnsOf(create)).toEqual(['tb_institution_id', 'competence', 'ibs_rate', 'cbs_rate', 'tb_user_id', ...AUDIT])
    expect(create).toContain('PRIMARY KEY (`tb_institution_id`, `competence`)')
    expect(create).toMatch(/`ibs_rate`\s+DECIMAL\(7,4\) NOT NULL/)
    expect(create).toMatch(/`cbs_rate`\s+DECIMAL\(7,4\) NOT NULL/)
    expect(create).toMatch(/FOREIGN KEY \(`tb_institution_id`\)\s+REFERENCES `setes_central`\.`tb_institution` \(`id`\)/)
    expect(sql).toContain("CHECK (`competence` REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$')")
    expect(sql).toContain('CHECK (`ibs_rate` BETWEEN 0 AND 100 AND `cbs_rate` BETWEEN 0 AND 100)')
    expect(columnsOf(create).some(c => /annex|anexo|activity/.test(c))).toBe(false)
  })

  it('a atividade: padrão em tb_entity_tax e exceção em tb_merchandise, as duas CHAR(2) NULL com CHECK binário 01-04 (D-IB139)', () => {
    for (const table of ['tb_entity_tax', 'tb_merchandise']) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE \`${table}\`\\s+ADD COLUMN IF NOT EXISTS \`simples_activity\` CHAR\\(2\\) DEFAULT NULL`))
    }
    const checks = sql.match(/`simples_activity` IS NULL OR `simples_activity` COLLATE utf8mb4_bin IN \('01', '02', '03', '04'\)/g) ?? []
    expect(checks).toHaveLength(2)   // a 90 (não tributável) fica de fora: A-IB138d
  })

  it('tb_order_item_ibscbs_simples: chave dos irmãos do item, sem kind (D-IB9), sem FK, com as colunas de valor que o cálculo grava', () => {
    const create = createOf(sql, 'tb_order_item_ibscbs_simples')
    expect(columnsOf(create)).toEqual([
      'tb_order_id', 'tb_order_item_id', 'tb_institution_id', 'terminal',
      'activity_code', 'competence', 'ibs_rate', 'cbs_rate', 'base_value', 'ibs_value', 'cbs_value', ...AUDIT])
    expect(create).toContain('PRIMARY KEY (`tb_order_id`, `tb_order_item_id`, `tb_institution_id`, `terminal`)')
    expect(create).not.toContain('FOREIGN KEY')
    expect(create).not.toMatch(/`kind`|classification_code|`cst`/)   // a classificação mora em tb_order_item_ibscbs
    expect(create).toMatch(/`(base|ibs|cbs)_value`\s+DECIMAL\(15,2\) NOT NULL/)
    expect(create).toContain("`activity_code` COLLATE utf8mb4_bin IN ('01', '02', '03', '04')")
  })

  it('a migration traz só as duas tabelas e as duas colunas (nada além)', () => {
    expect((sql.match(/CREATE TABLE/g) ?? []).length).toBe(2)
    expect((sql.match(/ADD COLUMN/g) ?? []).length).toBe(2)
  })

  // Com SQL_DIR informado o espelho é OBRIGATÓRIO (arquivo ausente = teste vermelho); sem ele, vale o caminho padrão do
  // repositório irmão e o teste só é pulado quando esse repositório não está na máquina.
  const withCanonical = process.env.SQL_DIR || fs.existsSync(CANONICAL) ? it : it.skip
  withCanonical('o canônico (sql/03) espelha as duas tabelas e as duas colunas, com as mesmas colunas e chaves', () => {
    const canonical = sqlOf(CANONICAL)
    for (const table of TABLES) {
      expect(createOf(canonical, table)).toBe(createOf(sql, table))
    }
    for (const table of ['tb_entity_tax', 'tb_merchandise']) {
      expect(canonical).toMatch(new RegExp(`ALTER TABLE \`${table}\`\\s+ADD COLUMN IF NOT EXISTS \`simples_activity\` CHAR\\(2\\) DEFAULT NULL`))
    }
    expect(canonical).toContain("CONSTRAINT IF NOT EXISTS `ck_entity_tax_simples_activity`")
    expect(canonical).toContain("CONSTRAINT IF NOT EXISTS `ck_merchandise_simples_activity`")
  })
})

describe('seed 80 — data de início do IBS/CBS do Simples na interface billing', () => {
  const withSeed = process.env.SQL_DIR || fs.existsSync(SEED) ? it : it.skip
  const seed = (): string => fs.readFileSync(SEED, 'utf8').replace(/\r\n/g, '\n')

  withSeed('semeia só a chave ibscbs_simples_start: Date, padrão 2027-01-01, por institution, ancorada na interface billing', () => {
    const s = seed()
    expect((s.match(/INSERT INTO `tb_interface_has_config`/g) ?? []).length).toBe(1)
    expect(s).toMatch(/SELECT i\.id, 'ibscbs_simples_start',[^]*?'Date', NULL, '2027-01-01', 'I', NOW\(\), NOW\(\), 'N'/)
    expect(s).toMatch(/WHERE i\.i18n_key = 'billing'/)
    expect(s).toMatch(/c\.name = 'ibscbs_simples_start'/)   // idempotente
    expect(s).toMatch(/^USE `setes_central`;$/m)
    expect(s).not.toMatch(/tb_interface_id`?\s*=\s*\d|VALUES\s*\(\s*\d/)   // nunca id fixo
  })

  it('o padrão é uma data aceita pelo framework de configurações', () => {
    expect(validateConfigContent('Date', null, '2027-01-01')).toBeNull()
  })

  withSeed('a chave não existe em outro seed da pasta (sem colisão de nome)', () => {
    const others = fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql') && !f.startsWith('80_'))
    expect(others.length).toBeGreaterThan(20)
    for (const f of others) {
      expect([f, fs.readFileSync(path.join(SQL_DIR, f), 'utf8').includes("'ibscbs_simples_start'")]).toEqual([f, false])
    }
  })
})
