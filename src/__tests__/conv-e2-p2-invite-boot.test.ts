/// <reference types="jest" />
// CONV.E2.P2 — passo 1 da ficha: o boot confere as quatro colunas e os quatro CHECKs do script central 75 (D-UC14/D-UC15, A-UC8).
jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn() } }))

import { assertInviteSchema, INVITE_CHECKS, INVITE_COLUMNS, pendingInviteSql } from '../shared/user/invite'

function fakePool(opts: { columns?: boolean; checks?: readonly string[]; oldPending?: boolean }) {
  return {
    query: jest.fn(async (sql: string) => {
      if (/LIMIT 0/.test(sql)) {
        if (opts.columns === false) throw Object.assign(new Error("Unknown column 'invited_at'"), { errno: 1054, code: 'ER_BAD_FIELD_ERROR' })
        return [[]]
      }
      if (/information_schema\.CHECK_CONSTRAINTS/.test(sql)) {
        return [(opts.checks ?? INVITE_CHECKS).map(name => ({
          name, clause: name === 'ck_ihu_pending_inactive' ? (opts.oldPending
            ? "not(`invited_at` is not null and `accepted_at` is null and `invite_withdrawn_at` is null and `active` = 'S')"
            : "not(`invited_at` is not null and `accepted_at` is null and `active` = 'S')") : 'x',
        }))]
      }
      throw new Error(`SQL inesperado: ${sql}`)
    }),
  } as any
}

describe('assertInviteSchema (boot, script 75)', () => {
  it('sobe com as quatro colunas e os quatro CHECKs', async () => {
    const q = fakePool({})
    await expect(assertInviteSchema(q)).resolves.toBe('ok (4 colunas, 4 CHECKs)')
    expect(q.query.mock.calls[0][0]).toContain(INVITE_COLUMNS.join(', '))
  })

  it('NÃO sobe sem as colunas — a mensagem nomeia o script 75', async () => {
    await expect(assertInviteSchema(fakePool({ columns: false }))).rejects.toThrow(/sql\/75_institution_user_invite_ddl\.sql/)
  })

  it.each(INVITE_CHECKS.map(c => [c]))('NÃO sobe sem o CHECK %s — a mensagem o nomeia', async (missing) => {
    const q = fakePool({ checks: INVITE_CHECKS.filter(c => c !== missing) })
    await expect(assertInviteSchema(q)).rejects.toThrow(new RegExp(missing))
  })

  it('NÃO sobe com a versão ANTIGA do CHECK do pendente (só o pendente ativo) — re-gate adversarial do P6, D3a', async () => {
    await expect(assertInviteSchema(fakePool({ oldPending: true }))).rejects.toThrow(/versão ANTIGA do CHECK ck_ihu_pending_inactive/)
  })

  it('outro erro do banco passa adiante sem disfarce', async () => {
    const q = { query: jest.fn().mockRejectedValue(Object.assign(new Error('conexão caiu'), { code: 'ECONNRESET' })) } as any
    await expect(assertInviteSchema(q)).rejects.toThrow('conexão caiu')
  })

  it('o "aguardando aceite" em SQL é o das três colunas (D-UC14/D-UC15)', () => {
    expect(pendingInviteSql('ihu.')).toBe(
      '(ihu.invited_at IS NOT NULL AND ihu.accepted_at IS NULL AND ihu.invite_withdrawn_at IS NULL)')
  })
})
