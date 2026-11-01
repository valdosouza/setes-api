/// <reference types="jest" />
// Gate adversarial do delta D-IB103 (2026-11-01, prompt_fase_ibs_cbs.md §14.6) — PARTE VIVA, opt-in `IB99_ADV_LIVE=1`: schema DESCARTÁVEL
// `setes_ib99_d103_jest_*` criado e APAGADO aqui (só leitura em setes_setes). ADV-D103-01 (custo da fronteira sob a trava: O(1) linhas lidas),
// o critério "nota do ERP web" (evento E) e ADV-D103-02 (o cabeçalho reescrito pelo sincronizador não move a fronteira).
import fs from 'fs'
import path from 'path'

const API = path.join(__dirname, '..', '..')
const live = process.env.IB99_ADV_LIVE === '1'

;(live ? describe : describe.skip)('ao vivo — D-IB103: fronteira = última nota viva do ERP web', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(require.resolve('dotenv', { paths: [API] })).config({ path: path.join(API, '.env') })
  let pool: any, lastErpWebEmissionDate: (q: any, s: string, i: number) => Promise<string | null>, splitStatements: (sql: string) => string[]
  // a 076 REAL (o índice da fronteira entra junto)
  const MIGRATION = path.join(API, 'src/migrations/sql/076_establishment_ibscbs_assessment.sql')
  const S = `setes_ib99_d103_jest_${Date.now().toString(36)}`

  beforeAll(async () => {
    pool = require('@shared/db/connection').default
    lastErpWebEmissionDate = require('@shared/invoice/emission-date').lastErpWebEmissionDate
    splitStatements = require(path.join(API, 'src/migrations/runner')).splitStatements
    await pool.query(`CREATE DATABASE \`${S}\``)
  }, 30000)
  afterAll(async () => { await pool.query(`DROP DATABASE IF EXISTS \`${S}\``); await pool.end() })
  beforeEach(async () => {
    for (const t of ['tb_invoice', 'tb_invoice_event']) {
      await pool.query(`DROP TABLE IF EXISTS \`${S}\`.${t}`)
      await pool.query(`CREATE TABLE \`${S}\`.${t} LIKE setes_setes.${t}`)
    }
    const c = await pool.getConnection()
    try {
      await c.query(`USE \`${S}\``)
      await c.query('DROP TABLE IF EXISTS tb_establishment_ibscbs_assessment')
      for (const st of splitStatements(fs.readFileSync(MIGRATION, 'utf8'))) await c.query(st)
    } finally { c.release() }
  }, 30000)

  const header = (id: number, day: string, o: { terminal?: number; issuer?: number; deleted?: 'N' | 'S' } = {}) => pool.query(
    `INSERT INTO \`${S}\`.tb_invoice (id, tb_institution_id, terminal, issuer, tb_entity_id, dt_emission, status, deleted) VALUES (?, 1, ?, ?, 1, ?, '0', ?)
     ON DUPLICATE KEY UPDATE dt_emission = VALUES(dt_emission), issuer = VALUES(issuer), deleted = VALUES(deleted)`,
    [id, o.terminal ?? 0, o.issuer ?? 1, day, o.deleted ?? 'N'])
  const event = (id: number, ev: number, kind: 'E' | 'C', day: string, terminal = 0) => pool.query(
    `INSERT INTO \`${S}\`.tb_invoice_event (tb_institution_id, tb_invoice_id, terminal, event, kind, dt_record) VALUES (1, ?, ?, ?, ?, ?)`,
    [id, terminal, ev, kind, day])
  const frontier = () => lastErpWebEmissionDate(pool, S, 1)

  it('ADV-D103-01: a fronteira lê O(1) linhas — não materializa os eventos do ERP web nem varre as notas mais novas do ERP Desktop', async () => {
    // 20 mil notas do ERP web (antigas, com E) + 20 mil do ERP Desktop MAIS NOVAS (sem E) — o cliente misto da D-IB103
    await pool.query(`INSERT INTO \`${S}\`.tb_invoice (id, tb_institution_id, terminal, issuer, tb_entity_id, dt_emission, status, model)
      SELECT seq, 1, 0, 1, 1, DATE_ADD('2027-01-01', INTERVAL (seq % 29) DAY), '0', 'SE' FROM seq_1_to_20000`)
    await pool.query(`INSERT INTO \`${S}\`.tb_invoice_event (tb_institution_id, tb_invoice_id, terminal, event, kind, dt_record)
      SELECT 1, seq, 0, 1, 'E', DATE_ADD('2027-01-01', INTERVAL (seq % 29) DAY) FROM seq_1_to_20000`)
    await pool.query(`INSERT INTO \`${S}\`.tb_invoice (id, tb_institution_id, terminal, issuer, tb_entity_id, dt_emission, status, model)
      SELECT 100000 + seq, 1, 0, 99, 1, DATE_ADD('2027-02-01', INTERVAL (seq % 29) DAY), 'F', '65' FROM seq_1_to_20000`)
    await pool.query(`ANALYZE TABLE \`${S}\`.tb_invoice, \`${S}\`.tb_invoice_event`)
    // a consulta EXATA que a função emite (espião no Queryable), medida por ANALYZE (linhas lidas de verdade, não a estimativa)
    const seen: string[] = []
    const spy = { query: (sql: string, p?: unknown[]) => { seen.push(pool.format(sql, p)); return pool.query(sql, p) } }
    expect(await lastErpWebEmissionDate(spy, S, 1)).toBe('2027-01-29')
    const [r] = await pool.query(`ANALYZE FORMAT=JSON ${seen[0]}`)
    // pelo TEXTO: o ANALYZE FORMAT=JSON do MariaDB 10.4 repete a chave "table" no mesmo bloco (o JSON.parse perderia a 1ª tabela)
    const read = String(r[0].ANALYZE).split('"table_name":').slice(1).map(chunk => ({
      table: /^\s*"([^"]+)"/.exec(chunk)![1],
      rows: Number(/"r_loops":\s*([0-9.]+)/.exec(chunk)?.[1] ?? 1) * Number(/"r_rows":\s*([0-9.]+)/.exec(chunk)?.[1] ?? 0),
    }))
    console.log(`ADV-D103-01 linhas lidas: ${JSON.stringify(read)}`)
    expect(JSON.stringify(read)).not.toMatch(/subquery/)                       // nada materializado
    expect(read.reduce((s, t) => s + t.rows, 0)).toBeLessThanOrEqual(50)    // sob a trava: O(1), nunca O(notas)
  }, 120000)

  it('critério: revivida conta pela vida nova; pendente cancelada não conta; autorizada cancelada conta; PDV com o mesmo id não conta', async () => {
    await header(1, '2027-03-10'); await event(1, 1, 'E', '2027-03-10')                 // web
    await header(2, '2027-03-12', { deleted: 'S' }); await event(2, 1, 'E', '2027-03-12'); await event(2, 2, 'C', '2027-03-12')   // pendente cancelada
    expect(await frontier()).toBe('2027-03-10')
    await header(2, '2027-03-14'); await event(2, 3, 'E', '2027-03-14')                 // revivida (E1, C2, E3)
    expect(await frontier()).toBe('2027-03-14')
    await header(3, '2027-03-15'); await event(3, 1, 'E', '2027-03-15'); await event(3, 2, 'C', '2027-03-15')   // autorizada cancelada (viva)
    expect(await frontier()).toBe('2027-03-15')
    await header(3, '2062-06-20', { terminal: 2, issuer: 99 })                          // PDV do ERP Desktop com o MESMO id, outro terminal
    await header(9, '2062-06-20', { issuer: 99 })                                       // ERP Desktop, terminal 0, sem E
    expect(await frontier()).toBe('2027-03-15')
  })

  it('ADV-D103-02 (FECHADO): o sincronizador reescrevendo o cabeçalho de uma nota do ERP web (mesmo id/terminal 0) NÃO move a fronteira', async () => {
    await header(5, '2027-03-10'); await event(5, 1, 'E', '2027-03-10')                 // nota do ERP web
    await header(5, '2062-06-20', { issuer: 99 })                                       // o upsert do sync na MESMA PK (id do ERP Desktop alcançou o da web)
    expect(await frontier()).toBe('2027-03-10')                                         // a fronteira é a data que a nota do ERP web LEU (o evento E)
  })
})
