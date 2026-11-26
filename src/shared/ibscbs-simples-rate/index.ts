import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { ibscbsPpmFromPercent } from '@shared/ibscbs-calculation'

/**
 * PEÇA @shared/ibscbs-simples-rate (setes-api:IBS.E9.P5; D-IB138, D-IB140): o PERCENTUAL EFETIVO do Simples no IBS/CBS
 * (`pIBSSN` e `pCBSSN` da NF-e de 2027, RF-SN-13) de cada estabelecimento em cada MÊS (`tb_establishment_simples_rate`,
 * migration 084). Dona ÚNICA da tabela — leitura do mês e escrita das linhas; ninguém mais toca a tabela (cerca
 * `ibscbs-simples-rate-fence.test.ts`).
 *
 * - **Fato gerador próprio** (parecer do guardião): a apuração mensal do DAS; o número é DADO DECLARADO pelo estabelecimento (o
 *   sistema não calcula o percentual — RF-SN-02/29: a origem e a granularidade não têm fonte oficial). Sem anexo por ora (D-IB138).
 * - **Sem linha = sem percentual**: não existe "padrão" nem "último mês" a aplicar (D-IB140). Quem lê trata `null` como recusa.
 * - **Cadastro livre no tempo** (A-IB138g): qualquer mês pode ser criado, editado ou removido, inclusive passado — a nota já emitida
 *   não muda, porque o item congela o percentual usado (`tb_order_item_ibscbs_simples`).
 * - O pool devolve DECIMAL como número (`decimalNumbers`): a leitura pede o texto exato do banco (`CAST … AS CHAR`) e só assim
 *   passa para milionésimos (`ibscbsPpmFromPercent` só aceita texto) — nunca por ponto flutuante.
 */

export type Queryable = { query: (sql: string, params?: unknown[]) => Promise<any> }

const TABLE = 'tb_establishment_simples_rate'
const tableOf = (schemaName: string) => `${schemaName}.${TABLE}`

/** O mês de apuração 'AAAA-MM' (mês 01 a 12). */
export const SIMPLES_COMPETENCE_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/
export const isSimplesCompetence = (value: unknown): value is string =>
  typeof value === 'string' && SIMPLES_COMPETENCE_PATTERN.test(value)

/** O mês de uma data ISO 'AAAA-MM-DD' (a data de emissão da nota — A-IB138a). */
export function simplesCompetenceOf(isoDate: string): string {
  if (!/^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(isoDate)) {
    throw new Error(`Percentual do Simples: data inválida (${JSON.stringify(isoDate)}) — o produtor da nota não mandou a data de emissão`)
  }
  return isoDate.slice(0, 7)
}

export interface SimplesRate {
  competence: string
  /** Texto exato do banco, 4 casas ('0.1000'). */
  ibsRate:    string
  cbsRate:    string
  /** Milionésimos da fração (0 a 1.000.000) — a unidade do motor `@shared/ibscbs-calculation`. */
  ibsPpm:     number
  cbsPpm:     number
}

export interface SimplesRateInput {
  competence: string
  /** Percentual (0 a 100, até 4 casas). Texto ou número: o número passa por texto, nunca por conta. */
  ibsRate:    string | number
  cbsRate:    string | number
}

const invalid = (field: string, message: string) =>
  new HttpError(400, 'Percentual do Simples (IBS/CBS) inválido', [{ field, message }], ErrorCodes.IBSCBS_SIMPLES_RATE_INVALID)

/** O percentual como texto de até 4 casas (sem notação científica); fora de 0 a 100 ou com mais casas = 400. */
function percentText(field: string, value: string | number): string {
  const text = typeof value === 'number' ? (Number.isFinite(value) ? value.toFixed(10).replace(/0+$/, '').replace(/\.$/, '') : '') : String(value).trim()
  // número que o arredondamento a 10 casas mudaria de verdade (1e-11 virava 0%) é recusado; a cauda binária (0.1 + 0.2) não
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(Number(text) - value) > 1e-12) throw invalid(field, 'De 0 a 100, com até 4 casas decimais')
  if (!/^\d{1,3}(?:[.,]\d{1,4})?$/.test(text)) throw invalid(field, 'De 0 a 100, com até 4 casas decimais')
  try {
    ibscbsPpmFromPercent(text)   // 100,0001 e acima: o motor recusa; aqui vira 400 com o campo
  } catch {
    throw invalid(field, 'De 0 a 100, com até 4 casas decimais')
  }
  return text.replace(',', '.')
}

