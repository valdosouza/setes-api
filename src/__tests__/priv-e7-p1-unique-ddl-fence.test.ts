/// <reference types="jest" />
// D-PV43/D-PV63/A-PV28 (setes-api:PRIV.E7.P1.T1): os nomes do catálogo central são ÚNICOS NO BANCO — script central 77 (repositório sql),
// espelhado no canônico 01. Cerca de TEXTO (sem banco): o 77 e o 01 têm a MESMA coluna gerada e os MESMOS UNIQUE; o 77 confere as
// duplicatas ANTES do primeiro ALTER, decide pelo information_schema (sem DROP+ADD) e não grava dado; e nenhum escritor das duas tabelas
// usa `ON DUPLICATE KEY UPDATE` (PADROES §9 regra 10 — com um UNIQUE além da PK, a colisão no nome viraria UPDATE calado da linha que
// colidiu). A prova ao vivo é `scripts/prove-catalog-unique-names.ts` (setes_central descartável).
import fs from 'fs'
import path from 'path'

const SQL_DIR = path.resolve(process.env.SQL_DIR ?? path.join(__dirname, '..', '..', '..', 'sql'))
const ROOT = path.join(__dirname, '..', '..')
const read = (file: string) => fs.readFileSync(path.join(SQL_DIR, file), 'utf8').replace(/\r\n/g, '\n')
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
const S77 = '77_catalog_unique_names_ddl.sql'
const GENERATED = "varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci GENERATED ALWAYS AS (CASE WHEN `deleted` = 'N' THEN `i18n_key` END) STORED"

function canonicalTable(table: string): string {
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS \`${table}\` \\(([\\s\\S]*?)\\n\\) ENGINE`).exec(read('01_setes_central_ddl.sql'))
  expect(m).not.toBeNull()
  return m![1].replace(/--[^\n]*/g, '')
}
function walk(dir: string, exts: string[], skip: (p: string) => boolean = () => false): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (skip(p)) return []
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p, exts, skip)
    return exts.some(x => e.name.endsWith(x)) ? [p] : []
  })
}
// INSERT nas DUAS tabelas (não nas filhas `_has_`) seguido de ON DUPLICATE KEY UPDATE no mesmo comando (até o `;` do SQL ou o próximo
// INSERT — sem teto curto: um seed de muitas linhas cabe; re-gate L2); ou REPLACE INTO nelas (com um
// UNIQUE além da PK, apaga FISICAMENTE a linha que colidiu — §3.1; gate socrático, L4)
const UPSERT = /INSERT\s+(?:IGNORE\s+)?INTO\s+\S*?\btb_(?:interface|privilege)\b(?:(?!INSERT\s)[^;]){0,20000}?ON\s+DUPLICATE\s+KEY\s+UPDATE|REPLACE\s+INTO\s+\S*?\btb_(?:interface|privilege)\b(?!_)/gi

