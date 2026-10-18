/// <reference types="jest" />
// D-PR43 (Valdo 2026-10-18: "só criar uma opção para desativar") — interruptor da chave do sincronizador no cadastro de Institutions
// (super): N = o estabelecimento sai do legado; S = religa a MESMA chave; nunca apaga (PADROES §3.1).
// Rodada 6 de produtos: o ato vira UMA transação — desligar avisa (Q-PR46 (a)) e cria "Serviços" sem S viva (Q-PR49 (a)); religar
// recusa 409 SYNC_KEY_WEB_ROWS quando a web criou linha nas tabelas do legado no período (Q-PR47 (a)); repetir o estado não muda nada.
import pool from '../shared/db/connection'
import { switchSyncApiKey, SYNC_OFF_NOTICE } from '../modules/institutions/institutions.service'
import { syncApiKeyActiveDto } from '../modules/institutions/institutions.dto'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn() } }))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
const mockQuery = (pool as any).query as jest.Mock
const mockGetConnection = (pool as any).getConnection as jest.Mock

type Route = [RegExp, (params: any[], sql: string) => any]
function conn(routes: Route[]) {
  const c: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      for (const [re, fn] of routes) if (re.test(sql)) return fn(params, sql)
      throw new Error(`SQL inesperado na transação: ${String(sql).slice(0, 90)}`)
    }),
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }
  mockGetConnection.mockResolvedValue(c)
  return c
}
const sqls = (c: any): string[] => c.query.mock.calls.map((x: any[]) => x[0] as string)
const NOW = new Date(Date.UTC(2026, 9, 18, 12, 0, 0))
const OFF_AT = new Date(Date.UTC(2026, 9, 18, 9, 0, 0))

beforeEach(() => {
  jest.clearAllMocks(); mockQuery.mockReset(); mockGetConnection.mockReset()
  mockQuery.mockImplementation(async (sql: string) => {
    if (/SELECT schema_name AS schemaName FROM setes_central\.tb_institution/.test(sql)) return [[{ schemaName: 'setes_setes' }]]
    if (/api_key AS apiKey/.test(sql)) return [[{ apiKey: 'k', establishmentCode: 'SETES_SETES', active: 'N' }]]
    throw new Error(`SQL inesperado no pool: ${String(sql).slice(0, 90)}`)
  })
})

const lock: Route = [/FROM setes_central\.tb_institution WHERE id = \? FOR UPDATE/, () => [[{ id: 1 }]]]
const keysOf = (rows: any[]): Route => [/FROM setes_central\.tb_sync_api_key\s+WHERE tb_institution_id = \? AND deleted = 'N' FOR UPDATE/, () => [rows]]
const update: Route = [/UPDATE setes_central\.tb_sync_api_key SET active/, () => [{ affectedRows: 1 }]]

