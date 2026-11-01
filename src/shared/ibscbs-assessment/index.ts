import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import { ErrorCodes } from '@shared/errors/error-codes'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { todayFor } from '@shared/time-zone'
import { lastLiveEmissionDate } from '@shared/invoice/emission-date'

/**
 * PEÇA @shared/ibscbs-assessment (fase IBS/CBS, D-IB99/D-IB100 — Infra-IA/prompts/prompt_fase_ibs_cbs.md §14): a OPÇÃO de
 * apuração do IBS/CBS do Simples (`regApIBSCBSSN` da NT 009), fato DATADO de cada estabelecimento
 * (`tb_establishment_ibscbs_assessment`, migration 076). Dona ÚNICA da tabela — leitura na data, regra da recusa e escrita das
 * linhas; ninguém mais toca a tabela (cerca `ibscbs-assessment-fence.test.ts`).
 *
 * - **Fato gerador próprio** (parecer do guardião, D-IB100): opção CGSN 194, semestral e irretratável no semestre — distinta do
 *   enquadramento no Simples (opSimpNac), do sublimite (regApTribSN) e do pTotTribSN, que seguem em `tb_entity_tax` sob a
 *   convenção "sem história" (D-IB66 — limite conhecido) até o 1º fato datado de cada um.
 * - **Conhecimento negativo (nota do Valdo à Q-IB104, 2026-11-01)**: o sistema NÃO controla as regras do governo sobre a opção —
 *   permanência no período, prazo/calendário para optar, exclusão por descumprimento. A opção é DADO DECLARADO pelo estabelecimento;
 *   nunca nasça aqui trava de permanência, calendário de opção ou exclusão automática (a D-IB101 só protege o passado lido por nota).
 * - **Sem linha = 1** (D-IB1: o efeito legal de NÃO optar) — nunca backfill; uma linha '1' explícita só fecha um período 2/3.
 * - **Vida da linha**: sem `valid_until` (a linha seguinte fecha a anterior); inserir com início ≥ hoje do estabelecimento; alterar
 *   e excluir (soft) só linha FUTURA; a vigente e as passadas são imutáveis; 2/3 só a partir de 01/01/2027. O calendário 01/01·01/07
 *   NÃO é travado (MAT/exclusão de ofício têm "data do fato motivador"). **D-IB101**: a fronteira é o MAIOR entre hoje e a última
 *   nota viva do estabelecimento — registrar, alterar ou excluir com início ≤ a data de uma nota já emitida = 409 (o passado já lido
 *   por uma nota nunca muda), conferido DEPOIS da trava e com o relógio de depois da espera (`frontierAfterLock`).
 * - **Suporte é propriedade do CÓDIGO** (nunca coluna): `IBSCBS_ASSESSMENTS_SUPPORTED` cresce quando o cálculo do regime regular
 *   (D-IB11/D-IB12) existir. Até lá o faturamento RECUSA toda nota cuja competência caia na vigência de 2/3 (D-IB99) — a recusa
 *   mora no escritor único da nota (`@shared/invoice.issueInvoice`), para todo modelo e todo produtor.
 */

export type Queryable = { query: (sql: string, params?: unknown[]) => Promise<any> }

/** Domínio da NT 009 (`regApIBSCBSSN`). */
export const IBSCBS_ASSESSMENTS = Object.freeze(['1', '2', '3'] as const)
export type IbscbsAssessment = typeof IBSCBS_ASSESSMENTS[number]

/** D-IB1: quem não registrou opção apura IBS e CBS pelo Simples — o efeito legal de não optar. */
export const IBSCBS_ASSESSMENT_WITHOUT_OPTION: IbscbsAssessment = '1'

/** D-IB99: o que o faturamento sabe tratar HOJE. Cresce com o cálculo do regime regular (D-IB11/D-IB12) — nunca vira coluna/flag. */
export const IBSCBS_ASSESSMENTS_SUPPORTED: ReadonlySet<string> = Object.freeze(new Set<IbscbsAssessment>(['1']))

