/// <reference types="jest" />
// setes-api:TERM.E4.P1 — D-TM29 (passo do boot que concede as telas ESTRUTURAIS a todo estabelecimento ativo) + D-TM31 (já, com as
// estruturais do `main`) + A-TM11 (só cria a que FALTA; a revogada pela aba do Super — D-PV35 — não volta). Ficha no Vault:
// projetos/setes-api/SUBJECT/ENTIDADE_UNICA/ficha-term-e4-p1-boot-telas-estruturais.md. Banco dublado: o INSERT … ON DUPLICATE KEY
// UPDATE tb_interface_id = tb_interface_id deixa a linha existente intacta e devolve `affectedRows` como o mysql2 COM FOUND_ROWS (o
// padrão do driver — gate do delta, HIGH): toda linha do VALUES conta, nova ou não. O resumo não pode depender disso.
import fs from 'fs'
import path from 'path'

jest.mock('../shared/db/connection', () => ({
  __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() },
}))

import pool from '../shared/db/connection'
import {
  STRUCTURAL_INTERFACE_KEYS, ensureStructuralInterfaces, grantStructuralInterfacesToActive,
} from '../shared/institution-interfaces'
import { grantStructuralInterfaces } from '../modules/institutions/institutions.repository'

const q = (pool as any).query as jest.Mock
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

interface Link { active: string; deleted: string; updatedAt: string }
let catalog: { id: number; k: string }[]
let institutions: { id: number; schemaName: string; active: string; deleted: string }[]
let links: Map<string, Link>          // `${schema}:${institution}:${interface}`
let writes: string[]
let catalogReads: number

function answer(sql: string, params: any[] = []): any {
  const t = norm(sql)
  if (t.startsWith('SELECT id, i18n_key AS k FROM setes_central.tb_interface WHERE i18n_key IN (?)')) {
    catalogReads++
    const keys = params[0] as string[]
    return [catalog.filter(c => keys.includes(c.k)), []]
  }
  const sel = /^SELECT tb_interface_id AS id FROM `([a-z0-9_]+)`\.tb_institution_has_interface WHERE tb_institution_id = \? AND tb_interface_id IN \(\?\)$/.exec(t)
  if (sel) {
    const ids = params[1] as number[]
    return [ids.filter(id => links.has(`${sel[1]}:${params[0]}:${id}`)).map(id => ({ id })), []]
  }
  if (t.startsWith('SELECT id, schema_name AS schemaName FROM setes_central.tb_institution')) {
    expect(t).toContain("WHERE active = 'S' AND deleted = 'N'")
    return [institutions.filter(i => i.active === 'S' && i.deleted === 'N').map(({ id, schemaName }) => ({ id, schemaName })), []]
  }
  const ins = /^INSERT INTO `([a-z0-9_]+)`\.tb_institution_has_interface \(tb_institution_id, tb_interface_id, active, created_at, updated_at\) VALUES (.*) ON DUPLICATE KEY UPDATE (.*)$/.exec(t)
  if (ins) {
    writes.push(t)
    expect(ins[3]).toBe('tb_interface_id = tb_interface_id')     // existente NÃO muda (nem active, nem deleted, nem updated_at)
    for (let i = 0; i < params.length; i += 3) {
      const key = `${ins[1]}:${params[i]}:${params[i + 1]}`
      if (!links.has(key)) links.set(key, { active: params[i + 2], deleted: 'N', updatedAt: 'agora' })
    }
    return [{ affectedRows: params.length / 3 }, []]                // FOUND_ROWS: conta também a existente
  }
  throw new Error(`SQL inesperado: ${t}`)
}

beforeEach(() => {
  catalog = STRUCTURAL_INTERFACE_KEYS.map((k, i) => ({ id: 100 + i, k }))
  institutions = [
    { id: 1, schemaName: 'setes_setes', active: 'S', deleted: 'N' },
    { id: 7, schemaName: 'setes_cliente', active: 'S', deleted: 'N' },
    { id: 8, schemaName: 'setes_cliente', active: 'S', deleted: 'N' },     // filial no mesmo schema (grupo)
    { id: 9, schemaName: 'setes_inativo', active: 'N', deleted: 'N' },
    { id: 10, schemaName: 'setes_apagado', active: 'S', deleted: 'S' },
  ]
  links = new Map()
  writes = []
  catalogReads = 0
  q.mockReset()
  q.mockImplementation(async (sql: string, params?: any[]) => answer(sql, params))
})

const has = (schema: string, inst: number) => catalog.every(c => links.get(`${schema}:${inst}:${c.id}`)?.active === 'S')

