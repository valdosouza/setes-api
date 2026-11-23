/// <reference types="jest" />
// CONV.E2.P6.T1 — o GRUPO (duas institutions no MESMO schema — D-GE4, fixture `two-institutions.ts`) com o pool dublado: toda gravação e
// leitura NOVA da onda do convidado que é POR estabelecimento expressa o predicado da institution certa (nunca "o schema inteiro"). A
// barreira ao vivo (matriz × filial pelas rotas reais) está em scripts/prove-conv-e2-fixture.ts (b1–b4).
import { FILIAL, MATRIZ, normalizeSql, paramOf } from '../test-setup/two-institutions'

const calls: Array<{ sql: string; params: unknown[] }> = []
const conn = {
  beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  query: jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql: normalizeSql(sql), params })
    if (/^SELECT deleted/.test(normalizeSql(sql))) return [[]]
    return [{ affectedRows: 1 }]
  }),
}
jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: {
    getConnection: jest.fn(async () => conn),
    query: jest.fn(async (sql: string, params: unknown[] = []) => { calls.push({ sql: normalizeSql(sql), params }); return [{ affectedRows: 1 }] }),
  },
}))

import { inviteToInstitution } from '../shared/user/invite'
import { withdrawInvite } from '../modules/users/users.repository'

beforeEach(() => { calls.length = 0 })

describe('o grupo: matriz e filial no mesmo schema', () => {
  it('o convite da FILIAL lê e grava só o par (filial, usuário) — nunca o da matriz', async () => {
    await inviteToInstitution(77, FILIAL, 'user', 5)
    const touching = calls.filter(c => /tb_institution_has_user/.test(c.sql))
    expect(touching.length).toBeGreaterThan(0)
    for (const c of touching) {
      const inst = paramOf(c.sql, c.params, 'tb_institution_id')
      // o INSERT leva a institution na lista de VALUES (1º parâmetro); o SELECT/UPDATE, no predicado
      expect(inst === undefined ? c.params[0] : inst).toBe(FILIAL)
      expect(c.params).not.toContain(MATRIZ)
    }
  })

  it('a retirada da FILIAL só toca o par (filial, usuário) e só o convite PENDENTE', async () => {
    await withdrawInvite(77, FILIAL)
    const [u] = calls
    expect(u.sql).toMatch(/^UPDATE setes_central\.tb_institution_has_user SET invite_withdrawn_at/)
    expect(paramOf(u.sql, u.params, 'tb_institution_id')).toBe(FILIAL)
    expect(paramOf(u.sql, u.params, 'tb_user_id')).toBe(77)
    expect(u.sql).toContain('invited_at IS NOT NULL AND accepted_at IS NULL AND invite_withdrawn_at IS NULL')
    expect(u.params).not.toContain(MATRIZ)
  })
})