function assertInput(input: SimplesRateInput): { competence: string; ibs: string; cbs: string } {
  if (!isSimplesCompetence(input.competence)) throw invalid('competence', 'Mês no formato AAAA-MM')
  return { competence: input.competence, ibs: percentText('ibsRate', input.ibsRate), cbs: percentText('cbsRate', input.cbsRate) }
}

const toRate = (row: any): SimplesRate => ({
  competence: String(row.competence),
  ibsRate:    String(row.ibsRate),
  cbsRate:    String(row.cbsRate),
  ibsPpm:     ibscbsPpmFromPercent(String(row.ibsRate)),
  cbsPpm:     ibscbsPpmFromPercent(String(row.cbsRate)),
})

const SELECT_RATE = `SELECT competence, CAST(ibs_rate AS CHAR) AS ibsRate, CAST(cbs_rate AS CHAR) AS cbsRate`

/** O percentual do mês: a linha VIVA da chave. `null` = não cadastrado (o faturamento recusa — D-IB140). Sem trava. */
export async function simplesRateAt(
  q: Queryable, schemaName: string, institutionId: number, competence: string,
): Promise<SimplesRate | null> {
  if (!isSimplesCompetence(competence)) throw new Error(`Percentual do Simples: competência inválida (${JSON.stringify(competence)})`)
  const [rows] = await q.query(
    `${SELECT_RATE} FROM ?? WHERE tb_institution_id = ? AND competence = ? AND deleted = 'N'`,
    [tableOf(schemaName), institutionId, competence])
  const row = (rows as any[])[0]
  return row ? toRate(row) : null
}

/** Todos os percentuais vivos do estabelecimento, do mês mais novo para o mais antigo. */
export async function listSimplesRates(schemaName: string, institutionId: number): Promise<SimplesRate[]> {
  const [rows] = await pool.query(
    `${SELECT_RATE} FROM ?? WHERE tb_institution_id = ? AND deleted = 'N' ORDER BY competence DESC`,
    [tableOf(schemaName), institutionId])
  return (rows as any[]).map(toRate)
}

async function inTransaction<T>(label: string, institutionId: number, fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  return withDeadlockRetry(label, { institutionId }, 3, async () => {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const out = await fn(conn)
      await conn.commit()
      return out
    } catch (err) {
      try { await conn.rollback() } catch { /* a conexão pode ter caído — o release resolve */ }
      throw err
    } finally {
      conn.release()
    }
  })
}

const duplicateOf = (competence: string) => new HttpError(409,
  `Já existe percentual do Simples para ${competence} — altere o existente`,
  [{ field: 'competence', message: 'Mês já cadastrado' }], ErrorCodes.IBSCBS_SIMPLES_RATE_DUPLICATE)

const notFoundOf = (competence: string) => new HttpError(404,
  `Percentual do Simples de ${competence} não encontrado`, undefined, ErrorCodes.IBSCBS_SIMPLES_RATE_NOT_FOUND)

/**
 * Cadastra o percentual de um mês. Chave já viva = 409; chave morta = REVIVE da MESMA linha sem herdar nada (PADROES §3.1 — todas as
 * colunas regravadas). O INSERT é a trava; a chave já existir manda para a leitura travada da linha, que decide.
 */
export async function createSimplesRate(
  schemaName: string, institutionId: number, userId: number, input: SimplesRateInput,
): Promise<void> {
  const { competence, ibs, cbs } = assertInput(input)
  await inTransaction('cadastro do percentual do Simples', institutionId, async conn => {
    try {
      await conn.query(
        `INSERT INTO ?? (tb_institution_id, competence, ibs_rate, cbs_rate, tb_user_id, created_at, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, NOW(), NOW(), 'N')`,
        [tableOf(schemaName), institutionId, competence, ibs, cbs, userId])
      return
    } catch (err: any) {
      if (err?.code !== 'ER_DUP_ENTRY') throw err
    }
    const [rows] = await conn.query(
      `SELECT deleted FROM ?? WHERE tb_institution_id = ? AND competence = ? FOR UPDATE`,
      [tableOf(schemaName), institutionId, competence])
    const line = (rows as any[])[0]
    if (!line) throw new Error(`Percentual do Simples ${institutionId}/${competence}: chave duplicada sem linha — dado inconsistente`)
    if (line.deleted === 'N') throw duplicateOf(competence)
    await conn.query(
      `UPDATE ?? SET ibs_rate = ?, cbs_rate = ?, tb_user_id = ?, created_at = NOW(), updated_at = NOW(), deleted = 'N'
        WHERE tb_institution_id = ? AND competence = ? AND deleted = 'S'`,
      [tableOf(schemaName), ibs, cbs, userId, institutionId, competence])
  })
}

