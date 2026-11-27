/// <reference types="jest" />
// IBS.E9.P4 — cerca de DONO ÚNICO da tabela central de alíquotas: só a peça @shared/ibscbs-rate a lê; só o script 81 e a carga
// manual (fora do repositório) a escrevem. A sonda de boot da peça de classificação só prova que a tabela existe.
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..')

function productFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'test-setup' || entry.name === 'node_modules') continue
      productFiles(full, out)
    } else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('cerca da tabela tb_tax_ibscbs_rate', () => {
  const mentions = productFiles(SRC)
    .filter(f => readFileSync(f, 'utf8').includes('tb_tax_ibscbs_rate'))
    .map(f => f.slice(SRC.length + 1).split('\\').join('/')).sort()

  it('só a peça das alíquotas e a sonda de boot do catálogo citam a tabela', () => {
    expect(mentions).toEqual(['shared/ibscbs-classification/index.ts', 'shared/ibscbs-rate/index.ts'])
  })

  it('nenhum arquivo do produto escreve na tabela (INSERT, UPDATE ou DELETE): a alíquota é da lei, cadastrada à mão no central', () => {
    for (const f of mentions) {
      const text = readFileSync(join(SRC, f), 'utf8')
      expect([f, /(INSERT\s+(IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM)\s+\S*tb_tax_ibscbs_rate/i.test(text)]).toEqual([f, false])
    }
  })
})
