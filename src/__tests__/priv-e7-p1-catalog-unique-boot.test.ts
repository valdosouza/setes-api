/// <reference types="jest" />
// D-PV43 ("a sonda do UNIQUE pelo NOME no boot") + D-PV63 (setes-api:PRIV.E7.P1.T1): sem a coluna gerada na forma, sem os dois UNIQUE do
// script 77 ou com outro UNIQUE além da PK e destes, o setes-api NÃO sobe. Banco dublado; a mesma sonda roda contra o descartável na prova
// (`scripts/prove-catalog-unique-names.ts`, B9/B10). E o 1062 dos dois índices é reconhecido pelo NOME (a corrida vira o 409 legível).
import fs from 'fs'
import path from 'path'
import {
  assertCatalogUniqueNames, catalogUniqueViolated, INTERFACE_KEY_UNIQUE, PRIVILEGE_NAME_UNIQUE,
} from '../shared/auth/catalog-unique'

const GOOD_COL = {
  type: 'varchar', len: 100, coll: 'utf8mb4_general_ci', extra: 'STORED GENERATED',
  expr: "case when `deleted` = 'N' then `i18n_key` end",
}
const GOOD_IDX = [
  { t: 'tb_interface', name: INTERFACE_KEY_UNIQUE, col: 'i18n_key_live', seq: 1, sub: null, type: 'BTREE' },
  { t: 'tb_privilege', name: PRIVILEGE_NAME_UNIQUE, col: 'description', seq: 1, sub: null, type: 'BTREE' },
]
const GOOD_BASE = [
  { t: 'tb_interface', c: 'i18n_key', coll: 'utf8mb4_general_ci' },
  { t: 'tb_privilege', c: 'description', coll: 'utf8mb4_general_ci' },
]
function db(col: Record<string, unknown> | null, idx: Record<string, unknown>[], base: Record<string, unknown>[] = GOOD_BASE) {
  return { query: jest.fn().mockResolvedValueOnce([col ? [col] : []]).mockResolvedValueOnce([base]).mockResolvedValueOnce([idx]) } as any
}

