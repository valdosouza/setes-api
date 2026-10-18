/// <reference types="jest" />
// D-PR32 (= Q-PR32 (a), Valdo 2026-10-18 — prompt_modulo_products.md §18): gate TÉCNICO da D-PR14. Institution com sincronizador ATIVO
// só CONSULTA o cadastro de mercadorias na web; toda escrita (inclusive criar marca/unidade/embalagem na central) = 409.
import pool from '../shared/db/connection'
import { syncWriteGuard } from '../gateway/sync-write.guard'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn() } }))
const mockQuery = (pool as any).query as jest.Mock

function res() {
  const r: any = { statusCode: 200, body: undefined }
  r.status = jest.fn((c: number) => { r.statusCode = c; return r })
  r.json = jest.fn((b: unknown) => { r.body = b; return r })
  return r
}
const req = (method: string) => ({ method, institution: { institutionId: 1, schemaName: 'setes_setes', userId: 9, role: 'admin' } }) as any

beforeEach(() => jest.clearAllMocks())

describe('syncWriteGuard (D-PR32)', () => {
  it('leitura passa SEM consultar o banco (GET/HEAD)', async () => {
    for (const m of ['GET', 'HEAD']) {
      const next = jest.fn()
      await syncWriteGuard(req(m), res(), next)
      expect(next).toHaveBeenCalledWith()
    }
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('escrita com chave de sincronizador ATIVA = 409 SYNC_MANAGED_CATALOG — também para admin', async () => {
    for (const m of ['POST', 'PUT', 'DELETE']) {
      mockQuery.mockResolvedValueOnce([[{ 1: 1 }]])
      const r = res(); const next = jest.fn()
      await syncWriteGuard(req(m), r, next)
      expect([m, r.statusCode, r.body?.code]).toEqual([m, 409, 'SYNC_MANAGED_CATALOG'])
      expect(next).not.toHaveBeenCalled()
    }
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('setes_central.tb_sync_api_key')
    expect(sql).toContain("active = 'S'")
    expect(sql).toContain("deleted = 'N'")
    expect(mockQuery.mock.calls[0][1]).toEqual([1])
  })

  it('escrita sem chave ativa segue', async () => {
    mockQuery.mockResolvedValueOnce([[]])
    const next = jest.fn()
    await syncWriteGuard(req('POST'), res(), next)
    expect(next).toHaveBeenCalledWith()
  })

  it('sem sessão = 401; erro do banco vai para o handler (nunca libera)', async () => {
    const r = res(); const next = jest.fn()
    await syncWriteGuard({ method: 'POST' } as any, r, next)
    expect(r.statusCode).toBe(401)
    const boom = new Error('pool'); mockQuery.mockRejectedValueOnce(boom)
    const next2 = jest.fn()
    await syncWriteGuard(req('PUT'), res(), next2)
    expect(next2).toHaveBeenCalledWith(boom)
  })
})

describe('rotas de criação na central exigem CATALOGAR (D-PR33)', () => {
  it('POST /brands, /measures e /packages: a 1ª camada confere o privilégio 10 (CATALOGAR) na interface merchandise', async () => {
    const routes = (await import('../modules/merchandise/merchandise.routes')).default as any
    for (const path of ['/brands', '/measures', '/packages']) {
      const layer = routes.stack.find((l: any) => l.route?.path === path && l.route.methods.post)
      expect([path, layer.route.stack.length]).toEqual([path, 2])
      // usuário REGULAR, interface contratada, sem o vínculo → 403; a consulta do vínculo pede o privilégio 10 na interface resolvida
      mockQuery.mockReset()
      mockQuery.mockImplementation(async (sql: string, params: any[]) => {
        if (/FROM setes_central\.tb_interface WHERE i18n_key = \?/.test(sql)) return [[{ id: 77 }]]
        if (/tb_institution_has_interface/.test(sql)) return [[{ 1: 1 }]]
        if (/tb_user_has_privilege/.test(sql)) return [[]]
        return [[]]
      })
      const r = res(); const next = jest.fn()
      await layer.route.stack[0].handle({ ...req('POST'), institution: { institutionId: 1, schemaName: 'setes_setes', userId: 9, role: 'user' } }, r, next)
      expect([path, r.statusCode, r.body?.code]).toEqual([path, 403, 'PRIVILEGE_REQUIRED'])
      const priv = mockQuery.mock.calls.find((c: any[]) => /tb_user_has_privilege/.test(c[0]))!
      expect(priv[1]).toEqual([9, 77, 10])
      const iface = mockQuery.mock.calls.find((c: any[]) => /tb_interface WHERE i18n_key/.test(c[0]))
      if (iface) expect(iface[1]).toEqual(['merchandise'])
    }
  })
})

describe('D-PR41 revista (Rodada 6) — o MÉTODO montado nos cadastros que o legado alimenta', () => {
  it('o gateway monta syncWriteGuard em /merchandise, /services, /price-lists e /categories — e em nenhum outro cadastro', async () => {
    const router = (await import('../gateway/router')).default as any
    const guarded = router.stack.filter((l: any) => l.handle === syncWriteGuard)
    const mounts = ['/merchandise', '/services', '/price-lists', '/categories', '/orders', '/contracts', '/financial-plans', '/customers']
      .filter(path => guarded.some((l: any) => l.regexp.test(path)))
    expect(mounts).toEqual(['/merchandise', '/services', '/price-lists', '/categories'])
    expect(guarded).toHaveLength(4)
  })

  it('a lista de tabelas que o religar confere acompanha os cadastros guardados (tb_product = mercadoria + serviço)', async () => {
    const { SYNC_FED_TABLES } = await import('../shared/sync-key')
    expect([...SYNC_FED_TABLES]).toEqual(['tb_product', 'tb_price_list', 'tb_category'])
  })
})

// Gate socrático da Rodada 6 (MEDIUM): a guarda lê a chave FORA da transação — quem passou por ela com a chave desligada e esperou a trava
// da institution enquanto o super RELIGAVA inseria depois, já com a chave ativa, numa linha que nenhuma conferência futura vê. Os três
// cunhadores de id nas tabelas do legado reconferem a chave LOGO DEPOIS da trava da institution (a mesma que o ato de religar segura).
describe('reconferência da chave DENTRO da transação de quem cunha id (gate socrático R6)', () => {
  const mockGetConnection = (pool as any).getConnection as jest.Mock
  const txConn = (keyActive: boolean) => {
    const c: any = {
      query: jest.fn(async (sql: string) => {
        if (/FROM setes_central\.tb_institution WHERE id = \? FOR UPDATE/.test(sql)) return [[{ id: 1 }]]
        if (/FROM setes_central\.tb_sync_api_key/.test(sql)) return [keyActive ? [{ 1: 1 }] : []]
        if (/^\s*SELECT/.test(sql)) return [[{ nextId: 50, 1: 1 }]]
        return [{ affectedRows: 1 }]
      }),
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    mockGetConnection.mockResolvedValue(c)
    return c
  }
  const order = (c: any): string[] => c.query.mock.calls.map((x: any[]) => x[0] as string)

  it('serviço, categoria e tabela de preço: com a chave religada → 409 SYNC_MANAGED_CATALOG, rollback, nenhum INSERT; a reconferência é a 2ª consulta (logo após a trava) e TRAVANTE', async () => {
    const { insertService } = await import('../modules/services/services.repository')
    const { insertCategory } = await import('../modules/categories/categories.repository')
    const { insertPriceList } = await import('../modules/price-lists/price-lists.repository')
    const attempts: [string, () => Promise<unknown>][] = [
      ['services', () => insertService({ description: 'X', categoryId: 1 } as any, 'setes_setes', 1)],
      ['categories', () => insertCategory({ description: 'X', kind: 'S' }, (_p, id) => String(id), 'setes_setes', 1)],
      ['price-lists', () => insertPriceList({ description: 'X' } as any, 'setes_setes', 1)],
    ]
    for (const [name, run] of attempts) {
      const c = txConn(true)
      await expect(run()).rejects.toMatchObject({ statusCode: 409, code: 'SYNC_MANAGED_CATALOG' })
      const sqls = order(c)
      expect([name, sqls[0]]).toEqual([name, expect.stringMatching(/setes_central\.tb_institution WHERE id = \? FOR UPDATE/)])
      expect([name, sqls[1]]).toEqual([name, expect.stringMatching(/tb_sync_api_key[\s\S]*LOCK IN SHARE MODE/)])
      expect([name, sqls.some(s => /INSERT INTO/.test(s))]).toEqual([name, false])
      expect(c.rollback).toHaveBeenCalled()
    }
  })

  it('mercadoria: a mesma reconferência pela peça @shared/product-id (allocateProductId)', async () => {
    const { allocateProductId } = await import('../shared/product-id')
    const c = txConn(true)
    await expect(allocateProductId(c, 'setes_setes', 1)).rejects.toMatchObject({ statusCode: 409, code: 'SYNC_MANAGED_CATALOG' })
    const free = txConn(false)
    expect(await allocateProductId(free, 'setes_setes', 1)).toBe(50)
  })
})
