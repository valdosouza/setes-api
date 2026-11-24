/// <reference types="jest" />
// NFE.E1.P2.T1 (D-NE43, D-NE49, D-NE260, D-NE267): a conferência do conteúdo da NF-e no faturamento — as regras puras e a leitura
// do cadastro. (A ligação com o /validate e o /invoice, só com a marcação `authorizeNfe`, está em billing.test.ts.)
import pool from '../shared/db/connection'
import {
  invoiceContentIssues, noteTextIssue, loadInvoiceContent, pisCofinsCstOf, NOTE_TEXT_MAX, InvoiceContent,
} from '../modules/billing/billing.content'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn() } }))
jest.mock('../shared/entity/entity-fiscal', () => ({ __esModule: true, getEntityFiscalFull: jest.fn() }))
jest.mock('../shared/entity-tax/entity-tax.repository', () => ({ __esModule: true, getEntityTax: jest.fn() }))

const mockQuery = (pool as any).query as jest.Mock
const mockFull = (jest.requireMock('../shared/entity/entity-fiscal') as any).getEntityFiscalFull as jest.Mock
const mockTax = (jest.requireMock('../shared/entity-tax/entity-tax.repository') as any).getEntityTax as jest.Mock

const address = (over: Record<string, unknown> = {}) => ({
  street: 'Rua das Flores', number: '100', complement: null, neighborhood: 'Centro', zipCode: '80000-000',
  cityCode: '4106902', state: 'PR', ...over,
})
const good = (over: { recipient?: Record<string, unknown>; items?: InvoiceContent['items'] } = {}): InvoiceContent => ({
  recipient: {
    personType: 'J', name: 'Cliente Bom Ltda', document: '11.222.333/0001-81', stateRegistration: '123.456.789',
    stateRegistrationIndicator: '1', address: address(), phone: '(41) 3333-4444', email: 'nfe@cliente.com.br', ...over.recipient,
  } as InvoiceContent['recipient'],
  items: over.items ?? [{ itemId: 1, description: 'Peça usinada', ncm: '8471.30.12', unit: 'UN', taxableUnit: 'UN', gtin: '7891234567895' }],
})
const fields = (c: InvoiceContent): string[] => invoiceContentIssues(c).map(i => `${i.scope}:${i.field}`)

beforeEach(() => jest.clearAllMocks())

