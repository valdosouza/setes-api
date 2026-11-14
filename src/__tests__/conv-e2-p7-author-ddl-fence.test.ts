/// <reference types="jest" />
// D-UC19/A-UC9 (setes-api:CONV.E2.P7.T1): o PAPEL de quem definiu a senha vigente mora em `setes_central.tb_user.password_author_role`,
// criado pelo script 76 (repositório sql) e espelhado no canônico 01. Cerca de TEXTO (sem banco): o 76 e o 01 têm a MESMA coluna e as
// MESMAS invariantes, o 76 não preenche nada (A-UC9) e troca os CHECKs a cada execução. A prova ao vivo é
// `scripts/prove-user-password-author.ts` (setes_central descartável).
import fs from 'fs'
import path from 'path'

const SQL_DIR = path.resolve(process.env.SQL_DIR ?? path.join(__dirname, '..', '..', '..', 'sql'))
const read = (file: string) => fs.readFileSync(path.join(SQL_DIR, file), 'utf8').replace(/\r\n/g, '\n')
const CHECKS = ['ck_user_password_author_role', 'ck_user_password_author_has_password']

function canonicalTable(): string {
  const m = /CREATE TABLE IF NOT EXISTS `tb_user` \(([\s\S]*?)\n\) ENGINE/.exec(read('01_setes_central_ddl.sql'))
  expect(m).not.toBeNull()
  return m![1]
}
function checkBodies(sql: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of CHECKS) {
    const m = new RegExp(`\`${name}\`\\s+CHECK\\s*(\\([\\s\\S]*?\\))\\s*(,|\\n\\)|;|$)`).exec(sql)
    expect(m).not.toBeNull()
    out[name] = m![1].replace(/\s+/g, '')
  }
  return out
}

describe('CONV.E2.P7 — script central 76 × canônico 01', () => {
  it('o repositório sql foi achado (cerca que pula não cerca — defina SQL_DIR)', () => {
    expect(fs.existsSync(path.join(SQL_DIR, '76_user_password_author_ddl.sql'))).toBe(true)
  })
  it('a coluna existe nos dois: char(1), anulável, logo depois de password_set_at', () => {
    expect(read('76_user_password_author_ddl.sql')).toMatch(/ADD COLUMN IF NOT EXISTS `password_author_role` char\(1\) NULL DEFAULT NULL[\s\S]*?AFTER `password_set_at`/)
    expect(canonicalTable()).toMatch(/`password_set_at`[^\n]*\n\s*`password_author_role` char\(1\) DEFAULT NULL/)
  })
  it('as duas invariantes têm o MESMO corpo nos dois; o domínio é binário (T, A, O)', () => {
    const a = checkBodies(read('76_user_password_author_ddl.sql')), b = checkBodies(canonicalTable())
    expect(a).toEqual(b)
    expect(a.ck_user_password_author_role).toContain("COLLATEutf8mb4_binIN('T','A','O')")
  })
  it('o 76 não preenche nada (A-UC9) e troca os CHECKs a cada execução (a lição do 75)', () => {
    const s = read('76_user_password_author_ddl.sql')
    expect(s).not.toMatch(/^\s*UPDATE\b/im)
    for (const name of CHECKS) expect(s).toMatch(new RegExp(`DROP CONSTRAINT IF EXISTS \`${name}\``))
  })
})