describe('PRIV.E7.P1 — script central 77 × canônico 01', () => {
  it('o repositório sql foi achado (cerca que pula não cerca — defina SQL_DIR)', () => {
    expect(fs.existsSync(path.join(SQL_DIR, S77))).toBe(true)
  })

  it('a coluna gerada é a MESMA nos dois (STORED, colação explícita, só as vivas)', () => {
    expect(flat(read(S77))).toContain(`ADD COLUMN \`i18n_key_live\` ${GENERATED}`.replace(/'/g, "''"))
    expect(flat(canonicalTable('tb_interface'))).toContain(`\`i18n_key_live\` ${GENERATED}`)
  })

  it('os dois UNIQUE são os MESMOS nos dois; o do verbo vale em TODAS as linhas (sem coluna gerada)', () => {
    const s = flat(read(S77))
    expect(s).toContain('ADD UNIQUE KEY `uq_interface_i18n_key_live` (`i18n_key_live`)')
    expect(s).toContain('ADD UNIQUE KEY `uq_privilege_description` (`description`)')
    expect(flat(canonicalTable('tb_interface'))).toContain('UNIQUE KEY `uq_interface_i18n_key_live` (`i18n_key_live`)')
    expect(flat(canonicalTable('tb_privilege'))).toContain('UNIQUE KEY `uq_privilege_description` (`description`)')
    expect(canonicalTable('tb_privilege')).not.toMatch(/GENERATED/i)
  })

  it('a pré-conferência (chave viva e verbo em qualquer linha) vem ANTES do primeiro ALTER', () => {
    const s = read(S77).replace(/--[^\n]*/g, '')
    const firstAlter = s.search(/ALTER TABLE/)
    expect(s.indexOf('SQL77_FALHOU_chave_viva_repetida')).toBeGreaterThan(-1)
    expect(s.indexOf('SQL77_FALHOU_chave_viva_repetida')).toBeLessThan(firstAlter)
    expect(s.indexOf('SQL77_FALHOU_verbo_repetido')).toBeLessThan(firstAlter)
    // o verbo é conferido em TODAS as linhas; a chave só entre as vivas
    const verb = /SET @sql77_dup_verb[\s\S]*?;/.exec(s)![0]
    expect(verb).not.toMatch(/deleted/)
    expect(/SET @sql77_dup_key[\s\S]*?;/.exec(s)![0]).toMatch(/`deleted` = 'N'/)
  })

  it('o 77 decide pelo information_schema: sem DROP, sem IF NOT EXISTS, sem gravar dado', () => {
    const s = read(S77).replace(/--[^\n]*/g, '')
    expect(s).not.toMatch(/\bDROP\b/i)
    expect(s).not.toMatch(/IF NOT EXISTS/i)
    expect(s).not.toMatch(/^\s*(UPDATE|DELETE|INSERT|REPLACE|TRUNCATE)\b/im)
    for (const marker of ['coluna_i18n_key_live_com_outra_forma', 'indice_uq_interface_i18n_key_live_com_outra_forma',
      'indice_uq_privilege_description_com_outra_forma', 'conferencia_dos_nomes_unicos']) {
      expect(s).toContain(`SQL77_FALHOU_${marker}`)
    }
  })

  it('§9 regra 10 + §3.1: nenhum ON DUPLICATE KEY UPDATE nem REPLACE INTO em tb_interface/tb_privilege (src, scripts e o repositório sql)', () => {
    const files = [
      ...walk(path.join(ROOT, 'src'), ['.ts'], p => p.includes(`${path.sep}__tests__${path.sep}`)),
      ...walk(path.join(ROOT, 'scripts'), ['.ts']),
      ...walk(SQL_DIR, ['.sql']),
    ]
    expect(files.length).toBeGreaterThan(50)
    const hits = files.flatMap(f => [...fs.readFileSync(f, 'utf8').matchAll(UPSERT)].map(m => `${path.relative(ROOT, f)}: ${m[0].slice(0, 60)}`))
    expect(hits).toEqual([])
  })

  it('o detector de upsert pega o caso proibido e deixa passar a filha `_has_`', () => {
    const hit = (s: string) => [...s.matchAll(UPSERT)].length
    expect(hit("INSERT INTO setes_central.tb_privilege (id, description) VALUES (1, 'X') ON DUPLICATE KEY UPDATE description = 'X'")).toBe(1)
    expect(hit('INSERT INTO `tb_interface` (id) VALUES (1)\n  ON DUPLICATE KEY UPDATE deleted = \'N\'')).toBe(1)
    expect(hit('INSERT INTO setes_central.tb_interface_has_privilege (a, b) VALUES (1, 2) ON DUPLICATE KEY UPDATE active = \'S\'')).toBe(0)
    expect(hit("REPLACE INTO `tb_privilege` (id, description) VALUES (5, 'FATURAR')")).toBe(1)
    // seed longo (mais de 800 caracteres entre o INSERT e o ON DUPLICATE), com crases nos identificadores — re-gate L2
    const rows = Array.from({ length: 60 }, (_, i) => `(${i}, 'VERBO${i}', NOW(), NOW(), 'N')`).join(',\n')
    expect(hit(`INSERT IGNORE INTO \`tb_privilege\` (\`id\`, \`description\`, \`created_at\`, \`updated_at\`, \`deleted\`) VALUES\n${rows}\nON DUPLICATE KEY UPDATE \`deleted\` = 'N';`)).toBe(1)
    // e não atravessa o `;` para o comando seguinte
    expect(hit("INSERT INTO `tb_privilege` (id) VALUES (1);\nINSERT INTO `tb_interface_has_privilege` (a) VALUES (1) ON DUPLICATE KEY UPDATE a = 1;")).toBe(0)
    expect(hit('REPLACE INTO setes_central.tb_interface_has_privilege (a, b) VALUES (1, 2)')).toBe(0)
  })
})
