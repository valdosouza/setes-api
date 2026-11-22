/// <reference types="jest" />
// O DONO DO CATÁLOGO (peça `@shared/catalog-owner`) — Rodada 7 do cadastro de produtos (D-PR47/D-PR52), revista pela D-OI10 (só W e D)
// e pelas D-PR77/D-PR70 (2026-11-22, prompt_modulo_products.md Rodadas 10 e 11): o dono deixou de ser trava — a `catalogOwnerGuard`
// saiu do gateway; o fato segue para o contexto da sessão, o ato D → W e a chave do sincronizador.
import pool from '../shared/db/connection'
import {
  BASE_CATALOG_TABLES, DESKTOP_OWNED_TABLES, catalogOwnerOf, sourceKindHasSync, isSourceKind, sourceKindOf, SOURCE_KINDS,
} from '../shared/catalog-owner'
import { allocateProductId } from '../shared/product-id'
import * as catalogOwner from '../shared/catalog-owner'

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

beforeEach(() => { jest.clearAllMocks(); mockQuery.mockReset() })

describe('a peça do dono do catálogo (D-OI10: só W e D; D-PR70: "desktop", nunca "legacy")', () => {
  it('regras puras: dono por fato; chave só para D (D-PR69); domínio fechado em W/D', () => {
    expect([...SOURCE_KINDS]).toEqual(['W', 'D'])
    expect(['W', 'D'].map(k => catalogOwnerOf(k as any))).toEqual(['web', 'desktop'])
    expect(['W', 'D'].map(k => sourceKindHasSync(k as any))).toEqual([false, true])
    expect(['W', 'D', 'L', 'P', 'w', 'd', 'X', '', null, undefined, 1].map(isSourceKind))
      .toEqual([true, true, false, false, false, false, false, false, false, false, false])
  })

  it('sourceKindOf lê o fato da institution do pedido; letra fora do domínio (L/P de antes da 081) = null', async () => {
    for (const [kind, expected] of [['W', 'W'], ['D', 'D'], ['L', null], ['P', null]] as const) {
      mockQuery.mockResolvedValueOnce([[{ kind }]])
      await expect(sourceKindOf(1)).resolves.toBe(expected)
    }
    mockQuery.mockResolvedValueOnce([[]])
    await expect(sourceKindOf(1)).resolves.toBeNull()
    expect(mockQuery.mock.calls[0][1]).toEqual([1])
  })

  it('a guarda e o que só existia para ela saíram da peça (D-PR77)', () => {
    const exported = Object.keys(catalogOwner)
    for (const gone of ['CATALOG_LEGACY_OWNED_MESSAGE', 'LEGACY_OWNED_TABLES', 'LEGACY_OWNED_MODULES', 'DESKTOP_OWNED_MODULES', 'CATALOG_DESKTOP_OWNED_MESSAGE']) expect(exported).not.toContain(gone)
  })
})

describe('as listas da peça (D-PR52 catálogo de base · D-PR51 o que o ERP Desktop também envia)', () => {
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

  it('DESKTOP_OWNED_TABLES = catálogo de base + plano de contas + contas bancárias (D-PR51); tb_service_ibscbs e tb_service_tax_rule NUNCA entram (D-PR45: enquadramento é da web)', () => {
    expect([...DESKTOP_OWNED_TABLES]).toEqual([...BASE_CATALOG_TABLES, 'tb_financial_plans', 'tb_bank_account'])
    expect(DESKTOP_OWNED_TABLES as readonly string[]).not.toContain('tb_service_ibscbs')
    expect(DESKTOP_OWNED_TABLES as readonly string[]).not.toContain('tb_service_tax_rule')
    expect(DESKTOP_OWNED_TABLES as readonly string[]).not.toContain('tb_bank_account_channel')
  })
})

describe('montagem no gateway (cerca, D-PR77): NENHUM cadastro monta guarda do dono do catálogo', () => {
  const MODULES = ['merchandise', 'services', 'price-lists', 'categories', 'financial-plans', 'bank-accounts']
  const isGuardLayer = (l: any) => !l.handle?.stack && /catalogOwner|catalog_owner/i.test(String(l.handle?.name ?? ''))

  it('nenhuma camada do roteador é a guarda; cada um dos 6 cadastros chega direto ao roteador do módulo', async () => {
    const router = (await import('../gateway/router')).default as any
    expect(router.stack.filter(isGuardLayer)).toEqual([])
    for (const m of MODULES) {
      const layers = router.stack.filter((l: any) => l.regexp.test(`/${m}`) && !l.regexp.test('/service-tax-rules') && !l.regexp.test('/bank-charge-agreements'))
      expect([m, layers.every((l: any) => !!l.handle.stack)]).toEqual([m, true])
    }
  })

  it('D-PR45: /services segue com o roteador FISCAL (só PUT /:id/tax-rule e /:id/ibscbs) antes do roteador do cadastro', async () => {
    const router = (await import('../gateway/router')).default as any
    const layers = router.stack.filter((l: any) => l.regexp.test('/services') && !l.regexp.test('/service-tax-rules'))
    expect(layers.map((l: any) => (l.handle.stack ? 'router' : 'other'))).toEqual(['router', 'router'])
    const fiscal = layers[0].handle.stack.filter((l: any) => l.route).map((l: any) => [l.route.path, Object.keys(l.route.methods).join(',')])
    expect(fiscal).toEqual([['/:id/tax-rule', 'put'], ['/:id/ibscbs', 'put']])
    for (const l of layers[0].handle.stack.filter((x: any) => x.route)) expect(l.route.stack).toHaveLength(2)
    const cadastro = layers[1].handle.stack.filter((l: any) => l.route).map((l: any) => l.route.path)
    expect(cadastro).toEqual(expect.arrayContaining(['/', '/:id']))
    expect(cadastro).not.toContain('/:id/tax-rule')
  })

  it('/bank-accounts segue com o roteador do CANAL API (só /:id/channel…) antes do cadastro da conta', async () => {
    const router = (await import('../gateway/router')).default as any
    const layers = router.stack.filter((l: any) => l.regexp.test('/bank-accounts') && !l.regexp.test('/bank-charge-agreements'))
    expect(layers.map((l: any) => (l.handle.stack ? 'router' : 'other'))).toEqual(['router', 'router'])
    const channel = layers[0].handle.stack.filter((l: any) => l.route).map((l: any) => l.route.path)
    expect(channel.length).toBeGreaterThan(0)
    expect(channel.every((p: string) => p.startsWith('/:id/channel'))).toBe(true)
    const cadastro = layers[1].handle.stack.filter((l: any) => l.route).map((l: any) => l.route.path)
    expect(cadastro).toEqual(expect.arrayContaining(['/', '/:id', '/banks']))
    expect(cadastro.some((p: string) => p.includes('channel'))).toBe(false)
  })
})

describe('quem cunha id no espaço do ERP Desktop NÃO reconfere nada na transação (nem a chave nem o fato — D-PR77)', () => {
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
