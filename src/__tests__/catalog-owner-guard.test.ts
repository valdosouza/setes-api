/// <reference types="jest" />
// Rodada 7 do cadastro de produtos (D-PR47/D-PR48/D-PR51/D-PR52, Valdo 2026-10-20 — prompt_modulo_products.md "Rodada 7"): a guarda
// de escrita dos cadastros que o legado alimenta pergunta "quem é o DONO do catálogo?" lendo o FATO `tb_institution.source_kind`
// (peça `@shared/catalog-owner`), nunca a chave do sincronizador (Rodada 6 — caiu). L = só consulta; W/P = a web escreve.
// Substitui `sync-write-guard.test.ts` (D-PR32/D-PR41 revista).
import pool from '../shared/db/connection'
import { catalogOwnerGuard } from '../gateway/catalog-owner.guard'
import {
  BASE_CATALOG_TABLES, LEGACY_OWNED_TABLES, LEGACY_OWNED_MODULES, catalogOwnerOf, sourceKindHasSync, isSourceKind,
} from '../shared/catalog-owner'
import { allocateProductId } from '../shared/product-id'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn() } }))
const mockQuery = (pool as any).query as jest.Mock

function res() {
  const r: any = { statusCode: 200, body: undefined }
  r.status = jest.fn((c: number) => { r.statusCode = c; return r })
  r.json = jest.fn((b: unknown) => { r.body = b; return r })
  return r
}
const req = (method: string, role = 'admin') =>
  ({ method, institution: { institutionId: 1, schemaName: 'setes_setes', userId: 9, role } }) as any
const factIs = (kind: string | null) => mockQuery.mockImplementation(async (sql: string) => {
  if (/SELECT source_kind AS kind FROM setes_central\.tb_institution/.test(sql)) return [kind === null ? [] : [{ kind }]]
  throw new Error(`SQL inesperado: ${String(sql).slice(0, 80)}`)
})

beforeEach(() => { jest.clearAllMocks(); mockQuery.mockReset() })

describe('catalogOwnerGuard (D-PR47) — o dono do catálogo decide, nunca a chave', () => {
  it('leitura passa SEM consultar o banco (GET/HEAD/OPTIONS)', async () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS']) {
      const r = res(); const next = jest.fn()
      await catalogOwnerGuard(req(m), r, next)
      expect([m, next.mock.calls.length, mockQuery.mock.calls.length]).toEqual([m, 1, 0])
    }
  })

  it('L (transição do desktop legado) = 409 CATALOG_LEGACY_OWNED em toda escrita — admin E super (o problema é o 2º escritor)', async () => {
    factIs('L')
    for (const role of ['admin', 'super', 'user']) {
      for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const r = res(); const next = jest.fn()
        await catalogOwnerGuard(req(m, role), r, next)
        expect([role, m, r.statusCode, r.body?.code, next.mock.calls.length]).toEqual([role, m, 409, 'CATALOG_LEGACY_OWNED', 0])
      }
    }
    expect(mockQuery.mock.calls.every(c => /tb_sync_api_key/.test(c[0]) === false)).toBe(true)   // nunca a chave
    expect(mockQuery.mock.calls[0][1]).toEqual([1])                                                 // a institution do JWT
  })

  it('W (nativo web) e P (PDV — a web é a dona, os PDVs recebem) escrevem', async () => {
    for (const kind of ['W', 'P']) {
      factIs(kind)
      const r = res(); const next = jest.fn()
      await catalogOwnerGuard(req('POST'), r, next)
      expect([kind, next.mock.calls.length, r.statusCode]).toEqual([kind, 1, 200])
    }
  })

  it('falha FECHADO: institution sem fato legível = 409; erro do banco vai ao handler (nunca libera); sem sessão = 401', async () => {
    factIs(null)
    const r1 = res(); const n1 = jest.fn()
    await catalogOwnerGuard(req('POST'), r1, n1)
    expect([r1.statusCode, n1.mock.calls.length]).toEqual([409, 0])

    mockQuery.mockRejectedValue(new Error('pool esgotado'))
    const r2 = res(); const n2 = jest.fn()
    await catalogOwnerGuard(req('PUT'), r2, n2)
    expect(n2).toHaveBeenCalledWith(expect.any(Error))
    expect(r2.status).not.toHaveBeenCalled()

    const r3 = res(); const n3 = jest.fn()
    await catalogOwnerGuard({ method: 'POST' } as any, r3, n3)
    expect([r3.statusCode, n3.mock.calls.length]).toEqual([401, 0])
  })

  it('regras puras da peça: dono por tipo da fonte; chave só para L e P; domínio fechado', () => {
    expect(['W', 'L', 'P'].map(k => catalogOwnerOf(k as any))).toEqual(['web', 'legacy', 'web'])
    expect(['W', 'L', 'P'].map(k => sourceKindHasSync(k as any))).toEqual([false, true, true])
    expect(['W', 'L', 'P', 'w', 'l', 'X', '', null, undefined, 1].map(isSourceKind)).toEqual([true, true, true, false, false, false, false, false, false, false])
  })
})

