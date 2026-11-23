/// <reference types="jest" />
// Rodada 7 do cadastro de produtos (Valdo 2026-10-20 — prompt_modulo_products.md "Rodada 7"): DOIS atos distintos no cadastro de
// Institutions (super) — (1) o interruptor da chave do sincronizador (D-PR43 + D-PR48 item 1) é só PAUSA de emergência, reversível, e
// não decide dono; (2) virar Web é a TROCA D → W no PUT do cadastro (D-PR72/D-PR73/D-PR76), só com a chave bloqueada, gravando quem e
// quando, sem motivo (D-PR75), e criando as categorias padrão que faltarem. Nunca apaga (PADROES §3.1).
// Letras W/D (D-OI10; o L virou D e o P saiu) — Rodada 11, setes-api:PROD.E10.P1.
import pool from '../shared/db/connection'
import logger from '../shared/logger/logger'
import { switchSyncApiKey, generateSyncApiKey } from '../modules/institutions/institutions.service'
import * as institutionsService from '../modules/institutions/institutions.service'
import { ErrorCodes } from '../shared/errors/error-codes'
import { updateInstitutionCascade } from '../modules/institutions/institutions.repository'
import { syncApiKeyActiveDto, institutionCreateDto, institutionUpdateDto } from '../modules/institutions/institutions.dto'
import * as institutionsDto from '../modules/institutions/institutions.dto'

jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn() } }))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('../shared/entity', () => ({
  ...jest.requireActual('../shared/entity'),
  saveEntityFiscalChain: jest.fn(async (_c: unknown, id: number) => ({ id })),
}))
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
const ENDED = new Date(Date.UTC(2026, 9, 20, 12, 0, 0))

// ---- rotas do modelo ----
const lock: Route = [/FROM setes_central\.tb_institution WHERE id = \? FOR UPDATE/, () => [[{ id: 1 }]]]
const factPlain = (kind: string): Route => [/SELECT source_kind AS sourceKind FROM setes_central\.tb_institution WHERE id = \? AND deleted = 'N'$/, () => [[{ sourceKind: kind }]]]
const keysOf = (rows: any[]): Route => [/SELECT id, active FROM setes_central\.tb_sync_api_key\s+WHERE tb_institution_id = \? AND deleted = 'N' FOR UPDATE/, () => [rows]]
const keyUpdate: Route = [/UPDATE setes_central\.tb_sync_api_key SET active = \?, updated_at = NOW\(\)/, () => [{ affectedRows: 1 }]]
const instUpdate = (affected = 1): Route => [/UPDATE setes_central\.tb_institution\s+SET source_kind = 'W', transition_ended_at = NOW\(\), transition_ended_by = \?, updated_at = NOW\(\)\s+WHERE id = \? AND source_kind = 'D' AND transition_ended_at IS NULL/, () => [{ affectedRows: affected }]]
const liveCategory = (has: Record<string, boolean>): Route => [/tb_category\s+WHERE tb_institution_id = \? AND kind = \? AND deleted = 'N' AND active = 'S' LIMIT 1 FOR UPDATE/, p => [has[p[1]] ? [{ id: 1 }] : []]]
const catMax: Route = [/MAX\(id\), 0\) \+ 1 AS nextId FROM `setes_setes`\.tb_category/, () => [[{ nextId: 10 }]]]
const catInsert: Route = [/INSERT INTO `setes_setes`\.tb_category/, () => [{}]]

beforeEach(() => {
  jest.clearAllMocks(); mockQuery.mockReset(); mockGetConnection.mockReset()
  mockQuery.mockImplementation(async (sql: string) => {
    if (/SELECT id FROM setes_central\.tb_institution WHERE id = \? AND deleted = 'N'/.test(sql)) return [[{ id: 1 }]]
    if (/SELECT schema_name AS schemaName, source_kind AS sourceKind, transition_ended_at AS transitionEndedAt\s+FROM setes_central\.tb_institution WHERE id = \? AND deleted = 'N'$/.test(sql)) {
      return [[{ schemaName: 'setes_setes', sourceKind: 'W', transitionEndedAt: ENDED }]]
    }
    if (/api_key AS apiKey/.test(sql)) return [[{ apiKey: 'k', establishmentCode: 'SETES_SETES', active: 'N' }]]
    throw new Error(`SQL inesperado no pool: ${String(sql).slice(0, 90)}`)
  })
})