describe('conferência do conteúdo — regras puras', () => {
  it('conteúdo que a NF-e aceita → nenhuma pendência (máscara de CNPJ, IE, CEP, NCM e telefone não conta)', () => {
    expect(invoiceContentIssues(good())).toEqual([])
  })

  it.each<[string, Record<string, unknown>, string | null]>([
    ['nome com 60 passa', { name: 'N'.repeat(60) }, null],
    ['nome com 61 é recusado (nunca truncado)', { name: 'N'.repeat(61) }, 'recipient:name'],
    ['nome com 1 é recusado', { name: 'N' }, 'recipient:name'],
    ['nome em branco é recusado', { name: '   ' }, 'recipient:name'],
    ['CNPJ com 13 dígitos', { document: '1122233300018' }, 'recipient:document'],
    ['CNPJ com dígito verificador errado', { document: '11.222.333/0001-82' }, 'recipient:document'],
    ['CNPJ sem máscara passa', { document: '11222333000181' }, null],
    ['CNPJ ALFANUMÉRICO válido passa (D-CJ12: nunca tirar as letras)', { document: '12.ABC.345/01DE-35' }, null],
    ['CNPJ ausente', { document: null }, 'recipient:document'],
    ['pessoa física com CPF de 11 passa', { personType: 'F', document: '123.456.789-09', stateRegistrationIndicator: '9' }, null],
    ['pessoa física com CPF de 10', { personType: 'F', document: '1234567890' }, 'recipient:document'],
    ['pessoa física com CPF de dígito verificador errado', { personType: 'F', document: '123.456.789-00' }, 'recipient:document'],
    ['sem documento (estrangeiro) é recusado', { personType: 'N', document: null }, 'recipient:document'],
    ['contribuinte (indicador 1) sem IE', { stateRegistration: null }, 'recipient:stateRegistration'],
    ['contribuinte com IE de 15 dígitos', { stateRegistration: '123456789012345' }, 'recipient:stateRegistration'],
    ['não contribuinte (indicador 9) sem IE passa', { stateRegistrationIndicator: '9', stateRegistration: null }, null],
    ['pessoa FÍSICA contribuinte sem IE passa (o cadastro de pessoa física não tem IE)', { personType: 'F', document: '12345678909', stateRegistrationIndicator: '1', stateRegistration: null }, null],
    ['sem endereço principal', { address: null }, 'recipient:address'],
    ['logradouro com 61', { address: address({ street: 'R'.repeat(61) }) }, 'recipient:street'],
    ['logradouro com 1', { address: address({ street: 'R' }) }, 'recipient:street'],
    ['número ausente', { address: address({ number: '' }) }, 'recipient:number'],
    ['bairro ausente', { address: address({ neighborhood: null }) }, 'recipient:neighborhood'],
    ['bairro com 61', { address: address({ neighborhood: 'B'.repeat(61) }) }, 'recipient:neighborhood'],
    ['complemento com 61', { address: address({ complement: 'C'.repeat(61) }) }, 'recipient:complement'],
    ['complemento com 60 passa', { address: address({ complement: 'C'.repeat(60) }) }, null],
    ['CEP com 7 dígitos', { address: address({ zipCode: '8000-000' }) }, 'recipient:zipCode'],
    ['CEP ausente', { address: address({ zipCode: null }) }, 'recipient:zipCode'],
    ['cidade sem IBGE', { address: address({ cityCode: null }) }, 'recipient:cityCode'],
    ['UF ausente', { address: address({ state: null }) }, 'recipient:state'],
    ['telefone ausente passa (a NF-e não exige)', { phone: null }, null],
    ['telefone com 5 dígitos', { phone: '33334' }, 'recipient:phone'],
    ['telefone com DDI (13 dígitos) passa', { phone: '+55 (41) 99999-8888' }, null],
    ['telefone com 15 dígitos', { phone: '554199999888877' }, 'recipient:phone'],
    ['e-mail ausente passa', { email: null }, null],
    ['e-mail com 61', { email: `${'a'.repeat(52)}@mail.com` }, 'recipient:email'],
  ])('destinatário — %s', (_label, over, expected) => {
    expect(fields(good({ recipient: over }))).toEqual(expected ? [expected] : [])
  })

  it.each<[string, Partial<InvoiceContent['items'][number]>, string | null]>([
    ['descrição ausente', { description: '  ' }, 'item:description'],
    ['descrição com 120 passa', { description: 'D'.repeat(120) }, null],
    ['descrição com 121', { description: 'D'.repeat(121) }, 'item:description'],
    ['NCM com 7 dígitos', { ncm: '8471301' }, 'item:ncm'],
    ['NCM ausente', { ncm: null }, 'item:ncm'],
    ['produto sem unidade cadastrada', { unit: null, taxableUnit: null }, 'item:unit'],
    ['unidade com 7', { unit: 'UNIDADE', taxableUnit: 'UN' }, 'item:unit'],
    ['unidade tributável com 7', { taxableUnit: 'UNIDADE' }, 'item:taxableUnit'],
    ['sem GTIN passa (o XML leva SEM GTIN)', { gtin: null }, null],
    ['GTIN-8 passa', { gtin: '12345670' }, null],
    ['GTIN-12 passa', { gtin: '123456789012' }, null],
    ['GTIN-14 passa', { gtin: '12345678901231' }, null],
    ['GTIN com 9 dígitos', { gtin: '123456789' }, 'item:gtin'],
    ['GTIN com letra', { gtin: '78912345678A5' }, 'item:gtin'],
  ])('item — %s', (_label, over, expected) => {
    const c = good()
    c.items = [{ ...c.items[0], ...over }]
    const issues = invoiceContentIssues(c)
    expect(issues.map(i => `${i.scope}:${i.field}`)).toEqual(expected ? [expected] : [])
    if (expected) expect(issues[0]).toMatchObject({ itemId: 1, message: expect.stringMatching(/^Item 1: /) })
  })

  it('NFE.E1.P4.T4 — PIS/COFINS da regra: só `null` acusa (a regra não tem a peça); ausente não é conferido; item de serviço nem entra', () => {
    const withCst = (pisCst: string | null | undefined, cofinsCst: string | null | undefined) => {
      const c = good()
      c.items = [{ ...c.items[0], ...(pisCst !== undefined ? { pisCst } : {}), ...(cofinsCst !== undefined ? { cofinsCst } : {}) }]
      return invoiceContentIssues(c)
    }
    expect(withCst('07', '07')).toEqual([])                 // Simples: CST 07 nas duas — passa
    expect(withCst(undefined, undefined)).toEqual([])       // item ainda sem regra: não conferido aqui
    expect(withCst(null, '07')).toEqual([{ scope: 'item', itemId: 1, field: 'pis', message: 'Item 1: regra de tributação sem PIS' }])
    expect(withCst('01', null)).toEqual([{ scope: 'item', itemId: 1, field: 'cofins', message: 'Item 1: regra de tributação sem COFINS' }])
    expect(withCst(null, null).map(i => i.field)).toEqual(['pis', 'cofins'])
  })

  it('NFE.E1.P4.T4 — pisCofinsCstOf: lê o CST de cada peça da regra; sem a peça (ou CST em branco) devolve null', () => {
    expect(pisCofinsCstOf({ pisCofins: [{ kind: 'P', cst: '07' }, { kind: 'C', cst: '07' }] })).toEqual({ pisCst: '07', cofinsCst: '07' })
    expect(pisCofinsCstOf({ pisCofins: [{ kind: 'C', cst: '01' }] })).toEqual({ pisCst: null, cofinsCst: '01' })
    expect(pisCofinsCstOf({ pisCofins: [{ kind: 'P', cst: ' ' }] })).toEqual({ pisCst: null, cofinsCst: null })
    expect(pisCofinsCstOf({})).toEqual({ pisCst: null, cofinsCst: null })
    expect(pisCofinsCstOf(undefined)).toEqual({ pisCst: null, cofinsCst: null })
  })

  it('devolve TODAS as pendências de uma vez (nunca para na primeira), cada uma com o campo e os números', () => {
    const c = good({
      recipient: { name: 'N'.repeat(73), address: address({ zipCode: null, neighborhood: '' }) },
      items: [
        { itemId: 1, description: 'Peça', ncm: '84713012', unit: null, taxableUnit: null, gtin: null },
        { itemId: 2, description: 'Outra', ncm: '8471', unit: 'KG', taxableUnit: 'KG', gtin: '1' },
      ],
    })
    expect(invoiceContentIssues(c)).toEqual([
      { scope: 'recipient', field: 'name', message: 'Nome do destinatário com 73 caracteres — o máximo da NF-e é 60' },
      { scope: 'recipient', field: 'neighborhood', message: 'Bairro do destinatário não informado' },
      { scope: 'recipient', field: 'zipCode', message: 'CEP do destinatário não informado' },
      { scope: 'item', itemId: 1, field: 'unit', message: 'Item 1: produto sem unidade de venda cadastrada' },
      { scope: 'item', itemId: 2, field: 'ncm', message: 'Item 2: NCM com 4 dígitos — são 8' },
      { scope: 'item', itemId: 2, field: 'gtin', message: expect.stringContaining('"1" inválido') },
    ])
  })

  it('texto da nota: até 5000 passa; 5001 é pendência com o campo note (nunca truncado)', () => {
    expect(NOTE_TEXT_MAX).toBe(5000)
    expect(noteTextIssue('x'.repeat(5000))).toBeNull()
    expect(noteTextIssue(null)).toBeNull()
    expect(noteTextIssue('x'.repeat(5001))).toEqual({
      scope: 'order', field: 'note', message: 'Observações da nota com 5001 caracteres — o máximo da NF-e é 5000',
    })
  })
})

