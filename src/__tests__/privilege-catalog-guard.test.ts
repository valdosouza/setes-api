/// <reference types="jest" />
// D-PV15 (= Q-PV17 (a), Valdo 2026-10-18) + D-PV42 (= Q-PV50 (a), Valdo 2026-10-20): as telas do Super Interfaces e Privilégios RECUSAM
// (409, nomeando o consumidor) a mudança que recriaria o C1 na hora — o boot só via no próximo restart. Integridade do catálogo, não
// autorização: vale também para o super (A-PV14). A guarda lê o MESMO conjunto da cerca e do boot (lista à mão ∪ tabela do roteador —
// D-PV14) + as REGRAS (VISUALIZAR em toda tela, CONFIGURAR com config/campo) + os reservados (D-PV51); e congela TODA chave que o código
// usa para abrir ou montar uma tela — a `i18n_key` existente não se renomeia (D-PV42).
jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() } }))
jest.mock('../modules/interfaces/interfaces.repository', () => ({
  getInterface: jest.fn(), updateInterface: jest.fn(), insertInterface: jest.fn(), deleteInterface: jest.fn(),
  syncInterfacePrivileges: jest.fn(), interfaceIdsWithKey: jest.fn(), interfaceHasConfigOrField: jest.fn(),
  INTERFACE_SEARCH_CRITERIA: [],
}))
jest.mock('../modules/privileges/privileges.repository', () => ({
  getPrivilege: jest.fn(), updatePrivilege: jest.fn(), insertPrivilege: jest.fn(), deletePrivilege: jest.fn(), privilegeIdsWithName: jest.fn(),
  PRIVILEGE_SEARCH_CRITERIA: [],
}))

import fs from 'fs'
import path from 'path'
import router from '../gateway/router'
import * as ifaceRepo from '../modules/interfaces/interfaces.repository'
import * as privRepo from '../modules/privileges/privileges.repository'
import { createInterface, editInterface, removeInterface } from '../modules/interfaces/interfaces.service'
import { createPrivilege, editPrivilege, removePrivilege } from '../modules/privileges/privileges.service'
import {
  requiredPairsOf, isMenuScreen, isScreen, interfaceCatalogViolations, privilegeCatalogViolations, assertNoCatalogViolation,
  privilegeConsumersOf, interfaceKeyUses, consumedPrivileges, RESERVED_PRIVILEGES, InterfaceCatalogState, InterfaceRules,
} from '../shared/auth/privilege-catalog'
import { HttpError } from '../shared/errors/http-error'
import { handleError } from '../shared/http/controller-utils'
import { interfaceDto } from '../modules/interfaces/interfaces.dto'

void router                                                     // montar o gateway registra as guardas (a tabela da D-PV14)

const m = <T extends (...a: any[]) => any>(f: T) => f as unknown as jest.Mock
beforeEach(() => {
  jest.clearAllMocks()
  m(ifaceRepo.interfaceIdsWithKey).mockResolvedValue([])
  m(privRepo.privilegeIdsWithName).mockResolvedValue([])
  m(ifaceRepo.insertInterface).mockResolvedValue(41)
  m(ifaceRepo.interfaceHasConfigOrField).mockResolvedValue(false)
})

/** settlements como fica no catálogo depois dos seeds 64 + 68 (1, 2, 3, 6, 8, 11). */
const SETTLEMENTS: InterfaceCatalogState = {
  i18nKey: 'settlements', kind: 'T', groupDefault: 'Financeiro', privilegeIds: [1, 2, 3, 6, 8, 11], configurable: true,
}
/** Uma interface que NENHUM código usa (sem rota no app, sem config/campo, sem par operado). */
const UNUSED: InterfaceCatalogState = { i18nKey: 'legacy-report', kind: 'T', groupDefault: 'Cadastros', privilegeIds: [6] }
const pairs = (k: string | null, rules: InterfaceRules) => requiredPairsOf(k, rules).map(r => r.privilege).sort()

