/// <reference types="jest" />
// NFE.E1.P1.T4 (D-FAT1): a nota só grava cálculo conferido com o pedido travado — a impressão do que o pedido entregou ao cálculo
// e a releitura sob a trava. (O laço "refaz leitura e cálculo" está em billing.test.ts.)
import { billingInputPrint, assertBillingInputsUnchanged, BillingInputChanged, BillingInputSource } from '../modules/billing/billing.input-print'

const src = (over: Partial<BillingInputSource> = {}): BillingInputSource => ({
  items: [
    { id: 1, kind: 'Sale', productId: 100, quantity: 2, unitValue: 50, discountValue: 0, productKind: 'P' },
    { id: 2, kind: 'Service', productId: 200, quantity: 1, unitValue: 300, discountValue: 10, productKind: 'S' },
  ],
  links: [{ orderItemId: 1, kind: 'Sale', taxRuleId: 42, cfopId: '5102', setFinancial: 'S' }],
  serviceLinks: [{ orderItemId: 2, kind: 'Service', serviceTaxRuleId: 7 }],
  freight: 12.5, expenses: 0,
  ...over,
})
const PRINT = billingInputPrint(src())

/** As colunas que um SELECT devolve: o alias depois de AS, ou o nome da coluna (sem o prefixo da tabela). */
function selectedColumns(sql: string): string[] {
  const list = sql.slice(sql.indexOf('SELECT') + 6, sql.indexOf(' FROM ')).replace(/\s+/g, ' ')
  const parts: string[] = []
  let depth = 0; let cur = ''
  for (const ch of list) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
  }
  parts.push(cur)
  return parts.map(p => p.trim()).map(p => / AS (\w+)$/.exec(p)?.[1] ?? p.split('.').pop()!)
}
/**
 * A conexão travada devolvendo o que o banco tem AGORA (decimais como texto, como o driver devolve). Como um banco de verdade,
 * cada linha só tem as colunas que O SQL SELECIONA, com o nome que ele dá: alias trocado ou coluna esquecida na releitura some da
 * linha — e a conferência acusaria mudança em TODO faturamento (gate adversarial do NFE.E1.P1).
 */
function lockedConn(now: BillingInputSource) {
  const pick = (sql: string, rows: Record<string, unknown>[]) => {
    const cols = selectedColumns(sql)
    return rows.map(r => Object.fromEntries(cols.map(c => [c, r[c]])))
  }
  const query = jest.fn(async (sql: string, _params?: unknown[]): Promise<unknown[]> => {
    if (/tb_order_item i\b/.test(sql)) return [pick(sql, now.items.map(i => ({ ...i, quantity: i.quantity.toFixed(4), unitValue: i.unitValue.toFixed(6), discountValue: i.discountValue.toFixed(6) })))]
    if (/tb_order_item_tax_rule\b/.test(sql)) return [pick(sql, now.links as any)]
    if (/tb_order_item_service_tax_rule\b/.test(sql)) return [pick(sql, now.serviceLinks as any)]
    if (/tb_order_shipping\b/.test(sql)) return [pick(sql, [{ freight: now.freight.toFixed(2) }])]
    if (/tb_order_totalizer\b/.test(sql)) return [pick(sql, [{ expenses: now.expenses.toFixed(2) }])]
    throw new Error('consulta inesperada: ' + sql)
  })
  return { query }
}
const check = (now: BillingInputSource) => assertBillingInputsUnchanged(lockedConn(now) as any, 'setes_setes', 1, 10, PRINT)