describe('D-PR48 item 1 — o interruptor é só PAUSA (reversível) e não decide dono', () => {
  it('pausar: UMA transação — trava da institution 1º, o fato, as chaves FOR UPDATE, UPDATE só do active; nada de categoria, contagem ou DELETE', async () => {
    const c = conn([lock, factPlain('D'), keysOf([{ id: 1, active: 'S' }]), keyUpdate])
    const out = await switchSyncApiKey(1, 'N', 7)
    expect(out).toEqual({ apiKey: 'k', establishmentCode: 'SETES_SETES', active: 'N' })
    const all = sqls(c)
    expect(all[0]).toMatch(/tb_institution WHERE id = \? FOR UPDATE/)
    expect(all[1]).toMatch(/source_kind AS sourceKind/)
    expect(all[2]).toMatch(/tb_sync_api_key[\s\S]*FOR UPDATE/)
    expect(all[3]).toMatch(/UPDATE setes_central\.tb_sync_api_key SET active = \?/)
    expect(c.query.mock.calls[3][1]).toEqual(['N', 1, 'N'])
    expect(all).toHaveLength(4)
    expect(all.some(s => /tb_category|COUNT\(\*\)|\bDELETE\s+FROM\b|\bREPLACE\s+INTO\b|INSERT INTO/i.test(s))).toBe(false)
    expect(c.commit).toHaveBeenCalled()
    expect((logger.info as jest.Mock).mock.calls.find(x => /PAUSADO/.test(x[0]))?.[1]).toEqual({ institutionId: 1, actorUserId: 7, keys: 1 })
  })

  it('retomar em D: a MESMA chave volta (sem conferir linhas nascidas na web — não há "religar", o dono é o fato)', async () => {
    for (const kind of ['D']) {
      const c = conn([lock, factPlain(kind), keysOf([{ id: 1, active: 'N' }]), keyUpdate])
      mockQuery.mockImplementation(async (sql: string) => {
        if (/SELECT id FROM setes_central\.tb_institution/.test(sql)) return [[{ id: 1 }]]
        if (/api_key AS apiKey/.test(sql)) return [[{ apiKey: 'k', establishmentCode: 'SETES_SETES', active: 'S' }]]
        throw new Error('inesperado')
      })
      const out = await switchSyncApiKey(1, 'S', 7)
      expect([kind, out.active, out.apiKey]).toEqual([kind, 'S', 'k'])
      expect(sqls(c).some(s => /COUNT\(\*\)|created_at >=/.test(s))).toBe(false)
    }
  })

  it('retomar em W = 409 SYNC_KEY_NOT_FOR_SOURCE sem tocar nas chaves (nativo web, ou trocado de D para W: a chave nunca reativa)', async () => {
    const c = conn([lock, factPlain('W'), keysOf([{ id: 1, active: 'N' }]), keyUpdate])
    await expect(switchSyncApiKey(1, 'S', 7)).rejects.toMatchObject({ statusCode: 409, code: 'SYNC_KEY_NOT_FOR_SOURCE' })
    expect(sqls(c).some(s => /^\s*UPDATE|tb_sync_api_key/.test(s))).toBe(false)              // nem leu as chaves
    expect(c.rollback).toHaveBeenCalled()
    expect(c.commit).not.toHaveBeenCalled()
  })

  it('estado já é o pedido: nada muda (rollback sem UPDATE); sem chave viva = 404 SYNC_KEY_MISSING; estabelecimento inexistente = 404 sem transação', async () => {
    const same = conn([lock, factPlain('D'), keysOf([{ id: 1, active: 'N' }]), keyUpdate])
    await switchSyncApiKey(1, 'N', 7)
    expect(sqls(same).some(s => /^\s*UPDATE/.test(s))).toBe(false)

    const none = conn([lock, factPlain('D'), keysOf([]), keyUpdate])
    await expect(switchSyncApiKey(1, 'N', 7)).rejects.toMatchObject({ statusCode: 404, code: 'SYNC_KEY_MISSING' })
    expect(none.rollback).toHaveBeenCalled()

    mockQuery.mockImplementation(async () => [[]])
    mockGetConnection.mockClear()
    await expect(switchSyncApiKey(99, 'N', 7)).rejects.toMatchObject({ statusCode: 404 })
    expect(mockGetConnection).not.toHaveBeenCalled()
  })

  it('o corpo só aceita S ou N', () => {
    expect(syncApiKeyActiveDto.safeParse({ active: 'S' }).success).toBe(true)
    for (const bad of [{ active: 'n' }, { active: 'X' }, {}, { active: null }]) expect(syncApiKeyActiveDto.safeParse(bad).success).toBe(false)
  })
})