describe('D-PV15/D-PV51 — o que o catálogo não pode perder (peça pura)', () => {
  it('tela = kind T (qualquer grupo — o menu do super também pede VISUALIZAR); tela do menu do CLIENTE = T fora do grupo Super', () => {
    expect([isScreen('T'), isScreen(null), isScreen('t'), isScreen('R')]).toEqual([true, true, true, false])
    expect([isMenuScreen('T', 'Financeiro'), isMenuScreen(null, null), isMenuScreen('t', 'Cadastros')]).toEqual([true, true, true])
    expect([isMenuScreen('R', 'Cadastros'), isMenuScreen('T', 'Super'), isMenuScreen('T', 'super ')]).toEqual([false, false, false])
  })

  it('pares exigidos = os que o código opera (roteador + lista à mão, sem os ausentes) + VISUALIZAR se tela + CONFIGURAR da regra + reservados', () => {
    expect(pairs('settlements', { screen: true })).toEqual(['ALTERAR', 'CONFIGURAR', 'DESCONTO', 'EXCLUIR', 'INSERIR', 'VISUALIZAR'])
    // CANCELAR/TRANSMITIR/CONSULTAR da devolução: ausentes por decisão (A-PV12)
    expect(pairs('order-returns', { screen: true })).toEqual(['ALTERAR', 'CONFIGURAR', 'EXCLUIR', 'FATURAR', 'INSERIR', 'VISUALIZAR'])
    expect(pairs('legacy-report', { screen: false })).toEqual([])                     // ninguém usa
    expect(pairs('legacy-report', { screen: true })).toEqual(['VISUALIZAR'])           // a regra do menu
    expect(pairs('legacy-report', { screen: false, configurable: true })).toEqual(['CONFIGURAR'])   // a regra do CONFIGURAR
    expect(pairs('general-configs', { screen: true })).toEqual(['CONFIGURAR', 'VISUALIZAR'])        // sempre tem CONFIGURAR (D-PV25)
    expect(pairs('Settlements ', { screen: false })).toEqual(['ALTERAR', 'CONFIGURAR', 'DESCONTO', 'EXCLUIR', 'INSERIR', 'VISUALIZAR'])
    expect(pairs(null, { screen: true })).toEqual(['VISUALIZAR'])
    // reservado por decisão (D-PV3/A-PV3): também não sai
    const inst = requiredPairsOf('institutions', { screen: true, configurable: true })
    for (const r of RESERVED_PRIVILEGES.filter(x => x.interface === 'institutions')) {
      expect(inst.find(p => p.privilege === r.privilege)?.by).toMatch(/^reservado: D-PV3/)
    }
  })

  it('quem consome um privilégio pelo NOME (app e view — D-PV53)', () => {
    expect(privilegeConsumersOf(2).some(c => c.includes('trocar a cobrança'))).toBe(true)
    expect(privilegeConsumersOf(6).some(c => c.startsWith('menu'))).toBe(true)
    expect(privilegeConsumersOf(11).some(c => c.startsWith('regra do CONFIGURAR'))).toBe(true)
    expect(privilegeConsumersOf(4).length).toBeGreaterThan(0)                        // IMPRIMIR: o PDF do boleto (roteador + app)
    // CATALOGAR (D-PR33): as criações na central da mercadoria (marca, unidade, embalagem) — o único consumidor, pela guarda por roteador
    expect(privilegeConsumersOf(10)).toEqual([
      'merchandise: guarda por roteador (D-PV2): POST /api/merchandise/brands, POST /api/merchandise/measures, POST /api/merchandise/packages',
    ])
  })

  it('a chave congelada pelo código (D-PV42): rota do app, config/campo, Configurações Gerais, pares operados, reservados', () => {
    expect(interfaceKeyUses('customers', false).some(u => u.includes('/home/customers/'))).toBe(true)
    expect(interfaceKeyUses('general-configs', false).some(u => u.includes('Configurações Gerais'))).toBe(true)
    expect(interfaceKeyUses('legacy-report', true)).toEqual(['configurações/campos do catálogo presos à chave'])
    expect(interfaceKeyUses('legacy-report', false)).toEqual([])
    expect(interfaceKeyUses('institutions', false).some(u => u.startsWith('reservados por decisão'))).toBe(true)
    expect(interfaceKeyUses(null, true)).toEqual([])
  })

  it('tirar o ALTERAR de Baixas recria o C1 → recusa nomeando o "trocar a cobrança"', () => {
    const v = interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS, privilegeIds: [1, 3, 6, 8, 11] })
    expect(v.map(x => x.code)).toEqual(['CATALOG_PAIR_IN_USE'])
    expect(v[0].message).toContain('ALTERAR (2)')
    expect(v[0].message).toContain('trocar a cobrança')
  })

  it('o PUT sem privilegeIds (zera os vínculos) recusa cada par exigido', () => {
    const v = interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS, privilegeIds: [] })
    expect(v.map(x => x.message.split(' ')[0]).sort()).toEqual(['ALTERAR', 'CONFIGURAR', 'DESCONTO', 'EXCLUIR', 'INSERIR', 'VISUALIZAR'])
  })

  it('tirar privilégio que ninguém opera passa (um IMPRIMIR que sobrasse em Baixas)', () => {
    const extra = { ...SETTLEMENTS, privilegeIds: [1, 2, 3, 4, 6, 8, 11] }
    expect(interfaceCatalogViolations(extra, SETTLEMENTS)).toEqual([])
  })

  it('D-PV42: a chave de interface EXISTENTE não se renomeia — nem a usada (só caixa, acento, espaço) nem a sem uso; a 1ª chave pode', () => {
    for (const k of ['baixas', 'SETTLEMENTS', 'Settlements', 'settlements ', 'séttlements', null]) {
      expect([k, interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS, i18nKey: k }).map(x => x.code)])
        .toEqual([k, ['INTERFACE_KEY_IN_USE']])
    }
    const unused = interfaceCatalogViolations(UNUSED, { ...UNUSED, i18nKey: 'legacy-reports' })
    expect(unused.map(x => `${x.code}:${x.field}`)).toEqual(['INTERFACE_KEY_IN_USE:i18nKey'])
    expect(unused[0].message).toContain('não se renomeia (D-PV42)')
    expect(interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS })).toEqual([])
    expect(interfaceCatalogViolations({ ...UNUSED, i18nKey: null }, { ...UNUSED, i18nKey: 'legacy-report' })).toEqual([])
  })

  it('tela do menu do cliente que o código usa (inclusive só pela rota do app) não vira recurso (R) nem vai ao grupo Super', () => {
    expect(interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS, kind: 'R' }).map(x => `${x.code}:${x.field}`))
      .toEqual(['INTERFACE_KEY_IN_USE:kind'])
    expect(interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS, groupDefault: 'Súper ' }).map(x => `${x.code}:${x.field}`))
      .toEqual(['INTERFACE_KEY_IN_USE:groupDefault'])
    const customers: InterfaceCatalogState = { i18nKey: 'customers', kind: 'T', groupDefault: 'Cadastros', privilegeIds: [1, 2, 3, 6, 11] }
    expect(interfaceCatalogViolations(customers, { ...customers, groupDefault: 'Super' }).map(x => x.code)).toEqual(['INTERFACE_KEY_IN_USE'])
    expect(interfaceCatalogViolations(UNUSED, { ...UNUSED, groupDefault: 'Super' })).toEqual([])   // o código não usa: pode ir ao Super
  })

  it('o DTO só aceita a chave na forma da rota (D-PV42: começa por letra; minúsculas, dígitos e hífen)', () => {
    const ok = (k: string | null) => interfaceDto.safeParse({ description: 'x', i18nKey: k }).success
    expect([ok('bank-slips'), ok('settlements'), ok('a1-b2'), ok(null)]).toEqual([true, true, true, true])
    expect([ok('Settlements'), ok('settlements '), ok('séttlements'), ok('cashier_v2'), ok('-x'), ok('x--y'), ok(''), ok('2fa'), ok('x-')])
      .toEqual([false, false, false, false, false, false, false, false, false])
  })

  it('excluir interface que o código usa recusa (par, rota do app ou config/campo); a que ninguém usa sai', () => {
    expect(interfaceCatalogViolations(SETTLEMENTS, null).map(x => x.code)).toEqual(['INTERFACE_KEY_IN_USE'])
    const customers: InterfaceCatalogState = { i18nKey: 'customers', kind: 'T', groupDefault: 'Cadastros', privilegeIds: [1, 2, 3, 6] }
    expect(interfaceCatalogViolations(customers, null).map(x => x.code)).toEqual(['INTERFACE_KEY_IN_USE'])   // a rota do app (D-PV42)
    expect(interfaceCatalogViolations({ ...UNUSED, configurable: true }, null).map(x => x.code)).toEqual(['INTERFACE_KEY_IN_USE'])
    expect(interfaceCatalogViolations(UNUSED, null)).toEqual([])
  })

  it('tela nova nasce com VISUALIZAR (D-GE19) — inclusive no grupo Super (o menu do super também a filtra); recurso R, não', () => {
    const novo = (kind: string, group: string, ids: number[]) =>
      interfaceCatalogViolations(null, { i18nKey: 'gift-cards', kind, groupDefault: group, privilegeIds: ids }).map(x => x.code)   // chave que nenhum código usa
    expect(novo('T', 'Cadastros', [1, 2, 3])).toEqual(['CATALOG_PAIR_IN_USE'])
    expect(novo('T', 'Cadastros', [6])).toEqual([])
    expect(novo('R', 'Cadastros', [])).toEqual([])
    expect(novo('T', 'Super', [])).toEqual(['CATALOG_PAIR_IN_USE'])
  })

  it('virar R → T sem VISUALIZAR recusa (a tela entraria no menu sem poder ser concedida)', () => {
    const r: InterfaceCatalogState = { i18nKey: 'partnerships', kind: 'R', groupDefault: 'Cadastros', privilegeIds: [2, 6, 11], configurable: true }
    expect(interfaceCatalogViolations(r, { ...r, kind: 'T' })).toEqual([])          // a aba já tem VISUALIZAR (a guarda por roteador o pede)
    const bare: InterfaceCatalogState = { ...UNUSED, kind: 'R', privilegeIds: [2] }
    expect(interfaceCatalogViolations(bare, { ...bare, kind: 'T' }).map(x => x.code)).toEqual(['CATALOG_PAIR_IN_USE'])
  })

  it('privilégio consumido pelo NOME EXATO (A-PV26): renomear recusa — nem a caixa muda; excluir recusa', () => {
    expect(privilegeCatalogViolations(2, 'EDITAR').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])
    expect(privilegeCatalogViolations(2, ' ALTERAR').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])
    expect(privilegeCatalogViolations(2, 'ALTERAR ').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])   // PAD SPACE: a view o tira
    expect(privilegeCatalogViolations(2, 'Alterar').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])    // a view compara binário
    expect(privilegeCatalogViolations(2, 'ALTERAR')).toEqual([])
    expect(privilegeCatalogViolations(6, null).map(x => x.field)).toEqual(['id'])
    expect(privilegeCatalogViolations(11, 'AJUSTAR').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])    // CONFIGURAR: a regra o consome
    expect(privilegeCatalogViolations(12, null).map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])         // CONSULTAR (D-PV40)
  })

  it('privilégio que ninguém consome se renomeia — mas não com o nome de um consumido; CATALOGAR tem consumidor (merchandise — D-PR33)', () => {
    // CATALOGAR passou a ser consumido (as criações na central da mercadoria): renomear/excluir recusa como os demais
    expect(privilegeCatalogViolations(10, 'CATALOGO CENTRAL').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])
    expect(privilegeCatalogViolations(10, null).map(x => x.field)).toEqual(['id'])
    expect(privilegeCatalogViolations(10, 'CATALOGAR')).toEqual([])
    // sem consumidor (o conjunto operado sem a mercadoria), o mesmo privilégio se renomeia — mas não com o nome de um consumido
    const semCatalogar = consumedPrivileges().filter(c => c.privilege !== 'CATALOGAR')
    expect(privilegeCatalogViolations(10, 'CATALOGO CENTRAL', semCatalogar)).toEqual([])
    expect(privilegeCatalogViolations(10, 'cancelar', semCatalogar).map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])
    expect(privilegeCatalogViolations(null, 'Faturar').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])
    expect(privilegeCatalogViolations(null, ' FATURAR ').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])
    expect(privilegeCatalogViolations(null, 'AUTORIZAR')).toEqual([])
  })

  it('a guarda lê o MESMO conjunto da cerca e do boot (par novo na lista passa a ser protegido sem código novo)', () => {
    const extra = [...consumedPrivileges(), { interface: 'legacy-report', privilege: 'IMPRIMIR' as const, consumers: ['app' as const], where: 'sonda' }]
    const s: InterfaceCatalogState = { ...UNUSED, privilegeIds: [4, 6] }
    expect(interfaceCatalogViolations(s, { ...s, privilegeIds: [6] }, extra).map(x => x.code)).toEqual(['CATALOG_PAIR_IN_USE'])
    expect(privilegeCatalogViolations(10, 'X', [{ interface: 'legacy-report', privilege: 'CATALOGAR', consumers: ['app'], where: 'sonda' }])
      .map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])
  })

  it('409 com TODAS as violações em fields[]; o código é o da mais grave; a mensagem não vira um livro', () => {
    let err: HttpError | null = null
    try {
      assertNoCatalogViolation(interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS, i18nKey: 'baixas', privilegeIds: [] }))
    } catch (e) { err = e as HttpError }
    expect(err?.statusCode).toBe(409)
    expect(err?.code).toBe('INTERFACE_KEY_IN_USE')
    expect(err?.fields?.length).toBeGreaterThan(1)
    expect(() => assertNoCatalogViolation([])).not.toThrow()
    const renamed = privilegeCatalogViolations(2, 'EDITAR')[0].message
    expect(renamed.length).toBeLessThan(1200)                                         // o roteador põe dezenas de rotas por verbo
  })
})