describe('D-PR43 + Rodada 6 — desligar', () => {
  it('uma transação: trava da institution 1º, chave FOR UPDATE, "Serviços" 1 s antes do instante, UPDATE com o MESMO instante; aviso na resposta', async () => {
    const c = conn([
      lock, keysOf([{ id: 1, active: 'S', createdAt: OFF_AT, updatedAt: OFF_AT }]),
      [/SELECT NOW\(\) AS now/, () => [[{ now: NOW }]]],
      [/tb_category\s+WHERE tb_institution_id = \? AND kind = \? AND deleted = 'N' AND active = 'S' LIMIT 1 FOR UPDATE/, () => [[]]],
      [/MAX\(id\), 0\) \+ 1 AS nextId FROM `setes_setes`\.tb_category/, () => [[{ nextId: 10 }]]],
      [/INSERT INTO `setes_setes`\.tb_category/, () => [{}]],
      update,
    ])
    const row = await switchSyncApiKey(1, 'N', 7)
    expect(row).toMatchObject({ active: 'N', notice: SYNC_OFF_NOTICE, defaultServiceCategoryId: 10 })
    expect(SYNC_OFF_NOTICE).toMatch(/ANTES/)
    expect(SYNC_OFF_NOTICE).toMatch(/5 min/)
    const all = sqls(c)
    expect(all[0]).toMatch(/setes_central\.tb_institution WHERE id = \? FOR UPDATE/)
    const ins = c.query.mock.calls.find((x: any[]) => /INSERT INTO `setes_setes`\.tb_category/.test(x[0]))!
    expect(ins[1].slice(0, 5)).toEqual([10, 1, 'Serviços', '010', 'S'])
    expect((ins[1][5] as Date).getTime()).toBe(NOW.getTime() - 1000)
    const upd = c.query.mock.calls.find((x: any[]) => /UPDATE setes_central\.tb_sync_api_key/.test(x[0]))!
    expect(upd[0]).toContain("deleted = 'N' AND active <> ?")
    expect(upd[1]).toEqual(['N', NOW, 1, 'N'])
    expect(all.findIndex(s => /INSERT INTO `setes_setes`\.tb_category/.test(s)))
      .toBeLessThan(all.findIndex(s => /UPDATE setes_central\.tb_sync_api_key/.test(s)))
    expect(all.some(s => /\bDELETE\s+FROM\b|\bREPLACE\s+INTO\b/i.test(s))).toBe(false)
    expect(c.commit).toHaveBeenCalled()
  })

  it('com categoria S viva não cria outra (defaultServiceCategoryId null)', async () => {
    const c = conn([
      lock, keysOf([{ id: 1, active: 'S', createdAt: OFF_AT, updatedAt: OFF_AT }]),
      [/SELECT NOW\(\) AS now/, () => [[{ now: NOW }]]],
      [/kind = \? AND deleted = 'N' AND active = 'S' LIMIT 1 FOR UPDATE/, () => [[{ id: 3 }]]],
      update,
    ])
    const row = await switchSyncApiKey(1, 'N', 7)
    expect(row.defaultServiceCategoryId).toBeNull()
    expect(sqls(c).some(s => /INSERT INTO/.test(s))).toBe(false)
  })

  it('já desligada: nada muda (o instante do desligamento fica) — o aviso continua na resposta', async () => {
    const c = conn([lock, keysOf([{ id: 1, active: 'N', createdAt: OFF_AT, updatedAt: OFF_AT }])])
    const row = await switchSyncApiKey(1, 'N', 7)
    expect(row.notice).toBe(SYNC_OFF_NOTICE)
    expect(sqls(c).some(s => /^\s*(UPDATE|INSERT)\b/.test(s))).toBe(false)
    expect(c.rollback).toHaveBeenCalled()
  })

  it('estabelecimento sem chave: 404 SYNC_KEY_MISSING; inexistente: 404 sem abrir transação', async () => {
    conn([lock, keysOf([])])
    await expect(switchSyncApiKey(1, 'N', 7)).rejects.toMatchObject({ statusCode: 404, code: 'SYNC_KEY_MISSING' })
    mockQuery.mockImplementation(async () => [[]])
    mockGetConnection.mockClear()
    await expect(switchSyncApiKey(999, 'N', 7)).rejects.toMatchObject({ statusCode: 404 })
    expect(mockGetConnection).not.toHaveBeenCalled()
  })
})

