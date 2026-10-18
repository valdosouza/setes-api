/// <reference types="jest" />
// GATE ADVERSARIAL do DELTA de correção — cadastro de produtos (mercadoria), onda 1 (2026-10-18, 2ª rodada).
//
// Alvo: o protocolo da trava NOMEADA do catálogo central em `createAndLinkCatalogItem` (correção do ADV-06): espera curta na sessão →
// GET_LOCK → transação → commit → RELEASE_LOCK → espera devolvida → conexão de volta ao pool. A trava é da SESSÃO e é RECURSIVA: conexão
// que volta ao pool segurando-a bloquearia TODO "criar na hora" de TODOS os clientes (por isso é atacada aqui com conexão simulada — o
// gate nunca toma `GET_LOCK('setes_central.tb_*')` no banco real). Semântica fixada (todos devem PASSAR):
//   · a trava só é solta DEPOIS do commit (o próximo criador enxerga o item no retrato e a dedupe o reusa);
//   · sem a trava no prazo = 409 RESOURCE_BUSY, sem transação, sem RELEASE_LOCK de trava que não é nossa;
//   · erro em QUALQUER passo depois da trava solta a trava e devolve a espera da sessão;
//   · falha do rollback não mascara o erro original; conexão que não conseguiu soltar a trava/devolver a espera é DESCARTADA (destroy).
import pool from '../shared/db/connection'
import { BRAND_CATALOG, createAndLinkCatalogItem } from '../shared/central-catalog'
import * as service from '../modules/merchandise/merchandise.service'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const mockGetConnection = (pool as any).getConnection as jest.Mock

interface FakeOpts {
  lockOk?: number | null
  failBegin?: boolean
  failInsert?: string
  failCommit?: boolean
  failRollback?: boolean
  failRelease?: boolean
  failRestore?: boolean
}

