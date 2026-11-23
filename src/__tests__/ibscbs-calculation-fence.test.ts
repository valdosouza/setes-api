/**
 * CERCA da peça @shared/ibscbs-calculation (setes-api:IBS.E9.P1, D-IB132): o motor é de FUNÇÕES PURAS — sem banco, sem
 * arquivo, sem rede, sem relógio — e não importa NADA de fora da própria pasta. Assim o mesmo cálculo dá o mesmo
 * resultado em qualquer lugar, os vetores neutros provam tudo e a peça pode ir para o núcleo só movendo arquivo.
 */
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import * as piece from '@shared/ibscbs-calculation'

const DIR = join(__dirname, '..', 'shared', 'ibscbs-calculation')
const entries = readdirSync(DIR, { withFileTypes: true })
const files = entries.filter(e => e.isFile()).map(e => e.name)

/** Tira comentários de bloco e de linha: a cerca olha o código, não a prosa. */
function codeOf(file: string): string {
  return readFileSync(join(DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

function specifiersOf(code: string): string[] {
  const found: string[] = []
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.push(match[1])
  }
  return found
}

describe('cerca @shared/ibscbs-calculation', () => {
  it('a pasta tem SÓ os arquivos da ficha: nenhum outro arquivo (.js, .tsx, .json) e nenhuma subpasta', () => {
    expect(entries.filter(e => !e.isFile()).map(e => e.name)).toEqual([])
    expect([...files].sort()).toEqual(
      ['aliqs.ts', 'arith.ts', 'gross-base.ts', 'index.ts', 'inside.ts', 'item.ts', 'simples.ts', 'totals.ts', 'types.ts'],
    )
  })

  it.each(files)('%s só importa arquivo da própria pasta', file => {
    const local = files.map(f => `./${f.replace(/\.ts$/, '')}`)
    const outside = specifiersOf(codeOf(file)).filter(spec => !local.includes(spec))
    expect(outside).toEqual([])
  })

  it.each(files)('%s não lê relógio, ambiente, aleatório nem faz I/O', file => {
    const code = codeOf(file)
    const forbidden: Array<[string, RegExp]> = [
      ['Date', /\bDate\b/],
      ['process', /\bprocess\b/],
      ['Math.random', /Math\s*\.\s*random/],
      ['fetch', /\bfetch\s*\(/],
      ['require dinâmico', /\brequire\s*\(/],
      ['import dinâmico', /\bimport\s*\(/],
      ['console', /\bconsole\b/],
      ['globalThis', /\bglobalThis\b/],
      ['performance', /\bperformance\b/],
      ['Intl', /\bIntl\b/],
      ['crypto', /\bcrypto\b/],
      ['Function', /\bFunction\b/],
      ['acesso por colchete a Math', /\bMath\s*\[/],
      ['estado mutável de módulo', /^(?:export\s+)?(?:let|var)\s/m],
      ['eval', /\beval\s*\(|\bnew\s+Function\b/],
      ['dinheiro em ponto flutuante', /\bparseFloat\b|\.toFixed\s*\(/],
    ]
    expect(forbidden.filter(([, pattern]) => pattern.test(code)).map(([name]) => name)).toEqual([])
  })

  it('a CBS de 2027 em diante não é constante da peça (RF-CAL-02, grau L)', () => {
    expect(piece.IBSCBS_LEGAL_ALIQS.filter(l => l.tax === 'CBS').map(l => l.validUntil)).toEqual(['2026-12-31'])
    expect(piece.IBSCBS_LEGAL_ALIQS.every(l => l.validUntil !== null && l.validUntil <= '2028-12-31')).toBe(true)
  })

  it('o barrel exporta só o contrato da peça (a aritmética interna fica de fora)', () => {
    expect(Object.keys(piece).sort()).toEqual([
      'IBSCBS_INSIDE_MAX_GROSS_BASE_CENTS', 'IBSCBS_LEGAL_ALIQS', 'IbscbsCalculationError',
      'calcIbscbsEffectiveAliq', 'calcIbscbsGrossBase', 'calcIbscbsInside', 'calcIbscbsItem',
      'calcIbscbsSimplesBase', 'calcIbscbsSimplesItem', 'calcIbscbsSimplesValue',
      'ibscbsAliqAt', 'ibscbsPpmFromPercent', 'ibscbsSimplesTotals', 'ibscbsTaxAssessmentOf', 'ibscbsTotals',
    ])
  })

  it('a cerca enxerga o que promete barrar (as formas que o gate adversarial usou para furar)', () => {
    const hostile = [
      "import { readFileSync } from'fs'", "import'pg'", "export * from'../ibscbs-assessment'", "import x from '@shared/money'",
    ]
    for (const code of hostile) expect(specifiersOf(code).length).toBe(1)
  })

  it('ninguém do produto chama o motor ainda: a ligação no faturamento é do IBS.E9.P3', () => {
    const src = join(__dirname, '..')
    const users: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (full === DIR || entry.name === '__tests__' || entry.name === 'test-setup' || entry.name === 'node_modules') continue
          walk(full)
        } else if (entry.name.endsWith('.ts') && /ibscbs-calculation/.test(readFileSync(full, 'utf8'))) {
          users.push(full)
        }
      }
    }
    walk(src)
    expect(users).toEqual([])
  })
})
