/// <reference types="jest" />
// Rodada 7 do cadastro de produtos (Valdo 2026-10-20 — prompt_modulo_products.md "Rodada 7"): DOIS atos distintos no cadastro de
// Institutions (super) — (1) o interruptor da chave do sincronizador (D-PR43 + D-PR48 item 1) é só PAUSA de emergência, reversível, e
// não decide dono; (2) "encerrar a transição" (D-PR48/D-PR49) é ato ÚNICO e IRREVERSÍVEL: L → W (sem PDV) ou L → P (com PDV), grava
// `transition_ended_at`, cria as categorias padrão que faltarem e, no destino W, inativa a chave em definitivo. Nunca apaga (PADROES §3.1).
import pool from '../shared/db/connection'
import logger from '../shared/logger/logger'
import { switchSyncApiKey, endLegacyTransition, generateSyncApiKey, OPEN_TRANSITION_DESTINATIONS } from '../modules/institutions/institutions.service'
import { updateInstitutionCascade, endLegacyTransitionTx } from '../modules/institutions/institutions.repository'
import { syncApiKeyActiveDto, endLegacyTransitionDto, institutionCreateDto, institutionUpdateDto } from '../modules/institutions/institutions.dto'

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
const factForUpdate = (kind: string | null, endedAt: Date | null = null): Route =>
  [/SELECT schema_name AS schemaName, source_kind AS sourceKind, transition_ended_at AS transitionEndedAt\s+FROM setes_central\.tb_institution WHERE id = \? AND deleted = 'N' FOR UPDATE/,
    () => [kind === null ? [] : [{ schemaName: 'setes_setes', sourceKind: kind, transitionEndedAt: endedAt }]]]
