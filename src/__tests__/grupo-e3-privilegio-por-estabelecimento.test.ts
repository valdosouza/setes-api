/// <reference types="jest" />
// D-GE3 (frente do grupo de estabelecimentos, Rodada 1, Valdo 2026-10-18 — passo setes-api:GRUPO.E3.P1): o privilégio é POR
// ESTABELECIMENTO. Com duas institutions no MESMO schema (o grupo), a concessão dada na matriz NÃO vale na filial — nem na leitura do
// cadastro de privilégios, nem na escrita (conceder e revogar numa não toca a outra), nem no veredito (a `vw_user_access` da 076).
// O pool é MOCKADO pela fixture `two-institutions`: só os predicados de institution que o PRÓPRIO SQL expressa são aplicados — sem o
// predicado o leitor recebe o schema inteiro, como o MySQL faria. A prova contra o banco real é o `scripts/prove-user-access-views.ts`.
import fs from 'fs'
import path from 'path'
import pool from '../shared/db/connection'
import {
  listUserPrivileges, listDelegableSuperPrivileges, setUserPrivileges,
} from '../modules/users/users.repository'
import { GROUP_SCHEMA, MATRIZ, FILIAL, normalizeSql, paramOf, scopedByInstitution } from '../test-setup/two-institutions'

jest.mock('../shared/db/connection', () => {
  const conn = { query: jest.fn(), beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
  return { __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(async () => conn), __conn: conn } }
})
const mockQuery = (pool as any).query as jest.Mock
const mockConn = (pool as any).__conn as { query: jest.Mock }

const USER = 9
const IFACE = 40
const TRANSMITIR = 9
const VISUALIZAR = 6

/** A concessão do usuário: TRANSMITIR e VISUALIZAR dados SÓ na matriz. */
const GRANTS = [
  { tb_institution_id: MATRIZ, tb_user_id: USER, tb_interface_id: IFACE, tb_privilege_id: TRANSMITIR },
  { tb_institution_id: MATRIZ, tb_user_id: USER, tb_interface_id: IFACE, tb_privilege_id: VISUALIZAR },
]

/** Dublê da leitura do cadastro: uma linha por par do catálogo, `granted` pelo que sobra da concessão DEPOIS dos predicados do SQL. */
function catalogAnswer(sql: string, params: unknown[]): unknown {
  const grants = scopedByInstitution(sql, params, 'uhp', GRANTS)
  return [[TRANSMITIR, VISUALIZAR].map(privilegeId => ({
    interfaceId: IFACE, description: 'Notas', i18nKey: 'orders', groupDefault: 'Fiscal', moduleNames: null,
    privilegeId, privilegeDescription: privilegeId === TRANSMITIR ? 'TRANSMITIR' : 'VISUALIZAR',
    granted: grants.some(g => g.tb_privilege_id === privilegeId) ? 'S' : 'N',
  }))]
}

const grantedOf = (rows: Awaited<ReturnType<typeof listUserPrivileges>>) =>
  rows.flatMap(r => r.privileges.filter(p => p.granted === 'S').map(p => p.description)).sort()

beforeEach(() => {
  mockQuery.mockReset()
  mockConn.query.mockReset()
  mockConn.query.mockResolvedValue([{ affectedRows: 0 }])
})