describe('D-PR73/D-PR75/D-PR76 — virar Web é a TROCA D → W no PUT do cadastro, só com a chave bloqueada; sem motivo', () => {
  const input: any = { entity: {}, personType: 'J', addresses: [], phones: [], socialMedia: [], sourceKind: 'W' }
  const fact = (kind: string | null): Route =>
    [/SELECT schema_name AS schemaName, source_kind AS sourceKind FROM setes_central\.tb_institution\s+WHERE id = \? AND deleted = 'N' FOR UPDATE/,
      () => [kind === null ? [] : [{ schemaName: 'setes_setes', sourceKind: kind }]]]
  const activeKeys = (n: number): Route =>
    [/SELECT id FROM setes_central\.tb_sync_api_key\s+WHERE tb_institution_id = \? AND deleted = 'N' AND active = 'S' FOR UPDATE/,
      () => [Array.from({ length: n }, (_, i) => ({ id: i + 1 }))]]
  const activeUpdate: Route = [/UPDATE setes_central\.tb_institution SET active = \?/, () => [{ affectedRows: 1 }]]
  let pausedFor: number | null = 3600                                                         // bloqueada há 1 h (D-PR78)
  const paused: Route = [/SELECT TIMESTAMPDIFF\(SECOND, MAX\(updated_at\), NOW\(\)\) AS pausedFor FROM setes_central\.tb_sync_api_key/, () => [[{ pausedFor }]]]
  beforeEach(() => { pausedFor = 3600 })
  const troca = (keys = 0, has: Record<string, boolean> = { P: true, S: false }, affected = 1) =>
    conn([factPlain('D'), lock, fact('D'), activeKeys(keys), paused, instUpdate(affected), liveCategory(has), catMax, catInsert, activeUpdate])

  it('D → W: UMA transação na ordem trava (1º statement) → fato FOR UPDATE → chaves ATIVAS FOR UPDATE → UPDATE com `source_kind = D` NO COMANDO (autor, sem motivo) → categorias padrão que faltam; a cadeia fiscal vem depois', async () => {
    const c = troca()
    const out = await updateInstitutionCascade(1, input, 7)
    expect(out).toEqual({ sourceKindChanged: true, defaultCategories: { P: null, S: 10 } })
    const all = sqls(c)
    expect(all[0]).toMatch(/SELECT source_kind AS sourceKind[^']*deleted = 'N'$/)                    // leitura SEM trava: a origem difere?
    all.shift()
    expect(all[0]).toMatch(/tb_institution WHERE id = \? FOR UPDATE/)                                 // PADROES §9 regra 7
    expect(all[1]).toMatch(/source_kind AS sourceKind[\s\S]*FOR UPDATE/)
    expect(all[2]).toMatch(/tb_sync_api_key[\s\S]*active = 'S' FOR UPDATE/)
    expect(all[3]).toMatch(/TIMESTAMPDIFF\(SECOND, MAX\(updated_at\)/)                             // D-PR78: há quanto tempo está bloqueada
    all.splice(3, 1)
    expect(all[3]).toMatch(/SET source_kind = 'W', transition_ended_at = NOW\(\), transition_ended_by = \?, updated_at = NOW\(\)\s+WHERE id = \? AND source_kind = 'D' AND transition_ended_at IS NULL/)
    expect(all[3]).not.toMatch(/transition_end_reason/)                                               // D-PR75: sem motivo
    expect(c.query.mock.calls[5][1]).toEqual([7, 1])
    expect(all.filter(s => /INSERT INTO `setes_setes`\.tb_category/.test(s))).toHaveLength(1)          // só a S faltava
    expect(all.some(s => /UPDATE setes_central\.tb_sync_api_key/.test(s))).toBe(false)                 // a chave já estava bloqueada: não mexe
    expect(all.some(s => /\bDELETE\s+FROM\b|\bREPLACE\s+INTO\b/i.test(s))).toBe(false)
    expect(c.commit).toHaveBeenCalledTimes(1)
  })

  it('D → W com a chave do sincronizador ATIVA = 409 SOURCE_KIND_SYNC_KEY_ACTIVE, nada gravado, rollback (bloqueie a chave antes — D-PR73)', async () => {
    const c = troca(1)
    await expect(updateInstitutionCascade(1, input, 7)).rejects.toMatchObject({ statusCode: 409, code: 'SOURCE_KIND_SYNC_KEY_ACTIVE' })
    expect(sqls(c).some(s => /^\s*UPDATE|INSERT INTO/.test(s))).toBe(false)
    expect(c.rollback).toHaveBeenCalled(); expect(c.commit).not.toHaveBeenCalled()
  })

  it('D-PR78: chave bloqueada há MENOS de 5 min (o cache do setes-sync) = 409 SOURCE_KIND_SYNC_KEY_ACTIVE com o tempo que falta, nada gravado; há 5 min passa', async () => {
    pausedFor = 120
    const c = troca()
    await expect(updateInstitutionCascade(1, input, 7)).rejects.toMatchObject({
      statusCode: 409, code: 'SOURCE_KIND_SYNC_KEY_ACTIVE', fields: [{ field: 'sourceKind', message: 'aguarde 180 s' }],
    })
    expect(sqls(c).some(s => /SET source_kind/.test(s))).toBe(false)
    expect(c.rollback).toHaveBeenCalled()
    pausedFor = 300
    troca()
    await expect(updateInstitutionCascade(1, input, 7)).resolves.toMatchObject({ sourceKindChanged: true })
  })

  it('D sem chave nenhuma (nunca gerada) troca para W na hora — não há cache a esperar (gate socrático M2)', async () => {
    pausedFor = null
    troca()
    await expect(updateInstitutionCascade(1, input, 7)).resolves.toMatchObject({ sourceKindChanged: true })
  })

  it('W → D = 409 SOURCE_KIND_IMMUTABLE (nunca de volta — D-OI10), sem ler a chave nem gravar; igual ao gravado passa sem troca', async () => {
    const back = conn([factPlain('W'), lock, fact('W'), activeKeys(0), paused, instUpdate(1)])
    await expect(updateInstitutionCascade(1, { ...input, sourceKind: 'D' }, 7)).rejects.toMatchObject({ statusCode: 409, code: 'SOURCE_KIND_IMMUTABLE' })
    expect(sqls(back).some(s => /tb_sync_api_key|^\s*UPDATE/.test(s))).toBe(false)
    expect(back.rollback).toHaveBeenCalled()

    for (const kind of ['W', 'D']) {
      const same = conn([factPlain(kind), lock, fact(kind), activeKeys(1), paused, instUpdate(1), activeUpdate])
      await expect(updateInstitutionCascade(1, { ...input, sourceKind: kind }, 7)).resolves.toEqual({ sourceKindChanged: false, defaultCategories: null })
      expect([kind, sqls(same).some(s => /tb_sync_api_key|SET source_kind|FOR UPDATE/.test(s))]).toEqual([kind, false])   // igual: nem trava
      expect(same.commit).toHaveBeenCalled()
    }
  })

  it('sem sourceKind no corpo (o app de hoje): nem trava nem lê o fato — a edição segue como antes', async () => {
    const c = conn([factPlain('D'), lock, fact('D'), activeUpdate])
    const { sourceKind: _k, ...noKind } = input
    await expect(updateInstitutionCascade(1, noKind, 7)).resolves.toEqual({ sourceKindChanged: false, defaultCategories: null })
    expect(sqls(c).some(s => /tb_institution WHERE id = \? FOR UPDATE|source_kind/.test(s))).toBe(false)
  })

  it('o fato mudou por baixo da trava (UPDATE afeta 0 linhas) = falha ALTA com rollback — nunca segue para as categorias', async () => {
    const c = troca(0, { P: true, S: true }, 0)
    await expect(updateInstitutionCascade(1, input, 7)).rejects.toThrow(/mudou por baixo da trava/)
    expect(sqls(c).some(s => /tb_category/.test(s))).toBe(false)
    expect(c.rollback).toHaveBeenCalled(); expect(c.commit).not.toHaveBeenCalled()
  })

  it('autor ausente = falha alta ANTES de gravar (nunca a troca sem quem a fez — D-PR75)', async () => {
    const c = troca()
    await expect(updateInstitutionCascade(1, input, null)).rejects.toThrow(/autor ausente/)
    expect(sqls(c).some(s => /^\s*UPDATE/.test(s))).toBe(false)
  })

  it('falha ao criar a categoria padrão desfaz a troca INTEIRA (o fato segue D) — nenhum commit', async () => {
    const c = conn([factPlain('D'), lock, fact('D'), activeKeys(0), paused, instUpdate(1), liveCategory({ P: true, S: false }), catMax,
      [/INSERT INTO `setes_setes`\.tb_category/, () => { throw Object.assign(new Error("Table 'setes_setes.tb_category' doesn't exist"), { errno: 1146 }) }]])
    await expect(updateInstitutionCascade(1, input, 7)).rejects.toThrow(/doesn't exist/)
    expect(c.rollback).toHaveBeenCalled(); expect(c.commit).not.toHaveBeenCalled()
  })

  it('pelo SERVIÇO: deadlock na 1ª tentativa (a troca cunha id de categoria) reexecuta a transação INTEIRA; conclui, invalida o contexto e loga quem trocou', async () => {
    let first = true
    const c = conn([factPlain('D'), lock, fact('D'), activeKeys(0), paused, instUpdate(1), liveCategory({ P: true, S: false }),
      [/MAX\(id\), 0\) \+ 1 AS nextId FROM `setes_setes`\.tb_category/, () => {
        if (first) { first = false; throw Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 }) }
        return [[{ nextId: 10 }]]
      }], catInsert, activeUpdate])
    await expect(institutionsService.editInstitution(1, input, 7)).resolves.toBeUndefined()
    expect(c.rollback).toHaveBeenCalledTimes(1)
    expect(c.commit).toHaveBeenCalledTimes(1)
    expect(sqls(c).filter(s => /SET source_kind = 'W'/.test(s))).toHaveLength(2)                     // uma por tentativa; só a 2ª comita
    const log = (logger.info as jest.Mock).mock.calls.find(x => /TROCADA/.test(x[0]))
    expect(log?.[1]).toMatchObject({ institutionId: 1, actorUserId: 7, defaultCategories: { P: null, S: 10 } })
  })

  it('o ato, o destino e a guarda deixaram de existir (D-PR72/D-PR76/D-PR77; D-PR55 sem objeto): sem rota, sem DTO, sem os códigos', () => {
    expect(Object.keys(institutionsService)).not.toEqual(expect.arrayContaining(['endDesktopTransition']))
    expect(Object.keys(institutionsService)).not.toContain('OPEN_TRANSITION_DESTINATIONS')
    expect(Object.keys(institutionsDto)).not.toContain('endDesktopTransitionDto')
    for (const gone of ['LEGACY_TRANSITION_DESTINATION_PENDING', 'LEGACY_TRANSITION_NOT_APPLICABLE', 'DESKTOP_TRANSITION_NOT_APPLICABLE', 'CATALOG_LEGACY_OWNED', 'CATALOG_DESKTOP_OWNED']) {
      expect(Object.keys(ErrorCodes)).not.toContain(gone)
    }
    expect(Object.keys(ErrorCodes)).toEqual(expect.arrayContaining(['SOURCE_KIND_SYNC_KEY_ACTIVE', 'SOURCE_KIND_IMMUTABLE']))   // a guarda saiu (D-PR77)
  })
})

describe('D-PR47 — a origem dos cadastros é DECLARADA no cadastro (W ou D)', () => {
  it('o POST exige sourceKind (sem default — fato declarado, nunca presumido); o PUT o aceita (igual passa; D → W é a troca)', () => {
    const base = {
      entity: { nameCompany: 'X LTDA', nickTrade: 'X' }, personType: 'J', company: { cnpj: '11222333000181' },
      addresses: [], phones: [], socialMedia: [], schemaName: 'setes_x',
      admin: { nameCompany: 'A', nickTrade: 'A', email: 'a@x.com', password: 'Vx9-sync-Rq4t' },   // senha pela política vigente do main (D-EA5)
    }
    expect(institutionCreateDto.safeParse(base).success).toBe(false)
    expect(institutionCreateDto.safeParse({ ...base, sourceKind: 'D' }).success).toBe(true)
    expect(institutionCreateDto.safeParse({ ...base, sourceKind: 'W' }).success).toBe(true)
    for (const k of ['X', 'L', 'P', 'd']) expect([k, institutionCreateDto.safeParse({ ...base, sourceKind: k }).success]).toEqual([k, false])   // D-OI10
    const { schemaName: _s, admin: _a, ...upd } = base
    expect(institutionUpdateDto.safeParse(upd).success).toBe(true)
    expect(institutionUpdateDto.safeParse({ ...upd, sourceKind: 'W' }).success).toBe(true)
    expect(institutionUpdateDto.safeParse({ ...upd, sourceKind: 'P' }).success).toBe(false)
  })

  const factForUpdatePlain = (kind: string): Route =>
    [/SELECT source_kind AS sourceKind FROM setes_central\.tb_institution WHERE id = \? AND deleted = 'N' FOR UPDATE/, () => [[{ sourceKind: kind }]]]
  const keyMax: Route = [/MAX\(id\), 0\) \+ 1 AS nextId FROM setes_central\.tb_sync_api_key/, () => [[{ nextId: 2 }]]]
  const keyInsert: Route = [/INSERT INTO setes_central\.tb_sync_api_key/, () => [{}]]
  const poolSaysD = () => mockQuery.mockImplementation(async (sql: string) => {
    if (/transition_ended_at AS transitionEndedAt/.test(sql)) return [[{ schemaName: 'setes_x', sourceKind: 'D', transitionEndedAt: null }]]
    if (/api_key AS apiKey/.test(sql)) return [[]]
    throw new Error('inesperado')
  })

  it('gerar a chave do sincronizador em W = 409 SYNC_KEY_NOT_FOR_SOURCE (a chave só existe para D — D-OI10); em D gera NUMA transação: trava → fato FOR UPDATE → chaves FOR UPDATE → MAX → INSERT', async () => {
    await expect(generateSyncApiKey(1)).rejects.toMatchObject({ statusCode: 409, code: 'SYNC_KEY_NOT_FOR_SOURCE' })   // o pool diz W
    expect(mockGetConnection).not.toHaveBeenCalled()

    poolSaysD()
    const c = conn([lock, factForUpdatePlain('D'), keysOf([]), keyMax, keyInsert])
    const row = await generateSyncApiKey(2)
    expect(row).toMatchObject({ establishmentCode: 'SETES_X', active: 'S' })
    const all = sqls(c)
    expect(all[0]).toMatch(/tb_institution WHERE id = \? FOR UPDATE/)                       // regra 7 — 1º statement
    expect(all[1]).toMatch(/source_kind AS sourceKind[\s\S]*FOR UPDATE/)
    expect(all[2]).toMatch(/tb_sync_api_key[\s\S]*FOR UPDATE/)
    expect(all[3]).toMatch(/MAX\(id\)/); expect(all[4]).toMatch(/INSERT INTO/)
    expect(c.commit).toHaveBeenCalled()
  })

  it('ADV-R7-03 (TOCTOU): a troca D → W comita ENTRE a leitura do pool e a transação → 409 SYNC_KEY_NOT_FOR_SOURCE, nenhum INSERT (nunca nasce chave viva em W)', async () => {
    poolSaysD()                                                                              // o pool ainda vê D…
    const c = conn([lock, factForUpdatePlain('W'), keysOf([]), keyMax, keyInsert])          // …a transação (depois da trava) vê W
    await expect(generateSyncApiKey(2)).rejects.toMatchObject({ statusCode: 409, code: 'SYNC_KEY_NOT_FOR_SOURCE' })
    expect(sqls(c).some(s => /INSERT INTO|MAX\(id\)/.test(s))).toBe(false)
    expect(c.rollback).toHaveBeenCalled(); expect(c.commit).not.toHaveBeenCalled()
  })

  it('dois POSTs simultâneos: o 2º acha a chave viva DENTRO da transação → 409 "já possui", sem INSERT', async () => {
    poolSaysD()
    const c = conn([lock, factForUpdatePlain('D'), keysOf([{ id: 1, active: 'S' }]), keyMax, keyInsert])
    await expect(generateSyncApiKey(2)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/já possui/) })
    expect(sqls(c).some(s => /INSERT INTO/.test(s))).toBe(false)
  })
})
