/// <reference types="jest" />
// D-UC19 (setes-api:CONV.E2.P7 — re-gate socrático, LOW): CERCA de texto — todo comando de produção que GRAVA a senha em `tb_user` grava
// também o PAPEL de quem a definiu (`password_author_role`) no MESMO comando; senão uma senha de terceiro herdaria um 'T' antigo e aceitaria
// convite. Exceção NOMEADA: o rehash (`rehashPassword` — a MESMA senha em outro formato, D-EA9/D-EA18), que nunca toca o papel.
import fs from 'fs'
import path from 'path'

const SRC = path.resolve(__dirname, '..')
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'test-setup' ? [] : files(p)
    return p.endsWith('.ts') ? [p] : []
  })
}
/** Cada template literal (`...`) que grava a coluna `password` de `tb_user`. */
function passwordWriters(): Array<{ file: string; sql: string }> {
  const out: Array<{ file: string; sql: string }> = []
  for (const file of files(SRC)) {
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(/`([^`]*?\btb_user\b[^`]*?)`/g)) {
      const sql = m[1].replace(/\s+/g, ' ')
      const updates = /\bUPDATE\b[^;]*\btb_user\b SET\b[^;]*\bpassword = /i.test(sql)
      const inserts = /\bINSERT INTO\b \S*\btb_user\b \([^)]*\bpassword\b/i.test(sql)
      if (updates || inserts) out.push({ file: path.relative(SRC, file), sql })
    }
  }
  return out
}

describe('CONV.E2.P7 — cerca dos escritores da senha (D-UC19)', () => {
  it('a cerca acha os escritores conhecidos (cerca que não acha nada não cerca)', () => {
    const where = passwordWriters().map(w => w.file.split(path.sep).join('/'))
    expect(where).toEqual(expect.arrayContaining([
      'modules/auth/auth.repository.ts', 'modules/users/users.repository.ts', 'shared/user/index.ts',
    ]))
  })
  it('todo comando que grava a senha grava o papel no MESMO comando — menos o rehash (a mesma senha)', () => {
    const offenders = passwordWriters()
      .filter(w => !/password_author_role/.test(w.sql))
      .filter(w => !/SET password = \? WHERE id = \? AND BINARY password = \?/.test(w.sql))   // rehashPassword (exceção nomeada)
    expect(offenders).toEqual([])
  })
})
