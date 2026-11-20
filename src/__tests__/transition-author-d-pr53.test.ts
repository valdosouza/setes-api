/// <reference types="jest" />
// D-PR53/D-PR57 (setes-api:PROD.E6.P2, 2026-11-20) — AUTOR e MOTIVO do ato "encerrar a transição" viram FATO do objeto
// (`tb_institution.transition_ended_by`/`transition_end_reason`, migration 079), gravados no MESMO UPDATE condicionado que muda
// `source_kind` e grava `transition_ended_at`; o `GET /api/institutions/:id` devolve os dois; o boot confere colunas, constraints e FK
// pelo NOME e sonda o motor. Pelo app REAL (auth RS256 de teste → superGuard → controller → service → repository), banco dublado.
// A semântica das constraints no motor é provada em schema descartável: scripts/prove-079-institution-transition-author.ts.
import request from 'supertest'
import { testToken } from '../test-setup/test-token'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFDPR53'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../feature-flags/flag.service', () => ({ __esModule: true, isModuleEnabled: jest.fn().mockResolvedValue(true), invalidateCache: jest.fn() }))
jest.mock('../shared/entity', () => ({
  ...jest.requireActual('../shared/entity'),
  getEntityFiscalFull: jest.fn(async (id: number) => ({ id, nickTrade: 'SETES' })),
}))

import pool from '../shared/db/connection'
import logger from '../shared/logger/logger'
import app from '../app'
import { endLegacyTransition } from '../modules/institutions/institutions.service'
import {
  assertInstitutionSourceKindSchema, CK_INSTITUTION_SOURCE_KIND, CK_INSTITUTION_TRANSITION_ENDED,
  CK_INSTITUTION_TRANSITION_AUTHOR, CK_INSTITUTION_TRANSITION_REASON, FK_INSTITUTION_TRANSITION_ENDED_BY,
} from '../shared/catalog-owner'

const q = (pool as any).query as jest.Mock
const ENDED = new Date(Date.UTC(2026, 10, 20, 13, 0, 0))
const SUPER = { institutionId: 1, userId: 7, role: 'super', schemaName: 'setes_setes' }
const bearer = (p: object) => `Bearer ${testToken(p)}`

// ---- modelo: UMA institution L (a Setes) ----
type Row = { kind: 'W' | 'L' | 'P'; endedAt: Date | null; by: number | null; reason: string | null }
let row: Row
let instUpdates: any[][]
let txSql: string[]
function db(sql: string, params: any[] = []): any {
  const s = String(sql)
  if (/FROM setes_central\.tb_institution WHERE id = \? FOR UPDATE/.test(s)) return [[{ id: params[0] }]]
  if (/SELECT schema_name AS schemaName, source_kind AS sourceKind, transition_ended_at AS transitionEndedAt\s+FROM setes_central\.tb_institution WHERE id = \? AND deleted = 'N'/.test(s)) {
    return [[{ schemaName: 'setes_setes', sourceKind: row.kind, transitionEndedAt: row.endedAt }]]
  }
  if (/i\.transition_ended_by AS transitionEndedBy, i\.transition_end_reason AS transitionEndReason,\s+COALESCE\(NULLIF\(ea\.nick_trade, ''\), ea\.name_company\) AS transitionEndedByName\s+FROM setes_central\.tb_institution i\s+LEFT JOIN setes_central\.tb_entity ea ON ea\.id = i\.transition_ended_by/.test(s)) {
    return [[{
      schemaName: 'setes_setes', active: 'S', sourceKind: row.kind, transitionEndedAt: row.endedAt, transitionEndedBy: row.by,
      transitionEndReason: row.reason, transitionEndedByName: row.by === 7 ? 'VALDO' : null,
    }]]
  }
  if (/UPDATE setes_central\.tb_institution\s+SET source_kind = \?, transition_ended_at = NOW\(\), transition_ended_by = \?, transition_end_reason = \?, updated_at = NOW\(\)\s+WHERE id = \? AND source_kind = 'L' AND transition_ended_at IS NULL/.test(s)) {
    instUpdates.push(params)
    if (row.kind !== 'L' || row.endedAt) return [{ affectedRows: 0 }]
    row = { kind: params[0], endedAt: ENDED, by: params[1], reason: params[2] }
    return [{ affectedRows: 1 }]
  }
  if (/UPDATE setes_central\.tb_sync_api_key SET active = 'N'/.test(s)) return [{ affectedRows: 1 }]
  if (/tb_category\s+WHERE tb_institution_id = \? AND kind = \? AND deleted = 'N' AND active = 'S' LIMIT 1 FOR UPDATE/.test(s)) return [[{ id: 1 }]]
  if (/^\s*SELECT/i.test(s)) return [[]]
  throw new Error(`SQL inesperado: ${s.slice(0, 100)}`)
}

