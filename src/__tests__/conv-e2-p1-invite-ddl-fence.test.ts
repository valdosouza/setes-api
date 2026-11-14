/// <reference types="jest" />
// D-UC10/D-UC14/D-UC15 (frente do usuário convidado — setes-api:CONV.E2.P1): o fato "aguardando aceite" mora no VÍNCULO central, em
// quatro colunas criadas pelo script 75 (repositório sql) e espelhadas no canônico 01. Cerca de TEXTO (sem banco): o 75 e o 01 têm as
// MESMAS colunas e as MESMAS invariantes, e o 75 não preenche nada (D-UC14: os vínculos de antes e os do setes-sync ficam "sem
// convite" — nada se inventa). A prova ao vivo é `scripts/prove-institution-user-invite.ts` (setes_central descartável).
import fs from 'fs'
import path from 'path'

const SQL_DIR = path.resolve(process.env.SQL_DIR ?? path.join(__dirname, '..', '..', '..', 'sql'))
const read = (file: string) => fs.readFileSync(path.join(SQL_DIR, file), 'utf8').replace(/\r\n/g, '\n')
const COLUMNS = ['tb_user_inviter_id', 'invited_at', 'accepted_at', 'invite_withdrawn_at']
const CHECKS = ['ck_ihu_inviter_has_invite', 'ck_ihu_pending_inactive', 'ck_ihu_accept_after_invite', 'ck_ihu_withdraw_pending']

/** O CREATE TABLE do vínculo no canônico 01. */
function canonicalTable(): string {
  const sql = read('01_setes_central_ddl.sql')
  const m = /CREATE TABLE IF NOT EXISTS `tb_institution_has_user` \(([\s\S]*?)\n\) ENGINE/.exec(sql)
  expect(m).not.toBeNull()
  return m![1]
}

/** O corpo de cada CHECK, sem espaços — para comparar o 75 com o 01. */
function checkBodies(sql: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of CHECKS) {
    const m = new RegExp(`\`${name}\`\\s+CHECK\\s*(\\([\\s\\S]*?\\))\\s*(,|\\n\\)|;|$)`).exec(sql)
    expect(m).not.toBeNull()
    out[name] = m![1].replace(/\s+/g, '')
  }
  return out
}

describe('CONV.E2.P1 — script central 75 × canônico 01', () => {
  it('o repositório sql foi achado (cerca que pula não cerca — defina SQL_DIR)', () => {
    expect(fs.existsSync(path.join(SQL_DIR, '75_institution_user_invite_ddl.sql'))).toBe(true)
  })

  it('as quatro colunas existem nos dois, anuláveis e sem default', () => {
    const s75 = read('75_institution_user_invite_ddl.sql')
    const s01 = canonicalTable()
    for (const c of COLUMNS) {
      expect(s75).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS \`${c}\` (int\\(11\\)|datetime) NULL DEFAULT NULL`))
      expect(s01).toMatch(new RegExp(`\`${c}\`\\s+(int\\(11\\)|datetime) DEFAULT NULL`))
    }
  })

  it('as mesmas quatro invariantes, com o mesmo corpo, e a mesma fk do convidante', () => {
    const s75 = read('75_institution_user_invite_ddl.sql')
    const s01 = canonicalTable()
    expect(checkBodies(s75)).toEqual(checkBodies(s01))
    expect(s75).toContain('ADD CONSTRAINT `fk_ihu_inviter_to_user` FOREIGN KEY (`tb_user_inviter_id`) REFERENCES `tb_user` (`id`)')
    expect(s01).toMatch(/CONSTRAINT `fk_ihu_inviter_to_user` FOREIGN KEY \(`tb_user_inviter_id`\) REFERENCES `tb_user` \(`id`\)/)
    expect(s01).toContain('KEY `idx_ihu_inviter` (`tb_user_inviter_id`)')
  })

  it('o 75 não preenche nada: nenhum UPDATE/INSERT de dados (D-UC14 — os vínculos de antes ficam sem convite)', () => {
    const body = read('75_institution_user_invite_ddl.sql').replace(/--[^\n]*\n/g, '\n')
    expect(body).not.toMatch(/\bUPDATE\s+`?tb_institution_has_user/i)
    expect(body).not.toMatch(/\bINSERT\s+INTO/i)
  })

  it('convite NUNCA aceito (pendente ou retirado) nunca ativo (o CHECK — gate adversarial do CONV.E2.P6, X3: cobria só o pendente); nunca "inativo e não aceito" (a leitura revista da D-UC10)', () => {
    const s75 = read('75_institution_user_invite_ddl.sql')
    expect(checkBodies(s75).ck_ihu_pending_inactive).toBe(
      "(NOT(`invited_at`ISNOTNULLAND`accepted_at`ISNULLAND`active`='S'))")
  })
})
