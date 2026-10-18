/// <reference types="jest" />
// Módulos services + price-lists (prompt_modulo_services.md, D1–D7
// 2026-09-01): serviço = tb_product kind='S' FIXO (D5 — o módulo nunca
// enxerga mercadoria), identifier em branco vira o id (D1), grade de
// preços tb_price na MESMA transação (D4/D7, presença = sincroniza).
import pool from '../shared/db/connection'
import { NO_CRITERIA } from '../shared/list'
import { serviceDto } from '../modules/services/services.dto'
import { priceListDto } from '../modules/price-lists/price-lists.dto'
import * as svcRepo from '../modules/services/services.repository'
import * as plRepo from '../modules/price-lists/price-lists.repository'
import * as svcService from '../modules/services/services.service'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const mockQuery = (pool as any).query as jest.Mock
const mockGetConnection = (pool as any).getConnection as jest.Mock

function fakeConn() {
  const conn: any = {
    query: jest.fn(),
    beginTransaction: jest.fn(),
    commit: jest.fn(),
    rollback: jest.fn(),
    release: jest.fn(),
  }
  mockGetConnection.mockResolvedValue(conn)
  return conn
}

beforeEach(() => jest.clearAllMocks())

// ---------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------

describe('services dto', () => {
  const base = { description: 'Instalação', categoryId: 1 }

  it('mínimo válido; defaults N/N/N/S e prices []', () => {
    const parsed = serviceDto.safeParse(base)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.promotion).toBe('N')
      expect(parsed.data.published).toBe('N')
      expect(parsed.data.active).toBe('S')
      expect(parsed.data.prices).toEqual([])
    }
  })

  it('grade com tabela DUPLICADA é rejeitada', () => {
    expect(serviceDto.safeParse({
      ...base,
      prices: [
        { priceListId: 1, priceTag: 10 },
        { priceListId: 1, priceTag: 20 },
      ],
    }).success).toBe(false)
  })

  it('priceTag null é aceito (remove o preço da tabela)', () => {
    expect(serviceDto.safeParse({
      ...base, prices: [{ priceListId: 1, priceTag: null }],
    }).success).toBe(true)
  })

  it('description vazia / categoryId ausente rejeitados', () => {
    expect(serviceDto.safeParse({ ...base, description: '' }).success).toBe(false)
    expect(serviceDto.safeParse({ description: 'X' }).success).toBe(false)
  })
})

describe('price-lists dto', () => {
  it('description obrigatória (max 45); published default S; validity YYYY-MM-DD', () => {
    const ok = priceListDto.safeParse({ description: 'Varejo' })
    expect(ok.success).toBe(true)
    if (ok.success) expect(ok.data.published).toBe('S')
    expect(priceListDto.safeParse({ description: '' }).success).toBe(false)
    expect(priceListDto.safeParse(
      { description: 'X', validity: '31/12/2027' }).success).toBe(false)
  })
})

// ---------------------------------------------------------------------
// services repository — invariante kind='S' e D1
// ---------------------------------------------------------------------