/** Lei (CGSN 194; obrigação do Simples desde a competência 01/2027 — Ato Conjunto nº 4 § 1º): a opção pelo regular só vale a partir daqui. */
export const IBSCBS_REGULAR_ASSESSMENT_START = '2027-01-01'

/** Rótulo oficial (NT 009 p. 9 — a D-IB99 descreveu a opção 2 ao contrário; vale o texto da NT). */
export const IBSCBS_ASSESSMENT_LABELS: Readonly<Record<IbscbsAssessment, string>> = Object.freeze({
  '1': 'IBS e CBS apurados pelo Simples Nacional',
  '2': 'CBS apurada pelo Simples Nacional e IBS pelo regime regular',
  '3': 'IBS e CBS apurados pelo regime regular',
})

export const isIbscbsAssessment = (v: unknown): v is IbscbsAssessment =>
  typeof v === 'string' && (IBSCBS_ASSESSMENTS as readonly string[]).includes(v)

export const isRegularAssessment = (a: IbscbsAssessment): boolean => a !== '1'

/** Valor fora do domínio (CHECK desligado/SQL direto) NUNCA é suportado — falha fechado. */
export const isAssessmentSupported = (a: string): boolean => IBSCBS_ASSESSMENTS_SUPPORTED.has(a)

/**
 * Data de calendário REAL 'YYYY-MM-DD'. O servidor roda SEM modo estrito: '2027-02-30' viraria '0000-00-00' com um aviso —
 * o que valida é o que grava (`setes-api/02-VALIDACAO.md`).
 */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= '2000-01-01'
}

const TABLE = 'tb_establishment_ibscbs_assessment'
const CHECK_NAME = 'ck_establishment_ibscbs_assessment'
const tableOf = (schemaName: string) => `${schemaName}.${TABLE}`

/** A opção que governa uma data. `validFrom` null = sem linha até a data (vale 1 — D-IB1). */
export interface IbscbsAssessmentAt {
  /** Valor gravado, cru (fora do domínio = desconhecido → recusado). */
  assessment: string
  validFrom:  string | null
}

/**
 * A opção vigente na DATA (a competência da nota = `dt_emission`, D-IB64): a linha viva de maior `valid_from` ≤ data. Dentro da
 * transação que decide (faturamento) a leitura é TRAVANTE compartilhada (PADROES §9 regra 2): o registro de uma opção nova com
 * início ≤ data ESPERA o faturamento terminar (nunca uma nota decidida com uma opção que muda no meio dela) — provado em
 * `scripts/prove-ibscbs-assessment.ts`. A espera ORDENA; quem CONFERE as notas já nascidas é o escritor da opção, depois da trava
 * (D-IB101 — `frontierAfterLock`).
 */
export async function ibscbsAssessmentAt(
  q: Queryable, schemaName: string, institutionId: number, date: string, opts: { lock: boolean },
): Promise<IbscbsAssessmentAt> {
  // ADV-IB99-03 (gate adversarial): data inválida acharia "sem linha" e valeria 1 — a nota passaria com 3 vigente. Falha FECHADO
  // (erro de programação do produtor: todo produtor manda a data do dono único `invoiceEmissionDateFor`)
  if (!isIsoDate(date)) throw new Error(`Opção IBS/CBS: competência inválida (${JSON.stringify(date)}) — o produtor da nota não mandou a data de emissão`)
  const [rows] = await q.query(
    `SELECT DATE_FORMAT(valid_from, '%Y-%m-%d') AS validFrom, assessment
       FROM ?? WHERE tb_institution_id = ? AND valid_from <= ? AND deleted = 'N'
      ORDER BY valid_from DESC LIMIT 1${opts.lock ? ' LOCK IN SHARE MODE' : ''}`,
    [tableOf(schemaName), institutionId, date])
  const row = (rows as any[])[0]
  if (!row) return { assessment: IBSCBS_ASSESSMENT_WITHOUT_OPTION, validFrom: null }
  return { assessment: String(row.assessment ?? ''), validFrom: String(row.validFrom) }
}