beforeEach(() => {
  jest.clearAllMocks()
  row = { kind: 'L', endedAt: null, by: null, reason: null }
  instUpdates = []; txSql = []
  q.mockImplementation(async (sql: string, params: any[] = []) => db(sql, params))
  ;(pool as any).getConnection.mockImplementation(async () => ({
    query: jest.fn(async (sql: string, params: any[] = []) => { txSql.push(String(sql)); return db(sql, params) }),
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }))
})

describe('D-PR53 — o ato grava as QUATRO marcas no MESMO UPDATE condicionado', () => {
  it('POST com motivo cercado de espaços: o UPDATE recebe (destino, autor do TOKEN, motivo APARADO, id), com a condição no comando; o log segue', async () => {
    const r = await request(app).post('/api/institutions/1/end-legacy-transition').set('Authorization', bearer(SUPER))
      .send({ destination: 'W', reason: '   servidor desktop desligado   ' })
    expect(r.status).toBe(200)
    expect(instUpdates).toEqual([['W', 7, 'servidor desktop desligado', 1]])
    const upd = txSql.filter(s => /UPDATE setes_central\.tb_institution/.test(s))
    expect(upd).toHaveLength(1)                                                      // UM comando para as quatro marcas
    expect(upd[0]).toMatch(/source_kind = \?, transition_ended_at = NOW\(\), transition_ended_by = \?, transition_end_reason = \?/)
    expect(upd[0]).toMatch(/WHERE id = \? AND source_kind = 'L' AND transition_ended_at IS NULL/)
    expect(r.body.data).toEqual({ sourceKind: 'W', transitionEndedAt: ENDED.toISOString(), defaultCategories: { P: null, S: null }, syncKeysInactivated: 1 })
    const log = (logger.info as jest.Mock).mock.calls.find(x => /ENCERRADA/.test(x[0]))
    expect(log?.[1]).toMatchObject({ institutionId: 1, destination: 'W', reason: 'servidor desktop desligado', actorUserId: 7 })
  })

  it('motivo curto depois de aparado = 400, nada chega ao banco', async () => {
    const r = await request(app).post('/api/institutions/1/end-legacy-transition').set('Authorization', bearer(SUPER))
      .send({ destination: 'W', reason: '   abc   ' })
    expect(r.status).toBe(400)
    expect(instUpdates).toEqual([])
  })

  it('repetir o ato não reescreve autor nem motivo (write-once): 409 e o fato fica como o 1º ato deixou', async () => {
    await request(app).post('/api/institutions/1/end-legacy-transition').set('Authorization', bearer(SUPER)).send({ destination: 'W', reason: 'primeira vez' })
    const again = await request(app).post('/api/institutions/1/end-legacy-transition').set('Authorization', bearer({ ...SUPER, userId: 8 }))
      .send({ destination: 'W', reason: 'segunda vez' })
    expect([again.status, again.body.code]).toEqual([409, 'LEGACY_TRANSITION_NOT_APPLICABLE'])
    expect(row).toEqual({ kind: 'W', endedAt: ENDED, by: 7, reason: 'primeira vez' })
  })

  it('autor ausente (chamada sem usuário) = falha alta ANTES da transação — nunca grava o ato pela metade', async () => {
    await expect(endLegacyTransition(1, 'W', 'sem autor no token', null)).rejects.toThrow(/autor ausente/)
    expect((pool as any).getConnection).not.toHaveBeenCalled()
  })
})