describe('D-TM29 — o boot concede as estruturais a todo estabelecimento ATIVO', () => {
  it('as estruturais do main (D-TM31): as 6 de hoje; `terminals` ainda NÃO (entra pela TERM.E3.P2.T3)', () => {
    expect([...STRUCTURAL_INTERFACE_KEYS].sort()).toEqual(
      ['establishment', 'general-configs', 'interface-configs', 'interface-fields', 'modules', 'users'])
  })

  it('cada institution ativa recebe todas — inclusive a filial do mesmo schema; inativa e apagada ficam de fora', async () => {
    const out = await grantStructuralInterfacesToActive()
    expect(has('setes_setes', 1) && has('setes_cliente', 7) && has('setes_cliente', 8)).toBe(true)
    expect([...links.keys()].some(k => k.startsWith('setes_inativo:') || k.startsWith('setes_apagado:'))).toBe(false)
    expect(out).toBe('3 estabelecimento(s) ativo(s), 18 concessão(ões) nova(s) [1:+6 7:+6 8:+6]')
    expect(catalogReads).toBe(1)                                    // o catálogo é lido UMA vez por boot (gate, LOW de escala)
  })

  it('IDEMPOTENTE: a 2ª rodada não cria nada e não muda linha nenhuma', async () => {
    await grantStructuralInterfacesToActive()
    const before = JSON.stringify([...links.entries()])
    const out = await grantStructuralInterfacesToActive()
    expect(out).toBe('3 estabelecimento(s) ativo(s), 0 concessão(ões) nova(s)')
    expect(JSON.stringify([...links.entries()])).toBe(before)
    expect(writes).toHaveLength(3)                                 // só os INSERTs da 1ª rodada: a 2ª não escreve nada
  })

  it('A-TM11: concessão REVOGADA pelo Super (D-PV35) ou apagada NÃO volta; só a que falta nasce', async () => {
    links.set('setes_cliente:7:100', { active: 'N', deleted: 'N', updatedAt: 'revogada pelo Super' })
    links.set('setes_cliente:7:101', { active: 'S', deleted: 'S', updatedAt: 'apagada' })
    const out = await ensureStructuralInterfaces('setes_cliente', 7)
    expect(out).toEqual({ catalog: 6, created: 4, missingKeys: [] })
    expect(links.get('setes_cliente:7:100')).toEqual({ active: 'N', deleted: 'N', updatedAt: 'revogada pelo Super' })
    expect(links.get('setes_cliente:7:101')).toEqual({ active: 'S', deleted: 'S', updatedAt: 'apagada' })
  })

  it('tela nova na constante chega a todo cliente sozinha no próximo boot (o efeito da D-TM29)', async () => {
    catalog = catalog.slice(0, 5)                  // cliente antigo: o catálogo ainda sem a 6ª
    await grantStructuralInterfacesToActive()
    catalog = STRUCTURAL_INTERFACE_KEYS.map((k, i) => ({ id: 100 + i, k }))
    expect(await grantStructuralInterfacesToActive()).toBe('3 estabelecimento(s) ativo(s), 3 concessão(ões) nova(s) [1:+1 7:+1 8:+1]')
  })

  it('estrutural fora do catálogo central = AVISO no resumo (sobe assim mesmo); catálogo vazio não escreve', async () => {
    catalog = catalog.filter(c => c.k !== 'general-configs')
    expect(await grantStructuralInterfacesToActive()).toMatch(/AVISO: fora do catálogo central: general-configs$/)
    catalog = []
    writes = []
    expect(await ensureStructuralInterfaces('setes_setes', 1)).toEqual({ catalog: 0, created: 0, missingKeys: [...STRUCTURAL_INTERFACE_KEYS] })
    expect(writes).toEqual([])
  })

  it('erro de banco PROPAGA (o boot não sobe — como o runner) e schema fora do padrão é recusado antes do SQL', async () => {
    q.mockImplementation(async (sql: string, params?: any[]) => {
      if (/^INSERT/.test(norm(sql))) { const e: any = new Error("Table 'setes_cliente.tb_institution_has_interface' doesn't exist"); e.errno = 1146; throw e }
      return answer(sql, params)
    })
    await expect(grantStructuralInterfacesToActive()).rejects.toThrow(/doesn't exist/)
    await expect(ensureStructuralInterfaces('outro`; DROP', 1)).rejects.toThrow()
  })

  it('o onboarding usa a MESMA regra (grantStructuralInterfaces delega à peça; devolve o tamanho do catálogo)', async () => {
    expect(await grantStructuralInterfaces('setes_cliente', 7)).toBe(6)
    expect(has('setes_cliente', 7)).toBe(true)
  })
})

const code = (f: string) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? (['__tests__', 'test-setup'].includes(e.name) ? [] : tsFiles(path.join(dir, e.name)))
    : /\.ts$/.test(e.name) ? [path.join(dir, e.name)] : [])
}

describe('cerca: o passo está no boot, DEPOIS das migrations e ANTES do listen', () => {
  it('server.ts chama grantStructuralInterfacesToActive na ordem certa (comentários não contam)', () => {
    const src = code(path.join(__dirname, '..', 'server.ts'))
    const at = (s: string) => src.indexOf(s)
    expect(at('await grantStructuralInterfacesToActive()')).toBeGreaterThan(at('await runMigrationsForAllInstitutions()'))
    expect(at('await runMigrationsForAllInstitutions()')).toBeGreaterThan(0)
    expect(at('app.listen(')).toBeGreaterThan(at('await grantStructuralInterfacesToActive()'))
  })
  it('nenhum outro escritor da licença em src/: INSERT/REPLACE/UPDATE/DELETE em tb_institution_has_interface só na peça', () => {
    const peca = path.join(__dirname, '..', 'shared', 'institution-interfaces', 'index.ts')
    const writers = tsFiles(path.join(__dirname, '..'))
      .filter(f => /\b(INSERT\s+(IGNORE\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s[^;]{0,80}tb_institution_has_interface\b/i.test(code(f)))
      .map(f => path.relative(path.join(__dirname, '..'), f).split(path.sep).join('/'))
    expect(writers).toEqual([path.relative(path.join(__dirname, '..'), peca).split(path.sep).join('/')])
  })
})