describe('services repository', () => {
  it("lista/COUNT usam a MESMA where com kind='S' e filtro em description+identifier", async () => {
    mockQuery
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ total: 2 }]])
    const result = await svcRepo.listServices(
      { filter: 'inst', page: 1, pageSize: 25, offset: 0, criteria: NO_CRITERIA } as any,
      'setes_setes', 1)
    expect(result.total).toBe(2)
    const pageSql = mockQuery.mock.calls[0][0] as string
    const countSql = mockQuery.mock.calls[1][0] as string
    expect(pageSql).toContain("p.kind = 'S'")
    expect(countSql).toContain("p.kind = 'S'")
    expect(pageSql).toContain('p.identifier LIKE ?')
  })

  it("insert grava kind='S' FIXO e identifier em branco vira o id (D1)", async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ id: 1 }]])          // trava da institution (D-PR2)
      .mockResolvedValueOnce([[]])                   // reconferência da chave do sincronizador (Rodada 6) — nenhuma ativa
      .mockResolvedValueOnce([[{ nextId: 7 }]])      // MAX+1
      .mockResolvedValueOnce([[{ 1: 1 }]])           // assertRefs: categoria viva
      .mockResolvedValueOnce([[{ 1: 1 }]])           // assertRefs: categoria serve ao serviço (Q-PR49 (a))
      .mockResolvedValueOnce([[]])                   // código livre (D-PR7)
      .mockResolvedValue([{}])                       // INSERT tb_product e o resto

    const id = await svcRepo.insertService(
      { identifier: '  ', description: 'Instalação', categoryId: 1 },
      'setes_setes', 1)

    expect(id).toBe(7)
    const insertCall = conn.query.mock.calls.find(
      (c: any[]) => (c[0] as string).includes('INSERT INTO'))
    expect(insertCall[0]).toContain("'S'")
    expect(insertCall[1][1]).toBe('7') // identifier = id
    expect(conn.commit).toHaveBeenCalled()
  })

  it('insert com identifier informado PRESERVA o valor', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ id: 1 }]])          // trava da institution
      .mockResolvedValueOnce([[]])                   // reconferência da chave do sincronizador (Rodada 6) — nenhuma ativa
      .mockResolvedValueOnce([[{ nextId: 8 }]])      // MAX+1
      .mockResolvedValueOnce([[{ 1: 1 }]])           // categoria viva
      .mockResolvedValueOnce([[{ 1: 1 }]])           // categoria serve ao serviço
      .mockResolvedValueOnce([[]])                   // código livre
      .mockResolvedValue([{}])

    await svcRepo.insertService(
      { identifier: 'SRV-01', description: 'Consultoria', categoryId: 1 },
      'setes_setes', 1)

    const insertCall = conn.query.mock.calls.find(
      (c: any[]) => (c[0] as string).includes('INSERT INTO'))
    expect(insertCall[1][1]).toBe('SRV-01')
  })

  it('categoria inexistente -> 400 com fields[] e rollback (id cunhado ANTES — D-PR2: trava da institution é o 1º statement)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ id: 1 }]])       // lockInstitutionCounters (1º statement da transação)
      .mockResolvedValueOnce([[]])                // reconferência da chave do sincronizador (Rodada 6)
      .mockResolvedValueOnce([[{ nextId: 10 }]])  // MAX + 1 — sem FOR UPDATE nas linhas de produto
      .mockResolvedValueOnce([[]])                // categoria não achada

    await expect(svcRepo.insertService(
      { description: 'X', categoryId: 99 }, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(conn.rollback).toHaveBeenCalled()
    const sqls = conn.query.mock.calls.map((c: any[]) => c[0] as string)
    expect(sqls[0]).toContain('setes_central.tb_institution')
    expect(sqls[0]).toContain('FOR UPDATE')
    expect(sqls[1]).toContain('setes_central.tb_sync_api_key')
    expect(sqls[1]).toContain('LOCK IN SHARE MODE')
    expect(sqls[2]).toContain('MAX(id)')
    expect(sqls[2]).not.toContain('FOR UPDATE')
  })

  it("update de id que é MERCADORIA devolve false (kind='S' no WHERE — D5)", async () => {
    const conn = fakeConn()
    conn.query.mockResolvedValueOnce([[]]) // SELECT ... kind='S' não acha

    const found = await svcRepo.updateService(
      5, { description: 'X', categoryId: 1 }, 'setes_setes', 1)

    expect(found).toBe(false)
    const selectSql = conn.query.mock.calls[0][0] as string
    expect(selectSql).toContain("kind = 'S'")
  })

  it('syncPrices: presença = sincroniza (soft-delete fora da grade; upsert com valor; null remove)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ identifier: 'SRV' }]]) // SELECT FOR UPDATE
      .mockResolvedValueOnce([[{ id: 1 }]])             // categoria
      .mockResolvedValueOnce([[{ id: 2 }]])             // price list 2
      .mockResolvedValueOnce([[{ id: 3 }]])             // price list 3
      .mockResolvedValue([{}])                          // demais

    await svcRepo.updateService(5, {
      identifier: 'SRV', description: 'X', categoryId: 1,   // código inalterado: sem lock nem conferência (A-PR1)
      prices: [
        { priceListId: 2, priceTag: 150.5 },
        { priceListId: 3, priceTag: null },   // remove
      ],
    }, 'setes_setes', 1)

    const calls = conn.query.mock.calls.map((c: any[]) => c[0] as string)
    // soft-delete de tudo que NÃO está na grade com valor (NOT IN (2))
    const softDelete = conn.query.mock.calls.find((c: any[]) =>
      (c[0] as string).includes("SET deleted = 'S'") &&
      (c[0] as string).includes('tb_price'))
    expect(softDelete).toBeDefined()
    expect(softDelete[1]).toEqual([1, 5, [2]])
    // upsert SÓ da tabela 2 (a 3 veio null)
    const upserts = calls.filter((sql: string) =>
      sql.includes('INSERT INTO') && sql.includes('tb_price'))
    expect(upserts.length).toBe(1)
  })

  it('createService reexecuta a transação em deadlock (D-PR2 — gate socrático da onda 1 de produtos: o ciclo com o faturamento via tb_service_ibscbs)', async () => {
    const first = fakeConn()
    first.query
      .mockResolvedValueOnce([[{ id: 1 }]])                  // trava da institution
      .mockRejectedValueOnce(Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK' }))
    const second: any = { query: jest.fn(), beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() }
    second.query
      .mockResolvedValueOnce([[{ id: 1 }]])                  // trava da institution
      .mockResolvedValueOnce([[]])                           // reconferência da chave (Rodada 6)
      .mockResolvedValueOnce([[{ nextId: 11 }]])             // MAX+1
      .mockResolvedValueOnce([[{ id: 1 }]])                  // categoria
      .mockResolvedValueOnce([[{ 1: 1 }]])                   // categoria serve ao serviço (Q-PR49 (a))
      .mockResolvedValue([[]])                               // código livre e o resto
    mockGetConnection.mockReset()
    mockGetConnection.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const id = await svcService.createService({ description: 'X', categoryId: 1 } as any, { schemaName: 'setes_setes', institutionId: 1 } as any)
    expect(id).toBe(11)
    expect(first.rollback).toHaveBeenCalled()
    expect(second.commit).toHaveBeenCalled()
  })

  it("Q-PR38'/Q-PR49 (a): categoria NOVA que não serve ao serviço (estabelecimento tem S viva e ela é P) → 400 no campo categoryId", async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ id: 1 }]])          // trava
      .mockResolvedValueOnce([[]])                   // reconferência da chave do sincronizador (Rodada 6) — nenhuma ativa
      .mockResolvedValueOnce([[{ nextId: 9 }]])      // MAX+1
      .mockResolvedValueOnce([[{ 1: 1 }]])           // categoria viva
      .mockResolvedValueOnce([[]])                   // predicado do serviço não casa
    await expect(svcRepo.insertService({ description: 'X', categoryId: 4 }, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 400, fields: [{ field: 'categoryId', message: 'Escolha uma categoria de serviço' }] })
    const kindSql = conn.query.mock.calls[4][0] as string
    expect(kindSql).toContain("c.kind = 'S'")
    expect(kindSql).toContain("c.kind = 'S' OR NOT EXISTS")
    expect(kindSql).toContain("sk.kind = 'S' AND sk.deleted = 'N' AND sk.active = 'S'")
    expect(conn.query.mock.calls[4][1]).toEqual([4, 1])
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('A-PR1: editar com a MESMA categoria gravada não reconfere a natureza (serviço do legado em categoria P segue editável); trocar reconfere', async () => {
    const run = async (categoryId: number) => {
      const conn = fakeConn()
      conn.query.mockImplementation(async (sql: string) => {
        if (/SELECT identifier, tb_category_id AS categoryId/.test(sql)) return [[{ identifier: 'SRV', categoryId: 3 }]]
        if (/c\.kind = 'S'/.test(sql)) return [[]]                      // nenhuma serviria
        if (/^\s*SELECT/.test(sql)) return [[{ 1: 1 }]]
        return [{ affectedRows: 1 }]
      })
      return { conn, result: svcRepo.updateService(5, { identifier: 'SRV', description: 'X', categoryId }, 'setes_setes', 1) }
    }
    const same = await run(3)
    await expect(same.result).resolves.toBe(true)
    expect(same.conn.query.mock.calls.some((c: any[]) => /c\.kind = 'S'/.test(c[0]))).toBe(false)
    const changed = await run(4)
    await expect(changed.result).rejects.toMatchObject({ statusCode: 400 })
  })

  it('Q-PR49 (a): o lookup de categorias do serviço vai pelo FATO (o predicado da peça), sem consultar a chave do sincronizador', async () => {
    mockQuery.mockResolvedValueOnce([[{ id: 2, description: 'Serviços', name: 'Serviços' }]])
    const rows = await svcService.fetchCategoriesLookup('serv', { schemaName: 'setes_setes', institutionId: 1 } as any)
    expect(rows).toHaveLength(1)
    expect(mockQuery).toHaveBeenCalledTimes(1)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).not.toContain('tb_sync_api_key')
    expect(sql).toContain("c.kind = 'S' OR NOT EXISTS")
    expect(params).toEqual([1, '%serv%', '%serv%'])
  })

  it("softDelete exige kind='S' no WHERE", async () => {
    mockQuery.mockResolvedValueOnce([{ affectedRows: 1 }])
    await svcRepo.softDeleteService(5, 'setes_setes', 1)
    expect(mockQuery.mock.calls[0][0] as string).toContain("kind = 'S'")
  })
})