describe('D-PR53 — o GET /:id devolve autor e motivo', () => {
  it('antes do ato: tudo nulo; depois: o id e o NOME do autor (D-PR57) e o motivo gravados', async () => {
    const before = await request(app).get('/api/institutions/1').set('Authorization', bearer(SUPER))
    expect(before.status).toBe(200)
    expect(before.body.data).toMatchObject({
      sourceKind: 'L', transitionEndedAt: null, transitionEndedBy: null, transitionEndedByName: null, transitionEndReason: null,
    })
    row = { kind: 'W', endedAt: ENDED, by: 7, reason: 'servidor desktop desligado' }
    const after = await request(app).get('/api/institutions/1').set('Authorization', bearer(SUPER))
    expect(after.body.data).toMatchObject({
      sourceKind: 'W', transitionEndedAt: ENDED.toISOString(), transitionEndedBy: 7, transitionEndedByName: 'VALDO',
      transitionEndReason: 'servidor desktop desligado',
    })
  })
})

describe('D-PR53/D-PR57 — o boot confere a 079 pelo NOME e sonda o motor', () => {
  const ALL_COLS = [
    { c: 'source_kind', n: 'NO', d: null }, { c: 'transition_ended_at', n: 'YES', d: null },
    { c: 'transition_ended_by', n: 'YES', d: null }, { c: 'transition_end_reason', n: 'YES', d: null },
  ]
  const ALL_CKS = [CK_INSTITUTION_SOURCE_KIND, CK_INSTITUTION_TRANSITION_ENDED, CK_INSTITUTION_TRANSITION_AUTHOR, CK_INSTITUTION_TRANSITION_REASON]
  /** Conexão dublada: o motor recusa cada sonda pela constraint que o modelo manda (null = grava). */
  const fakeConn = (o: { cols?: any[]; cks?: string[]; fk?: string | null; refuse?: (p: any[]) => string | null } = {}) => {
    const calls: Array<[string, any[]]> = []
    const conn = {
      query: jest.fn(async (sql: string, p: any[] = []) => {
        calls.push([sql, p])
        if (/information_schema\.COLUMNS/.test(sql)) return [o.cols ?? ALL_COLS]
        if (/information_schema\.CHECK_CONSTRAINTS/.test(sql)) return [(o.cks ?? ALL_CKS).map(n => ({ n }))]
        if (/information_schema\.REFERENTIAL_CONSTRAINTS/.test(sql)) return [o.fk === null ? [] : [{ t: o.fk ?? 'tb_user' }]]
        if (/INSERT INTO setes_central\.tb_institution/.test(sql)) {
          const ck = (o.refuse ?? defaultRefuse)(p)
          if (ck) throw Object.assign(new Error(`CONSTRAINT \`${ck}\` failed for \`setes_central\`.\`tb_institution\``), { errno: 4025 })
        }
        return [{}]
      }),
      beginTransaction: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    return { q: { getConnection: async () => conn as any }, calls, conn }
  }
  // o motor de verdade: [id, schema_name?, source_kind, by, reason] — params do INSERT da sonda: [id, sourceKind, by, reason]
  const defaultRefuse = (p: any[]): string | null => {
    const [, kind, by, reason] = p
    if (!['W', 'L', 'P'].includes(kind)) return CK_INSTITUTION_SOURCE_KIND
    if (kind === 'L' && by !== null) return CK_INSTITUTION_TRANSITION_ENDED      // a única sonda "L com data" leva autor e motivo
    if (by === null || reason === null) return CK_INSTITUTION_TRANSITION_AUTHOR  // W com data, sem autor e/ou sem motivo
    if (typeof reason === 'string' && reason.trim() === '') return CK_INSTITUTION_TRANSITION_REASON   // motivo só branco
    return null
  }

  it('tudo certo = "ok"; as seis sondas rodam, cada uma numa transação desfeita; só as que levam autor criam o usuário de prova', async () => {
    const f = fakeConn()
    await expect(assertInstitutionSourceKindSchema(f.q as any)).resolves.toBe('ok')
    const inserts = f.calls.filter(([s]) => /INSERT INTO setes_central\.tb_institution/.test(s)).map(([, p]) => p)
    expect(inserts).toEqual([
      [-1, 'X', null, null], [-1, 'l', null, null], [-1, 'L', -1, 'sonda do boot (D-PR53)'], [-1, 'W', null, null], [-1, 'W', -1, '   '],
      [-1, 'W', -1, null],
    ])
    expect(f.calls.filter(([s]) => /INSERT INTO setes_central\.tb_user/.test(s))).toHaveLength(3)
    expect(f.conn.rollback).toHaveBeenCalledTimes(6)
  })

  it('CHECK do autor frouxo que esquece o motivo (mesmo nome) = o boot não sobe', async () => {
    const f = fakeConn({ refuse: p => (p[1] === 'W' && p[2] === -1 && p[3] === null ? null : defaultRefuse(p)) })
    await expect(assertInstitutionSourceKindSchema(f.q as any)).rejects.toThrow(new RegExp(`CHECK ${CK_INSTITUTION_TRANSITION_AUTHOR} NÃO aplicado`))
  })

  it('o motor ACEITA motivo só branco (CHECK do motivo frouxo com o mesmo nome) = o boot não sobe', async () => {
    const f = fakeConn({ refuse: p => (p[3] === '   ' ? null : defaultRefuse(p)) })
    await expect(assertInstitutionSourceKindSchema(f.q as any)).rejects.toThrow(new RegExp(`CHECK ${CK_INSTITUTION_TRANSITION_REASON} NÃO aplicado`))
  })

  it('a 079 não rodou (colunas ausentes) = o boot não sobe', async () => {
    const f = fakeConn({ cols: ALL_COLS.slice(0, 2) })
    await expect(assertInstitutionSourceKindSchema(f.q as any)).rejects.toThrow(/a migration 079 não rodou/)
  })

  it('coluna do autor NOT NULL = o boot não sobe (só o ato a preenche)', async () => {
    const f = fakeConn({ cols: [...ALL_COLS.slice(0, 2), { c: 'transition_ended_by', n: 'NO', d: null }, ALL_COLS[3]] })
    await expect(assertInstitutionSourceKindSchema(f.q as any)).rejects.toThrow(/têm de ser anuláveis/)
  })

  it.each([CK_INSTITUTION_TRANSITION_AUTHOR, CK_INSTITUTION_TRANSITION_REASON])('sem a constraint %s = o boot não sobe', async (ck) => {
    const f = fakeConn({ cks: ALL_CKS.filter(n => n !== ck) })
    await expect(assertInstitutionSourceKindSchema(f.q as any)).rejects.toThrow(new RegExp(`sem a constraint ${ck} \\(migration 079`))
  })

  it('sem a FK para tb_user (ou apontando para outra tabela) = o boot não sobe', async () => {
    await expect(assertInstitutionSourceKindSchema(fakeConn({ fk: null }).q as any)).rejects.toThrow(new RegExp(`sem a FK ${FK_INSTITUTION_TRANSITION_ENDED_BY}`))
    await expect(assertInstitutionSourceKindSchema(fakeConn({ fk: 'tb_entity' }).q as any)).rejects.toThrow(new RegExp(`sem a FK ${FK_INSTITUTION_TRANSITION_ENDED_BY}`))
  })

  it('o motor GRAVA o ato sem autor (CHECK da 079 não aplicado) = o boot não sobe', async () => {
    const f = fakeConn({ refuse: p => (p[1] === 'W' && p[2] === null ? null : defaultRefuse(p)) })
    await expect(assertInstitutionSourceKindSchema(f.q as any)).rejects.toThrow(new RegExp(`CHECK ${CK_INSTITUTION_TRANSITION_AUTHOR} NÃO aplicado`))
  })

  it('a sonda "W com data" recusada por OUTRA constraint = o boot não sobe', async () => {
    const f = fakeConn({ refuse: p => (p[1] === 'W' && p[2] === null ? CK_INSTITUTION_TRANSITION_REASON : defaultRefuse(p)) })
    await expect(assertInstitutionSourceKindSchema(f.q as any)).rejects.toThrow(/recusada por OUTRA constraint/)
  })
})
