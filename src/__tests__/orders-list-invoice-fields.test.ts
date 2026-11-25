/**
 * NFE.E1.P7 — a lista de pedidos devolve o modelo e o número da nota.
 * pool.query mockado: prova o SQL (colunas do JOIN `inv`) e a repassagem da linha.
 */
import pool from '../shared/db/connection'
import { fetchOrders } from '../modules/orders/orders.service'
import type { ListQuery } from '../shared/list'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const mockQuery = (pool as any).query as jest.Mock
const scope = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }
const query = { filter: '', page: 1, pageSize: 20, offset: 0, criteria: { sql: '', params: [] } } as unknown as ListQuery

const base = { number: 1, customerId: 5, customerName: 'C', salesmanId: 9, salesmanName: 'V',
  status: 'F', dtRecord: '2026-11-25', hasService: 0, itemsCount: 1, totalValue: 10 }

describe('NFE.E1.P7 — GET /api/orders traz invoiceModel e invoiceNumber', () => {
  beforeEach(() => mockQuery.mockReset())

  it('o SELECT da lista lê modelo e número do JOIN inv', async () => {
    mockQuery.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]])
    await fetchOrders('', query, scope)
    const sql: string = mockQuery.mock.calls[0][0]
    expect(sql).toMatch(/inv\.model AS invoiceModel/)
    expect(sql).toMatch(/inv\.number AS invoiceNumber/)
    expect(sql).toMatch(/LEFT JOIN `setes_setes`\.tb_invoice inv/)
  })

  it('55 faturado sem número, SE com número e pedido sem nota', async () => {
    mockQuery
      .mockResolvedValueOnce([[
        { ...base, id: 1, invoiceModel: '55', invoiceNumber: null },
        { ...base, id: 2, invoiceModel: 'SE', invoiceNumber: '123' },
        { ...base, id: 3, status: 'A', invoiceModel: null, invoiceNumber: null },
      ]])
      .mockResolvedValueOnce([[{ total: 3 }]])
    const r = await fetchOrders('', query, scope)
    expect(r.total).toBe(3)
    expect(r.rows[0]).toMatchObject({ invoiceModel: '55', invoiceNumber: null })
    expect(r.rows[1]).toMatchObject({ invoiceModel: 'SE', invoiceNumber: '123' })
    expect(r.rows[2]).toMatchObject({ invoiceModel: null, invoiceNumber: null })
    expect(r.rows[0].hasService).toBe(false)
  })
})
