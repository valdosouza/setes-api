/// <reference types="jest" />
// NFE.E1.P2.T3: as configurações do e-mail e do DANFE da NF-e existem na interface de faturamento, com seed, para a nfe-api ler
// (D-NE261, D-NE262, D-NE264). O seed mora no repositório `sql` (SQL_DIR); aqui a cerca do conteúdo dele.
import * as fs from 'fs'
import * as path from 'path'
import { validateConfigContent } from '../shared/interface-config/interface-config.service'

const SQL_DIR = path.resolve(process.env.SQL_DIR ?? path.join(__dirname, '../../../sql'))
const seed = fs.readFileSync(path.join(SQL_DIR, '78_nfe_email_danfe_configs_seed.sql'), 'utf8').replace(/\r\n/g, '\n')

/** Os INSERTs do seed: nome, descrição, kind, options, padrão e scope de cada chave. */
function keysOf(sql: string) {
  const re = /SELECT i\.id, '([^']+)', '([^']*)',\s+'([^']+)', (NULL|'[^']*'), '([^']*)', '([^']+)', NOW\(\), NOW\(\), 'N'\s+FROM `tb_interface` i\s+WHERE i\.i18n_key = '([^']+)'\s+AND NOT EXISTS \(SELECT 1 FROM `tb_interface_has_config` c WHERE c\.tb_interface_id = i\.id AND c\.name = '([^']+)'\)/g
  return [...sql.matchAll(re)].map(m => ({
    name: m[1], description: m[2], kind: m[3], options: m[4] === 'NULL' ? null : m[4].slice(1, -1), default: m[5], scope: m[6],
    interfaceKey: m[7], guardName: m[8],
  }))
}

describe('seed 78 — configurações do e-mail e do DANFE da NF-e na interface billing', () => {
  const keys = keysOf(seed)

  it('semeia EXATAMENTE as três chaves decididas, com kind, padrão e scope', () => {
    expect(keys.map(k => [k.name, k.kind, k.default, k.scope, k.options])).toEqual([
      ['fiscal_email_auto_send', 'Boolean', 'S', 'I', null],              // D-NE261: nasce ligado, como no ERP Desktop
      ['nfe_email_subject', 'String', 'Envio de NF-e Nº {number}', 'I', null],   // D-NE264: só o assunto é configuração
      ['danfe_print_logo', 'Boolean', 'S', 'I', null],                    // D-NE262: o logo já cadastrado
    ])
    expect((seed.match(/INSERT INTO `tb_interface_has_config`/g) ?? []).length).toBe(3)   // nenhum INSERT fora do molde
  })

  it('cada chave é ancorada na interface billing pelo i18n_key e é idempotente (NOT EXISTS pelo próprio nome)', () => {
    for (const k of keys) {
      expect(k.interfaceKey).toBe('billing')
      expect(k.guardName).toBe(k.name)
    }
    expect(seed).toMatch(/^USE `setes_central`;$/m)
    expect(seed).not.toMatch(/tb_interface_id`?\s*=\s*\d|VALUES\s*\(\s*\d/)   // nunca id fixo
  })

  it('o padrão de cada chave cabe no catálogo (100 caracteres) e é aceito pela validação do framework; a descrição cabe em 255', () => {
    for (const k of keys) {
      expect(k.default.length).toBeLessThanOrEqual(100)
      expect(validateConfigContent(k.kind, k.options, k.default)).toBeNull()
      expect(k.description.length).toBeGreaterThan(10)
      expect(k.description.length).toBeLessThanOrEqual(255)
    }
  })

  it('o corpo do e-mail NÃO é configuração no 1º release (D-NE264) e o assunto traz o marcador {number}', () => {
    expect(keys.some(k => /body|corpo/i.test(k.name))).toBe(false)
    expect(keys.find(k => k.name === 'nfe_email_subject')!.default).toContain('{number}')
  })

  it('nenhuma das três chaves já existe em outro seed da pasta (sem colisão de nome)', () => {
    const others = fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql') && !f.startsWith('78_'))
    expect(others.length).toBeGreaterThan(20)   // a varredura não passa no vazio
    for (const f of others) {
      const sql = fs.readFileSync(path.join(SQL_DIR, f), 'utf8')
      for (const k of keys) expect([f, sql.includes(`'${k.name}'`)]).toEqual([f, false])
    }
  })
})