describe('as listas da peça (D-PR52 catálogo de base · D-PR51 guarda)', () => {
  it('BASE_CATALOG_TABLES = a lista literal do Valdo (unidade/medida/embalagem/categorias/produtos/serviços/tabela de preço/preço/lista e saldo de estoque)', () => {
    expect([...BASE_CATALOG_TABLES]).toEqual([
      'tb_merchandise_trade_unit',
      'tb_measure', 'tb_institution_has_measure',
      'tb_package', 'tb_institution_has_package',
      'tb_category',
      'tb_product', 'tb_merchandise',
      'tb_service',
      'tb_price_list', 'tb_price',
      'tb_stock_list', 'tb_stock_balance',
    ])
  })

  it('LEGACY_OWNED_TABLES = catálogo de base + plano de contas + contas bancárias (D-PR51); tb_service_ibscbs e tb_service_tax_rule NUNCA entram (D-PR45: enquadramento é da web)', () => {
    expect([...LEGACY_OWNED_TABLES]).toEqual([...BASE_CATALOG_TABLES, 'tb_financial_plans', 'tb_bank_account'])
    expect(LEGACY_OWNED_TABLES as readonly string[]).not.toContain('tb_service_ibscbs')
    expect(LEGACY_OWNED_TABLES as readonly string[]).not.toContain('tb_service_tax_rule')
    expect(LEGACY_OWNED_TABLES as readonly string[]).not.toContain('tb_bank_account_channel')
  })

  it('LEGACY_OWNED_MODULES = os 6 cadastros montados com a guarda', () => {
    expect([...LEGACY_OWNED_MODULES]).toEqual(['merchandise', 'services', 'price-lists', 'categories', 'financial-plans', 'bank-accounts'])
  })
})

describe('montagem no gateway (cerca): a guarda em TODOS os módulos da lista, só neles; o que o legado não produz fica ANTES da guarda', () => {
  it('o gateway monta catalogOwnerGuard exatamente nos LEGACY_OWNED_MODULES — e em nenhum outro cadastro', async () => {
    const router = (await import('../gateway/router')).default as any
    const guarded = router.stack.filter((l: any) => l.handle === catalogOwnerGuard)
    const probe = [...LEGACY_OWNED_MODULES.map(m => `/${m}`), '/orders', '/contracts', '/customers', '/service-tax-rules', '/tax-rules', '/payment-types']
    const mounts = probe.filter(path => guarded.some((l: any) => l.regexp.test(path)))
    expect(mounts).toEqual(LEGACY_OWNED_MODULES.map(m => `/${m}`))
    expect(guarded).toHaveLength(LEGACY_OWNED_MODULES.length)
  })

  it('D-PR45: /services tem o roteador FISCAL (só PUT /:id/tax-rule e /:id/ibscbs) montado ANTES da guarda; o roteador do cadastro vem depois', async () => {
    const router = (await import('../gateway/router')).default as any
    const layers = router.stack.filter((l: any) => l.regexp.test('/services') && !l.regexp.test('/service-tax-rules'))
    const kinds = layers.map((l: any) => l.handle === catalogOwnerGuard ? 'guard' : (l.handle.stack ? 'router' : 'other'))
    expect(kinds).toEqual(['router', 'guard', 'router'])
    const fiscal = layers[0].handle.stack.filter((l: any) => l.route).map((l: any) => [l.route.path, Object.keys(l.route.methods).join(',')])
    expect(fiscal).toEqual([['/:id/tax-rule', 'put'], ['/:id/ibscbs', 'put']])
    // cada rota fiscal tem 2 handlers: o privilégio ALTERAR em services e o controller
    for (const l of layers[0].handle.stack.filter((x: any) => x.route)) expect(l.route.stack).toHaveLength(2)
    const cadastro = layers[2].handle.stack.filter((l: any) => l.route).map((l: any) => l.route.path)
    expect(cadastro).toEqual(expect.arrayContaining(['/', '/:id']))
    expect(cadastro).not.toContain('/:id/tax-rule')
  })

  it('D-PR51: /bank-accounts tem o roteador do CANAL API (só /:id/channel…) montado ANTES da guarda; o cadastro da conta vem depois', async () => {
    const router = (await import('../gateway/router')).default as any
    const layers = router.stack.filter((l: any) => l.regexp.test('/bank-accounts') && !l.regexp.test('/bank-charge-agreements'))
    const kinds = layers.map((l: any) => l.handle === catalogOwnerGuard ? 'guard' : (l.handle.stack ? 'router' : 'other'))
    expect(kinds).toEqual(['router', 'guard', 'router'])
    const channel = layers[0].handle.stack.filter((l: any) => l.route).map((l: any) => l.route.path)
    expect(channel.length).toBeGreaterThan(0)
    expect(channel.every((p: string) => p.startsWith('/:id/channel'))).toBe(true)
    const cadastro = layers[2].handle.stack.filter((l: any) => l.route).map((l: any) => l.route.path)
    expect(cadastro).toEqual(expect.arrayContaining(['/', '/:id', '/banks']))
    expect(cadastro.some((p: string) => p.includes('channel'))).toBe(false)
  })
})

