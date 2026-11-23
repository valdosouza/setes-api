/// <reference types="jest" />
// Fase IBS/CBS, D-IB127/D-IB129 (setes-api:IBS.E6.P7 — prompt_fase_ibs_cbs.md §17.3/§17.7): a VIEW `vw_establishment_ibscbs_assessment`
// (migration 078) × o CONTRATO dela, que mora no subpath puro do núcleo (`ESTABLISHMENT_IBSCBS_ASSESSMENT_VIEW`/`_COLUMNS`) — o leitor do
// núcleo monta o SELECT a partir dele; uma coluna renomeada ou a mais aqui quebraria o leitor só em produção. Também a FORMA da view: só as
// linhas vivas, sem resolver a vigente (a regra é do seletor único, D-IB128) e fundível (PADROES §11 regra 3).
import fs from 'fs'
import path from 'path'
import { ESTABLISHMENT_IBSCBS_ASSESSMENT_VIEW, ESTABLISHMENT_IBSCBS_ASSESSMENT_COLUMNS } from 'fiscal-api/ibscbs-assessment'

const SQL = path.join(__dirname, '..', 'migrations', 'sql')
const VIEW_DDL = fs.readFileSync(path.join(SQL, '078_establishment_ibscbs_assessment_view.sql'), 'utf8')
const TABLE_DDL = fs.readFileSync(path.join(SQL, '077_establishment_ibscbs_assessment.sql'), 'utf8')

/** O comando da view, sem os comentários `-- …`. */
const statement = VIEW_DDL.split(/\r?\n/).filter(l => !/^\s*--/.test(l)).join('\n').trim()
const header = /^CREATE\s+OR\s+REPLACE\s+VIEW\s+`?(\w+)`?\s+AS\s+SELECT\s+([\s\S]+?)\s+FROM\s+`?(\w+)`?\s+(\w+)\s+WHERE\s+([\s\S]+?);\s*$/i.exec(statement)
/** Nome da coluna de cada item da lista do SELECT (`a.\`x\`` ou `a.\`x\` AS \`y\`` → x / y). */
const selected = (header?.[2] ?? '').split(',').map(c => {
  const m = /(?:AS\s+)?`?(\w+)`?\s*$/i.exec(c.trim())
  return m ? m[1] : c.trim()
})

describe('vw_establishment_ibscbs_assessment (078) × contrato do núcleo (D-IB127/D-IB129)', () => {
  it('a 078 é UM `CREATE OR REPLACE VIEW` (re-executável) sobre a tabela da opção, com o nome do contrato', () => {
    expect(header).not.toBeNull()
    expect(statement.match(/;/g)).toHaveLength(1)
    expect(header![1]).toBe(ESTABLISHMENT_IBSCBS_ASSESSMENT_VIEW)
    expect(header![3]).toBe('tb_establishment_ibscbs_assessment')
  })

  it('as colunas, NA ORDEM, são as do contrato (`ESTABLISHMENT_IBSCBS_ASSESSMENT_COLUMNS`)', () => {
    expect(selected).toEqual(ESTABLISHMENT_IBSCBS_ASSESSMENT_COLUMNS.map(c => c[0]))
  })

  it('cada coluna vem direto da tabela (sem expressão nem renome) e a marcada `date` é DATE na 077', () => {
    for (const item of header![2].split(',')) expect(item.trim()).toMatch(new RegExp(`^${header![4]}\\.\`?\\w+\`?$`))
    for (const [column, , kind] of ESTABLISHMENT_IBSCBS_ASSESSMENT_COLUMNS) {
      const def = new RegExp(`^\\s*\`${column}\`\\s+(\\w+)`, 'm').exec(TABLE_DDL)
      expect(def).not.toBeNull()
      if (kind === 'date') expect(def![1].toUpperCase()).toBe('DATE')
    }
  })

  it('só as linhas VIVAS: o filtro é `deleted = \'N\'` e nada mais', () => {
    expect(header![5].replace(/`/g, '').replace(/\s+/g, ' ').trim()).toBe(`${header![4]}.deleted = 'N'`)
  })

  it('não publica autor, datas nem `deleted` (D-IB77) e não resolve a vigente: fundível, sem COALESCE/COLLATE (PADROES §11 regra 3)', () => {
    expect(selected).not.toEqual(expect.arrayContaining(['deleted']))
    for (const c of ['deleted', 'tb_user_id', 'created_at', 'updated_at', 'valid_until']) expect(selected).not.toContain(c)
    expect(statement).not.toMatch(/\b(?:COALESCE|IFNULL|COLLATE|GROUP\s+BY|DISTINCT|LIMIT|UNION|HAVING|ORDER\s+BY|MAX|MIN|EXISTS|JOIN)\b/i)
    expect(statement.match(/\bSELECT\b/gi)).toHaveLength(1)   // nenhuma subconsulta
  })
})
