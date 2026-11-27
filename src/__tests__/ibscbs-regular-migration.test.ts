/// <reference types="jest" />
// IBS.E9.P4 — migration 085 e script central 81: o que o motor calculou por tributo, a base do item, a redução do catálogo e as alíquotas.
// Nada é aplicado aqui: o teste lê os arquivos e cerca a FORMA decidida (D-IB9, D-IB135, D-IB143 a D-IB145, D-NE248, A-IB143).
import fs from 'fs'
import path from 'path'
import { IBSCBS_LEGAL_ALIQS } from '@shared/ibscbs-calculation'

const MIGRATION = path.join(__dirname, '..', 'migrations', 'sql', '085_ibscbs_regular_values.sql')
const SQL_DIR = path.resolve(process.env.SQL_DIR ?? path.join(__dirname, '../../../sql'))
const CANONICAL = path.join(SQL_DIR, '03_schema_cliente_ddl.sql')
const CENTRAL_CANONICAL = path.join(SQL_DIR, '01_setes_central_ddl.sql')
const CENTRAL_SCRIPT = path.join(SQL_DIR, '81_ibscbs_reduction_and_rate_ddl.sql')

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
// Com SQL_DIR informado o espelho é OBRIGATÓRIO (arquivo ausente = teste vermelho); sem ele, vale o caminho padrão do repositório irmão.
const withSql = process.env.SQL_DIR || fs.existsSync(CANONICAL) ? it : it.skip

describe('migration 085 — IBS/CBS do regime regular', () => {
  const sql = sqlOf(MIGRATION)

  it('é re-executável: só CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS e ADD CONSTRAINT IF NOT EXISTS', () => {
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean)
    expect(statements.length).toBe(5)
    for (const s of statements) {
      if (s.startsWith('CREATE TABLE')) expect(s.startsWith('CREATE TABLE IF NOT EXISTS')).toBe(true)
      else {
        expect(s.startsWith('ALTER TABLE')).toBe(true)
        expect(s).toMatch(/ADD (COLUMN|CONSTRAINT) IF NOT EXISTS/)
      }
    }
    expect(sql).not.toMatch(/DROP |TRUNCATE|DELETE FROM|^\s*UPDATE /m)
  })

  it('tb_order_item_ibscbs_tax: uma linha por tributo; chave dos irmãos do item mais `tax`, sem kind (D-IB9), sem FK', () => {
    const create = createOf(sql, 'tb_order_item_ibscbs_tax')
    expect(columnsOf(create)).toEqual([
      'tb_order_id', 'tb_order_item_id', 'tb_institution_id', 'terminal',
      'tax', 'nominal_rate', 'reduction_rate', 'effective_rate', 'tax_value', ...AUDIT])
    expect(create).toContain('PRIMARY KEY (`tb_order_id`, `tb_order_item_id`, `tb_institution_id`, `terminal`, `tax`)')
    expect(create).not.toContain('FOREIGN KEY')
    expect(create).not.toMatch(/`kind`|classification_code|`cst`/)
    expect(create).toMatch(/`(nominal|effective)_rate`\s+DECIMAL\(7,4\) NOT NULL/)
    expect(create).toMatch(/`reduction_rate`\s+DECIMAL\(7,4\) DEFAULT NULL/)   // NULL = sem gRed, nunca 0 no lugar
    expect(create).toMatch(/`tax_value`\s+DECIMAL\(15,2\) NOT NULL/)
  })

  it('nada que o cálculo do passo não grava: sem diferimento (RF-BC-12), sem modo, sem S, sem vIBS, sem totais (D-NE248)', () => {
    const cols = columnsOf(createOf(sql, 'tb_order_item_ibscbs_tax')).join(' ')
    expect(cols).not.toMatch(/defer|dif|mode|gross|vibs|total|adjust/)
  })

  it('o domínio de `tax` e as faixas são CHECKs binários nomeados (a sonda de boot os confere)', () => {
    expect(sql).toContain("CONSTRAINT IF NOT EXISTS `ck_order_item_ibscbs_tax_tax`")
    expect(sql).toContain("CHECK (`tax` COLLATE utf8mb4_bin IN ('U', 'M', 'C'))")
    expect(sql).toContain('CONSTRAINT IF NOT EXISTS `ck_order_item_ibscbs_tax_range`')
    expect(sql).toMatch(/`nominal_rate` BETWEEN 0 AND 100 AND `effective_rate` BETWEEN 0 AND 100\s+AND \(`reduction_rate` IS NULL OR `reduction_rate` BETWEEN 0 AND 100\)/)
    expect(sql).toContain('CONSTRAINT IF NOT EXISTS `ck_order_item_ibscbs_tax_effective`')
    expect(sql).toContain('CHECK (`effective_rate` <= `nominal_rate`)')
  })

  it('a base do item é UMA coluna anulável em tb_order_item_ibscbs (as linhas da 083 continuam válidas)', () => {
    expect(sql).toMatch(/ALTER TABLE `tb_order_item_ibscbs`\s+ADD COLUMN IF NOT EXISTS `base_value` DECIMAL\(15,2\) DEFAULT NULL/)
    expect((sql.match(/ADD COLUMN/g) ?? []).length).toBe(1)
    expect((sql.match(/CREATE TABLE/g) ?? []).length).toBe(1)
  })

  withSql('o canônico do cliente (sql/03) espelha a tabela, a coluna e os CHECKs', () => {
    const canonical = sqlOf(CANONICAL)
    expect(createOf(canonical, 'tb_order_item_ibscbs_tax')).toBe(createOf(sql, 'tb_order_item_ibscbs_tax'))
    expect(canonical).toMatch(/ALTER TABLE `tb_order_item_ibscbs`\s+ADD COLUMN IF NOT EXISTS `base_value` DECIMAL\(15,2\) DEFAULT NULL/)
    for (const name of ['ck_order_item_ibscbs_tax_tax', 'ck_order_item_ibscbs_tax_range', 'ck_order_item_ibscbs_tax_effective']) {
      expect(canonical).toContain(`CONSTRAINT IF NOT EXISTS \`${name}\``)
    }
  })
})

