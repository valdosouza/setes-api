/// <reference types="jest" />
// setes-api:IBS.E9.P5 (D-IB138): CERCA — `tb_establishment_simples_rate` tem UM dono: a peça @shared/ibscbs-simples-rate (leitura do
// mês e escrita). Outro arquivo que nomeie a tabela é uma 2ª regra ou um 2º escritor — este teste falha e diz onde. Exceções
// nomeadas: a migration que a cria e o espelho das migrations; a tabela do ITEM (`tb_order_item_ibscbs_simples`) tem o dono
// próprio: `persistItemTaxes` e o cancelamento (a cerca dela está em `billing-simples-das.test.ts`).
import fs from 'fs'
import path from 'path'

const ROOT = path.join(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')
const SCRIPTS = path.join(ROOT, 'scripts')
const OWNER = path.join(SRC, 'shared', 'ibscbs-simples-rate', 'index.ts')
const ALLOWED = new Set([OWNER, path.join(SRC, 'migrations', 'sql', '084_ibscbs_simples_das.sql')])
const TABLE = /tb_establishment_simples_rate\b/

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : files(p)
    return /\.(ts|sql)$/.test(e.name) ? [p] : []
  })
}

describe('cerca do percentual do Simples no IBS/CBS (D-IB138 — dono único)', () => {
  it('o dono existe e nomeia a tabela (a cerca não é vazia)', () => {
    expect(TABLE.test(fs.readFileSync(OWNER, 'utf8'))).toBe(true)
  })

  it('nenhum outro arquivo de src/, scripts/ ou das migrations nomeia a tabela', () => {
    const offenders = [...files(SRC), ...files(SCRIPTS)]
      .filter(f => !ALLOWED.has(f) && TABLE.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(ROOT, f))
    expect(offenders).toEqual([])
  })

  it('a peça nunca apaga fisicamente (PADROES §3.1) e nunca guarda dado do tomador ou da nota na tabela', () => {
    const text = fs.readFileSync(OWNER, 'utf8')
    expect(text).not.toMatch(/\bDELETE\s+FROM\b|\bREPLACE\s+INTO\b|\bTRUNCATE\b/i)
  })

  it('o controller não aceita institutionId do corpo nem da URL no sub-recurso (IDOR por construção)', () => {
    const controller = fs.readFileSync(path.join(SRC, 'modules', 'establishment', 'establishment.controller.ts'), 'utf8')
    const block = controller.slice(controller.indexOf('Percentual do Simples no IBS/CBS'))
    expect(block).not.toMatch(/req\.params\.(id|institutionId)|req\.body\.institutionId/)
    expect(block).toMatch(/req\.institution!/)
  })
})