describe('conferência do conteúdo — leitura do cadastro (ao vivo)', () => {
  const entity = (over: Record<string, unknown> = {}) => ({
    id: 55, entity: { nameCompany: 'Cliente Bom Ltda', nickTrade: null, aniversary: null }, personType: 'J',
    person: null, company: { cnpj: '11222333000181', ie: '123456789', im: null }, noDoc: null,
    addresses: [
      { kind: 'COBRANCA', street: 'Rua B', nmbr: '2', complement: null, neighborhood: 'Outro', zipCode: '81000000', tbCountryId: 1, tbStateId: 41, tbCityId: 9, main: 'N' },
      { kind: 'COMERCIAL', street: 'Rua das Flores', nmbr: '100', complement: 'Sala 2', neighborhood: 'Centro', zipCode: '80000000', tbCountryId: 1, tbStateId: 41, tbCityId: 7, main: 'S' },
    ],
    phones: [{ kind: 'A', contact: null, number: '' }, { kind: 'B', contact: null, number: '4133334444' }],
    socialMedia: [], ...over,
  })
  /** O pool respondendo por consulta (regex do SQL), como o banco. */
  function db(over: { units?: unknown[]; mail?: unknown[]; geo?: unknown[] } = {}) {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/FROM setes_central\.tb_city c/.test(sql)) return [over.geo ?? [{ cityCode: '4106902', state: 'PR' }]]
      if (/tb_entity_has_mailing/.test(sql)) return [over.mail ?? [{ email: 'nfe@cliente.com.br' }]]
      if (/tb_merchandise_trade_unit/.test(sql)) return [over.units ?? [{ productId: 100, unit: 'UN', taxableUnit: 'UN', gtin: '7891234567895' }]]
      throw new Error('consulta inesperada: ' + sql)
    })
  }
  const items = [
    { id: 1, productId: 100, productKind: 'P', productDescription: 'Peça usinada', ncm: '84713012' },
    { id: 2, productId: 300, productKind: 'S', productDescription: 'Serviço', ncm: null },
    { id: 3, productId: 200, productKind: 'M', productDescription: 'Sem unidade', ncm: '73259990' },
  ]

  it('monta o destinatário do endereço PRINCIPAL, com IBGE e UF, o 1º telefone preenchido, o e-mail e o indicador de IE; e só os itens de mercadoria', async () => {
    mockFull.mockResolvedValueOnce(entity())
    mockTax.mockResolvedValueOnce({ indIeDest: '1' })
    db()
    const c = await loadInvoiceContent('setes_setes', 1, 55, items)
    expect(mockFull).toHaveBeenCalledWith(55)
    expect(mockTax).toHaveBeenCalledWith('setes_setes', 1, 55)
    expect(c.recipient).toEqual({
      personType: 'J', name: 'Cliente Bom Ltda', document: '11222333000181', stateRegistration: '123456789',
      stateRegistrationIndicator: '1',
      address: { street: 'Rua das Flores', number: '100', complement: 'Sala 2', neighborhood: 'Centro', zipCode: '80000000', cityCode: '4106902', state: 'PR' },
      phone: '4133334444', email: 'nfe@cliente.com.br',
    })
    expect(c.items).toEqual([
      { itemId: 1, description: 'Peça usinada', ncm: '84713012', unit: 'UN', taxableUnit: 'UN', gtin: '7891234567895' },
      { itemId: 3, description: 'Sem unidade', ncm: '73259990', unit: null, taxableUnit: null, gtin: null },   // mercadoria sem unidade cadastrada
    ])
    expect(invoiceContentIssues(c).map(i => `${i.itemId}:${i.field}`)).toEqual(['3:unit'])
    // a cidade e a UF são as do endereço principal (ids 7 e 41)
    const geo = mockQuery.mock.calls.find(call => /tb_city c/.test(String(call[0])))!
    expect(geo[1]).toEqual([41, 7])
  })

  it('as consultas: unidade do nível de venda padrão (nulo = 1), tributável nula = a de venda, GTIN do nível de venda; e-mail do grupo NF-e antes do principal', async () => {
    mockFull.mockResolvedValueOnce(entity())
    mockTax.mockResolvedValueOnce(null)
    db()
    await loadInvoiceContent('setes_setes', 1, 55, items)
    const units = mockQuery.mock.calls.find(call => /tb_merchandise_trade_unit/.test(String(call[0])))!
    const sql = String(units[0]).replace(/\s+/g, ' ')
    expect(sql).toContain('sale.level = COALESCE(m.default_sale_trade_level, 1)')
    expect(sql).toContain('taxable.level = m.taxable_trade_level')
    expect(sql).toContain('COALESCE(tu2.abbreviation, su.abbreviation) AS taxableUnit')
    expect(sql).toContain('sale.gtin')
    expect(sql).toMatch(/FROM `setes_setes`\.tb_merchandise m LEFT JOIN `setes_setes`\.tb_merchandise_trade_unit sale/)   // LEFT: sem unidade = nulo
    expect(units[1]).toEqual([1, [100, 200]])                                                                          // só mercadoria, sem repetir
    const mail = String(mockQuery.mock.calls.find(call => /tb_entity_has_mailing/.test(String(call[0])))![0]).replace(/\s+/g, ' ')
    expect(mail).toContain('em.tb_mailing_group_id IN (3, 1) ORDER BY em.tb_mailing_group_id DESC LIMIT 1')
    expect(mockQuery.mock.calls.every(call => /^\s*SELECT/.test(String(call[0])))).toBe(true)                            // só leitura
  })

  it('entidade sem endereço, sem telefone, sem e-mail e sem documento → conteúdo com nulos, e a conferência acusa cada falta', async () => {
    mockFull.mockResolvedValueOnce(entity({ personType: 'N', company: null, addresses: [], phones: [] }))
    mockTax.mockResolvedValueOnce(null)
    db({ mail: [] })
    const c = await loadInvoiceContent('setes_setes', 1, 55, [items[0]])
    expect(c.recipient).toMatchObject({ personType: 'N', document: null, address: null, phone: null, email: null, stateRegistrationIndicator: null })
    expect(mockQuery.mock.calls.some(call => /tb_city c/.test(String(call[0])))).toBe(false)   // sem endereço não consulta a cidade
    expect(invoiceContentIssues(c).map(i => i.field)).toEqual(['document', 'address'])
  })

  it('NFE.E1.P4.T4 — o CST de PIS/COFINS que o faturamento entrega por item passa para o conteúdo; item sem o campo fica sem ele', async () => {
    mockFull.mockResolvedValueOnce(entity())
    mockTax.mockResolvedValueOnce(null)
    db({ units: [{ productId: 100, unit: 'UN', taxableUnit: 'UN', gtin: null }, { productId: 200, unit: 'KG', taxableUnit: 'KG', gtin: null }] })
    const c = await loadInvoiceContent('setes_setes', 1, 55, [
      { ...items[0], pisCst: '07', cofinsCst: null }, items[2],
    ])
    expect(c.items[0]).toMatchObject({ itemId: 1, pisCst: '07', cofinsCst: null })
    expect('pisCst' in c.items[1]).toBe(false)
    expect('cofinsCst' in c.items[1]).toBe(false)
    expect(invoiceContentIssues(c).map(i => `${i.itemId}:${i.field}`)).toEqual(['1:cofins'])
  })

  it('sem endereço marcado como principal usa o primeiro; pedido sem mercadoria não consulta unidades', async () => {
    const e = entity()
    e.addresses = [e.addresses[0]]
    mockFull.mockResolvedValueOnce(e)
    mockTax.mockResolvedValueOnce(null)
    db()
    const c = await loadInvoiceContent('setes_setes', 1, 55, [items[1]])
    expect(c.recipient.address).toMatchObject({ street: 'Rua B' })
    expect(c.items).toEqual([])
    expect(mockQuery.mock.calls.some(call => /tb_merchandise_trade_unit/.test(String(call[0])))).toBe(false)
  })
})
