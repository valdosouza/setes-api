/// <reference types="jest" />
// NFE.E1.P4.T2 (D-E14, D-NE25, D-PV9): o privilégio TRANSMITIR vale também em `order-returns` — o par existe no catálogo de
// privilégios consumidos (sem a marca "ausente por decisão") E no seed, que é aplicado antes do app. O seed mora no repositório
// `sql` (SQL_DIR); o banco do dev é conferido por `privilege-catalog-live.test.ts`.
import * as fs from 'fs'
import * as path from 'path'
import { CONSUMED_PRIVILEGES } from '../shared/auth/privilege-catalog'
import { PRIVILEGE_TRANSMITIR } from '../shared/auth/privileges'

const SQL_DIR = path.resolve(process.env.SQL_DIR ?? path.join(__dirname, '../../../sql'))
const seed = fs.readFileSync(path.join(SQL_DIR, '79_privilege_transmit_order_returns_seed.sql'), 'utf8').replace(/\r\n/g, '\n')
const sqlOnly = seed.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

describe('seed 79 — TRANSMITIR em order-returns', () => {
  it('o catálogo: o par order-returns × TRANSMITIR existe SEM a marca de ausente; CANCELAR e CONSULTAR seguem ausentes por decisão', () => {
    const of = (privilege: string) => CONSUMED_PRIVILEGES.find(c => c.interface === 'order-returns' && c.privilege === privilege)
    expect(of('TRANSMITIR')).toBeDefined()
    expect(of('TRANSMITIR')!.absentBy).toBeUndefined()
    expect(of('CANCELAR')!.absentBy).toEqual(expect.any(String))
    expect(of('CONSULTAR')!.absentBy).toEqual(expect.any(String))
    // os outros ramos do pedido já tinham o par (seed 59)
    for (const key of ['orders', 'service-orders']) {
      expect(CONSUMED_PRIVILEGES.find(c => c.interface === key && c.privilege === 'TRANSMITIR')!.absentBy).toBeUndefined()
    }
  })

  it('o seed liga EXATAMENTE a interface order-returns ao privilégio 9, ancorado por i18n_key, idempotente, no setes_central', () => {
    expect(PRIVILEGE_TRANSMITIR).toBe(9)
    expect(sqlOnly).toMatch(/^USE `setes_central`;$/m)
    expect((sqlOnly.match(/INSERT /g) ?? []).length).toBe(1)
    expect(sqlOnly).toMatch(/INSERT IGNORE INTO `tb_interface_has_privilege`\s+\(`tb_interface_id`, `tb_privilege_id`, `active`, `created_at`, `updated_at`, `deleted`\)/)
    expect(sqlOnly).toMatch(/JOIN `tb_privilege` p ON p\.`id` = 9 AND p\.`deleted` = 'N'/)
    expect(sqlOnly).toMatch(/WHERE i\.`i18n_key` IN \('order-returns'\) AND i\.`deleted` = 'N';/)
    expect(sqlOnly).not.toMatch(/\b(UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i)        // só acrescenta
    expect(sqlOnly).not.toMatch(/tb_interface_id`?\s*=\s*\d|VALUES\s*\(\s*\d/)      // nunca id fixo de interface
  })

  it('o seed 59 (service-orders e orders) não foi tocado e NENHUM outro arquivo da pasta liga order-returns ao privilégio 9', () => {
    const s59 = fs.readFileSync(path.join(SQL_DIR, '59_privilege_transmit_seed.sql'), 'utf8')
    expect(s59).toMatch(/IN \('service-orders', 'orders'\)/)
    expect(s59).not.toMatch(/order-returns/)
    const others = fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql') && !f.startsWith('79_'))
    expect(others.length).toBeGreaterThan(20)   // a varredura não passa no vazio
    // um arquivo "liga o par" se algum comando (até o `;`) cita order-returns E o privilégio 9 (pelo id ou pelo nome)
    const linking = others.filter(f => fs.readFileSync(path.join(SQL_DIR, f), 'utf8').split(';')
      .some(stmt => /order-returns/.test(stmt) && /tb_interface_has_privilege/.test(stmt)
        && (/`?id`?\s*=\s*9\b/.test(stmt) || /'TRANSMITIR'/.test(stmt) || /\(\s*9\s*[,)]/.test(stmt))))
    expect(linking).toEqual([])
  })
})
