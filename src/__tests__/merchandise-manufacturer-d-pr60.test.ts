/// <reference types="jest" />
// FABRICANTE da mercadoria (setes-api:PROD.E9.P1 — prompt_modulo_products.md Rodada 9: D-PR10, D-PR60…D-PR65, A-PR6; RF-NFE-32/33).
// indEscala = `tb_merchandise.manuf_sign_ind_scale` (`scaleRelevance` S/N/null); CNPJFab = `tb_merchandise_factory` (`manufacturerCnpj`,
// migration 080). Três camadas: (i) o DTO (forma pela FederalId, alfanumérico aceito, coerência com o indEscala, chaves juntas); (ii) o
// repository com o pool falso (o SQL que grava/não grava cada tabela e o mapeamento do GET); (iii) a rota pelo app real com o serviço
// dublado (o 400 sai antes da escrita; o corpo válido chega ao serviço com os dois campos).
import request from 'supertest'
import { testToken } from '../test-setup/test-token'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFMFC01'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
jest.mock('../modules/merchandise/merchandise.service', () => {
  const actual = jest.requireActual('../modules/merchandise/merchandise.service')
  return { ...actual, __esModule: true, createMerchandise: jest.fn().mockResolvedValue(77), editMerchandise: jest.fn().mockResolvedValue(undefined) }
})

import pool from '../shared/db/connection'
import * as service from '../modules/merchandise/merchandise.service'
import * as repo from '../modules/merchandise/merchandise.repository'
import { merchandiseDto } from '../modules/merchandise/merchandise.dto'
import { resetPrivilegeCache } from '../shared/auth/require-privilege'
import app from '../app'

const mockQuery = (pool as any).query as jest.Mock
const mockGetConnection = (pool as any).getConnection as jest.Mock

const NUM = '11222333000181'          // CNPJ numérico válido
const ALFA = '12ABC34501DE35'         // CNPJ alfanumérico válido (exemplo da NT Conjunta 2025.001) — D-PR64
const BAD_DV = '11222333000182'
const MASK = '11.222.333/0001-81'
const LOWER = '12abc34501de35'

const base = { description: 'Parafuso 8mm', categoryId: 3, brandId: 1, baseUnit: { measureId: 1 } }
const ok = (over: Record<string, unknown>) => merchandiseDto.safeParse({ ...base, ...over }).success

beforeEach(() => jest.clearAllMocks())