describe('D-PV15/D-PV42 — as telas do Super recusam ANTES de gravar', () => {
  const row = (over: Record<string, unknown> = {}) => ({ id: 21, description: 'Baixas', position: null, ...SETTLEMENTS, ...over })

  it('Interfaces: tirar o ALTERAR de Baixas → 409 e nada é gravado', async () => {
    m(ifaceRepo.getInterface).mockResolvedValue(row())
    await expect(editInterface(21, { i18nKey: 'settlements', kind: 'T', groupDefault: 'Financeiro', description: 'Baixas' }, [1, 3, 6, 8, 11]))
      .rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_PAIR_IN_USE' })
    expect(ifaceRepo.updateInterface).not.toHaveBeenCalled()
    expect(ifaceRepo.syncInterfacePrivileges).not.toHaveBeenCalled()
  })

  it('Interfaces: editar mantendo os pares grava', async () => {
    m(ifaceRepo.getInterface).mockResolvedValue(row())
    m(ifaceRepo.interfaceIdsWithKey).mockResolvedValue([{ id: 21, deleted: false }])          // ela mesma
    await editInterface(21, { i18nKey: 'settlements', kind: 'T', groupDefault: 'Financeiro', description: 'Baixas e estornos' }, [1, 2, 3, 6, 8, 11])
    expect(ifaceRepo.updateInterface).toHaveBeenCalled()
    expect(ifaceRepo.syncInterfacePrivileges).toHaveBeenCalledWith(21, [1, 2, 3, 6, 8, 11])
  })

  it('Interfaces: tirar o CONFIGURAR de uma interface com config/campo → 409 (a REGRA lida do banco pela linha)', async () => {
    m(ifaceRepo.getInterface).mockResolvedValue(row({ id: 70, i18nKey: 'legacy-report', privilegeIds: [6, 11] }))
    m(ifaceRepo.interfaceHasConfigOrField).mockResolvedValue(true)
    await expect(editInterface(70, { i18nKey: 'legacy-report', kind: 'T', groupDefault: 'Cadastros', description: 'x' }, [6]))
      .rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_PAIR_IN_USE' })
    expect(ifaceRepo.interfaceHasConfigOrField).toHaveBeenCalledWith(70)
    expect(ifaceRepo.updateInterface).not.toHaveBeenCalled()
  })

  it('Interfaces: renomear a chave (mesmo sem uso) → 409 sem gravar (D-PV42); dar a 1ª chave grava', async () => {
    m(ifaceRepo.getInterface).mockResolvedValue(row({ id: 70, i18nKey: 'legacy-report', privilegeIds: [6] }))
    await expect(editInterface(70, { i18nKey: 'legacy-reports', kind: 'T', groupDefault: 'Cadastros', description: 'x' }, [6]))
      .rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
    expect(ifaceRepo.updateInterface).not.toHaveBeenCalled()
    m(ifaceRepo.getInterface).mockResolvedValue(row({ id: 71, i18nKey: null, privilegeIds: [6] }))
    await editInterface(71, { i18nKey: 'legacy-report', kind: 'T', groupDefault: 'Cadastros', description: 'x' }, [6])
    expect(ifaceRepo.updateInterface).toHaveBeenCalled()
  })

  it('Interfaces: chave REPETIDA em outra interface viva → 409 (a resolução por chave pegaria uma só)', async () => {
    m(ifaceRepo.interfaceIdsWithKey).mockResolvedValue([{ id: 21, deleted: false }])
    await expect(createInterface({ i18nKey: 'settlements', kind: 'R', description: 'cópia' }, [1, 2, 3, 6, 8, 11]))
      .rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
    expect(ifaceRepo.insertInterface).not.toHaveBeenCalled()
  })

  it('Interfaces: tela nova do menu sem VISUALIZAR → 409; com ele, cria', async () => {
    // chave que NENHUM código opera (`merchandise` passou a ter pares operados — o 409 dela não isolaria o VISUALIZAR)
    await expect(createInterface({ i18nKey: 'gift-cards', kind: 'T', groupDefault: 'Cadastros', description: 'Vales-presente' }, [1]))
      .rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_PAIR_IN_USE' })
    expect(ifaceRepo.insertInterface).not.toHaveBeenCalled()
    await expect(createInterface({ i18nKey: 'gift-cards', kind: 'T', groupDefault: 'Cadastros', description: 'Vales-presente' }, [1, 6]))
      .resolves.toEqual({ id: 41 })
  })

  it('Interfaces: excluir a que o código usa (par, rota do app, config/campo) → 409; a que ninguém usa sai', async () => {
    m(ifaceRepo.getInterface).mockResolvedValue(row())
    await expect(removeInterface(21)).rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
    m(ifaceRepo.getInterface).mockResolvedValue(row({ id: 9, i18nKey: 'customers', groupDefault: 'Cadastros', privilegeIds: [1, 2, 3, 6] }))
    await expect(removeInterface(9)).rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
    m(ifaceRepo.getInterface).mockResolvedValue(row({ id: 70, i18nKey: 'legacy-report', privilegeIds: [6] }))
    m(ifaceRepo.interfaceHasConfigOrField).mockResolvedValueOnce(true)
    await expect(removeInterface(70)).rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
    expect(ifaceRepo.deleteInterface).not.toHaveBeenCalled()
    await removeInterface(70)
    expect(ifaceRepo.deleteInterface).toHaveBeenCalledWith(70)
  })

  it('Privilégios: renomear ALTERAR ou CATALOGAR (consumido pela merchandise) → 409 sem gravar; o que ninguém consome se renomeia; excluir VISUALIZAR → 409', async () => {
    m(privRepo.getPrivilege).mockResolvedValue({ id: 2, description: 'ALTERAR' })
    await expect(editPrivilege(2, 'Alterar dados')).rejects.toMatchObject({ statusCode: 409, code: 'PRIVILEGE_IN_USE' })
    expect(privRepo.updatePrivilege).not.toHaveBeenCalled()
    m(privRepo.getPrivilege).mockResolvedValue({ id: 10, description: 'CATALOGAR' })
    await expect(editPrivilege(10, 'CATALOGO CENTRAL')).rejects.toMatchObject({ statusCode: 409, code: 'PRIVILEGE_IN_USE' })
    expect(privRepo.updatePrivilege).not.toHaveBeenCalled()
    m(privRepo.getPrivilege).mockResolvedValue({ id: 13, description: 'AUTORIZAR' })   // fora do vocabulário: nenhum código o consome
    await editPrivilege(13, 'APROVAR')
    expect(privRepo.updatePrivilege).toHaveBeenCalledWith(13, 'APROVAR')
    m(privRepo.getPrivilege).mockResolvedValue({ id: 6, description: 'VISUALIZAR' })
    await expect(removePrivilege(6)).rejects.toMatchObject({ statusCode: 409, code: 'PRIVILEGE_IN_USE' })
    expect(privRepo.deletePrivilege).not.toHaveBeenCalled()
  })

  it('Privilégios: criar outro "Faturar" → 409 sem gravar', async () => {
    await expect(createPrivilege('Faturar')).rejects.toMatchObject({ statusCode: 409, code: 'PRIVILEGE_IN_USE' })
    expect(privRepo.insertPrivilege).not.toHaveBeenCalled()
  })
})