function fakeConn(opts: FakeOpts = {}) {
  const events: string[] = []
  const conn: any = {
    query: jest.fn(async (sql: string) => {
      if (/GET_LOCK\(/.test(sql)) { events.push('GET_LOCK'); return [[{ ok: opts.lockOk === undefined ? 1 : opts.lockOk }]] }
      if (/RELEASE_LOCK\(/.test(sql)) {
        events.push('RELEASE_LOCK')
        if (opts.failRelease) throw new Error('Connection lost')
        return [[{ r: 1 }]]
      }
      if (/^\s*SET @setes_cat_prev/.test(sql)) { events.push('SAVE_WAIT'); return [{}] }
      if (/SET SESSION innodb_lock_wait_timeout = \?/.test(sql)) { events.push('SHORTEN_WAIT'); return [{}] }
      if (/SET SESSION innodb_lock_wait_timeout = @setes_cat_prev_lw/.test(sql)) {
        events.push('RESTORE_WAIT')
        if (opts.failRestore) throw new Error('Connection lost')
        return [{}]
      }
      if (/FROM setes_central\.tb_brand\s+WHERE/.test(sql)) return [[]]                // dedupe: não existe
      if (/MAX\(id\), 0\) \+ 1 AS nextId FROM setes_central\.tb_brand/.test(sql)) return [[{ nextId: 7 }]]
      if (/INSERT INTO setes_central\.tb_brand/.test(sql)) {
        events.push('INSERT_ITEM')
        if (opts.failInsert) throw Object.assign(new Error('falha no INSERT'), { code: opts.failInsert })
        return [{ affectedRows: 1 }]
      }
      if (/tb_institution_has_brand/.test(sql)) { events.push('LINK'); return [{ affectedRows: 1 }] }
      return /^\s*SELECT/i.test(sql) ? [[]] : [{ affectedRows: 1 }]
    }),
    beginTransaction: jest.fn(async () => {
      events.push('BEGIN')
      if (opts.failBegin) throw Object.assign(new Error('begin falhou'), { code: 'ER_BEGIN' })
    }),
    commit: jest.fn(async () => {
      events.push('COMMIT')
      if (opts.failCommit) throw Object.assign(new Error('commit falhou'), { code: 'ER_COMMIT' })
    }),
    rollback: jest.fn(async () => {
      events.push('ROLLBACK')
      if (opts.failRollback) throw Object.assign(new Error('rollback falhou'), { code: 'ER_ROLLBACK' })
    }),
    release: jest.fn(() => { events.push('RELEASE_CONN') }),
    destroy: jest.fn(() => { events.push('DESTROY_CONN') }),
  }
  mockGetConnection.mockResolvedValue(conn)
  return { conn, events }
}

const create = () => createAndLinkCatalogItem(BRAND_CATALOG, 'setes_setes', 1, { description: 'Ciser' })

beforeEach(() => { jest.clearAllMocks(); mockGetConnection.mockReset() })

describe('trava nomeada do catálogo central — protocolo (correção do ADV-06)', () => {
  it('caminho feliz: espera curta → GET_LOCK → transação → COMMIT → RELEASE_LOCK → espera devolvida → conexão ao pool', async () => {
    const { events } = fakeConn()
    await expect(create()).resolves.toEqual({ id: 7, reused: false })
    expect(events).toEqual([
      'SAVE_WAIT', 'SHORTEN_WAIT', 'GET_LOCK', 'BEGIN', 'INSERT_ITEM', 'LINK', 'COMMIT', 'RELEASE_LOCK', 'RESTORE_WAIT', 'RELEASE_CONN',
    ])
  })

  it.each([[0], [null]])('GET_LOCK devolve %p (prazo estourado / erro) → 409 RESOURCE_BUSY, sem transação e sem soltar trava alheia', async (ok) => {
    const { events } = fakeConn({ lockOk: ok as any })
    await expect(create()).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_BUSY' })
    expect(events).not.toContain('BEGIN')
    expect(events).not.toContain('RELEASE_LOCK')
    expect(events.slice(-2)).toEqual(['RESTORE_WAIT', 'RELEASE_CONN'])
  })

  it('o 409 de trava NÃO é reexecutado pelo retry de deadlock do serviço (uma conexão só)', async () => {
    fakeConn({ lockOk: 0 })
    await expect(service.createBrand({ description: 'Ciser' }, { schemaName: 'setes_setes', institutionId: 1 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_BUSY' })
    expect(mockGetConnection).toHaveBeenCalledTimes(1)
  })

  it('erro ENTRE a trava e a transação (beginTransaction falha): solta a trava, devolve a espera, erro original', async () => {
    const { events } = fakeConn({ failBegin: true })
    await expect(create()).rejects.toMatchObject({ code: 'ER_BEGIN' })
    expect(events).toContain('RELEASE_LOCK')
    expect(events.slice(-2)).toEqual(['RESTORE_WAIT', 'RELEASE_CONN'])
  })

  it('erro DENTRO da transação: ROLLBACK antes de soltar a trava', async () => {
    const { events } = fakeConn({ failInsert: 'ER_NO_REFERENCED_ROW_2' })
    await expect(create()).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' })
    expect(events.indexOf('ROLLBACK')).toBeGreaterThan(-1)
    expect(events.indexOf('ROLLBACK')).toBeLessThan(events.indexOf('RELEASE_LOCK'))
    expect(events).not.toContain('COMMIT')
    expect(events[events.length - 1]).toBe('RELEASE_CONN')
  })

  it('COMMIT falha: rollback, trava solta, erro do COMMIT propaga', async () => {
    const { events } = fakeConn({ failCommit: true })
    await expect(create()).rejects.toMatchObject({ code: 'ER_COMMIT' })
    expect(events).toEqual(expect.arrayContaining(['COMMIT', 'ROLLBACK', 'RELEASE_LOCK', 'RESTORE_WAIT']))
    expect(events.indexOf('ROLLBACK')).toBeLessThan(events.indexOf('RELEASE_LOCK'))
  })

  it('COMMIT e ROLLBACK falham: o erro ORIGINAL (commit) propaga e a conexão é DESCARTADA, nunca volta ao pool', async () => {
    const { events } = fakeConn({ failCommit: true, failRollback: true })
    await expect(create()).rejects.toMatchObject({ code: 'ER_COMMIT' })
    expect(events).toContain('DESTROY_CONN')
    expect(events).not.toContain('RELEASE_CONN')
  })

  it('RELEASE_LOCK falha depois do commit: o item criado é devolvido, mas a conexão (talvez ainda dona da trava) é DESCARTADA', async () => {
    const { events } = fakeConn({ failRelease: true })
    await expect(create()).resolves.toEqual({ id: 7, reused: false })
    expect(events).toContain('DESTROY_CONN')
    expect(events).not.toContain('RELEASE_CONN')
  })

  it('a espera curta não pode ser devolvida: conexão DESCARTADA (não volta ao pool com innodb_lock_wait_timeout = 10)', async () => {
    const { events } = fakeConn({ failRestore: true })
    await expect(create()).resolves.toEqual({ id: 7, reused: false })
    expect(events).toContain('DESTROY_CONN')
    expect(events).not.toContain('RELEASE_CONN')
  })
})
