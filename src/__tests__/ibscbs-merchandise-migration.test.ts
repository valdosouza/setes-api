/// <reference types="jest" />
// IBS.E9.P3 — migration 083: a classificação de IBS/CBS da mercadoria na regra de tributação e no item do pedido.
// A migration não é aplicada aqui: o teste lê o arquivo e cerca a FORMA decidida (D-IB9, D-IB133 a D-IB136, D-NE248).
import fs from 'fs'
import path from 'path'

const MIGRATION = path.join(__dirname, '..', 'migrations', 'sql', '083_ibscbs_merchandise_classification.sql')
const CANONICAL = path.resolve(process.env.SQL_DIR ?? path.join(__dirname, '../../../sql'), '03_schema_cliente_ddl.sql')

/** O SQL sem comentários de linha (o texto dos comentários cita `kind`, `cst`… e não é estrutura). */
const sqlOf = (file: string): string =>
  fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

/** O corpo `CREATE TABLE IF NOT EXISTS \`<table>\` ( … ) ENGINE…;` de uma tabela. */
function createOf(sql: string, table: string): string {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS \`${table}\``)
  if (start < 0) throw new Error(`CREATE TABLE de ${table} não achado`)
  return sql.slice(start, sql.indexOf(';', start) + 1)
}

/** Nomes das colunas declaradas (linhas que começam com `nome` — fora PRIMARY KEY, KEY e CONSTRAINT). */
const columnsOf = (create: string): string[] =>
  create.split('\n').map(l => l.trim()).filter(l => l.startsWith('`')).map(l => l.slice(1, l.indexOf('`', 1)))

const AUDIT = ['created_at', 'updated_at', 'deleted']

describe('migration 083 — classificação de IBS/CBS da mercadoria', () => {
  const sql = sqlOf(MIGRATION)

  it('é re-executável: só CREATE TABLE IF NOT EXISTS (e a sonda da referência central)', () => {
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean)
    expect(statements).toHaveLength(3)
    expect(statements[0]).toBe('SELECT 1 FROM `setes_central`.`tb_tax_ibscbs_classification` LIMIT 0')
    expect(statements[1].startsWith('CREATE TABLE IF NOT EXISTS `tb_tax_rule_ibscbs`')).toBe(true)
    expect(statements[2].startsWith('CREATE TABLE IF NOT EXISTS `tb_order_item_ibscbs`')).toBe(true)
  })

  it('tb_tax_rule_ibscbs: peça 1:1 da regra, só com o código da classificação', () => {
    const create = createOf(sql, 'tb_tax_rule_ibscbs')
    expect(columnsOf(create)).toEqual(['id', 'classification_code', ...AUDIT])
    expect(create).toContain('PRIMARY KEY (`id`)')
    expect(create).toContain('FOREIGN KEY (`id`) REFERENCES `tb_tax_rule` (`id`)')
    expect(create).toMatch(/FOREIGN KEY \(`classification_code`\)\s+REFERENCES `setes_central`\.`tb_tax_ibscbs_classification` \(`code`\)/)
    expect(create).toContain('COLLATE=utf8mb4_unicode_ci')
    expect(create).toContain("CHECK (`classification_code` REGEXP '^[0-9]{6}$')")   // linha gravada fora da API não foge do formato
  })

  it('tb_order_item_ibscbs: chave dos registros irmãos do item, sem kind (D-IB9), sem FK e com CHECK de formato', () => {
    const create = createOf(sql, 'tb_order_item_ibscbs')
    expect(columnsOf(create)).toEqual(
      ['tb_order_id', 'tb_order_item_id', 'tb_institution_id', 'terminal', 'classification_code', ...AUDIT])
    expect(create).toContain('PRIMARY KEY (`tb_order_id`, `tb_order_item_id`, `tb_institution_id`, `terminal`)')
    expect(create).not.toContain('FOREIGN KEY')
    expect(create).toContain("CHECK (`classification_code` REGEXP '^[0-9]{6}$')")
  })

  it('nenhuma das duas guarda kind, CST, alíquota ou valor (D-NE248: coluna nasce com o cálculo)', () => {
    for (const table of ['tb_tax_rule_ibscbs', 'tb_order_item_ibscbs']) {
      for (const column of columnsOf(createOf(sql, table))) {
        expect(column).not.toMatch(/kind|cst|aliq|value|base|reduction|defer/)
      }
    }
  })

  // Com SQL_DIR informado o espelho é OBRIGATÓRIO (arquivo ausente = teste vermelho); sem ele, vale o caminho padrão do
  // repositório irmão e o teste só é pulado quando esse repositório não está na máquina.
  const withCanonical = process.env.SQL_DIR || fs.existsSync(CANONICAL) ? it : it.skip
  withCanonical('o canônico (sql/03) espelha as duas tabelas, com as mesmas colunas e chaves', () => {
    const canonical = sqlOf(CANONICAL)
    for (const table of ['tb_tax_rule_ibscbs', 'tb_order_item_ibscbs']) {
      expect(createOf(canonical, table)).toBe(createOf(sql, table))
    }
  })
})