describe('quem cunha id no espaço do legado NÃO reconfere nada na transação (monotonia do fato — a assertNoActiveSyncKey morreu)', () => {
  it('allocateProductId: trava da institution → MAX (2 consultas; nenhuma à chave nem ao fato)', async () => {
    const calls: string[] = []
    const fake = {
      query: jest.fn(async (sql: string) => {
        calls.push(String(sql))
        if (/MAX\(id\)/.test(sql)) return [[{ nextId: 81 }]]
        return [[{ id: 1 }]]
      }),
    } as any
    await expect(allocateProductId(fake, 'setes_setes', 1)).resolves.toBe(81)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatch(/setes_central\.tb_institution WHERE id = \? FOR UPDATE/)
    expect(calls[1]).toMatch(/MAX\(id\)/)
    expect(calls[1]).not.toMatch(/FOR UPDATE|LOCK IN SHARE MODE/)      // o MAX segue sem next-key lock (D-PR2)
    expect(calls.some(s => /tb_sync_api_key|source_kind/.test(s))).toBe(false)
  })

  it('insertCategory e insertPriceList: trava da institution 1ª, depois o MAX — sem consulta à chave', async () => {
    const { insertCategory } = await import('../modules/categories/categories.repository')
    const { insertPriceList } = await import('../modules/price-lists/price-lists.repository')
    for (const [name, run] of [
      ['categoria', () => insertCategory({ description: 'X', kind: 'S' }, (_p, id) => String(id), 'setes_setes', 1)],
      ['tabela de preço', () => insertPriceList({ description: 'VAREJO' }, 'setes_setes', 1)],
    ] as const) {
      const sqls: string[] = []
      const conn = {
        query: jest.fn(async (sql: string) => {
          sqls.push(String(sql))
          if (/MAX\(id\)/.test(sql)) return [[{ nextId: 5 }]]
          if (/INSERT INTO/.test(sql)) return [{}]
          return [[{ id: 1 }]]
        }),
        beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
      }
      ;(pool as any).getConnection.mockResolvedValue(conn)
      await expect(run()).resolves.toBe(5)
      expect([name, sqls[0]]).toEqual([name, expect.stringMatching(/setes_central\.tb_institution WHERE id = \? FOR UPDATE/)])
      expect([name, /MAX\(id\)/.test(sqls[1])]).toEqual([name, true])
      expect([name, sqls.some(s => /tb_sync_api_key|source_kind/.test(s))]).toEqual([name, false])
    }
  })
})

describe('rotas de criação na central exigem CATALOGAR (D-PR33)', () => {
  it('POST /brands, /measures e /packages: a 1ª camada confere o privilégio 10 (CATALOGAR) na interface merchandise', async () => {
    const routes = (await import('../modules/merchandise/merchandise.routes')).default as any
    for (const path of ['/brands', '/measures', '/packages']) {
      const layer = routes.stack.find((l: any) => l.route?.path === path && l.route.methods.post)
      expect([path, layer.route.stack.length]).toEqual([path, 2])
      mockQuery.mockReset()
      mockQuery.mockImplementation(async (sql: string) => {
        if (/FROM setes_central\.tb_interface WHERE i18n_key = \?/.test(sql)) return [[{ id: 77 }]]
        if (/tb_institution_has_interface/.test(sql)) return [[{ 1: 1 }]]
        if (/tb_user_has_privilege/.test(sql)) return [[]]
        return [[]]
      })
      const r = res(); const next = jest.fn()
      await layer.route.stack[0].handle(req('POST', 'user'), r, next)
      expect([path, r.statusCode, r.body?.code]).toEqual([path, 403, 'PRIVILEGE_REQUIRED'])
      const priv = mockQuery.mock.calls.find((c: any[]) => /tb_user_has_privilege/.test(c[0]))!
      expect(priv[1]).toEqual([9, 77, 10])
    }
  })
})
