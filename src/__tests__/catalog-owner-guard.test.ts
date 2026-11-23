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
import { listGatedRoutes, listGatedModules } from '../shared/auth/module-privilege-gate'
import { PRIVILEGE_INSERIR, PRIVILEGE_ALTERAR, PRIVILEGE_VISUALIZAR, PRIVILEGE_CATALOGAR } from '../shared/auth/privileges'
import { adminGuard } from '../gateway/admin.guard'
import { accessAnswer } from '../test-setup/access-model'

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

describe('montagem no gateway (cerca, D-PR77 + D-PV2): NENHUM cadastro monta guarda do dono do catálogo — só a guarda por roteador', () => {
  const MODULES = ['merchandise', 'services', 'price-lists', 'categories', 'financial-plans', 'bank-accounts']
  const isGuardLayer = (l: any) => !l.handle?.stack && /catalogOwner|catalog_owner/i.test(String(l.handle?.name ?? ''))
  const layersOf = (router: any, m: string) =>
    router.stack.filter((l: any) => l.regexp.test(`/${m}`) && !l.regexp.test('/service-tax-rules') && !l.regexp.test('/bank-charge-agreements'))
  const gated = (m: string) => listGatedRoutes().filter(r => r.moduleKey === m)

  it('nenhuma camada do roteador é a guarda do dono; cada um dos 6 cadastros é UM roteador sob `gatedModule` (a guarda por roteador + o roteador do módulo)', async () => {
    const router = (await import('../gateway/router')).default as any
    expect(router.stack.filter(isGuardLayer)).toEqual([])
    for (const m of MODULES) {
      // o módulo tem UM roteador só (nenhum roteador irmão montado antes) e está no registro da guarda por roteador
      expect([m, layersOf(router, m).filter((l: any) => !!l.handle.stack).length]).toEqual([m, 1])
      expect([m, listGatedModules().includes(m)]).toEqual([m, true])
    }
  })

  it('D-PR45: o enquadramento fiscal do serviço vive no roteador do módulo (só PUT /:id/tax-rule e /:id/ibscbs) — ALTERAR em services pelo verbo, conferido pela guarda do roteador', async () => {
    const router = (await import('../gateway/router')).default as any
    const cadastro = layersOf(router, 'services').find((l: any) => !!l.handle.stack)
    const fiscal = cadastro.handle.stack.filter((l: any) => l.route && ['/:id/tax-rule', '/:id/ibscbs'].includes(l.route.path))
      .map((l: any) => [l.route.path, Object.keys(l.route.methods).join(',')])
    expect(fiscal).toEqual([['/:id/tax-rule', 'put'], ['/:id/ibscbs', 'put']])
    expect(gated('services').filter(r => ['/:id/tax-rule', '/:id/ibscbs'].includes(r.path)).map(r => [r.method, r.path, r.privilegeId, r.interfaces.join('|')]))
      .toEqual([['PUT', '/:id/tax-rule', PRIVILEGE_ALTERAR, 'services'], ['PUT', '/:id/ibscbs', PRIVILEGE_ALTERAR, 'services']])
    expect(cadastro.handle.stack.filter((l: any) => l.route).map((l: any) => l.route.path)).toEqual(expect.arrayContaining(['/', '/:id']))
  })

  it('/bank-accounts: o CANAL API (só /:id/channel…) vive no roteador da conta — toda escrita dele = ALTERAR + adminGuard; a leitura = VISUALIZAR', async () => {
    const router = (await import('../gateway/router')).default as any
    const cadastro = layersOf(router, 'bank-accounts').find((l: any) => !!l.handle.stack)
    const routes = cadastro.handle.stack.filter((l: any) => l.route)
    expect(routes.map((l: any) => l.route.path)).toEqual(expect.arrayContaining(['/', '/:id', '/banks']))
    const channel = gated('bank-accounts').filter(r => r.path.includes('channel'))
    expect(channel.length).toBeGreaterThan(0)
    expect(channel.every(r => r.path.startsWith('/:id/channel'))).toBe(true)
    for (const r of channel) {
      expect([r.method, r.path, r.privilegeId, r.interfaces.join('|')])
        .toEqual([r.method, r.path, r.method === 'GET' ? PRIVILEGE_VISUALIZAR : PRIVILEGE_ALTERAR, 'bank-accounts'])
    }
    // escrita do canal: adminGuard → marcador do ato → controller (3 camadas, o adminGuard na frente); leitura: só o controller
    for (const l of routes.filter((x: any) => String(x.route.path).includes('channel'))) {
      const methods = Object.keys(l.route.methods).join(',')
      const write = !l.route.methods.get
      expect([l.route.path, methods, l.route.stack.length]).toEqual([l.route.path, methods, write ? 3 : 1])
      if (write) expect([l.route.path, methods, l.route.stack[0].handle === adminGuard]).toEqual([l.route.path, methods, true])
    }
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
  it('POST /brands, /measures e /packages: o marcador do ato declara o privilégio 10 (CATALOGAR) na interface merchandise — a guarda do roteador o confere (D-PV2/D-PV7)', async () => {
    const routes = (await import('../modules/merchandise/merchandise.routes')).default as any
    await import('../gateway/router')                                // montar o gateway registra a guarda do módulo
    const table = listGatedRoutes().filter(r => r.moduleKey === 'merchandise')
    for (const path of ['/brands', '/measures', '/packages']) {
      const layer = routes.stack.find((l: any) => l.route?.path === path && l.route.methods.post)
      expect([path, layer.route.stack.length]).toEqual([path, 2])    // marcador do ato + controller
      const row = table.find(r => r.method === 'POST' && r.path === path)!
      expect([path, row.privilegeId, row.interfaces.join('|'), row.dynamic]).toEqual([path, PRIVILEGE_CATALOGAR, 'merchandise', false])
    }
    // nenhuma OUTRA rota do módulo pede CATALOGAR; o POST da ficha é INSERIR pelo verbo
    expect(table.filter(r => r.privilegeId === PRIVILEGE_CATALOGAR).map(r => r.path)).toEqual(['/brands', '/measures', '/packages'])
    expect(table.find(r => r.method === 'POST' && r.path === '/')!.privilegeId).toBe(PRIVILEGE_INSERIR)
  })

  it('a guarda do roteador nega as três ao usuário regular sem a concessão (403 PRIVILEGE_REQUIRED) e pergunta à view por CATALOGAR em merchandise', async () => {
    const { modulePrivilegeGate } = await import('../shared/auth/module-privilege-gate')
    const routes = (await import('../modules/merchandise/merchandise.routes')).default
    const gate = modulePrivilegeGate('merchandise', routes)
    for (const path of ['/brands', '/measures', '/packages']) {
      mockQuery.mockReset()
      // outro privilégio da tela (INSERIR) não substitui CATALOGAR
      mockQuery.mockImplementation(async (sql: string, params: any[] = []) =>
        [accessAnswer(sql, params, { profile: 'user', contracted: ['merchandise'], granted: { merchandise: ['INSERIR'] } }) ?? [], []])
      const r = res(); const next = jest.fn()
      await gate({ ...req('POST', 'user'), path } as any, r, next)
      expect([path, r.statusCode, r.body?.code, next.mock.calls.length]).toEqual([path, 403, 'PRIVILEGE_REQUIRED', 0])
      const verdict = mockQuery.mock.calls.find((c: any[]) => /vw_user_access/.test(c[0]))!
      expect(verdict[1]).toEqual([9, 1, ['merchandise'], 'CATALOGAR'])
      // com a concessão, a mesma guarda deixa passar
      mockQuery.mockImplementation(async (sql: string, params: any[] = []) =>
        [accessAnswer(sql, params, { profile: 'user', contracted: ['merchandise'], granted: { merchandise: ['CATALOGAR'] } }) ?? [], []])
      const ok = res(); const pass = jest.fn()
      await gate({ ...req('POST', 'user'), path } as any, ok, pass)
      expect([path, pass.mock.calls.length]).toEqual([path, 1])
    }
  })
})
