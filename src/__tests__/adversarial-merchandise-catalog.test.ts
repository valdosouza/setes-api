/// <reference types="jest" />
// GATE ADVERSARIAL — cadastro de produtos (mercadoria), onda 1 (2026-10-18). Achado ADV-06 do relatório.
//
// "Criar na hora" marca/unidade/embalagem (D-PR5/D-PR28) CUNHA id por MAX+1 numa tabela da CENTRAL — compartilhada por TODOS os
// clientes — sem a trava de serialização da regra 7 do PADROES §9 (dedupe `… FOR UPDATE` no índice não-único `description` + MAX
// `FOR UPDATE`: travas de gap compatíveis → deadlock no INSERT) e SEM `withDeadlockRetry` (o comentário do merchandise.service promete o
// retry para "as transações que cunham id"). Provado em CÓPIA descartável da `tb_brand` com o SQL real da peça (roteiro do gate, V12):
// 8 criações concorrentes → 1 ok e 7 × ER_LOCK_DEADLOCK → 409 RESOURCE_BUSY — tanto com descrições diferentes quanto com a mesma
// (o dedupe se sustentou: nenhuma descrição duplicada).
// Semântica fixada: o deadlock dessa transação é reexecutado (como as demais que cunham id) antes de virar 409.
// Estado em 2026-10-18: o teste [BUG] FALHA — demonstra o defeito.
import pool from '../shared/db/connection'
import * as service from '../modules/merchandise/merchandise.service'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const mockGetConnection = (pool as any).getConnection as jest.Mock

function conn(failInsertWith?: string) {
  return {
    query: jest.fn(async (sql: string) => {
      // (correção dos gates) a criação é serializada pela trava NOMEADA do catálogo antes da transação — o mock a concede
      if (/SELECT GET_LOCK\(\?, \?\) AS ok/.test(sql)) return [[{ ok: 1 }]]
      if (/COALESCE\(MAX\(id\), 0\) \+ 1 AS nextId FROM setes_central\.tb_brand/.test(sql)) return [[{ nextId: 12 }]]
      if (failInsertWith && /INSERT INTO setes_central\.tb_brand/.test(sql)) {
        throw Object.assign(new Error('Deadlock found when trying to get lock'), { code: failInsertWith })
      }
      return /^\s*SELECT/i.test(sql) ? [[]] : [{ affectedRows: 1 }]
    }),
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }
}

beforeEach(() => { jest.clearAllMocks(); mockGetConnection.mockReset() })

describe('ADV-06 — criar item do catálogo central', () => {
  it('[BUG] deadlock na 1ª tentativa de criar a marca é reexecutado (withDeadlockRetry) — não vira 409 de cara', async () => {
    const first = conn('ER_LOCK_DEADLOCK')
    const second = conn()
    mockGetConnection.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    await expect(service.createBrand({ description: 'Ciser' }, { schemaName: 'setes_setes', institutionId: 1 }))
      .resolves.toEqual({ id: 12, reused: false })
    expect(first.rollback).toHaveBeenCalled()
    expect(second.commit).toHaveBeenCalled()
  })

  it('erro que NÃO é deadlock propaga na hora (sem reexecutar)', async () => {
    const c = conn('ER_NO_REFERENCED_ROW_2')
    mockGetConnection.mockResolvedValue(c)
    await expect(service.createBrand({ description: 'Ciser' }, { schemaName: 'setes_setes', institutionId: 1 }))
      .rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' })
    expect(mockGetConnection).toHaveBeenCalledTimes(1)
  })
})