describe('D-PR43 + Rodada 6 — religar (Q-PR47 (a))', () => {
  const born = (counts: Record<string, number>): Route[] => [
    [/SELECT COUNT\(\*\) AS n FROM `setes_setes`\.(tb_\w+) WHERE tb_institution_id = \? AND created_at >= \?/,
      (_p, sql) => [[{ n: counts[/\.(tb_\w+)/.exec(sql)![1]] ?? 0 }]]],
    [/SELECT id FROM `setes_setes`\.(tb_\w+) WHERE tb_institution_id = \? AND created_at >= \? ORDER BY id LIMIT 20/,
      (_p, sql) => [Array.from({ length: Math.min(20, counts[/\.(tb_\w+)/.exec(sql)![1]] ?? 0) }, (_, i) => ({ id: 80 + i }))]],
  ]

  it('nasceu linha na web desde o desligamento → 409 SYNC_KEY_WEB_ROWS com contagem e ids; nada gravado', async () => {
    const c = conn([lock, keysOf([{ id: 1, active: 'N', createdAt: new Date(0), updatedAt: OFF_AT }]), ...born({ tb_product: 2, tb_category: 1 })])
    await expect(switchSyncApiKey(1, 'S', 7)).rejects.toMatchObject({
      statusCode: 409, code: 'SYNC_KEY_WEB_ROWS',
      fields: [{ field: 'active', message: '2 produto(s)/serviço(s) (id 80, 81); 1 categoria(s) (id 80)' }],
    })
    const count = c.query.mock.calls.find((x: any[]) => /COUNT\(\*\) AS n FROM `setes_setes`\.tb_product/.test(x[0]))!
    expect(count[1]).toEqual([1, OFF_AT])                          // o instante do desligamento é o `updated_at` da chave
    expect(sqls(c).some(s => /UPDATE setes_central\.tb_sync_api_key/.test(s))).toBe(false)
    expect(c.rollback).toHaveBeenCalled()
    expect(c.commit).not.toHaveBeenCalled()
  })

  it('as 3 tabelas do legado são conferidas (produto/serviço, tabela de preço, categoria) — nenhuma linha → religa', async () => {
    const c = conn([lock, keysOf([{ id: 1, active: 'N', createdAt: new Date(0), updatedAt: OFF_AT }]), ...born({}), update])
    const row = await switchSyncApiKey(1, 'S', 7)
    expect(row.notice).toBeUndefined()
    const tables = c.query.mock.calls.filter((x: any[]) => /COUNT\(\*\) AS n/.test(x[0])).map((x: any[]) => /\.(tb_\w+)/.exec(x[0])![1])
    expect(tables).toEqual(['tb_product', 'tb_price_list', 'tb_category'])
    const upd = c.query.mock.calls.find((x: any[]) => /UPDATE setes_central\.tb_sync_api_key/.test(x[0]))!
    expect(upd[1]).toEqual(['S', null, 1, 'S'])
    expect(c.commit).toHaveBeenCalled()
  })

  it('chave desligada por SQL sem updated_at: o instante cai no created_at da chave (falha fechado)', async () => {
    const created = new Date(Date.UTC(2026, 7, 10, 15, 30, 9))
    const c = conn([lock, keysOf([{ id: 1, active: 'N', createdAt: created, updatedAt: null }]), ...born({}), update])
    await switchSyncApiKey(1, 'S', 7)
    const count = c.query.mock.calls.find((x: any[]) => /COUNT\(\*\) AS n FROM `setes_setes`\.tb_product/.test(x[0]))!
    expect(count[1]).toEqual([1, created])
  })

  it('já ligada: nada muda e nada é contado', async () => {
    const c = conn([lock, keysOf([{ id: 1, active: 'S', createdAt: OFF_AT, updatedAt: OFF_AT }])])
    await switchSyncApiKey(1, 'S', 7)
    expect(sqls(c)).toHaveLength(2)
  })
})

describe('corpo', () => {
  it('o corpo só aceita S ou N', () => {
    expect(syncApiKeyActiveDto.safeParse({ active: 'N' }).success).toBe(true)
    expect(syncApiKeyActiveDto.safeParse({ active: 'X' }).success).toBe(false)
    expect(syncApiKeyActiveDto.safeParse({}).success).toBe(false)
  })
})

describe('gate socrático R6 — o ato cunha id de categoria: reexecuta em deadlock', () => {
  it('1ª transação em deadlock → rollback e a 2ª conclui (o ato é idempotente)', async () => {
    const deadlocked: any = {
      query: jest.fn(async (sql: string) => {
        if (/FOR UPDATE WAIT|FROM setes_central\.tb_institution WHERE id = \? FOR UPDATE/.test(sql)) {
          throw Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 })
        }
        return [[]]
      }),
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    const ok: any = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        for (const [re, fn] of [lock, keysOf([{ id: 1, active: 'S', createdAt: OFF_AT, updatedAt: OFF_AT }]),
          [/SELECT NOW\(\) AS now/, () => [[{ now: NOW }]]] as Route,
          [/kind = \? AND deleted = 'N' AND active = 'S' LIMIT 1 FOR UPDATE/, () => [[{ id: 3 }]]] as Route, update] as Route[]) {
          if (re.test(sql)) return fn(params, sql)
        }
        throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`)
      }),
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    mockGetConnection.mockResolvedValueOnce(deadlocked).mockResolvedValueOnce(ok)
    const row = await switchSyncApiKey(1, 'N', 7)
    expect(row.active).toBe('N')
    expect(deadlocked.rollback).toHaveBeenCalled()
    expect(ok.commit).toHaveBeenCalled()
  })
})