export interface IbscbsAssessmentRefusal {
  code:    string
  message: string
}

/** A regra da recusa (D-IB99): opção vigente na competência sem suporte no código. null = a nota pode nascer. */
export function assessmentRefusalOf(at: IbscbsAssessmentAt, competenceDate: string): IbscbsAssessmentRefusal | null {
  if (isAssessmentSupported(at.assessment)) return null
  const what = isIbscbsAssessment(at.assessment)
    ? `"${at.assessment} — ${IBSCBS_ASSESSMENT_LABELS[at.assessment]}"`
    : `desconhecida ("${at.assessment}")`
  return {
    code: ErrorCodes.IBSCBS_REGULAR_REGIME_UNSUPPORTED,
    message: `Regime regular de IBS/CBS ainda não suportado: o estabelecimento registrou a opção de apuração ${what} a partir de `
      + `${at.validFrom}, e a nota de competência ${competenceDate} cai nessa vigência — o sistema ainda não calcula o IBS/CBS do `
      + 'regime regular e não emite a nota (opção em Meu Estabelecimento → Regime IBS/CBS)',
  }
}

/**
 * O FATURAMENTO (D-IB99): chamado pelo escritor único da nota, na transação dele (conexão dela — nunca uma 2ª do pool), ANTES de
 * cunhar o número. Opção sem suporte na competência = 422 e a transação inteira desfaz.
 */
export async function assertIbscbsAssessmentSupported(
  conn: Queryable, schemaName: string, institutionId: number, competenceDate: string,
): Promise<void> {
  const refusal = assessmentRefusalOf(
    await ibscbsAssessmentAt(conn, schemaName, institutionId, competenceDate, { lock: true }), competenceDate)
  if (refusal) throw new HttpError(422, refusal.message, undefined, refusal.code)
}

/** A PRÉVIA (validate da venda, detalhe da OS aberta): a MESMA regra, só-pergunta (sem trava). */
export async function previewIbscbsAssessmentRefusal(
  q: Queryable, schemaName: string, institutionId: number, competenceDate: string,
): Promise<IbscbsAssessmentRefusal | null> {
  return assessmentRefusalOf(
    await ibscbsAssessmentAt(q, schemaName, institutionId, competenceDate, { lock: false }), competenceDate)
}

// ---------------------------------------------------------------------------------------------------------------------------
// A tela (sub-recurso /api/establishment/ibscbs-assessments — escritor ÚNICO da tabela)
// ---------------------------------------------------------------------------------------------------------------------------

export interface IbscbsAssessmentLine {
  validFrom:  string
  assessment: string
  supported:  boolean
  /** Vigente hoje (a linha que governa a data de hoje). */
  inEffect:   boolean
  /** Só linha FUTURA e depois da última nota muda (alterar/excluir — D-IB100/D-IB101). */
  editable:   boolean
}

export interface IbscbsAssessmentView {
  /** Hoje do estabelecimento (fuso — PADROES §10): a fronteira passado × futuro. */
  today:        string
  /** D-IB101: a última data de emissão de nota viva (null = nenhuma) — início ≤ ela é recusado. */
  lastInvoice:  string | null
  /** O 1º início que o registro aceita hoje = o maior entre hoje e o dia seguinte à última nota (a tela sugere/limita por ele). */
  firstStart:   string
  regularStart: string
  supported:    string[]
  /** O que vale hoje — `validFrom` null = sem linha (D-IB1). */
  current:      { assessment: string; validFrom: string | null; supported: boolean }
  items:        IbscbsAssessmentLine[]
}

