/// <reference types="jest" />
// Fase IBS/CBS, D-IB99/D-IB100 (prompt_fase_ibs_cbs.md §14): CERCA — `tb_establishment_ibscbs_assessment` tem UM dono: a peça
// @shared/ibscbs-assessment (leitura na data, regra da recusa e escrita). Outro arquivo que nomeie a tabela é uma 2ª regra ou um 2º
// escritor (ex.: um backfill de '1' — maquete nº 2 do parecer do guardião: duas representações de "não optou") — este teste falha e
// diz onde. Exceções nomeadas: a migration que a cria e a prova em schema DESCARTÁVEL.
import fs from 'fs'
import path from 'path'

const ROOT = path.join(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')
const SCRIPTS = path.join(ROOT, 'scripts')
const OWNER = path.join(SRC, 'shared', 'ibscbs-assessment', 'index.ts')
const ALLOWED = new Set([
  OWNER,
  path.join(SRC, 'migrations', 'sql', '077_establishment_ibscbs_assessment.sql'),
  path.join(SCRIPTS, 'prove-ibscbs-assessment.ts'),
])
const TABLE = /tb_establishment_ibscbs_assessment/

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : files(p)
    return /\.(ts|sql)$/.test(e.name) ? [p] : []
  })
}

describe('cerca da opção de apuração do IBS/CBS (D-IB100 — dono único)', () => {
  it('o dono existe e nomeia a tabela (a cerca não é vazia)', () => {
    expect(TABLE.test(fs.readFileSync(OWNER, 'utf8'))).toBe(true)
  })

  it('nenhum outro arquivo de src/, scripts/ ou das migrations nomeia a tabela', () => {
    const offenders = [...files(SRC), ...files(SCRIPTS)]
      .filter(f => !ALLOWED.has(f) && TABLE.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(ROOT, f))
    expect(offenders).toEqual([])
  })

  it('a peça nunca apaga fisicamente (PADROES §3.1) e nunca guarda o "suportado" no banco', () => {
    const text = fs.readFileSync(OWNER, 'utf8')
    expect(text).not.toMatch(/\bDELETE\s+FROM\b|\bREPLACE\s+INTO\b|\bTRUNCATE\b/i)
    expect(text).not.toMatch(/\bsupported\b\s*=\s*'[SN]'|\bsupported\s+CHAR/i)
  })
})