// D-PV63/A-PV28 (setes-api:PRIV.E7.P1.T2): o nome do catálogo é ÚNICO NO BANCO (script 77). As telas conferem ANTES e respondem 409 legível
// — inclusive contra a linha EXCLUÍDA, que a tela NUNCA revive (as views reativariam pares, contratos e concessões presos ao id, sem a lista
// da D-PV64) — e traduzem o 1062 da corrida no mesmo 409. O conserto de DUPLICATA da tela Interfaces SAIU do código (D-PV45).
describe('D-PV63 — nome repetido, linha excluída e corrida nas telas do Super', () => {
  const dup = (index: string, entry = 'x') =>
    Object.assign(new Error(`Duplicate entry '${entry}' for key '${index}'`), { errno: 1062, code: 'ER_DUP_ENTRY' })
  const SETTLEMENTS_ROW = { id: 21, description: 'Baixas', position: null, ...SETTLEMENTS }

  it('Interfaces: chave de uma interface EXCLUÍDA → 409 INTERFACE_KEY_RETIRED nomeando o id, sem gravar nem reviver', async () => {
    m(ifaceRepo.interfaceIdsWithKey).mockResolvedValue([{ id: 33, deleted: true }])
    const err = await createInterface({ i18nKey: 'old-report', kind: 'T', groupDefault: 'Cadastros', description: 'Velho' }, [6])
      .catch(e => e)
    expect(err).toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_RETIRED' })
    expect(err.message).toMatch(/EXCLUÍDA \(id 33\)/)
    expect(err.fields).toEqual([expect.objectContaining({ field: 'i18nKey' })])
    expect(ifaceRepo.insertInterface).not.toHaveBeenCalled()
    expect(ifaceRepo.updateInterface).not.toHaveBeenCalled()
  })

  it('Interfaces: dar a 1ª chave (a de uma EXCLUÍDA) a uma interface sem chave → 409 RETIRED; viva E excluída → o 409 da viva', async () => {
    m(ifaceRepo.getInterface).mockResolvedValue({ ...SETTLEMENTS_ROW, id: 71, i18nKey: null, privilegeIds: [6] })
    m(ifaceRepo.interfaceIdsWithKey).mockResolvedValue([{ id: 33, deleted: true }])
    await expect(editInterface(71, { i18nKey: 'old-report', kind: 'T', groupDefault: 'Cadastros', description: 'x' }, [6]))
      .rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_RETIRED' })
    m(ifaceRepo.interfaceIdsWithKey).mockResolvedValue([{ id: 33, deleted: true }, { id: 40, deleted: false }])
    await expect(editInterface(71, { i18nKey: 'old-report', kind: 'T', groupDefault: 'Cadastros', description: 'x' }, [6]))
      .rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE', message: expect.stringMatching(/id 40\)/) })
    expect(ifaceRepo.updateInterface).not.toHaveBeenCalled()
  })

  it('Interfaces: a própria linha não colide com ela mesma; editar sem trocar a chave nem consulta a chave', async () => {
    m(ifaceRepo.getInterface).mockResolvedValue(SETTLEMENTS_ROW)
    await editInterface(21, { i18nKey: 'settlements', kind: 'T', groupDefault: 'Financeiro', description: 'Baixas (nova)' }, [1, 2, 3, 6, 8, 11])
    expect(ifaceRepo.interfaceIdsWithKey).not.toHaveBeenCalled()
    expect(ifaceRepo.updateInterface).toHaveBeenCalled()
  })

  it('Interfaces: o 1062 do UNIQUE da chave numa corrida vira o 409 INTERFACE_KEY_IN_USE (nunca 500); outro erro segue como veio', async () => {
    m(ifaceRepo.insertInterface).mockRejectedValueOnce(dup('uq_interface_i18n_key_live', 'merchandise'))
    await expect(createInterface({ i18nKey: 'merchandise', kind: 'T', groupDefault: 'Cadastros', description: 'Mercadorias' }, [1, 2, 3, 6, 10, 11]))
      .rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE', fields: [expect.objectContaining({ field: 'i18nKey' })] })
    m(ifaceRepo.getInterface).mockResolvedValue({ ...SETTLEMENTS_ROW, id: 71, i18nKey: null, privilegeIds: [6] })
    m(ifaceRepo.updateInterface).mockRejectedValueOnce(dup('uq_interface_i18n_key_live'))
    await expect(editInterface(71, { i18nKey: 'legacy-report', kind: 'T', groupDefault: 'Cadastros', description: 'x' }, [6]))
      .rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
    expect(ifaceRepo.syncInterfacePrivileges).not.toHaveBeenCalled()
    const other = dup('PRIMARY', '41')
    m(ifaceRepo.insertInterface).mockRejectedValueOnce(other)
    await expect(createInterface({ i18nKey: 'merchandise', kind: 'T', groupDefault: 'Cadastros', description: 'Mercadorias' }, [1, 2, 3, 6, 10, 11]))
      .rejects.toBe(other)
  })

  it('Interfaces: o conserto de DUPLICATA saiu — excluir a que o código usa recusa mesmo com outra linha "equivalente" (D-PV45)', async () => {
    m(ifaceRepo.getInterface).mockResolvedValue({ ...SETTLEMENTS_ROW, id: 50 })
    m(ifaceRepo.interfaceIdsWithKey).mockResolvedValue([{ id: 21, deleted: false }, { id: 50, deleted: false }])
    await expect(removeInterface(50)).rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
    expect(ifaceRepo.deleteInterface).not.toHaveBeenCalled()
    expect(ifaceRepo.interfaceIdsWithKey).not.toHaveBeenCalled()
    const service = fs.readFileSync(path.join(__dirname, '..', 'modules', 'interfaces', 'interfaces.service.ts'), 'utf8')
    expect(service).not.toMatch(/keyKeptElsewhere|liveInterfaceIdsWithKey|keptElsewhere/)
  })

  it('Privilégios: nome de outro privilégio VIVO fora do vocabulário → 409 PRIVILEGE_NAME_TAKEN, sem gravar', async () => {
    m(privRepo.privilegeIdsWithName).mockResolvedValue([{ id: 13, deleted: false }])
    const err = await createPrivilege('Arquivar').catch(e => e)
    expect(err).toMatchObject({ statusCode: 409, code: 'PRIVILEGE_NAME_TAKEN', fields: [expect.objectContaining({ field: 'description' })] })
    expect(err.message).toMatch(/id 13\)/)
    expect(privRepo.insertPrivilege).not.toHaveBeenCalled()
  })

  it('Privilégios: nome de um privilégio EXCLUÍDO → 409 PRIVILEGE_NAME_RETIRED nomeando o id — criar e renomear; nunca revive', async () => {
    m(privRepo.privilegeIdsWithName).mockResolvedValue([{ id: 10, deleted: true }])
    const err = await createPrivilege('ANTIGO').catch(e => e)
    expect(err).toMatchObject({ statusCode: 409, code: 'PRIVILEGE_NAME_RETIRED' })
    expect(err.message).toMatch(/EXCLUÍDO \(id 10\)/)
    m(privRepo.getPrivilege).mockResolvedValue({ id: 13, description: 'ARQUIVAR' })
    await expect(editPrivilege(13, 'antigo')).rejects.toMatchObject({ statusCode: 409, code: 'PRIVILEGE_NAME_RETIRED' })
    expect(privRepo.insertPrivilege).not.toHaveBeenCalled()
    expect(privRepo.updatePrivilege).not.toHaveBeenCalled()
  })

  it('Privilégios: renomear só a caixa do próprio nome passa (a própria linha não colide); o vocabulário do veredito vem antes', async () => {
    m(privRepo.getPrivilege).mockResolvedValue({ id: 13, description: 'ARQUIVAR' })
    m(privRepo.privilegeIdsWithName).mockResolvedValue([{ id: 13, deleted: false }])
    await editPrivilege(13, 'Arquivar')
    expect(privRepo.updatePrivilege).toHaveBeenCalledWith(13, 'Arquivar')
    await expect(createPrivilege('Faturar')).rejects.toMatchObject({ code: 'PRIVILEGE_IN_USE' })
  })

  it('Privilégios: o 1062 do UNIQUE do nome numa corrida vira o 409 PRIVILEGE_NAME_TAKEN; outro erro segue como veio', async () => {
    m(privRepo.insertPrivilege).mockRejectedValueOnce(dup('uq_privilege_description', 'NOVO'))
    await expect(createPrivilege('NOVO')).rejects.toMatchObject({ statusCode: 409, code: 'PRIVILEGE_NAME_TAKEN' })
    m(privRepo.getPrivilege).mockResolvedValue({ id: 13, description: 'ARQUIVAR' })
    m(privRepo.updatePrivilege).mockRejectedValueOnce(dup('tb_privilege.uq_privilege_description', 'NOVO'))
    await expect(editPrivilege(13, 'NOVO')).rejects.toMatchObject({ statusCode: 409, code: 'PRIVILEGE_NAME_TAKEN' })
    const other = new Error('lost connection')
    m(privRepo.insertPrivilege).mockRejectedValueOnce(other)
    await expect(createPrivilege('NOVO')).rejects.toBe(other)
  })

  it('dois POST simultâneos: o perdedor sai com 1213 (o MAX+1 não serializa no MariaDB) → refaz conferência + gravação', async () => {
    const deadlock = () => Object.assign(new Error('Deadlock found when trying to get lock'), { errno: 1213, code: 'ER_LOCK_DEADLOCK' })
    // verbo: na 2ª tentativa o vencedor já gravou o MESMO nome → PRIVILEGE_NAME_TAKEN, sem 2º INSERT
    m(privRepo.privilegeIdsWithName).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 14, deleted: false }])
    m(privRepo.insertPrivilege).mockRejectedValueOnce(deadlock())
    await expect(createPrivilege('NOVO')).rejects.toMatchObject({ statusCode: 409, code: 'PRIVILEGE_NAME_TAKEN' })
    expect(privRepo.insertPrivilege).toHaveBeenCalledTimes(1)
    // verbo: o vencedor gravou OUTRO nome → a 2ª tentativa grava (antes era RESOURCE_BUSY)
    m(privRepo.privilegeIdsWithName).mockResolvedValue([])
    m(privRepo.insertPrivilege).mockRejectedValueOnce(deadlock()).mockResolvedValueOnce(15)
    await expect(createPrivilege('OUTRO')).resolves.toEqual({ id: 15 })
    // 1213 em todas as tentativas → o 1213 original segue (vira RESOURCE_BUSY no handleError); só 3 tentativas
    const d = deadlock()
    m(privRepo.insertPrivilege).mockReset().mockRejectedValue(d)
    await expect(createPrivilege('OUTRO')).rejects.toBe(d)
    expect(privRepo.insertPrivilege).toHaveBeenCalledTimes(3)
    // outro erro NUNCA se repete
    const lost = new Error('lost connection')
    m(privRepo.insertPrivilege).mockReset().mockRejectedValueOnce(lost)
    await expect(createPrivilege('OUTRO')).rejects.toBe(lost)
    expect(privRepo.insertPrivilege).toHaveBeenCalledTimes(1)
    // interface: na 2ª tentativa a chave já está viva em outra linha → INTERFACE_KEY_IN_USE
    m(ifaceRepo.interfaceIdsWithKey).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 42, deleted: false }])
    m(ifaceRepo.insertInterface).mockRejectedValueOnce(deadlock())
    await expect(createInterface({ i18nKey: 'merchandise', kind: 'T', groupDefault: 'Cadastros', description: 'M' }, [1, 2, 3, 6, 10, 11]))
      .rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
    // interface: o vencedor era outra chave → grava na 2ª
    m(ifaceRepo.interfaceIdsWithKey).mockResolvedValue([])
    m(ifaceRepo.insertInterface).mockRejectedValueOnce(deadlock()).mockResolvedValueOnce(43)
    await expect(createInterface({ i18nKey: 'merchandise', kind: 'T', groupDefault: 'Cadastros', description: 'M' }, [1, 2, 3, 6, 10, 11]))
      .resolves.toEqual({ id: 43 })
  })

  it('"n" minúsculo no deleted é VIVO para o banco: o repositório não o trata como excluído', async () => {
    const pool = (await import('../shared/db/connection')).default as any
    m(pool.query).mockResolvedValueOnce([[{ id: 5, deleted: 'n' }, { id: 7, deleted: 'S' }]])
    const real = jest.requireActual('../modules/privileges/privileges.repository')
    await expect(real.privilegeIdsWithName('FATURAR')).resolves.toEqual([{ id: 5, deleted: false }, { id: 7, deleted: true }])
  })

  it('o 409 do service passa pelo handleError dos controllers com error, code e fields (o app mostra a mensagem — setes-app:PRIV.E5.P1)', async () => {
    m(privRepo.privilegeIdsWithName).mockResolvedValue([{ id: 10, deleted: true }])
    const err = await createPrivilege('ANTIGO').catch(e => e)
    expect(err).toBeInstanceOf(HttpError)
    const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) }
    handleError(res, err, 'POST /api/privileges')
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({
      error: err.message, code: 'PRIVILEGE_NAME_RETIRED', fields: [{ field: 'description', message: err.message }],
    })
    m(ifaceRepo.interfaceIdsWithKey).mockResolvedValue([{ id: 33, deleted: true }])
    const ierr = await createInterface({ i18nKey: 'old-report', kind: 'T', groupDefault: 'Cadastros', description: 'Velho' }, [6]).catch(e => e)
    handleError(res, ierr, 'POST /api/interfaces')
    expect(res.json).toHaveBeenLastCalledWith(expect.objectContaining({ code: 'INTERFACE_KEY_RETIRED' }))
  })
})