describe('D-FAT1 — impressão do pedido', () => {
  it('é estável: a ordem das linhas e o tipo (número × texto decimal do banco) não mudam a impressão', () => {
    expect(PRINT).toBe('I|1|Sale|100|2|50|0\nI|2|Service|200|1|300|10\nL|1|Sale|42|5102|S\nS|2|Service|7\nF|12.5\nE|0')
    const s0 = src()
    expect(billingInputPrint({ ...s0, items: [...s0.items].reverse() })).toBe(PRINT)
    expect(billingInputPrint({ ...s0, items: s0.items.map(i => ({ ...i, quantity: '2.0000' as any, unitValue: String(i.unitValue.toFixed(6)) as any })).map((i, k) => k === 0 ? i : { ...i, quantity: 1 }) })).toBe(PRINT)
  })

  it('vínculo de item que não está vivo não conta; vínculo de serviço em item que não é serviço também não', () => {
    const s0 = src()
    expect(billingInputPrint({ ...s0, links: [...s0.links, { orderItemId: 9, kind: 'Sale', taxRuleId: 1, cfopId: null, setFinancial: 'S' }] })).toBe(PRINT)
    expect(billingInputPrint({ ...s0, serviceLinks: [...s0.serviceLinks, { orderItemId: 1, kind: 'Sale', serviceTaxRuleId: 3 }] })).toBe(PRINT)
  })

  it.each([
    ['quantidade do item', (s: BillingInputSource) => ({ ...s, items: s.items.map(i => i.id === 1 ? { ...i, quantity: 3 } : i) })],
    ['valor unitário', (s: BillingInputSource) => ({ ...s, items: s.items.map(i => i.id === 1 ? { ...i, unitValue: 50.01 } : i) })],
    ['desconto', (s: BillingInputSource) => ({ ...s, items: s.items.map(i => i.id === 2 ? { ...i, discountValue: 0 } : i) })],
    ['produto do item', (s: BillingInputSource) => ({ ...s, items: s.items.map(i => i.id === 1 ? { ...i, productId: 101 } : i) })],
    ['item novo', (s: BillingInputSource) => ({ ...s, items: [...s.items, { id: 3, kind: 'Sale', productId: 5, quantity: 1, unitValue: 1, discountValue: 0, productKind: 'P' }] })],
    ['item removido', (s: BillingInputSource) => ({ ...s, items: s.items.slice(0, 1), serviceLinks: [] })],
    ['regra de tributação do item', (s: BillingInputSource) => ({ ...s, links: [{ ...s.links[0], taxRuleId: 43 }] })],
    ['CFOP do vínculo', (s: BillingInputSource) => ({ ...s, links: [{ ...s.links[0], cfopId: '6102' }] })],
    ['gera financeiro (set_financial)', (s: BillingInputSource) => ({ ...s, links: [{ ...s.links[0], setFinancial: 'N' }] })],
    ['regra de serviço do item', (s: BillingInputSource) => ({ ...s, serviceLinks: [{ ...s.serviceLinks[0], serviceTaxRuleId: 8 }] })],
    ['frete do pedido', (s: BillingInputSource) => ({ ...s, freight: 12.51 })],
    ['outras despesas do pedido', (s: BillingInputSource) => ({ ...s, expenses: 1 })],
  ])('mudou %s → a conferência sob a trava acusa (BillingInputChanged)', async (_what, change) => {
    await expect(check(change(src()))).rejects.toBeInstanceOf(BillingInputChanged)
  })

  it('nada mudou → passa; relê na conexão travada, com o pedido e a institution como parâmetros', async () => {
    const conn = lockedConn(src())
    await expect(assertBillingInputsUnchanged(conn as any, 'setes_setes', 1, 10, PRINT)).resolves.toBeUndefined()
    expect(conn.query).toHaveBeenCalledTimes(5)
    for (const c of conn.query.mock.calls) expect(c[1]).toEqual([10, 1])
  })

  it('paridade com as leituras do service: a releitura seleciona, com os MESMOS nomes, as colunas que a impressão lê — e as leituras do service também', async () => {
    const conn = lockedConn(src())
    await assertBillingInputsUnchanged(conn as any, 'setes_setes', 1, 10, PRINT)
    const cols = (re: RegExp) => selectedColumns(String(conn.query.mock.calls.find(c => re.test(String(c[0])))![0])).sort()
    expect(cols(/tb_order_item i\b/)).toEqual(['discountValue', 'id', 'kind', 'productId', 'productKind', 'quantity', 'unitValue'])
    expect(cols(/tb_order_item_tax_rule\b/)).toEqual(['cfopId', 'kind', 'orderItemId', 'setFinancial', 'taxRuleId'])
    expect(cols(/tb_order_item_service_tax_rule\b/)).toEqual(['kind', 'orderItemId', 'serviceTaxRuleId'])
    expect(cols(/tb_order_shipping\b/)).toEqual(['freight'])
    expect(cols(/tb_order_totalizer\b/)).toEqual(['expenses'])
    // as leituras do service (pelo pool) devolvem essas mesmas colunas — a impressão dos dois lados nasce dos mesmos nomes
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const repo = fs.readFileSync(path.join(__dirname, '..', 'modules', 'billing', 'billing.repository.ts'), 'utf8')
    const fn = (name: string) => { const i = repo.indexOf(`export async function ${name}(`); return repo.slice(i, repo.indexOf('\n}\n', i)) }
    const serviceCols = (name: string, nth = 0) => {
      const body = fn(name); let at = -1
      for (let k = 0; k <= nth; k++) at = body.indexOf('SELECT', at + 1)
      return selectedColumns(body.slice(at))
    }
    expect(serviceCols('listBillingItems')).toEqual(expect.arrayContaining(['id', 'kind', 'productId', 'quantity', 'unitValue', 'discountValue', 'productKind']))
    expect(serviceCols('getItemRuleLinks')).toEqual(expect.arrayContaining(['orderItemId', 'kind', 'taxRuleId', 'cfopId', 'setFinancial']))
    expect(serviceCols('getItemServiceRuleLinks')).toEqual(expect.arrayContaining(['orderItemId', 'kind', 'serviceTaxRuleId']))
    expect(serviceCols('getFreightAndExpenses', 0)).toEqual(['freight'])
    expect(serviceCols('getFreightAndExpenses', 1)).toEqual(['expenses'])
    // e os mesmos filtros: item vivo com produto, terminal 0
    for (const sql of conn.query.mock.calls.map(c => String(c[0]))) expect(sql).toMatch(/terminal = 0[\s\S]*deleted = 'N'/)
  })

  it('TODA releitura é travante (não abre o retrato da transação — invariante do saldo devolvível); os vínculos com FOR UPDATE (a transação os atualiza depois)', async () => {
    const conn = lockedConn(src())
    await assertBillingInputsUnchanged(conn as any, 'setes_setes', 1, 10, PRINT)
    const sqls = conn.query.mock.calls.map(c => String(c[0]))
    expect(sqls.every(s => /LOCK IN SHARE MODE|FOR UPDATE/.test(s))).toBe(true)
    expect(sqls.find(s => /tb_order_item_tax_rule\b/.test(s))).toMatch(/FOR UPDATE/)
    expect(sqls.find(s => /tb_order_item_service_tax_rule\b/.test(s))).toMatch(/FOR UPDATE/)
    expect(sqls.find(s => /tb_order_item i\b/.test(s))).toMatch(/deleted = 'N'\s+LOCK IN SHARE MODE/)
  })

  it('a transação do faturamento chama a conferência logo depois da trava do pedido e antes de gravar imposto (leitura do fonte)', () => {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const repo = fs.readFileSync(path.join(__dirname, '..', 'modules', 'billing', 'billing.repository.ts'), 'utf8')
    const once = repo.slice(repo.indexOf('async function persistInvoiceOnce'))
    const lock = once.indexOf('FOR UPDATE')
    const check_ = once.indexOf('assertBillingInputsUnchanged(conn')
    const parcels = once.indexOf('params.resolveParcels(conn)')
    const taxes = once.indexOf('persistItemTaxes(conn')
    expect(lock).toBeGreaterThan(0)
    expect(check_).toBeGreaterThan(lock)
    expect(parcels).toBeGreaterThan(check_)
    expect(taxes).toBeGreaterThan(check_)
    expect(repo).not.toContain('assertBillingItemsUnchanged')
  })
})