describe('script central 81 — redução do catálogo e alíquotas datadas', () => {
  const script = (): string => sqlOf(CENTRAL_SCRIPT)

  withSql('a redução: duas colunas anuláveis na história do cClassTrib, com CHECK de 0 a 100', () => {
    const s = script()
    expect(s).toMatch(/ADD COLUMN IF NOT EXISTS `ibs_reduction_rate` DECIMAL\(7,4\) DEFAULT NULL/)
    expect(s).toMatch(/ADD COLUMN IF NOT EXISTS `cbs_reduction_rate` DECIMAL\(7,4\) DEFAULT NULL/)
    expect(s).toContain('CONSTRAINT IF NOT EXISTS `ck_ibscbs_validity_reduction`')
    expect(s).toMatch(/^USE `setes_central`;$/m)
  })

  withSql('tb_tax_ibscbs_rate: PK (tax, valid_from) — duas linhas do mesmo tributo com o mesmo início não existem', () => {
    const create = createOf(script(), 'tb_tax_ibscbs_rate')
    expect(columnsOf(create)).toEqual(['tax', 'valid_from', 'valid_until', 'rate', 'legal_basis', 'tb_user_id', ...AUDIT])
    expect(create).toContain('PRIMARY KEY (`tax`, `valid_from`)')
    expect(create).toMatch(/`rate`\s+DECIMAL\(7,4\) NOT NULL/)
    expect(create).toContain("CHECK (`tax` COLLATE utf8mb4_bin IN ('U', 'M', 'C'))")
  })

  withSql('o seed traz exatamente as cinco linhas que a norma fixa (IBSCBS_LEGAL_ALIQS) e nenhuma CBS de 2027 em diante', () => {
    const s = script()
    const rows = [...s.matchAll(/\('([UMC])', '(\d{4}-\d{2}-\d{2})', '(\d{4}-\d{2}-\d{2})', (\d\.\d{4}),/g)]
      .map(m => ({ tax: m[1], validFrom: m[2], validUntil: m[3], ppm: Math.round(Number(m[4]) * 10000) }))
    const TAX = { IBS_UF: 'U', IBS_MUN: 'M', CBS: 'C' } as const
    const expected = IBSCBS_LEGAL_ALIQS.map(l => ({ tax: TAX[l.tax], validFrom: l.validFrom, validUntil: l.validUntil, ppm: l.ppm }))
    expect(rows).toEqual(expected)
    expect(rows).toHaveLength(5)
    expect(rows.some(r => r.tax === 'C' && r.validFrom >= '2027-01-01')).toBe(false)
    expect(s).toMatch(/INSERT INTO `tb_tax_ibscbs_rate`[\s\S]*ON DUPLICATE KEY UPDATE/)   // idempotente pela PK, sem engolir dado inválido (IGNORE não)
  })

  withSql('o canônico central (sql/01) espelha as colunas, o CHECK e a tabela de alíquotas', () => {
    const central = sqlOf(CENTRAL_CANONICAL)
    // a tabela antiga tem ';' dentro de um COMMENT: o corpo vai até o `) ENGINE`
    const from = central.indexOf('CREATE TABLE IF NOT EXISTS `tb_tax_ibscbs_classification_validity`')
    const validity = central.slice(from, central.indexOf(') ENGINE', from))
    expect(columnsOf(validity)).toEqual(expect.arrayContaining(['ibs_reduction_rate', 'cbs_reduction_rate']))
    expect(validity).toContain('`ck_ibscbs_validity_reduction`')
    expect(createOf(central, 'tb_tax_ibscbs_rate')).toBe(createOf(script(), 'tb_tax_ibscbs_rate'))
  })
})