/** Troca os percentuais de um mês já cadastrado (o mês é a identidade). */
export async function changeSimplesRate(
  schemaName: string, institutionId: number, userId: number, input: SimplesRateInput,
): Promise<void> {
  const { competence, ibs, cbs } = assertInput(input)
  await inTransaction('alteração do percentual do Simples', institutionId, async conn => {
    const [res] = await conn.query(
      `UPDATE ?? SET ibs_rate = ?, cbs_rate = ?, tb_user_id = ?, updated_at = NOW()
        WHERE tb_institution_id = ? AND competence = ? AND deleted = 'N'`,
      [tableOf(schemaName), ibs, cbs, userId, institutionId, competence])
    if (!(res as any).affectedRows) throw notFoundOf(competence)
  })
}

/** Exclui (SOFT — PADROES §3.1) o percentual de um mês. A nota já emitida não muda: o item guarda o percentual que usou. */
export async function removeSimplesRate(
  schemaName: string, institutionId: number, userId: number, competence: string,
): Promise<void> {
  if (!isSimplesCompetence(competence)) throw invalid('competence', 'Mês no formato AAAA-MM')
  await inTransaction('exclusão do percentual do Simples', institutionId, async conn => {
    const [res] = await conn.query(
      `UPDATE ?? SET deleted = 'S', tb_user_id = ?, updated_at = NOW()
        WHERE tb_institution_id = ? AND competence = ? AND deleted = 'N'`,
      [tableOf(schemaName), userId, institutionId, competence])
    if (!(res as any).affectedRows) throw notFoundOf(competence)
  })
}

// ---------------------------------------------------------------------------------------------------------------------------
// Boot (PADROES §11 regras 11 e 16): as guardas do banco da migration 084 existem, pelo NOME, em cada schema
// ---------------------------------------------------------------------------------------------------------------------------

/** Os CHECKs que a migration 084 cria, por tabela. */
export const SIMPLES_EXPECTED_CHECKS: ReadonlyArray<readonly [table: string, name: string]> = Object.freeze([
  ['tb_establishment_simples_rate', 'ck_establishment_simples_rate_competence'],
  ['tb_establishment_simples_rate', 'ck_establishment_simples_rate_range'],
  ['tb_entity_tax', 'ck_entity_tax_simples_activity'],
  ['tb_merchandise', 'ck_merchandise_simples_activity'],
  ['tb_order_item_ibscbs_simples', 'ck_order_item_ibscbs_simples_activity'],
  ['tb_order_item_ibscbs_simples', 'ck_order_item_ibscbs_simples_competence'],
])

/** Os CHECKs que faltam num schema (vazio = todos presentes). */
export async function simplesMissingChecks(q: Queryable, schemaName: string): Promise<string[]> {
  const [rows] = await q.query(
    `SELECT TABLE_NAME AS t, CONSTRAINT_NAME AS n FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?`, [schemaName])
  const present = new Set((rows as any[]).map(r => `${r.t}.${r.n}`))
  return SIMPLES_EXPECTED_CHECKS.filter(([t, n]) => !present.has(`${t}.${n}`)).map(([t, n]) => `${t}.${n}`)
}

/**
 * Depois das migrations: em cada schema de cliente vivo, as guardas da 084 (formato do mês, faixa do percentual, atividade 01-04)
 * existem. Faltando, o setes-api NÃO sobe: sem elas, carga ou SQL direto gravaria um percentual ou uma atividade que o código leria
 * como outra.
 */
export async function assertIbscbsSimplesChecks(q: Queryable = pool): Promise<string> {
  const [schemas] = await q.query(
    "SELECT DISTINCT schema_name AS s FROM setes_central.tb_institution WHERE active = 'S' AND deleted = 'N' AND schema_name IS NOT NULL")
  const bad: string[] = []
  for (const { s } of schemas as any[]) {
    const missing = await simplesMissingChecks(q, String(s))
    if (missing.length) bad.push(`${s}: ${missing.join(', ')} ausente(s)`)
  }
  if (bad.length) {
    throw new Error(`D-IB138: guardas do IBS/CBS do Simples ausentes — ${bad.join(' | ')} — confira a migration 084`)
  }
  return `${SIMPLES_EXPECTED_CHECKS.length} CHECK(s) em ${(schemas as any[]).length} schema(s)`
}