describe('T3 — o privilégio dado na matriz NÃO vale na filial (duas institutions no mesmo schema)', () => {
  it('cadastro de privilégios: a matriz vê TRANSMITIR e VISUALIZAR; a filial, nada', async () => {
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => catalogAnswer(sql, params))
    expect(grantedOf(await listUserPrivileges(GROUP_SCHEMA, MATRIZ, USER, []))).toEqual(['TRANSMITIR', 'VISUALIZAR'])
    expect(grantedOf(await listUserPrivileges(GROUP_SCHEMA, FILIAL, USER, []))).toEqual([])
  })

  it('a concessão é lida pela institution ALVO (o predicado está no SQL, ligado ao parâmetro da institution pedida)', async () => {
    mockQuery.mockResolvedValue([[]])
    await listUserPrivileges(GROUP_SCHEMA, FILIAL, USER, [])
    const [sql, params] = mockQuery.mock.calls[0]
    expect(paramOf(sql, params, 'uhp.tb_institution_id')).toBe(FILIAL)
    expect(paramOf(sql, params, 'ihi.tb_institution_id')).toBe(FILIAL)
  })

  it('tela do Super delegável: a concessão também é da institution alvo', async () => {
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => catalogAnswer(sql, params))
    expect(grantedOf(await listDelegableSuperPrivileges(GROUP_SCHEMA, MATRIZ, USER, ['orders']))).toEqual(['TRANSMITIR', 'VISUALIZAR'])
    expect(grantedOf(await listDelegableSuperPrivileges(GROUP_SCHEMA, FILIAL, USER, ['orders']))).toEqual([])
  })

  it('conceder na filial grava a linha DA FILIAL e revogar o resto só mexe na filial (a matriz fica como estava)', async () => {
    await setUserPrivileges(GROUP_SCHEMA, FILIAL, USER, IFACE, [VISUALIZAR])
    const [insert, revoke] = mockConn.query.mock.calls
    expect(normalizeSql(insert[0])).toMatch(/INSERT INTO setes_acme\.tb_user_has_privilege \(tb_user_id, tb_institution_id, tb_interface_id, tb_privilege_id,/)
    expect(insert[1]).toEqual([USER, FILIAL, IFACE, VISUALIZAR])
    expect(normalizeSql(revoke[0])).toMatch(/^UPDATE setes_acme\.tb_user_has_privilege SET active = 'N'/)
    expect(paramOf(revoke[0], revoke[1], 'tb_institution_id')).toBe(FILIAL)
  })

  it('revogar tudo na filial não toca a matriz', async () => {
    await setUserPrivileges(GROUP_SCHEMA, FILIAL, USER, IFACE, [])
    const [revoke] = mockConn.query.mock.calls
    expect(normalizeSql(revoke[0])).toMatch(/^UPDATE setes_acme\.tb_user_has_privilege SET active = 'N'/)
    expect(paramOf(revoke[0], revoke[1], 'tb_institution_id')).toBe(FILIAL)
  })
})