/** Histórico do estabelecimento (lista curta de um único registro — como a habilitação do emissor; sem paginação). */
export async function readIbscbsAssessmentView(
  schemaName: string, institutionId: number, q: Queryable = pool,
): Promise<IbscbsAssessmentView> {
  const today = await todayFor(schemaName, institutionId, q)
  const lastInvoice = await lastLiveEmissionDate(q, schemaName, institutionId)
  const [rows] = await q.query(
    `SELECT DATE_FORMAT(valid_from, '%Y-%m-%d') AS validFrom, assessment
       FROM ?? WHERE tb_institution_id = ? AND deleted = 'N' ORDER BY valid_from`,
    [tableOf(schemaName), institutionId])
  const changeable = (validFrom: string) => validFrom > today && (lastInvoice === null || validFrom > lastInvoice)
  const lines = (rows as any[]).map(r => ({ validFrom: String(r.validFrom), assessment: String(r.assessment ?? '') }))
  const governing = [...lines].reverse().find(l => l.validFrom <= today) ?? null
  const current = governing
    ? { ...governing, supported: isAssessmentSupported(governing.assessment) }
    : { assessment: IBSCBS_ASSESSMENT_WITHOUT_OPTION, validFrom: null, supported: true }
  const dayAfterInvoice = lastInvoice === null ? null : nextDay(lastInvoice)
  return {
    today, lastInvoice, firstStart: dayAfterInvoice !== null && dayAfterInvoice > today ? dayAfterInvoice : today,
    regularStart: IBSCBS_REGULAR_ASSESSMENT_START, supported: [...IBSCBS_ASSESSMENTS_SUPPORTED],
    current,
    items: lines.map(l => ({
      ...l, supported: isAssessmentSupported(l.assessment),
      inEffect: governing !== null && l.validFrom === governing.validFrom,
      editable: changeable(l.validFrom),
    })),
  }
}

const nextDay = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** Piso legal do regular (422 no campo da data — o que a tela corrige). */
function assertRegularFloor(validFrom: string, assessment: IbscbsAssessment): void {
  if (isRegularAssessment(assessment) && validFrom < IBSCBS_REGULAR_ASSESSMENT_START) {
    throw new HttpError(422,
      `A opção "${assessment} — ${IBSCBS_ASSESSMENT_LABELS[assessment]}" só tem efeito a partir de ${IBSCBS_REGULAR_ASSESSMENT_START} `
      + `(opção do Simples pelo regime regular — CGSN 194); informe início em ${IBSCBS_REGULAR_ASSESSMENT_START} ou depois`,
      [{ field: 'validFrom', message: `A partir de ${IBSCBS_REGULAR_ASSESSMENT_START} para o regime regular` }],
      ErrorCodes.IBSCBS_ASSESSMENT_REGULAR_TOO_EARLY)
  }
}

/** Entrada do escritor — os DOIS já conferidos pelo DTO; conferidos de novo aqui (o que valida é o que grava). */
export interface IbscbsAssessmentInput {
  validFrom:  string
  assessment: IbscbsAssessment
}