describe('PRIV.E7.P1 — a sonda do boot (script 77)', () => {
  it('na forma: "ok", lendo o information_schema do setes_central', async () => {
    const q = db(GOOD_COL, GOOD_IDX)
    await expect(assertCatalogUniqueNames(q)).resolves.toBe('ok (coluna gerada e 2 UNIQUE)')
    expect(q.query.mock.calls[0][1]).toEqual(['setes_central', 'i18n_key_live'])
    expect(q.query.mock.calls[1][1]).toEqual(['setes_central'])
    expect(q.query.mock.calls[2][1]).toEqual(['setes_central'])
  })

  it('a expressão: crase, aspas, caixa e espaços não importam; a grafia do MySQL 8 (introducer) recusa alto até a F3', async () => {
    await expect(assertCatalogUniqueNames(db({ ...GOOD_COL, expr: "(case when (`deleted` = _utf8mb4\\'N\\') then `i18n_key` end)" }, GOOD_IDX)))
      .rejects.toThrow(/outra forma/)   // a do MySQL 8 traz o introducer: recusa alta (a ida ao MySQL 8 — F3 — revê, PADROES §11 regra 11 (c))
    await expect(assertCatalogUniqueNames(db({ ...GOOD_COL, expr: 'CASE WHEN "deleted" = \'N\' THEN "i18n_key" END' }, GOOD_IDX)))
      .resolves.toMatch(/^ok/)
  })

  it.each([
    ['sem a coluna', null, GOOD_IDX, /sem a coluna i18n_key_live/],
    ['coluna VIRTUAL', { ...GOOD_COL, extra: 'VIRTUAL GENERATED' }, GOOD_IDX, /outra forma/],
    ['coluna binária', { ...GOOD_COL, coll: 'utf8mb4_bin' }, GOOD_IDX, /outra forma/],
    ['expressão sem o filtro das vivas', { ...GOOD_COL, expr: '`i18n_key`' }, GOOD_IDX, /outra forma/],
    ['sem o UNIQUE da chave', GOOD_COL, [GOOD_IDX[1]], /tb_interface sem o UNIQUE uq_interface_i18n_key_live/],
    ['sem o UNIQUE do verbo', GOOD_COL, [GOOD_IDX[0]], /tb_privilege sem o UNIQUE uq_privilege_description/],
    ['UNIQUE do verbo composto', GOOD_COL, [GOOD_IDX[0], GOOD_IDX[1], { ...GOOD_IDX[1], col: 'id', seq: 2 }], /uq_privilege_description com outra forma/],
    ['UNIQUE do verbo com prefixo', GOOD_COL, [GOOD_IDX[0], { ...GOOD_IDX[1], sub: 10 }], /uq_privilege_description com outra forma/],
    ['UNIQUE da chave sobre i18n_key (todas as linhas)', GOOD_COL, [{ ...GOOD_IDX[0], col: 'i18n_key' }, GOOD_IDX[1]], /uq_interface_i18n_key_live com outra forma/],
    ['UNIQUE a mais (§9 regra 10)', GOOD_COL, [...GOOD_IDX, { t: 'tb_interface', name: 'uq_x', col: 'description', seq: 1, sub: null }], /UNIQUE a mais.*tb_interface\.uq_x/],
    ['UNIQUE do verbo USING HASH (gate adversarial)', GOOD_COL, [GOOD_IDX[0], { ...GOOD_IDX[1], type: 'HASH' }], /uq_privilege_description com outra forma/],
    ['nome do índice em MAIÚSCULAS (homônimo sem caixa)', GOOD_COL, [GOOD_IDX[0], { ...GOOD_IDX[1], name: 'UQ_PRIVILEGE_DESCRIPTION' }], /sem o UNIQUE uq_privilege_description/],
    ['o nome certo na tabela errada', GOOD_COL, [GOOD_IDX[0], GOOD_IDX[1], { t: 'tb_interface', name: PRIVILEGE_NAME_UNIQUE, col: 'description', seq: 1, sub: null }], /UNIQUE a mais/],
  ])('%s → o boot não sobe, apontando o script 77', async (_l, col, idx, msg) => {
    const p = assertCatalogUniqueNames(db(col as any, idx as any))
    await expect(p).rejects.toThrow(msg as RegExp)
    await expect(assertCatalogUniqueNames(db(col as any, idx as any))).rejects.toThrow(/sql\/77_catalog_unique_names_ddl\.sql/)
  })

  it.each([
    ['description em utf8mb4_bin', [GOOD_BASE[0], { ...GOOD_BASE[1], coll: 'utf8mb4_bin' }], /tb_privilege\.description fora da colação/],
    ['i18n_key em utf8mb4_bin', [{ ...GOOD_BASE[0], coll: 'utf8mb4_bin' }, GOOD_BASE[1]], /tb_interface\.i18n_key fora da colação/],
    ['coluna-base ausente', [GOOD_BASE[0]], /tb_privilege\.description fora da colação utf8mb4_general_ci \(ausente\)/],
  ])('gate adversarial (MEDIUM): %s → o boot não sobe (a colação É a regra do UNIQUE)', async (_l, base, msg) => {
    await expect(assertCatalogUniqueNames(db(GOOD_COL, GOOD_IDX, base as any))).rejects.toThrow(msg as RegExp)
  })

  it('o server.ts chama a sonda no boot, depois da do script 76', () => {
    const s = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8')
    const at = s.indexOf('await assertCatalogUniqueNames()')
    expect(at).toBeGreaterThan(s.indexOf('await assertPasswordAuthorSchema()'))
    expect(s.indexOf('await assertPasswordAuthorSchema()')).toBeGreaterThan(-1)
  })
})

describe('PRIV.E7.P1 — o 1062 dos dois índices, pelo nome', () => {
  it('MariaDB e MySQL 8; outro índice, outro erro e nada → null', () => {
    expect(catalogUniqueViolated({ errno: 1062, message: "Duplicate entry 'orders' for key 'uq_interface_i18n_key_live'" })).toBe('interface-key')
    expect(catalogUniqueViolated({ code: 'ER_DUP_ENTRY', message: "Duplicate entry 'X' for key 'tb_privilege.uq_privilege_description'" })).toBe('privilege-name')
    expect(catalogUniqueViolated({ errno: 1062, message: "Duplicate entry '7' for key 'PRIMARY'" })).toBeNull()
    expect(catalogUniqueViolated({ errno: 1205, message: 'uq_privilege_description' })).toBeNull()
    expect(catalogUniqueViolated(null)).toBeNull()
    expect(catalogUniqueViolated(new Error('x'))).toBeNull()
    // o VALOR digitado vem na mensagem: o nome do outro índice dentro dele não engana (ancorado no fim — gate socrático, L3)
    expect(catalogUniqueViolated({ errno: 1062, message: "Duplicate entry 'uq_interface_i18n_key_live' for key 'uq_privilege_description'" }))
      .toBe('privilege-name')
    expect(catalogUniqueViolated({ errno: 1062, message: "Duplicate entry 'x' for key 'uq_privilege_description_old'" })).toBeNull()
  })
})