describe('T1/T2 — a chave e o veredito (cercas sobre o SQL que vai ao banco)', () => {
  const SQL_DIR = path.join(__dirname, '..', 'migrations', 'sql')
  const read = (file: string) => fs.readFileSync(path.join(SQL_DIR, file), 'utf8').replace(/\r\n/g, '\n')

  /** A ÚLTIMA migration que (re)define a view é a definição que vale no banco. */
  function lastDefinitionOf(view: string): string {
    const files = fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql')).sort()
    const defining = files.filter(f => new RegExp(`VIEW \`${view}\` AS`).test(read(f)))
    expect(defining.length).toBeGreaterThan(0)
    return read(defining[defining.length - 1])
  }

  it('a 076 põe a institution na chave primária, com o usuário na frente (índice da fk do usuário) e a fk da institution', () => {
    const sql = read('076_user_privilege_by_institution.sql')
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS `tb_institution_id` INT NULL/)
    expect(sql).toMatch(/MODIFY COLUMN `tb_institution_id` INT NOT NULL,\s*DROP PRIMARY KEY,\s*ADD PRIMARY KEY \(`tb_user_id`, `tb_institution_id`, `tb_interface_id`, `tb_privilege_id`\)/)
    expect(sql).toMatch(/REFERENCES `setes_central`\.`tb_institution` \(`id`\)/)
  })

  it('o preenchimento NUNCA copia para mais de uma institution: subconsulta escalar (2 institutions vivas no schema = erro, boot para)', () => {
    const sql = read('076_user_privilege_by_institution.sql')
    expect(sql).toMatch(/SET `tb_institution_id` = \(SELECT i\.`id`\s+FROM `setes_central`\.`tb_institution` i\s+WHERE i\.`schema_name` = DATABASE\(\)\s+AND i\.`deleted` = 'N'\)\s+WHERE `tb_institution_id` IS NULL/)
    expect(sql).not.toMatch(/INSERT INTO `tb_user_has_privilege`/)
  })

  it('a vw_user_access que vale (a última definição) só aceita a concessão da MESMA institution do alcance', () => {
    const view = lastDefinitionOf('vw_user_access')
    expect(view).toMatch(/LEFT JOIN `tb_user_has_privilege` g\s+ON g\.`tb_user_id` = r\.`tb_user_id`\s+AND g\.`tb_institution_id` = r\.`tb_institution_id`/)
  })

  it('a cerca pega o leitor que filtra a institution de OUTRA tabela juntada, não a da concessão', () => {
    const leak = "LEFT JOIN `x`.tb_user_has_privilege uhp ON uhp.tb_user_id = ? WHERE ihi.tb_institution_id = ?`,"
    const m = /tb_user_has_privilege(?:\s+(?:AS\s+)?(\w+))?([\s\S]*?)`\s*[,)]/i.exec(leak)!
    expect(m[1]).toBe('uhp')
    expect(new RegExp(`\\b${m[1]}\\.tb_institution_id\\s*=`).test(m[0])).toBe(false)
  })

  it('o boot reconhece a linha da D-GE3 na definição que o MariaDB guarda da view', () => {
    const { GRANT_BY_INSTITUTION } = jest.requireActual('../shared/access') as typeof import('../shared/access')
    expect(GRANT_BY_INSTITUTION.test('left join `s`.`tb_user_has_privilege` `g` on(`g`.`tb_user_id` = `r`.`tb_user_id` and '
      + '`g`.`tb_institution_id` = `r`.`tb_institution_id` and `g`.`tb_interface_id` = `ihp`.`tb_interface_id`')).toBe(true)
    expect(GRANT_BY_INSTITUTION.test('left join `s`.`tb_user_has_privilege` `g` on(`g`.`tb_user_id` = `r`.`tb_user_id` and '
      + '`g`.`tb_interface_id` = `ihp`.`tb_interface_id`')).toBe(false)
  })

  it('todo SQL do código de produto que toca tb_user_has_privilege nomeia a institution', () => {
    const ROOT = path.join(__dirname, '..')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { if (!['__tests__', 'test-setup', 'migrations'].includes(e.name)) walk(p); continue }
        if (!e.name.endsWith('.ts')) continue
        // sem comentários; de cada menção à tabela até o FIM do literal SQL (crase seguida de `,` ou `)`). Com apelido (`... uhp`), a
        // institution tem de vir PELO apelido (`uhp.tb_institution_id`) — a de outra tabela juntada não serve (gate socrático, achado 3);
        // sem apelido (INSERT/UPDATE), a coluna nua.
        const code = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
        for (const m of code.matchAll(/tb_user_has_privilege(?:\s+(?:AS\s+)?(\w+))?([\s\S]*?)`\s*[,)]/gi)) {
          const alias = m[1] && !/^(SET|WHERE|ON|VALUES|LIMIT|AND|OR|INNER|LEFT|JOIN|GROUP|ORDER)$/i.test(m[1]) ? m[1] : null
          // sem apelido, a coluna pode vir ANTES da tabela (`SELECT tb_institution_id FROM … tb_user_has_privilege`)
          const ok = alias
            ? new RegExp(`\\b${alias}\\.tb_institution_id\\s*=`).test(m[0])
            : /(^|[^\w.])tb_institution_id\b/.test(code.slice(Math.max(0, (m.index ?? 0) - 120), m.index) + m[0])
          if (!ok) offenders.push(`${path.relative(ROOT, p)}: ${m[0].slice(0, 80)}`)
        }
      }
    }
    walk(ROOT)
    expect(offenders).toEqual([])
  })
})
