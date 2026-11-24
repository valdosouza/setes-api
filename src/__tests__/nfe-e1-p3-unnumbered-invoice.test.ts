/// <reference types="jest" />
// NFE.E1.P3 (D-NE257, PM-26) — cerca: o ERP web NÃO cunha o número do modelo 55. O número nasce na transmissão, na API fiscal;
// aqui a nota é faturada sem número fiscal. Esta cerca impede que o MAX+1 do 55 volte por outro caminho.
import * as fs from 'fs'
import * as path from 'path'

const SRC = path.join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'test-setup' ? [] : sourceFiles(full)
    return e.name.endsWith('.ts') ? [full] : []
  })
}
/** Código sem comentários (de linha e de bloco) — a cerca olha o que executa, não o que explica. */
function code(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const INVOICE = path.join(SRC, 'shared', 'invoice', 'invoice.ts')

describe('NFE.E1.P3 — o 55 não é numerado no faturamento', () => {
  const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, '/')

  it('o identificador `nextInvoiceNumber` só existe dentro da peça da nota (nem chamada, nem import com apelido)', () => {
    const users = sourceFiles(SRC).filter(f => /\bnextInvoiceNumber\b/.test(code(f)))
    expect(users.map(rel)).toEqual(['shared/invoice/invoice.ts'])
  })

  it('`number_seq` fora da peça só aparece como critério de BUSCA das duas listas — ninguém cunha por outro SQL', () => {
    const lines = sourceFiles(SRC).filter(f => f !== INVOICE)
      .flatMap(f => code(f).split('\n').filter(l => /number_seq/i.test(l)).map(l => `${rel(f)}: ${l.trim()}`))
    expect(lines).toHaveLength(2)
    expect(lines.filter(l => /^modules\/(orders|service-orders)\/[a-z-]+\.repository\.ts: .*expr: 'inv\.number_seq'/.test(l))).toHaveLength(2)
  })

  it('nenhum SQL fora da peça calcula número de nota por MAX/CAST sobre `number` de tb_invoice', () => {
    const suspects = sourceFiles(SRC).filter(f => f !== INVOICE)
      .filter(f => /MAX\(\s*CAST\(\s*(\w+\.)?`?number`?[\s\S]{0,200}tb_invoice\b/i.test(code(f)))
    expect(suspects.map(rel)).toEqual([])
  })

  it("na peça, o literal '55' só existe na lista MODELS_NUMBERED_AT_TRANSMISSION e a chamada do MAX+1 fica atrás da guarda", () => {
    const src = code(INVOICE)
    const literals = src.split('\n').filter(l => /['"]55['"]/.test(l))
    expect(literals).toHaveLength(1)
    expect(literals[0]).toMatch(/MODELS_NUMBERED_AT_TRANSMISSION[^=]*=\s*Object\.freeze\(\['55'\]\)/)
    // uma única chamada, e ela é o ramo "senão" da guarda
    expect(src.match(/await nextInvoiceNumber\(/g)).toHaveLength(1)
    expect(src).toMatch(/isNumberedAtTransmission\(input\.model\)\s*\?\s*null\s*:\s*await nextInvoiceNumber\(/)
  })

  it('a peça da nota e o módulo de faturamento não leem faixa inutilizada, ambiente, habilitação nem último número (D-NE257, D-NE249)', () => {
    const billing = sourceFiles(path.join(SRC, 'modules', 'billing'))
    expect(billing.length).toBeGreaterThan(3)
    for (const f of [INVOICE, ...billing]) {
      expect(`${rel(f)}: ${/number_void|readWithdrawnRanges|readIssuerView|establishment_issuer|last_number/i.test(code(f))}`)
        .toBe(`${rel(f)}: false`)
    }
    expect(code(INVOICE)).not.toMatch(/environment/i)
  })
})
