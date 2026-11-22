/// <reference types="jest" />
// Cercas de CONTRATO do fato `source_kind` (D-PR47 — gate adversarial da Rodada 7, ADV-R7-01/ADV-R7-02):
//  1. o POST /api/institutions exige `sourceKind` (sem default — fato declarado): o payload que o app PUBLICADO manda hoje
//     (`ObjectInstitution.toJson(creating: true)`, sem o campo) é recusado com 400 em `fields[sourceKind]` — este teste DOCUMENTA a
//     condição da janela (o form de Institutions do app ganha o seletor W/L/P ANTES do merge — Q-PR62); com o campo, passa;
//  2. o seed canônico da Setes (`sql/02`) carrega TODA coluna NOT NULL sem DEFAULT que o DDL canônico (`sql/01`) declara em
//     tb_institution — uma instalação limpa não pode quebrar no INSERT da própria Setes (vetor "seed × DDL" da skill testar-adversarial).
import fs from 'fs'
import path from 'path'
import { institutionCreateDto, institutionUpdateDto } from '../modules/institutions/institutions.dto'
import { zodToFields } from '../shared/http/controller-utils'

// o payload do app publicado (apps/web/lib/app/modules/institutions/domain/entity/object_institution.dart — toJson(creating: true))
const appPayload = {
  entity: { nameCompany: 'CLIENTE NOVO LTDA', nickTrade: 'Cliente Novo' },
  personType: 'J',
  company: { cnpj: '11222333000181' },
  addresses: [], phones: [], socialMedia: [],
  schemaName: 'setes_cliente_novo',
  admin: { nameCompany: 'Dono', nickTrade: 'Dono', email: 'dono@cliente.com.br', password: 'segredo' },
}

describe('D-PR47 — contrato do POST /api/institutions com o app', () => {
  it('sem sourceKind (o app de hoje) = 400 em fields[sourceKind] — nunca default silencioso; com W/D passa; L e P (fora desde a D-OI10) = 400', () => {
    const r = institutionCreateDto.safeParse(appPayload)
    expect(r.success).toBe(false)
    if (!r.success) expect(zodToFields(r.error).map(f => f.field)).toEqual(['sourceKind'])
    for (const k of ['W', 'D']) expect(institutionCreateDto.safeParse({ ...appPayload, sourceKind: k }).success).toBe(true)
    for (const k of ['L', 'P', 'd']) {
      const bad = institutionCreateDto.safeParse({ ...appPayload, sourceKind: k })
      expect([k, bad.success]).toEqual([k, false])
      if (!bad.success) expect(zodToFields(bad.error).map(f => f.field)).toEqual(['sourceKind'])
    }
    expect(institutionCreateDto.safeParse({ ...appPayload, sourceKind: 'w' }).success).toBe(false)
  })

  it('o PUT do app (sem sourceKind) segue aceito — o campo é só conferência na edição', () => {
    const { schemaName: _s, admin: _a, ...upd } = appPayload
    expect(institutionUpdateDto.safeParse(upd).success).toBe(true)
  })
})

const SQL_DIR = path.join(__dirname, '..', '..', '..', 'sql')
const hasSqlRepo = fs.existsSync(path.join(SQL_DIR, '01_setes_central_ddl.sql')) && fs.existsSync(path.join(SQL_DIR, '02_setes_central_seed.sql'))

;(hasSqlRepo ? describe : describe.skip)('sql/01 × sql/02 — o seed da Setes carrega toda coluna NOT NULL sem DEFAULT de tb_institution', () => {
  it('toda coluna NOT NULL sem DEFAULT do CREATE de tb_institution aparece no INSERT da Setes (source_kind = D: o ERP Desktop é o dono do catálogo da Setes — D-OI10; o espelho do repo sql é refeito na janela PROD.E7.P2)', () => {
    const ddl = fs.readFileSync(path.join(SQL_DIR, '01_setes_central_ddl.sql'), 'utf8')
    const seed = fs.readFileSync(path.join(SQL_DIR, '02_setes_central_seed.sql'), 'utf8')
    const start = ddl.indexOf('CREATE TABLE IF NOT EXISTS `tb_institution` (')
    expect(start).toBeGreaterThan(-1)
    const table = ddl.slice(start, ddl.indexOf(') ENGINE', start))
    const required = [...table.matchAll(/^\s*`(\w+)`\s+\S+(?:\(\d+\))?\s+NOT NULL(?!\s+DEFAULT)/gm)].map(m => m[1]).filter(c => c !== 'id')
    expect(required).toEqual(expect.arrayContaining(['schema_name', 'source_kind']))
    const insert = /INSERT INTO `tb_institution` \(([^)]*)\)\s*VALUES \(([^)]*)\)/.exec(seed)
    expect(insert).not.toBeNull()
    const cols = insert![1].replace(/`/g, '').split(',').map(s => s.trim())
    for (const c of required) expect(cols).toContain(c)
    const values = insert![2].split(',').map(s => s.trim())
    expect(values[cols.indexOf('source_kind')]).toBe("'D'")
    expect(table).toMatch(/CONSTRAINT `ck_institution_source_kind` CHECK \(`source_kind` COLLATE utf8mb4_bin IN \('W', 'D'\)\)/)
    expect(table).toMatch(/CONSTRAINT `ck_institution_transition_ended` CHECK/)
  })
})