const keysOf = (rows: any[]): Route => [/SELECT id, active FROM setes_central\.tb_sync_api_key\s+WHERE tb_institution_id = \? AND deleted = 'N' FOR UPDATE/, () => [rows]]
const keyUpdate: Route = [/UPDATE setes_central\.tb_sync_api_key SET active = \?, updated_at = NOW\(\)/, () => [{ affectedRows: 1 }]]
const keyInactivate = (n: number): Route => [/UPDATE setes_central\.tb_sync_api_key SET active = 'N', updated_at = NOW\(\)\s+WHERE tb_institution_id = \? AND deleted = 'N' AND active = 'S'/, () => [{ affectedRows: n }]]
const instUpdate = (affected = 1): Route => [/UPDATE setes_central\.tb_institution\s+SET source_kind = \?, transition_ended_at = NOW\(\), updated_at = NOW\(\)\s+WHERE id = \? AND source_kind = 'L' AND transition_ended_at IS NULL/, () => [{ affectedRows: affected }]]
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
    const c = conn([lock, factPlain('L'), keysOf([{ id: 1, active: 'S' }]), keyUpdate])
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

  it('retomar em L e em P: a MESMA chave volta (sem conferir linhas nascidas na web — não há "religar", o dono é o fato)', async () => {
    for (const kind of ['L', 'P']) {
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

  it('retomar em W = 409 SYNC_KEY_NOT_FOR_SOURCE sem tocar nas chaves (nativo web, ou transição encerrada para W: a chave nunca reativa)', async () => {
    const c = conn([lock, factPlain('W'), keysOf([{ id: 1, active: 'N' }]), keyUpdate])
    await expect(switchSyncApiKey(1, 'S', 7)).rejects.toMatchObject({ statusCode: 409, code: 'SYNC_KEY_NOT_FOR_SOURCE' })
    expect(sqls(c).some(s => /^\s*UPDATE|tb_sync_api_key/.test(s))).toBe(false)              // nem leu as chaves
    expect(c.rollback).toHaveBeenCalled()
    expect(c.commit).not.toHaveBeenCalled()
  })

  it('estado já é o pedido: nada muda (rollback sem UPDATE); sem chave viva = 404 SYNC_KEY_MISSING; estabelecimento inexistente = 404 sem transação', async () => {
    const same = conn([lock, factPlain('L'), keysOf([{ id: 1, active: 'N' }]), keyUpdate])
    await switchSyncApiKey(1, 'N', 7)
    expect(sqls(same).some(s => /^\s*UPDATE/.test(s))).toBe(false)

    const none = conn([lock, factPlain('L'), keysOf([]), keyUpdate])
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

describe('D-PR48/D-PR49 — "encerrar a transição": ato único e irreversível, L → W ou L → P', () => {
  const happy = (kind: string, keysHit = 1, has: Record<string, boolean> = { P: true, S: false }) =>
    conn([lock, factForUpdate(kind), instUpdate(1), keyInactivate(keysHit), liveCategory(has), catMax, catInsert])

  it('L → W: UMA transação na ordem trava → fato FOR UPDATE → UPDATE com `source_kind = L` NO COMANDO → chaves inativadas → categorias padrão que faltam; log com autor e motivo', async () => {
    const c = happy('L')
    const out = await endLegacyTransition(1, 'W', 'servidor desktop desligado em 20/10', 7)
    expect(out).toEqual({
      sourceKind: 'W', transitionEndedAt: ENDED.toISOString(), defaultCategories: { P: null, S: 10 }, syncKeysInactivated: 1,
    })
    const all = sqls(c)
    expect(all[0]).toMatch(/tb_institution WHERE id = \? FOR UPDATE/)
    expect(all[1]).toMatch(/transition_ended_at AS transitionEndedAt[\s\S]*FOR UPDATE/)
    expect(all[2]).toMatch(/UPDATE setes_central\.tb_institution[\s\S]*WHERE id = \? AND source_kind = 'L' AND transition_ended_at IS NULL/)
    expect(c.query.mock.calls[2][1]).toEqual(['W', 1])
    expect(all[3]).toMatch(/UPDATE setes_central\.tb_sync_api_key SET active = 'N'/)
    expect(all.filter(s => /INSERT INTO `setes_setes`\.tb_category/.test(s))).toHaveLength(1)          // só a S faltava
    const ins = c.query.mock.calls.find((x: any[]) => /INSERT INTO `setes_setes`\.tb_category/.test(x[0]))!
    expect(ins[1].slice(0, 5)).toEqual([10, 1, 'Serviços', '010', 'S'])
    expect(all.some(s => /\bDELETE\s+FROM\b|\bREPLACE\s+INTO\b/i.test(s))).toBe(false)
    expect(c.commit).toHaveBeenCalledTimes(1)
    const log = (logger.info as jest.Mock).mock.calls.find(x => /ENCERRADA/.test(x[0]))
    expect(log?.[1]).toMatchObject({ institutionId: 1, destination: 'W', reason: 'servidor desktop desligado em 20/10', actorUserId: 7, syncKeysInactivated: 1 })
  })

  it('L → P na TRANSAÇÃO (repositório): a chave NÃO é tocada (é a dos PDVs — A-PR4/Q-PR60); o destino vai no UPDATE do fato; as duas categorias nascem se faltarem', async () => {
    const c = conn([lock, factForUpdate('L'), instUpdate(1), keyInactivate(1), liveCategory({ P: false, S: false }), catMax, catInsert])
    const out = await endLegacyTransitionTx(1, 'P')
    expect(out).toMatchObject({ kind: 'ended', syncKeysInactivated: 0, defaultCategories: { P: 10, S: 10 } })
    expect(c.query.mock.calls[2][1]).toEqual(['P', 1])
    expect(sqls(c).some(s => /UPDATE setes_central\.tb_sync_api_key/.test(s))).toBe(false)
    expect(sqls(c).filter(s => /INSERT INTO `setes_setes`\.tb_category/.test(s))).toHaveLength(2)
  })

  it('L → P pelo SERVIÇO: barreira INTERINA (A-PR5/Q-PR62) — 409 LEGACY_TRANSITION_DESTINATION_PENDING antes de qualquer transação, até o setes-sync honrar o fato', async () => {
    expect([...OPEN_TRANSITION_DESTINATIONS]).toEqual(['W'])
    mockGetConnection.mockClear()
    await expect(endLegacyTransition(1, 'P', 'ficam os PDVs', 7)).rejects.toMatchObject({
      statusCode: 409, code: 'LEGACY_TRANSITION_DESTINATION_PENDING', fields: [{ field: 'destination', message: 'destinos abertos: W' }],
    })
    expect(mockGetConnection).not.toHaveBeenCalled()
  })

  it('não-L = 409 LEGACY_TRANSITION_NOT_APPLICABLE sem gravar: W nunca foi L; P com data = "já foi encerrada" (repetir o ato cai aqui — irreversível)', async () => {
    const w = conn([lock, factForUpdate('W'), instUpdate(1)])
    await expect(endLegacyTransition(1, 'W', 'tentativa indevida', 7)).rejects.toMatchObject({ statusCode: 409, code: 'LEGACY_TRANSITION_NOT_APPLICABLE' })
    expect(sqls(w).some(s => /^\s*UPDATE/.test(s))).toBe(false)
    expect(w.rollback).toHaveBeenCalled()

    const again = conn([lock, factForUpdate('P', ENDED), instUpdate(1)])
    await expect(endLegacyTransition(1, 'W', 'de novo', 7)).rejects.toMatchObject({
      statusCode: 409, code: 'LEGACY_TRANSITION_NOT_APPLICABLE', message: expect.stringMatching(/já foi encerrada/),
      fields: [{ field: 'destination', message: 'origem atual: P' }, { field: 'transitionEndedAt', message: ENDED.toISOString() }],
    })
    expect(sqls(again).some(s => /^\s*UPDATE/.test(s))).toBe(false)
  })

  it('o fato mudou por baixo da trava (UPDATE afeta 0 linhas) = falha ALTA com rollback — nunca segue para a chave nem para as categorias', async () => {
    const c = conn([lock, factForUpdate('L'), instUpdate(0), keyInactivate(1), liveCategory({ P: true, S: true })])
    await expect(endLegacyTransition(1, 'W', 'corrida', 7)).rejects.toThrow(/mudou por baixo da trava/)
    expect(sqls(c).some(s => /tb_sync_api_key|tb_category/.test(s))).toBe(false)
    expect(c.rollback).toHaveBeenCalled()
    expect(c.commit).not.toHaveBeenCalled()
  })

  it('falha ao criar a categoria padrão desfaz o ato INTEIRO (o fato segue L, a chave segue viva) — nenhum commit', async () => {
    const c = conn([lock, factForUpdate('L'), instUpdate(1), keyInactivate(1), liveCategory({ P: true, S: false }), catMax,
      [/INSERT INTO `setes_setes`\.tb_category/, () => { throw Object.assign(new Error("Table 'setes_setes.tb_category' doesn't exist"), { errno: 1146 }) }]])
    await expect(endLegacyTransition(1, 'W', 'schema sem categoria', 7)).rejects.toThrow(/doesn't exist/)
    expect(c.rollback).toHaveBeenCalled()
    expect(c.commit).not.toHaveBeenCalled()
    expect((logger.info as jest.Mock).mock.calls.some(x => /ENCERRADA/.test(x[0]))).toBe(false)
  })

  it('deadlock na 1ª tentativa (o ato cunha id de categoria): reexecuta INTEIRO e conclui na 2ª', async () => {
    let first = true
    const c = conn([lock, factForUpdate('L'), instUpdate(1), keyInactivate(1), liveCategory({ P: true, S: false }),
      [/MAX\(id\), 0\) \+ 1 AS nextId FROM `setes_setes`\.tb_category/, () => {
        if (first) { first = false; throw Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 }) }
        return [[{ nextId: 10 }]]
      }], catInsert])
    const out = await endLegacyTransition(1, 'W', 'com deadlock', 7)
    expect(out.defaultCategories).toEqual({ P: null, S: 10 })
    expect(c.rollback).toHaveBeenCalledTimes(1)
    expect(c.commit).toHaveBeenCalledTimes(1)
    expect(sqls(c).filter(s => /UPDATE setes_central\.tb_institution/.test(s))).toHaveLength(2)      // uma por tentativa; só a 2ª comita
  })

  it('estabelecimento inexistente = 404', async () => {
    conn([lock, factForUpdate(null)])
    await expect(endLegacyTransition(99, 'W', 'não existe', 7)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('o corpo: destino W ou P (nunca L) e motivo com pelo menos 5 caracteres', () => {
    expect(endLegacyTransitionDto.safeParse({ destination: 'W', reason: 'desktop desligado' }).success).toBe(true)
    expect(endLegacyTransitionDto.safeParse({ destination: 'P', reason: '  7 PDVs ficam  ' }).success).toBe(true)
    for (const bad of [{ destination: 'L', reason: 'volta' }, { destination: 'W' }, { destination: 'W', reason: '   ' }, { destination: 'w', reason: 'minúscula' }, { reason: 'sem destino' }]) {
      expect([JSON.stringify(bad), endLegacyTransitionDto.safeParse(bad).success]).toEqual([JSON.stringify(bad), false])
    }
  })
})

describe('D-PR47 — a origem dos cadastros é DECLARADA no cadastro e IMUTÁVEL pela edição', () => {
  it('o POST exige sourceKind (sem default — fato declarado, nunca presumido); o PUT o aceita só como conferência', () => {
    const base = {
      entity: { nameCompany: 'X LTDA', nickTrade: 'X' }, personType: 'J', company: { cnpj: '11222333000181' },
      addresses: [], phones: [], socialMedia: [], schemaName: 'setes_x',
      admin: { nameCompany: 'A', nickTrade: 'A', email: 'a@x.com', password: 'segredo' },
    }
    expect(institutionCreateDto.safeParse(base).success).toBe(false)
    expect(institutionCreateDto.safeParse({ ...base, sourceKind: 'L' }).success).toBe(true)
    expect(institutionCreateDto.safeParse({ ...base, sourceKind: 'X' }).success).toBe(false)
    const { schemaName: _s, admin: _a, ...upd } = base
    expect(institutionUpdateDto.safeParse(upd).success).toBe(true)
    expect(institutionUpdateDto.safeParse({ ...upd, sourceKind: 'P' }).success).toBe(true)
  })

  it('PUT com sourceKind DIFERENTE do gravado = 409 SOURCE_KIND_IMMUTABLE (leitura travante da linha do fato) e rollback; igual passa', async () => {
    const input: any = { entity: {}, personType: 'J', addresses: [], phones: [], socialMedia: [], sourceKind: 'W' }
    const c = conn([[/SELECT source_kind AS sourceKind FROM setes_central\.tb_institution WHERE id = \? FOR UPDATE/, () => [[{ sourceKind: 'L' }]]]])
    await expect(updateInstitutionCascade(1, input, 7)).rejects.toMatchObject({ statusCode: 409, code: 'SOURCE_KIND_IMMUTABLE' })
    expect(c.rollback).toHaveBeenCalled()
    expect(sqls(c).some(s => /^\s*UPDATE/.test(s))).toBe(false)

    const same = conn([[/SELECT source_kind AS sourceKind FROM setes_central\.tb_institution WHERE id = \? FOR UPDATE/, () => [[{ sourceKind: 'W' }]]]])
    await expect(updateInstitutionCascade(1, input, 7)).resolves.toBeUndefined()
    expect(same.commit).toHaveBeenCalled()
  })

  const factForUpdatePlain = (kind: string): Route =>
    [/SELECT source_kind AS sourceKind FROM setes_central\.tb_institution WHERE id = \? AND deleted = 'N' FOR UPDATE/, () => [[{ sourceKind: kind }]]]
  const keyMax: Route = [/MAX\(id\), 0\) \+ 1 AS nextId FROM setes_central\.tb_sync_api_key/, () => [[{ nextId: 2 }]]]
  const keyInsert: Route = [/INSERT INTO setes_central\.tb_sync_api_key/, () => [{}]]
  const poolSaysL = () => mockQuery.mockImplementation(async (sql: string) => {
    if (/transition_ended_at AS transitionEndedAt/.test(sql)) return [[{ schemaName: 'setes_x', sourceKind: 'L', transitionEndedAt: null }]]
    if (/api_key AS apiKey/.test(sql)) return [[]]
    throw new Error('inesperado')
  })

  it('gerar a chave do sincronizador em W = 409 SYNC_KEY_NOT_FOR_SOURCE (a chave só existe para L e P); em L gera NUMA transação: trava → fato FOR UPDATE → chaves FOR UPDATE → MAX → INSERT', async () => {
    await expect(generateSyncApiKey(1)).rejects.toMatchObject({ statusCode: 409, code: 'SYNC_KEY_NOT_FOR_SOURCE' })   // o pool diz W
    expect(mockGetConnection).not.toHaveBeenCalled()

    poolSaysL()
    const c = conn([lock, factForUpdatePlain('L'), keysOf([]), keyMax, keyInsert])
    const row = await generateSyncApiKey(2)
    expect(row).toMatchObject({ establishmentCode: 'SETES_X', active: 'S' })
    const all = sqls(c)
    expect(all[0]).toMatch(/tb_institution WHERE id = \? FOR UPDATE/)                       // regra 7 — 1º statement
    expect(all[1]).toMatch(/source_kind AS sourceKind[\s\S]*FOR UPDATE/)
    expect(all[2]).toMatch(/tb_sync_api_key[\s\S]*FOR UPDATE/)
    expect(all[3]).toMatch(/MAX\(id\)/); expect(all[4]).toMatch(/INSERT INTO/)
    expect(c.commit).toHaveBeenCalled()
  })

  it('ADV-R7-03 (TOCTOU): o ato L → W comita ENTRE a leitura do pool e a transação → 409 SYNC_KEY_NOT_FOR_SOURCE, nenhum INSERT (nunca nasce chave viva em W)', async () => {
    poolSaysL()                                                                              // o pool ainda vê L…
    const c = conn([lock, factForUpdatePlain('W'), keysOf([]), keyMax, keyInsert])          // …a transação (depois da trava) vê W
    await expect(generateSyncApiKey(2)).rejects.toMatchObject({ statusCode: 409, code: 'SYNC_KEY_NOT_FOR_SOURCE' })
    expect(sqls(c).some(s => /INSERT INTO|MAX\(id\)/.test(s))).toBe(false)
    expect(c.rollback).toHaveBeenCalled(); expect(c.commit).not.toHaveBeenCalled()
  })

  it('dois POSTs simultâneos: o 2º acha a chave viva DENTRO da transação → 409 "já possui", sem INSERT', async () => {
    poolSaysL()
    const c = conn([lock, factForUpdatePlain('L'), keysOf([{ id: 1, active: 'S' }]), keyMax, keyInsert])
    await expect(generateSyncApiKey(2)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/já possui/) })
    expect(sqls(c).some(s => /INSERT INTO/.test(s))).toBe(false)
  })
})