// ---------------------------------------------------------------------------------------------------------------------------------
// (i) DTO
// ---------------------------------------------------------------------------------------------------------------------------------
describe('DTO — scaleRelevance + manufacturerCnpj (D-PR60, D-PR62, D-PR64, A-PR6)', () => {
  it("'N' + CNPJ numérico ou ALFANUMÉRICO canônico = aceito", () => {
    expect(ok({ scaleRelevance: 'N', manufacturerCnpj: NUM })).toBe(true)
    expect(ok({ scaleRelevance: 'N', manufacturerCnpj: ALFA })).toBe(true)
  })

  it("'N' sem CNPJ (null) = recusado no manufacturerCnpj (rej. 879)", () => {
    const r = merchandiseDto.safeParse({ ...base, scaleRelevance: 'N', manufacturerCnpj: null })
    expect(r.success).toBe(false)
    expect(r.error!.issues.map(i => i.path.join('.'))).toEqual(['manufacturerCnpj'])
  })

  it('forma não canônica é RECUSADA, nunca limpa (D-CJ12): DV errado, máscara, minúscula, 15 posições, espaço', () => {
    for (const v of [BAD_DV, MASK, LOWER, `${NUM}0`, ` ${NUM}`, `${NUM} `, '00000000000000', '']) {
      expect([v, ok({ scaleRelevance: 'N', manufacturerCnpj: v })]).toEqual([v, false])
    }
  })

  it("CNPJ com escala 'S' ou null = recusado (D-PR62 — nunca zerar em silêncio)", () => {
    expect(ok({ scaleRelevance: 'S', manufacturerCnpj: NUM })).toBe(false)
    expect(ok({ scaleRelevance: null, manufacturerCnpj: NUM })).toBe(false)
  })

  it("'S' + null e null + null = aceitos", () => {
    expect(ok({ scaleRelevance: 'S', manufacturerCnpj: null })).toBe(true)
    expect(ok({ scaleRelevance: null, manufacturerCnpj: null })).toBe(true)
  })

  it('as duas chaves andam JUNTAS (A-PR6): uma sem a outra = recusado; as duas ausentes = aceito', () => {
    expect(ok({ scaleRelevance: 'S' })).toBe(false)
    expect(ok({ scaleRelevance: null })).toBe(false)
    expect(ok({ manufacturerCnpj: null })).toBe(false)
    expect(ok({ manufacturerCnpj: NUM })).toBe(false)
    expect(ok({})).toBe(true)
  })

  it("produto do legado gravado com 'N' e SEM CNPJ (o sync grava assim): a ficha devolvida como veio é RECUSADA — o CNPJ passa a ser exigido na edição (D-PR60 'sempre'; efeito conhecido, gate do delta)", () => {
    const r = merchandiseDto.safeParse({ ...base, scaleRelevance: 'N', manufacturerCnpj: null })
    expect(r.success).toBe(false)
    expect(r.error!.issues[0].message).toContain('879')
  })

  it('domínio do indEscala: só S/N/null', () => {
    expect(ok({ scaleRelevance: 's', manufacturerCnpj: null })).toBe(false)
    expect(ok({ scaleRelevance: '', manufacturerCnpj: null })).toBe(false)
    expect(ok({ scaleRelevance: 'X', manufacturerCnpj: null })).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------
// (ii) repository
// ---------------------------------------------------------------------------------------------------------------------------------
type Route = [RegExp, (params: any[]) => any]
function routedConn(routes: Route[]) {
  const conn: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      for (const [re, fn] of routes) if (re.test(sql)) return fn(params)
      return /^\s*SELECT/i.test(sql) ? [[]] : [{ affectedRows: 1 }]
    }),
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }
  mockGetConnection.mockResolvedValue(conn)
  return conn
}
const callsOf = (conn: any, re: RegExp): Array<[string, any[]]> =>
  conn.query.mock.calls.filter((c: any[]) => re.test(c[0])).map((c: any[]) => [c[0] as string, c[1] as any[]])
const refsOk: Route[] = [
  [/FROM `setes_setes`\.tb_category/, () => [[{ 1: 1 }]]],
  [/tb_institution_has_(brand|measure|package) l/, () => [[{ 1: 1 }]]],
]
const input = (over: Record<string, unknown> = {}) => merchandiseDto.parse({ ...base, ...over })
const insertRoutes: Route[] = [
  [/setes_central\.tb_institution WHERE id = \? FOR UPDATE/, () => [[{ id: 1 }]]],
  [/MAX\(id\), 0\) \+ 1 AS nextId FROM `setes_setes`\.tb_product/, () => [[{ nextId: 42 }]]],
  ...refsOk,
]
const updateRoutes: Route[] = [
  [/SELECT p\.identifier, p\.tb_category_id/, () => [[{ identifier: '5', categoryId: 3, financialPlansId: null }]]],
  [/SELECT tb_brand_id AS brandId FROM `setes_setes`\.tb_merchandise WHERE/, () => [[{ brandId: 1 }]]],
  ...refsOk,
]
const MERCH = /INSERT INTO `setes_setes`\.tb_merchandise\s*\(/
const FACTORY = /tb_merchandise_factory/

describe('repository — gravação (D-PR65, A-PR6)', () => {
  it("criar com 'N' + CNPJ: indEscala gravado e a linha do fabricante nasce viva, na MESMA transação, DEPOIS da tb_merchandise", async () => {
    const conn = routedConn(insertRoutes)
    await repo.insertMerchandise(input({ scaleRelevance: 'N', manufacturerCnpj: ALFA }), 'setes_setes', 1)
    const [[mSql, mPar]] = callsOf(conn, MERCH)
    expect(mSql).toContain('manuf_sign_ind_scale')
    expect(mPar[7]).toBe('N')
    const f = callsOf(conn, FACTORY)
    expect(f).toHaveLength(1)
    expect(f[0][0]).toMatch(/INSERT INTO `setes_setes`\.tb_merchandise_factory[\s\S]*ON DUPLICATE KEY UPDATE cnpj = VALUES\(cnpj\), deleted = 'N'/)
    expect(f[0][1]).toEqual([1, 42, ALFA])
    const sqls: string[] = conn.query.mock.calls.map((c: any[]) => c[0])
    expect(sqls.findIndex(s => FACTORY.test(s))).toBeGreaterThan(sqls.findIndex(s => MERCH.test(s)))
    expect(conn.commit).toHaveBeenCalled()
  })

  it('criar SEM as chaves: indEscala nasce NULL (nunca o DEFAULT S) e nada na tb_merchandise_factory', async () => {
    const conn = routedConn(insertRoutes)
    await repo.insertMerchandise(input(), 'setes_setes', 1)
    const [[mSql, mPar]] = callsOf(conn, MERCH)
    expect(mSql).toContain('manuf_sign_ind_scale')
    expect(mPar[7]).toBeNull()
    expect(callsOf(conn, FACTORY)).toEqual([])
  })

  it("criar com 'S' + null: nenhum comando na tb_merchandise_factory (sem UPDATE inútil que travaria intervalo — gate LOW-3)", async () => {
    const conn = routedConn(insertRoutes)
    await repo.insertMerchandise(input({ scaleRelevance: 'S', manufacturerCnpj: null }), 'setes_setes', 1)
    expect(callsOf(conn, MERCH)[0][1][7]).toBe('S')
    expect(callsOf(conn, FACTORY)).toEqual([])
  })

  it("editar produto do sync SEM linha em tb_merchandise, com 'N' + CNPJ: a tb_merchandise nasce ANTES do fabricante (FK)", async () => {
    const conn = routedConn([
      [/SELECT p\.identifier, p\.tb_category_id/, () => [[{ identifier: '5', categoryId: 3, financialPlansId: null }]]],
      [/SELECT tb_brand_id AS brandId FROM `setes_setes`\.tb_merchandise WHERE/, () => [[]]],
      ...refsOk,
    ])
    expect(await repo.updateMerchandise(5, input({ identifier: '5', scaleRelevance: 'N', manufacturerCnpj: NUM }), 'setes_setes', 1)).toBe(true)
    const sqls: string[] = conn.query.mock.calls.map((c: any[]) => c[0])
    const iM = sqls.findIndex(s => MERCH.test(s)), iF = sqls.findIndex(s => FACTORY.test(s))
    expect(iM).toBeGreaterThanOrEqual(0)
    expect(iF).toBeGreaterThan(iM)
    expect(callsOf(conn, MERCH)[0][1][7]).toBe('N')
  })

  it('editar SEM as chaves: a linha existente não muda o indEscala (fora do ON DUPLICATE) e nada na tb_merchandise_factory', async () => {
    const conn = routedConn(updateRoutes)
    expect(await repo.updateMerchandise(5, input({ identifier: '5' }), 'setes_setes', 1)).toBe(true)
    const [[mSql, mPar]] = callsOf(conn, MERCH)
    const onDup = mSql.slice(mSql.indexOf('ON DUPLICATE KEY UPDATE'))
    expect(onDup).not.toContain('manuf_sign_ind_scale')
    expect(mPar[7]).toBeNull()        // só vale se a PRÓPRIA linha nascer agora (produto do sync sem tb_merchandise) — nunca o 'S'
    expect(callsOf(conn, FACTORY)).toEqual([])
  })

  it("editar para 'S' + null: indEscala no ON DUPLICATE e o fabricante vivo vira soft delete (nunca DELETE)", async () => {
    const conn = routedConn(updateRoutes)
    await repo.updateMerchandise(5, input({ identifier: '5', scaleRelevance: 'S', manufacturerCnpj: null }), 'setes_setes', 1)
    const [[mSql, mPar]] = callsOf(conn, MERCH)
    expect(mSql.slice(mSql.indexOf('ON DUPLICATE KEY UPDATE'))).toContain('manuf_sign_ind_scale = VALUES(manuf_sign_ind_scale)')
    expect(mPar[7]).toBe('S')
    const f = callsOf(conn, FACTORY)
    expect(f).toHaveLength(1)
    expect(f[0][0]).toMatch(/UPDATE `setes_setes`\.tb_merchandise_factory SET deleted = 'S', updated_at = NOW\(\)\s+WHERE tb_institution_id = \? AND tb_merchandise_id = \? AND deleted = 'N'/)
    expect(f[0][1]).toEqual([1, 5])
    const all: string[] = conn.query.mock.calls.map((c: any[]) => c[0])
    expect(all.some(s => /\bDELETE\s+FROM\b|\bREPLACE\s+INTO\b/i.test(s))).toBe(false)
  })

  it("editar trocando o CNPJ: upsert pela PK grava o NOVO (revive linha morta com o CNPJ novo)", async () => {
    const conn = routedConn(updateRoutes)
    await repo.updateMerchandise(5, input({ identifier: '5', scaleRelevance: 'N', manufacturerCnpj: NUM }), 'setes_setes', 1)
    const f = callsOf(conn, FACTORY)
    expect(f).toHaveLength(1)
    expect(f[0][0]).toContain("ON DUPLICATE KEY UPDATE cnpj = VALUES(cnpj), deleted = 'N', updated_at = NOW()")
    expect(f[0][1]).toEqual([1, 5, NUM])
  })
})

describe('repository — leitura (GET da ficha)', () => {
  it("lê o indEscala com NULLIF('') e o CNPJ da linha VIVA da tb_merchandise_factory; devolve os dois campos", async () => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 9, cest: '0100100', buMeasureId: 1, origin: '0', purpose: '1', scaleRelevance: 'N', manufacturerCnpj: ALFA }]])
      .mockResolvedValueOnce([[]])
    const full = await repo.getMerchandise(9, 'setes_setes', 1)
    expect(full).toMatchObject({ scaleRelevance: 'N', manufacturerCnpj: ALFA })
    const sql: string = mockQuery.mock.calls[0][0]
    // domínio fechado no GET (gate LOW-2): '', minúscula, SQL manual etc. viram null — o GET nunca sai do tipo 'S' | 'N' | null
    expect(sql).toContain("CASE WHEN m.manuf_sign_ind_scale COLLATE utf8mb4_bin IN ('S', 'N') THEN m.manuf_sign_ind_scale END AS scaleRelevance")
    expect(sql).toContain('mfc.cnpj                AS manufacturerCnpj')
    expect(sql).toMatch(/LEFT JOIN `setes_setes`\.tb_merchandise_factory mfc\s+ON mfc\.tb_institution_id = m\.tb_institution_id AND mfc\.tb_merchandise_id = m\.id AND mfc\.deleted = 'N'/)
  })

  it('sem fabricante e indEscala vazio do sync: os dois null', async () => {
    mockQuery.mockResolvedValueOnce([[{ id: 9, buMeasureId: null, origin: '0', purpose: '1', scaleRelevance: null, manufacturerCnpj: null }]]).mockResolvedValueOnce([[]])
    expect(await repo.getMerchandise(9, 'setes_setes', 1)).toMatchObject({ scaleRelevance: null, manufacturerCnpj: null })
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------
// (iii) rota pelo app real (serviço de escrita dublado)
// ---------------------------------------------------------------------------------------------------------------------------------
const MERCH_IFACE = 40
const SETES_ADMIN = { institutionId: 1, userId: 1, role: 'admin', schemaName: 'setes_setes' }
const auth = `Bearer ${testToken(SETES_ADMIN)}`

describe('rota /api/merchandise — o 400 sai antes da escrita; o corpo válido chega ao serviço', () => {
  beforeEach(() => {
    resetPrivilegeCache()
    mockQuery.mockImplementation(async (sql: string, params: any[] = []) => {
      if (/SELECT source_kind AS kind FROM setes_central\.tb_institution/.test(sql)) return [[{ kind: 'W' }]]
      if (/FROM setes_central\.tb_interface WHERE i18n_key/.test(sql)) return [String(params[0]) === 'merchandise' ? [{ id: MERCH_IFACE }] : []]
      if (/tb_institution_has_interface/.test(sql)) return [[{ 1: 1 }]]
      return [[]]
    })
  })

  it("POST com 'N' sem CNPJ, CNPJ mascarado e chave sozinha = 400, e o serviço não é chamado", async () => {
    const bodies = [
      { ...base, scaleRelevance: 'N', manufacturerCnpj: null },
      { ...base, scaleRelevance: 'N', manufacturerCnpj: MASK },
      { ...base, scaleRelevance: 'N' },
      { ...base, scaleRelevance: 'S', manufacturerCnpj: NUM },
    ]
    for (const body of bodies) {
      const r = await request(app).post('/api/merchandise').set('Authorization', auth).send(body)
      expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 400])
    }
    // só a REGRA DAS CHAVES JUNTAS recusa este corpo (sem CNPJ não há D-PR62 a disparar) — gate LOW-3 do socrático
    const r = await request(app).put('/api/merchandise/5').set('Authorization', auth).send({ ...base, scaleRelevance: 'S' })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).toContain('A-PR6')
    expect((service.createMerchandise as jest.Mock).mock.calls).toHaveLength(0)
    expect((service.editMerchandise as jest.Mock).mock.calls).toHaveLength(0)
  })

  it("POST com 'N' + CNPJ alfanumérico = 201 e o serviço recebe os dois campos como vieram", async () => {
    const r = await request(app).post('/api/merchandise').set('Authorization', auth).send({ ...base, scaleRelevance: 'N', manufacturerCnpj: ALFA })
    expect(r.status).toBe(201)
    expect((service.createMerchandise as jest.Mock).mock.calls[0][0]).toMatchObject({ scaleRelevance: 'N', manufacturerCnpj: ALFA })
  })

  it("PUT válido ('S' + null) = 200 e chega ao serviço com as duas chaves; PUT sem elas chega SEM as chaves (A-PR6: não mexe)", async () => {
    const a = await request(app).put('/api/merchandise/5').set('Authorization', auth).send({ ...base, scaleRelevance: 'S', manufacturerCnpj: null })
    const b = await request(app).put('/api/merchandise/5').set('Authorization', auth).send(base)
    expect([a.status, b.status]).toEqual([200, 200])
    const calls = (service.editMerchandise as jest.Mock).mock.calls
    expect(calls[0][1]).toMatchObject({ scaleRelevance: 'S', manufacturerCnpj: null })
    expect('scaleRelevance' in calls[1][1] || 'manufacturerCnpj' in calls[1][1]).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------
// Cerca de escritor (gate adversarial LOW-5): só o repositório do merchandise escreve em tb_merchandise_factory, e só por
// INSERT … ON DUPLICATE KEY UPDATE (pela PK) ou UPDATE … deleted = 'S' — nunca DELETE/REPLACE/TRUNCATE (PADROES §3.1).
// ---------------------------------------------------------------------------------------------------------------------------------
describe('cerca — escritores da tb_merchandise_factory', () => {
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const SRC = path.resolve(__dirname, '..')
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (e.name === '__tests__' || e.name === 'test-setup' ? [] : files(path.join(dir, e.name)))
                    : (/\.ts$/.test(e.name) ? [path.join(dir, e.name)] : []))
  const WRITE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO|TRUNCATE(\s+TABLE)?)\s+[\\`\w${}.]*tb_merchandise_factory\b/gi

  it('só merchandise.repository.ts escreve, e só por INSERT/UPDATE', () => {
    const hits = files(SRC).flatMap(f => [...fs.readFileSync(f, 'utf8').matchAll(WRITE)]
      .map(m => `${path.relative(SRC, f).split(path.sep).join('/')}: ${m[1].toUpperCase().split(/\s+/)[0]}`))
    expect(hits.sort()).toEqual(['modules/merchandise/merchandise.repository.ts: INSERT', 'modules/merchandise/merchandise.repository.ts: UPDATE'])
  })
})