function assertInput(validFrom: unknown, assessment: unknown): asserts assessment is IbscbsAssessment {
  if (!isIsoDate(validFrom)) {
    throw new HttpError(400, 'Data de início inválida', [{ field: 'validFrom', message: 'Data inválida (AAAA-MM-DD)' }],
      ErrorCodes.VALIDATION_FAILED)
  }
  if (!isIbscbsAssessment(assessment)) {
    throw new HttpError(400, 'Opção de apuração inválida', [{ field: 'assessment', message: 'Use 1, 2 ou 3' }],
      ErrorCodes.VALIDATION_FAILED)
  }
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

/** Linha da PK, TRAVADA (registro — a PK é completa: PADROES §9 regra 8). */
async function lockLine(conn: PoolConnection, schemaName: string, institutionId: number, validFrom: string) {
  const [rows] = await conn.query<any[]>(
    `SELECT assessment, deleted FROM ?? WHERE tb_institution_id = ? AND valid_from = ? FOR UPDATE`,
    [tableOf(schemaName), institutionId, validFrom])
  return rows[0] as { assessment: string; deleted: string } | undefined
}

/**
 * D-IB101 (Valdo 2026-11-01, Q-IB104 = (a) — prompt_fase_ibs_cbs.md §14.4): a FRONTEIRA do que a opção pode mudar é o MAIOR entre
 * HOJE e a ÚLTIMA data de emissão de nota VIVA do estabelecimento — "o passado já lido por uma nota nunca muda", ao pé da letra.
 * Chamada SEMPRE DEPOIS da trava que serializa com o faturamento (o INSERT da linha nova ou o FOR UPDATE da linha existente — o
 * faturamento lê a opção com LOCK IN SHARE MODE): nenhuma leitura consistente acontece antes dela nesta transação, então o retrato
 * nasce DEPOIS da espera e enxerga a nota que o faturamento concorrente acabou de gravar; e o "hoje" é o do relógio REAL de depois
 * da espera (nunca o do início da requisição — a virada da meia-noite). Fecha os 3 casos do gate (ADV-IB99-01/02): a opção registrada
 * HOJE depois de uma nota de hoje, a meia-noite e a troca do fuso do estabelecimento (o "hoje" anda para trás; a nota não).
 */
async function frontierAfterLock(
  conn: Queryable, schemaName: string, institutionId: number,
): Promise<{ today: string; lastInvoice: string | null }> {
  const today = await todayFor(schemaName, institutionId, conn, new Date())
  const lastInvoice = await lastLiveEmissionDate(conn, schemaName, institutionId)
  return { today, lastInvoice }
}

/** Início ≤ a última nota viva = 409: a opção mudaria o que uma nota já emitida leu. */
function assertNotInvoiced(validFrom: string, lastInvoice: string | null, act: string): void {
  if (lastInvoice !== null && validFrom <= lastInvoice) {
    throw new HttpError(409,
      `Já existe nota emitida em ${lastInvoice} — ${act} a opção de apuração do IBS/CBS a partir de ${validFrom} mudaria o que essa nota `
      + `já leu; use início depois de ${lastInvoice} (D-IB101)`,
      [{ field: 'validFrom', message: `Depois de ${lastInvoice}` }], ErrorCodes.IBSCBS_ASSESSMENT_INVOICED)
  }
}

/** Registrar: início ≥ hoje E depois da última nota viva — conferido DEPOIS da trava (D-IB101). */
async function assertRegistrable(conn: Queryable, schemaName: string, institutionId: number, validFrom: string): Promise<void> {
  const { today, lastInvoice } = await frontierAfterLock(conn, schemaName, institutionId)
  if (validFrom < today) {
    throw new HttpError(422,
      `A opção de apuração do IBS/CBS começa em ${validFrom}, antes de hoje (${today}) — o passado é imutável; registre a partir de hoje`,
      [{ field: 'validFrom', message: `A partir de ${today}` }], ErrorCodes.IBSCBS_ASSESSMENT_DATE_PAST)
  }
  assertNotInvoiced(validFrom, lastInvoice, 'registrar')
}

const duplicateOf = (validFrom: string) => new HttpError(409,
  `Já existe opção de apuração do IBS/CBS a partir de ${validFrom} — altere a existente`,
  [{ field: 'validFrom', message: 'Data já registrada' }], ErrorCodes.IBSCBS_ASSESSMENT_DUPLICATE)

/**
 * Registra uma opção (início ≥ hoje e depois da última nota viva — D-IB101). PK já existente: viva = 409; morta = REVIVE da MESMA linha
 * sem herdar nada (PADROES §3.1 — todas as colunas regravadas). Duas transações, cada uma com a trava ANTES de qualquer leitura:
 * (1) INSERT da linha nova (a trava é o próprio INSERT — espera o faturamento que leu a data); a chave já existir encerra esta
 * transação sem nada gravado; (2) a linha EXISTENTE é travada por REGISTRO antes de decidir (ADV-IB99-05: reviveres concorrentes se
 * enfileiram — o 2º vê a linha viva e recebe 409, nunca deadlock). Corrida de dois criadores: 1 criação + 409.
 */
export async function createIbscbsAssessment(
  schemaName: string, institutionId: number, userId: number, input: IbscbsAssessmentInput,
): Promise<void> {
  assertInput(input.validFrom, input.assessment)
  const { validFrom, assessment } = input
  assertRegularFloor(validFrom, assessment)
  // PRÉ-CHECAGEM (gate do delta, socrático 2): o pedido inválido é recusado pelo pool, SEM trava — nunca segura o faturamento para
  // recusar; a conferência DECISIVA continua depois da trava (abaixo)
  await assertRegistrable(pool, schemaName, institutionId, validFrom)
  const created = await inTransaction('registro da opção IBS/CBS', institutionId, async conn => {
    try {
      await conn.query(
        `INSERT INTO ?? (tb_institution_id, valid_from, assessment, tb_user_id, created_at, updated_at, deleted)
         VALUES (?, ?, ?, ?, NOW(), NOW(), 'N')`,
        [tableOf(schemaName), institutionId, validFrom, assessment, userId])
    } catch (err: any) {
      if (err?.code === 'ER_DUP_ENTRY') return false   // a data já existe: decide a transação (2), com a trava de registro
      throw err
    }
    await assertRegistrable(conn, schemaName, institutionId, validFrom)   // falhou = a transação desfaz o INSERT
    return true
  })
  if (created) return
  await inTransaction('revive da opção IBS/CBS', institutionId, async conn => {
    const line = await lockLine(conn, schemaName, institutionId, validFrom)
    if (!line) throw new Error(`Opção IBS/CBS ${institutionId}/${validFrom}: chave duplicada sem linha — dado inconsistente`)
    if (line.deleted === 'N') throw duplicateOf(validFrom)
    await assertRegistrable(conn, schemaName, institutionId, validFrom)
    await conn.query(
      `UPDATE ?? SET assessment = ?, tb_user_id = ?, created_at = NOW(), updated_at = NOW(), deleted = 'N'
        WHERE tb_institution_id = ? AND valid_from = ? AND deleted = 'S'`,
      [tableOf(schemaName), assessment, userId, institutionId, validFrom])
  })
}

/** A linha viva da PK, FUTURA e depois da última nota viva — senão 404 / 409 (D-IB100/D-IB101). Trava ANTES de ler a fronteira. */
async function lockFutureLine(
  conn: PoolConnection, schemaName: string, institutionId: number, validFrom: string, act: string,
): Promise<void> {
  const line = await lockLine(conn, schemaName, institutionId, validFrom)
  if (!line || line.deleted !== 'N') {
    throw new HttpError(404, `Opção de apuração do IBS/CBS a partir de ${validFrom} não encontrada`, undefined,
      ErrorCodes.IBSCBS_ASSESSMENT_NOT_FOUND)
  }
  const { today, lastInvoice } = await frontierAfterLock(conn, schemaName, institutionId)
  if (validFrom <= today) {
    throw new HttpError(409,
      `A opção de apuração do IBS/CBS a partir de ${validFrom} já está vigente (hoje é ${today}) — linha imutável; registre uma nova `
      + 'opção com data futura', undefined, ErrorCodes.IBSCBS_ASSESSMENT_IN_EFFECT)
  }
  assertNotInvoiced(validFrom, lastInvoice, act)
}

/** Troca a opção de uma linha FUTURA (a data é a identidade — mudar a data = excluir e registrar outra). */
export async function changeIbscbsAssessment(
  schemaName: string, institutionId: number, userId: number, input: IbscbsAssessmentInput,
): Promise<void> {
  assertInput(input.validFrom, input.assessment)
  const { validFrom, assessment } = input
  assertRegularFloor(validFrom, assessment)
  await inTransaction('alteração da opção IBS/CBS', institutionId, async conn => {
    await lockFutureLine(conn, schemaName, institutionId, validFrom, 'alterar')
    await conn.query(
      `UPDATE ?? SET assessment = ?, tb_user_id = ?, updated_at = NOW()
        WHERE tb_institution_id = ? AND valid_from = ? AND deleted = 'N'`,
      [tableOf(schemaName), assessment, userId, institutionId, validFrom])
  })
}

/** Exclui (SOFT — PADROES §3.1) uma linha FUTURA: é o cancelamento da opção antes de ela valer (CGSN 194: 03/11 a 20/12/2026). */
export async function removeIbscbsAssessment(
  schemaName: string, institutionId: number, userId: number, validFrom: string,
): Promise<void> {
  if (!isIsoDate(validFrom)) {
    throw new HttpError(400, 'Data de início inválida', [{ field: 'validFrom', message: 'Data inválida (AAAA-MM-DD)' }],
      ErrorCodes.VALIDATION_FAILED)
  }
  await inTransaction('exclusão da opção IBS/CBS', institutionId, async conn => {
    await lockFutureLine(conn, schemaName, institutionId, validFrom, 'excluir')
    await conn.query(
      `UPDATE ?? SET deleted = 'S', tb_user_id = ?, updated_at = NOW()
        WHERE tb_institution_id = ? AND valid_from = ? AND deleted = 'N'`,
      [tableOf(schemaName), userId, institutionId, validFrom])
  })
}

// ---------------------------------------------------------------------------------------------------------------------------
// Boot (D-IB26 / PADROES §11 regras 11 e 16): o CHECK do domínio existe, pelo NOME, em cada schema
// ---------------------------------------------------------------------------------------------------------------------------

/** Corpo do CHECK normalizado (sem crase, espaço e caixa) — o que o motor guarda difere só na forma. */
export const normalizeCheckClause = (clause: string): string => clause.replace(/[`\s]/g, '').toLowerCase()
export const EXPECTED_CHECK_CLAUSE = normalizeCheckClause("`assessment` collate utf8mb4_bin in ('1','2','3')")

/** O CHECK do domínio num schema: null = presente com o corpo esperado; senão, o problema (a prova em schema descartável usa a MESMA). */
export async function ibscbsAssessmentCheckProblem(q: Queryable, schemaName: string): Promise<string | null> {
  const [rows] = await q.query(
    `SELECT CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`, [schemaName, TABLE, CHECK_NAME])
  const clause = (rows as any[])[0]?.clause
  if (clause == null) return `${CHECK_NAME} ausente`
  if (normalizeCheckClause(String(clause)) !== EXPECTED_CHECK_CLAUSE) return `${CHECK_NAME} com corpo diferente (${clause})`
  return null
}

/**
 * Depois das migrations: em cada schema de cliente vivo, `ck_establishment_ibscbs_assessment` existe na tabela com o corpo
 * BINÁRIO esperado. O motor aplicar CHECK já é provado antes (`assertCheckConstraintsEnforced`, D-IB26); faltando ou diferente,
 * o setes-api NÃO sobe (a única guarda contra carga/SQL direto gravar uma opção que o código leria como outra).
 */
export async function assertIbscbsAssessmentChecks(q: Queryable = pool): Promise<string> {
  const [schemas] = await q.query(
    "SELECT DISTINCT schema_name AS s FROM setes_central.tb_institution WHERE active = 'S' AND deleted = 'N' AND schema_name IS NOT NULL")
  const bad: string[] = []
  for (const { s } of schemas as any[]) {
    const problem = await ibscbsAssessmentCheckProblem(q, String(s))
    if (problem) bad.push(`${s}: ${problem}`)
  }
  if (bad.length) {
    throw new Error(`D-IB100: domínio da opção de apuração IBS/CBS sem a guarda do banco — ${bad.join(' | ')} — confira a migration 076`)
  }
  return `${CHECK_NAME} em ${(schemas as any[]).length} schema(s)`
}
