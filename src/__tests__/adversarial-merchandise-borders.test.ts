/// <reference types="jest" />
// GATE ADVERSARIAL — cadastro de produtos (mercadoria), onda 1 (2026-10-18). Achados ADV-03/ADV-04/ADV-05 do relatório.
//
// REGRA da casa ("o que valida é o que grava" — setes-api/02-VALIDACAO.md; "conferir o valor DEPOIS de normalizado" — HIGH da Pesquisa
// Avançada): o DTO tem de recusar o que a coluna não guarda como veio. O servidor do dev/produção roda SEM modo estrito
// (`@@sql_mode` = IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION — nem a conexão do pool o liga): valor fora da faixa
// do DECIMAL é GRAMPEADO em silêncio e casa decimal a mais é arredondada. Provado em schema descartável (roteiro do gate):
//   · V1: priceTag 12345678901.25 → `tb_price.price_tag` DECIMAL(13,6) gravou 9999999.999999 e o POST respondeu 201.
//   · V2: fator 0.0000004 (passa no `.positive()`) → DECIMAL(14,6) arredonda para 0 → CHECK `ck_mtu_factor` → 500.
//   · V3: fator 12.0000001 vira 12.000000 (o JS achou dois fatores diferentes; o banco, um só).
//   · V8: GTIN 7891234567895 num produto e 07891234567895 (o MESMO GTIN-13 no formato de 14 dígitos da GS1) noutro → ambos aceitos;
//         nem a conferência da aplicação nem o UNIQUE da 071 normalizam a forma.
// Estado em 2026-10-18: os testes [BUG] FALHAM — demonstram o defeito.
import pool from '../shared/db/connection'
import { merchandiseDto, tradeUnitsDto } from '../modules/merchandise/merchandise.dto'
import * as repo from '../modules/merchandise/merchandise.repository'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const mockGetConnection = (pool as any).getConnection as jest.Mock

const minimal = (over: Record<string, unknown> = {}) => ({
  description: 'Parafuso', categoryId: 3, brandId: 1, baseUnit: { measureId: 1 }, ...over,
})
const levels = (factor: number) => ({ levels: [{ level: 1, measureId: 1, factor: 1 }, { measureId: 2, factor }] })

beforeEach(() => jest.clearAllMocks())

describe('ADV-03 — fator: o DTO recusa o que o DECIMAL(14,6) não guarda como veio', () => {
  it('[BUG] fator que arredonda para ZERO (0.0000004) é 400 no DTO — hoje passa e estoura o CHECK no banco (500)', () => {
    expect(tradeUnitsDto.safeParse(levels(0.0000004)).success).toBe(false)
  })

  it('[BUG] fator com mais de 6 casas (12.0000001) é 400 — senão o JS e o banco discordam sobre "mesmo fator" (D-PR31)', () => {
    expect(tradeUnitsDto.safeParse(levels(12.0000001)).success).toBe(false)
  })

  it('fator com até 6 casas e dentro da faixa segue aceito (GLP 13 kg, fração 0.125, teto 99999999)', () => {
    expect(tradeUnitsDto.safeParse(levels(13)).success).toBe(true)
    expect(tradeUnitsDto.safeParse(levels(0.125)).success).toBe(true)
    expect(tradeUnitsDto.safeParse(levels(0.000001)).success).toBe(true)
    expect(tradeUnitsDto.safeParse(levels(99999999)).success).toBe(true)
    expect(tradeUnitsDto.safeParse(levels(100000000)).success).toBe(false)
  })
})

describe('ADV-04 — preço: o DTO recusa o que o DECIMAL(13,6) grampearia em silêncio', () => {
  it('[BUG] priceTag acima de 9999999.999999 é 400 — hoje o POST responde 201 e grava 9999999.999999', () => {
    const r = merchandiseDto.safeParse(minimal({ prices: [{ priceListId: 1, priceTag: 12345678901.25 }] }))
    expect(r.success).toBe(false)
  })

  it('priceTag dentro da faixa e null (remover da tabela) seguem aceitos', () => {
    expect(merchandiseDto.safeParse(minimal({ prices: [{ priceListId: 1, priceTag: 9999999.99 }] })).success).toBe(true)
    expect(merchandiseDto.safeParse(minimal({ prices: [{ priceListId: 1, priceTag: null }] })).success).toBe(true)
  })
})

describe('ADV-05 — GTIN: unicidade (D-PR19) pela identidade GS1, não pela grafia', () => {
  it('[BUG] produto 10 tem 7891234567895; cadastrar 07891234567895 (mesmo GTIN, 14 dígitos) → 409 GTIN_TAKEN com o id 10', async () => {
    const STORED = '7891234567895'
    const conn: any = {
      // o "banco" compara como o MariaDB: literal — ou pela forma canônica de 14 dígitos se o SQL normalizar (LPAD)
      query: jest.fn(async (sql: string, params: any[] = []) => {
        if (/setes_central\.tb_institution WHERE id = \? FOR UPDATE/.test(sql)) return [[{ id: 1 }]]
        if (/MAX\(id\), 0\) \+ 1 AS nextId/.test(sql)) return [[{ nextId: 11 }]]
        if (/FROM `setes_setes`\.tb_category/.test(sql) || /tb_institution_has_(brand|measure|package) l/.test(sql)) return [[{ 1: 1 }]]
        if (/FROM `setes_setes`\.tb_merchandise_trade_unit\s+WHERE tb_institution_id = \? AND/.test(sql)) {
          const literal = params.includes(STORED)
          // (correção dos gates) a forma canônica vem do banco: `live_gtin` = LPAD(gtin, 14, '0') na 071 (provado em schema descartável)
          const canonical = (/LPAD\(\s*`?gtin`?\s*,\s*14\s*,\s*'0'\s*\)/i.test(sql) || /live_gtin = \?/.test(sql))
            && params.includes(STORED.padStart(14, '0'))
          return literal || canonical ? [[{ id: 10 }]] : [[]]
        }
        return /^\s*SELECT/i.test(sql) ? [[]] : [{ affectedRows: 1 }]
      }),
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    }
    mockGetConnection.mockResolvedValue(conn)
    await expect(repo.insertMerchandise(merchandiseDto.parse(minimal({ baseUnit: { measureId: 1, gtin: '07891234567895' } })),
      'setes_setes', 1)).rejects.toMatchObject({ statusCode: 409, code: 'GTIN_TAKEN', fields: [{ field: 'baseUnit.gtin' }, { message: '10' }] })
  })
})