// ---------------------------------------------------------------------
// price-lists repository
// ---------------------------------------------------------------------

describe('price-lists repository', () => {
  it('lista paginada: página + COUNT com a MESMA where', async () => {
    mockQuery
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ total: 1 }]])
    const result = await plRepo.listPriceLists(
      { filter: 'var', page: 1, pageSize: 25, offset: 0, criteria: NO_CRITERIA } as any,
      'setes_setes', 1)
    expect(result.total).toBe(1)
    expect(mockQuery.mock.calls[0][0] as string).toContain('LIMIT ? OFFSET ?')
    expect(mockQuery.mock.calls[1][0] as string).toContain('COUNT(*)')
  })

  it('insert: trava a institution (regra 7), reconfere a chave do sincronizador (Rodada 6) e cunha MAX+1 FOR UPDATE por institution', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ id: 1 }]])          // trava da institution
      .mockResolvedValueOnce([[]])                   // chave do sincronizador: nenhuma ativa
      .mockResolvedValueOnce([[{ nextId: 3 }]])
      .mockResolvedValueOnce([{}])
    const id = await plRepo.insertPriceList(
      { description: 'Atacado' }, 'setes_setes', 1)
    expect(id).toBe(3)
    const sqls = conn.query.mock.calls.map((c: any[]) => c[0] as string)
    expect(sqls[0]).toMatch(/setes_central\.tb_institution WHERE id = \? FOR UPDATE/)
    expect(sqls[1]).toContain('LOCK IN SHARE MODE')
    expect(sqls[2]).toContain('FOR UPDATE')
  })

  it('insert com a chave do sincronizador RELIGADA enquanto esperava a trava → 409 SYNC_MANAGED_CATALOG e rollback (reconferência — gate socrático R6)', async () => {
    const conn = fakeConn()
    conn.query
      .mockResolvedValueOnce([[{ id: 1 }]])
      .mockResolvedValueOnce([[{ 1: 1 }]])          // a chave está ativa agora
    await expect(plRepo.insertPriceList({ description: 'Atacado' }, 'setes_setes', 1))
      .rejects.toMatchObject({ statusCode: 409, code: 'SYNC_MANAGED_CATALOG' })
    expect(conn.rollback).toHaveBeenCalled()
    expect(conn.query.mock.calls.some((c: any[]) => /INSERT INTO/.test(c[0]))).toBe(false)
  })

  it('update/softDelete devolvem false quando não acham a linha', async () => {
    mockQuery.mockResolvedValueOnce([{ affectedRows: 0 }])
    expect(await plRepo.updatePriceList(
      9, { description: 'X' }, 'setes_setes', 1)).toBe(false)
    mockQuery.mockResolvedValueOnce([{ affectedRows: 0 }])
    expect(await plRepo.softDeletePriceList(9, 'setes_setes', 1)).toBe(false)
  })
})
