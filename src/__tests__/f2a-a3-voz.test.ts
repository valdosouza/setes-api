/// <reference types="jest" />
// F2a, etapa A3 (`prompt_apis_fiscais_isoladas.md` §22.2/§22.6/§22.11): a PORTA de leitura da voz do fisco (`@shared/fiscal-voice` — o
// único lugar do setes-api que lê o fiscal_api), a NOTA diante da voz (`@shared/invoice/invoice-fiscal-effect` — predicados do núcleo,
// D-F114 `fiscalEffectOf`, selo em lote) e a SÉRIE da nota (`@shared/invoice-series` — D-F112). Leitor do núcleo REAL; banco mockado na
// fronteira com LINHAS CRUAS da view (o mapa da família é o real — nota (5)).
import { fiscalDbName, readServiceVoiceOfLife, readServiceVoicesOfLives, assertFiscalVoiceReadable, READ_FAMILIES } from '../shared/fiscal-voice'
import {
  fiscalEffectOf, fiscalCancelBarrier, readFiscalSeals, unknownFamilies, KNOWN_FAMILIES, FAMILIES_AWAITING_CANCEL_PLAN,
  awaitingFamiliesBootNote, fiscalRecordKey,
} from '../shared/invoice/invoice-fiscal-effect'
import * as fs from 'fs'
import * as path from 'path'
import { invoiceSerieFor } from '../shared/invoice-series'
import { rawServiceRow, serviceView, unrecorded, TEST_KEY } from '../test-setup/fiscal-voice-rows'
import { VOICE_READINGS } from 'fiscal-api/reading'

// D-F130: a porta grava o ALARME (tb_crashlytics) quando a voz está ilegível — aqui na fronteira, sem banco
jest.mock('../shared/errors/crash.repository', () => ({
  __esModule: true, newCrashRef: jest.fn(() => 'REFVOZ01'), recordCrash: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../shared/logger/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))

const ENV0 = { ...process.env }
afterEach(() => { process.env = { ...ENV0 } })
const qOf = (...results: any[][]) => {
  const query = jest.fn()
  for (const r of results) query.mockResolvedValueOnce([r, []])
  return { query }
}

describe('porta @shared/fiscal-voice — o único leitor do fiscal_api (D-F15/D-NE77)', () => {
  it('banco da voz: padrão fiscal_api; FISCAL_DB_NAME sobrepõe; nome fora do padrão ou setes_* → erro (D-F7, PADROES §11 regra 1)', () => {
    expect(fiscalDbName({})).toBe('fiscal_api')
    expect(fiscalDbName({ FISCAL_DB_NAME: ' fiscal_api_h ' })).toBe('fiscal_api_h')
    for (const bad of ['setes_setes', 'fiscal-api', 'x`; DROP', '', '1abc']) expect(() => fiscalDbName({ FISCAL_DB_NAME: bad })).toThrow(/FISCAL_DB_NAME/)
  })
  it('a voz de UMA vida: SELECT publicado da view da família no banco fiscal, chave inteira + vida por parâmetro, mapa REAL (registro vira boolean)', async () => {
    const q = qOf([rawServiceRow({ invoiceId: 7400, lifeEvent: 3, attempt: 1 })])
    const rows = await readServiceVoiceOfLife(q, 1, 7400, 3)
    const [sql, params] = q.query.mock.calls[0]
    expect(sql).toMatch(/FROM `fiscal_api`\.vw_invoice_service_transmission v/)
    expect(sql).toMatch(/v\.tb_institution_id = \? AND v\.tb_invoice_id = \? AND v\.terminal = \? AND v\.life_event = \?/)
    expect(sql).toMatch(/v\.authority_recorded AS authorityRecorded/)
    expect(sql).not.toMatch(/FOR UPDATE|LOCK IN SHARE MODE/)
    expect(params).toEqual([1, 7400, 0, 3])
    expect(rows).toEqual([expect.objectContaining({ invoiceId: 7400, lifeEvent: 3, authorityRecorded: true, environment: 'P', nfseNumber: '710' })])
  })
  it('FISCAL_DB_NAME vale para a porta (um ambiente com outro nome de banco)', async () => {
    process.env.FISCAL_DB_NAME = 'fiscal_api_teste'
    const q = qOf([])
    await readServiceVoiceOfLife(q, 1, 7400, 1)
    expect(q.query.mock.calls[0][0]).toMatch(/FROM `fiscal_api_teste`\.vw_invoice_service_transmission/)
  })
  // D-F130: toda falha da leitura da voz (argumento recusado pelo leitor do núcleo, linha que o mapa recusa, banco) sai da porta como
  // UM fato tipado — 503 FISCAL_VOICE_UNAVAILABLE com o ref do alarme; a causa fica em `causeMessage` (log/crashlytics), nunca na mensagem
  const unavailable = (cause: RegExp) => expect.objectContaining({ statusCode: 503, code: 'FISCAL_VOICE_UNAVAILABLE', ref: 'REFVOZ01', causeMessage: expect.stringMatching(cause) })
  it('vida ausente/inválida → erro ANTES do banco (D-F119: nunca "todas as vidas") — tipado pela porta (D-F130)', async () => {
    const q = qOf()
    for (const life of [0, -1, 1.5, NaN, null as any]) await expect(readServiceVoiceOfLife(q, 1, 7400, life)).rejects.toEqual(unavailable(/Vida da nota/))
    expect(q.query).not.toHaveBeenCalled()
  })
  it('linha de OUTRA vida/nota vinda do banco → falha ALTO (D-F119) — tipada pela porta (D-F130), com o alarme gravado', async () => {
    await expect(readServiceVoiceOfLife(qOf([rawServiceRow({ invoiceId: 7400, lifeEvent: 2 })]), 1, 7400, 3)).rejects.toEqual(unavailable(/./))
    await expect(readServiceVoiceOfLife(qOf([rawServiceRow({ invoiceId: 9999, lifeEvent: 3 })]), 1, 7400, 3)).rejects.toEqual(unavailable(/./))
    const crash = (jest.requireMock('../shared/errors/crash.repository') as any).recordCrash as jest.Mock
    expect(crash).toHaveBeenCalledWith(expect.objectContaining({ ref: 'REFVOZ01', code: 'FISCAL_VOICE_UNAVAILABLE', statusCode: 503, institutionId: 1 }))
  })
  it('lote: pares nota × vida (selo da lista de OS); lista vazia não pergunta ao banco', async () => {
    const empty = qOf()
    expect(await readServiceVoicesOfLives(empty, 1, [])).toEqual([])
    expect(empty.query).not.toHaveBeenCalled()
    const q = qOf([rawServiceRow({ invoiceId: 10, lifeEvent: 1 }), rawServiceRow({ invoiceId: 11, lifeEvent: 4, attempt: 2 })])
    const rows = await readServiceVoicesOfLives(q, 1, [{ invoiceId: 10, lifeEvent: 1 }, { invoiceId: 11, lifeEvent: 4 }])
    expect(rows.map(r => [r.invoiceId, r.lifeEvent])).toEqual([[10, 1], [11, 4]])
    expect(q.query.mock.calls[0][0]).toMatch(/FROM `fiscal_api`\.vw_invoice_service_transmission/)
  })
  it('D-F113/D-F127 + NFE.E1.P4 — conferência do boot: a view de cada família que o ERP LÊ (NFS-e e NF-e) responde ao SELECT publicado; sem view/coluna/GRANT o boot NÃO sobe', async () => {
    const ok = qOf([])
    expect(await assertFiscalVoiceReadable(ok)).toBe('fiscal_api — conferida(s): service, merchandise')
    expect(ok.query).toHaveBeenCalledTimes(2)   // NFE.E1.P4: a família merchandise saiu da espera — o boot confere as duas views
    expect(ok.query.mock.calls[0][0]).toMatch(/FROM `fiscal_api`\.vw_invoice_service_transmission v WHERE 1 = 0/)
    expect(ok.query.mock.calls[1][0]).toMatch(/FROM `fiscal_api`\.vw_invoice_merchandise_transmission v WHERE 1 = 0/)
    // sem a view da NF-e (nfe-api não instalada antes) o setes-api NÃO sobe — ordem de deploy
    const noNfe = { query: jest.fn()
      .mockResolvedValueOnce([[]])
      .mockRejectedValueOnce(Object.assign(new Error("Table 'fiscal_api.vw_invoice_merchandise_transmission' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' })) }
    await expect(assertFiscalVoiceReadable(noNfe)).rejects.toThrow(/família "merchandise"[\s\S]*ER_NO_SUCH_TABLE/)
    const denied = { query: jest.fn().mockRejectedValue(Object.assign(new Error('SELECT command denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' })) }
    await expect(assertFiscalVoiceReadable(denied)).rejects.toThrow(/família "service"[\s\S]*ER_TABLEACCESS_DENIED_ERROR[\s\S]*D-F113/)
  })
})

describe('nota (9) — famílias que o plano conhece × catálogo da biblioteca', () => {
  it('o catálogo VOICE_READINGS desta versão do núcleo só tem famílias que a composição do ERP conhece ou que esperam o plano (família nova = revisão obrigatória do plano)', () => {
    expect(unknownFamilies()).toEqual([])
    expect(Object.keys(VOICE_READINGS).sort()).toEqual([...KNOWN_FAMILIES, ...FAMILIES_AWAITING_CANCEL_PLAN].sort())
  })
  it('D-NE245 + NFE.E1.P4.T1 — a lista de espera ESVAZIOU: o plano de cancelamento lê a NF-e e a família merchandise está em KNOWN_FAMILIES', () => {
    expect([...FAMILIES_AWAITING_CANCEL_PLAN]).toEqual([])
    expect([...KNOWN_FAMILIES]).toEqual(['service', 'merchandise'])
    const known: readonly string[] = KNOWN_FAMILIES
    expect(FAMILIES_AWAITING_CANCEL_PLAN.filter(f => known.includes(f))).toEqual([])                          // disjuntas
    expect(FAMILIES_AWAITING_CANCEL_PLAN.filter(f => !Object.keys(VOICE_READINGS).includes(f))).toEqual([])   // sem espera órfã
  })
  it('D-NE245 — o log do boot diz a família que está no catálogo SEM conferência, derivado da lista (vazio quando ela esvaziar)', () => {
    expect(awaitingFamiliesBootNote()).toBe('')   // NFE.E1.P4: nada mais espera — o log do boot só diz o que conferiu
    expect(awaitingFamiliesBootNote(['x', 'y'])).toBe('; no catálogo sem conferência (esperando o plano de cancelamento, NFE.E1.P4): x, y')
    expect(awaitingFamiliesBootNote([])).toBe('')
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8')
    expect(server).toContain('${await assertFiscalVoiceReadable(pool)}${awaitingFamiliesBootNote()}')
  })
  it('D-NE245 — catálogo = famílias que a porta LÊ (e o boot confere) ∪ famílias em espera; e toda conhecida do plano é lida', () => {
    const read = READ_FAMILIES.map(r => r.branch as string)
    expect([...read, ...FAMILIES_AWAITING_CANCEL_PLAN].sort()).toEqual(Object.keys(VOICE_READINGS).sort())
    expect([...read].sort()).toEqual([...KNOWN_FAMILIES].sort())   // no NFE.E1.P4.T1: quem entra em KNOWN_FAMILIES entra em READ_FAMILIES
  })
  it('D-NE245 — as cercas de leitura valem SEMPRE: o catálogo só na peça do efeito, leitura NOMEADA na porta, nomes da família só na porta e na peça, e nada de família em espera em src', () => {
    const root = path.join(__dirname, '..')
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'test-setup') walk(path.join(dir, e.name)) }
        else if (e.name.endsWith('.ts')) files.push(path.join(dir, e.name))
      }
    }
    walk(root)
    expect(files.length).toBeGreaterThan(100)   // a varredura não passa no vazio
    const rel = (f: string): string => path.relative(root, f).replace(/\\/g, '/')
    const code = (f: string): string => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')   // sem comentários
    // (1) os nomes da família da NF-e (a leitura, o mapa, o predicado, a view) só na PORTA — a peça do efeito e o plano recebem as
    // tentativas já lidas, tipadas; ninguém mais lê a voz dela (NFE.E1.P4: a família saiu da espera, mas a leitura segue numa porta só)
    const names = /MERCHANDISE_VOICE_READING|mapMerchandiseTransmissionView|isMerchandiseHumanEffectCancel|vw_invoice_merchandise_transmission/
    expect(files.filter(f => names.test(code(f))).map(rel)).toEqual(['shared/fiscal-voice/fiscal-voice.ts'])
    expect(files.filter(f => /\breadMerchandiseVoiceOfLife\b/.test(code(f))).map(rel).sort())
      .toEqual(['shared/fiscal-voice/fiscal-voice.ts', 'shared/invoice/invoice-fiscal-effect.ts'])
    // (2) o catálogo só é citado na peça da cerca — ninguém o percorre (Object.values/entries, índice, alias) para ler uma família
    expect(files.filter(f => /\bVOICE_READINGS\b/.test(code(f))).map(rel)).toEqual(['shared/invoice/invoice-fiscal-effect.ts'])
    // (3) na porta, todo leitor do núcleo recebe uma leitura NOMEADA — nunca variável nem o catálogo
    const door = code(path.join(root, 'shared', 'fiscal-voice', 'fiscal-voice.ts'))
    const calls = [...door.matchAll(/readFamilyTransmissions(?:Many)?\(\s*\w+\s*,\s*([^,]+),/g)].map(m => m[1].trim())
    expect(calls.sort()).toEqual(['MERCHANDISE_VOICE_READING', 'SERVICE_VOICE_READING', 'SERVICE_VOICE_READING'])
    // família em espera (lista vazia hoje) nunca tem leitor: se alguém puser uma família na espera, o nome dela não pode estar em src
    for (const f of FAMILIES_AWAITING_CANCEL_PLAN) {
      expect(files.filter(x => new RegExp(`\\b${f}\\b`, 'i').test(code(x))).map(rel)).toEqual([])
    }
    // (4) o 5.0.0 também publica em `fiscal-api/reading` os leitores das faixas retiradas e da habilitação (não são a voz, mas leem o
    // fiscal_api): só a porta `@shared/fiscal-voice` pode chamá-los (é o ÚNICO lugar que lê o fiscal_api) — hoje ninguém chama
    const fiscalReaders = /\b(readWithdrawnRanges|assertWithdrawnRangesViewReadable|readIssuerView|assertIssuerViewReadable)\b/
    expect(files.filter(f => fiscalReaders.test(code(f)) && !rel(f).startsWith('shared/fiscal-voice/')).map(rel)).toEqual([])
  })
})

describe('D-F114 — fiscalEffectOf: o efeito da voz na nota é UMA classificação derivada', () => {
  const C = (code: string | null, over: any = {}) => serviceView({ lastKind: 'C', lastCode: code, lastSource: 'Q', ...over })
  it.each([
    ['sem voz', null, 'E', false, 'none'],
    ['autorizada', serviceView(), 'E', false, 'none'],
    ['C comum (101101) e nota viva', C('101101'), 'E', false, 'apply'],
    ['C deferido (105104)', C('105104'), 'E', false, 'apply'],
    ['C sem código (anterior à 067)', C(null), 'E', false, 'apply'],
    ['C qualquer com a nota JÁ cancelada', C('101101'), 'C', false, 'none'],
    ['SUBSTITUIÇÃO (105102) em produção sem dispensa', C('105102'), 'E', false, 'decide'],
    ['SUBSTITUIÇÃO dispensada ("manter a nota")', C('105102'), 'E', true, 'none'],
    ['SUBSTITUIÇÃO em HOMOLOGAÇÃO (sem "manter" — D-F80/D-F83)', C('105102', { environment: 'H' }), 'E', false, 'cancel'],
    ['DE OFÍCIO (305101 — D-F82)', C('305101'), 'E', false, 'cancel'],
    ['DE OFÍCIO com a nota já cancelada', C('305101'), 'C', false, 'none'],
  ] as const)('%s → %s', (_l, cur, lastKind, waived, expected) => {
    expect(fiscalEffectOf(cur as any, lastKind, waived)).toBe(expected)
  })
})

describe('fiscalCancelBarrier — predicados do núcleo, nunca coluna crua', () => {
  const r = (list: any[]) => ({ service: list, current: list.length ? list[list.length - 1] : null })
  it('autorizada em PRODUÇÃO barra; em HOMOLOGAÇÃO não (Q-CA5b); voz C não barra (é o caminho do efeito)', () => {
    expect(fiscalCancelBarrier(r([serviceView()]))).toMatchObject({ kind: 'authorized', attempt: 1, nfseNumber: '710' })
    expect(fiscalCancelBarrier(r([serviceView({ environment: 'H' })]))).toEqual({ kind: 'none' })
    expect(fiscalCancelBarrier(r([serviceView({ lastKind: 'C', lastCode: '101101' })]))).toEqual({ kind: 'none' })
  })
  it('S, K e reserva sem voz barram em qualquer ambiente', () => {
    expect(fiscalCancelBarrier(r([unrecorded({ lastKind: 'S' })]))).toMatchObject({ kind: 'in-flight' })
    expect(fiscalCancelBarrier(r([serviceView({ lastKind: 'K', environment: 'H' })]))).toMatchObject({ kind: 'cancel-in-flight' })
    expect(fiscalCancelBarrier(r([unrecorded({ lastKind: null, lastEvent: null, lastSource: null, lastDh: null, lastEventAt: null })]))).toMatchObject({ kind: 'in-flight' })
  })
  it('prova da reconferência pelo VEREDITO do núcleo (D-F109): sem E2404 → reconfirm; com → none', () => {
    const f = { lastKind: 'F', lastSource: 'Q' as const, createdAt: '2026-10-10 12:00:00', lastEventAt: '2026-10-10 12:10:00' }
    expect(fiscalCancelBarrier(r([unrecorded(f)]))).toEqual({ kind: 'reconfirm', reason: 'sem-e2404', attempt: 1 })
    expect(fiscalCancelBarrier(r([unrecorded({ ...f, nfseNotGeneratedAt: '2026-10-11 00:00:00' })]))).toEqual({ kind: 'none' })
  })
})

describe('F2A3-SOC-08 — a chave é IDENTIDADE do documento registrado, lida só DEPOIS do fato (fiscalRecordKey)', () => {
  it('registro em produção → a chave; homologação, sem registro ou sem vigente → null; registro SEM chave → falha ALTO', () => {
    expect(fiscalRecordKey(serviceView())).toBe(TEST_KEY)
    expect(fiscalRecordKey(serviceView({ environment: 'H' }))).toBeNull()            // homologação registrada: sem valor jurídico
    expect(fiscalRecordKey(unrecorded({ lastKind: 'R' }))).toBeNull()
    expect(fiscalRecordKey(null)).toBeNull()
    expect(() => fiscalRecordKey({ ...serviceView(), accessKey: null })).toThrow(/registro fiscal sem chave/)
  })
  it('o efeito decide pelo ESTADO do núcleo (cancelled), não pela letra: voz C em produção com a nota viva → apply; K → none', () => {
    expect(fiscalEffectOf(serviceView({ lastKind: 'C', lastCode: '101101' }), 'E', false)).toBe('apply')
    expect(fiscalEffectOf(serviceView({ lastKind: 'K' }), 'E', false)).toBe('none')
  })
})

describe('selo da lista de OS — readFiscalSeals (vidas pela view de política + lote nota × vida)', () => {
  it('estado/ambiente/número pela VIGENTE de cada nota; nota sem vida (sincronizada) ou sem tentativa → none; uma ida ao ERP e uma ao fiscal_api', async () => {
    const q = qOf(
      [{ invoiceId: 10, invoiceDeleted: 'N', lifeEvent: 1, lastEvent: 1, lastKind: 'E' },
       { invoiceId: 11, invoiceDeleted: 'N', lifeEvent: null, lastEvent: null, lastKind: null },
       { invoiceId: 12, invoiceDeleted: 'N', lifeEvent: 3, lastEvent: 3, lastKind: 'E' }],
      [rawServiceRow({ invoiceId: 10, lifeEvent: 1, attempt: 1, accessKey: null, authorityRecorded: 'N', lastKind: 'R', nfseNumber: null }),
       rawServiceRow({ invoiceId: 10, lifeEvent: 1, attempt: 2 }),
       rawServiceRow({ invoiceId: 12, lifeEvent: 3, environment: 'H', lastKind: 'C', lastCode: '101101', nfseNumber: '15' })],
    )
    const seals = await readFiscalSeals(q as any, 'setes_setes', 1, [10, 11, 12, 13])
    expect(Object.fromEntries(seals)).toEqual({
      10: { state: 'authorized', environment: 'P', nfseNumber: '710' },
      11: { state: 'none', environment: null, nfseNumber: null },
      12: { state: 'cancelled', environment: 'H', nfseNumber: '15' },
      13: { state: 'none', environment: null, nfseNumber: null },
    })
    expect(q.query).toHaveBeenCalledTimes(2)
    expect(q.query.mock.calls[0][0]).toMatch(/FROM `setes_setes`\.vw_invoice_life/)
    expect(q.query.mock.calls[0][1]).toEqual([1, [10, 11, 12, 13]])
    expect(q.query.mock.calls[1][1]).toEqual([1, 0, [[10, 1], [12, 3]]])   // só as notas COM vida, em pares (D-F119)
  })
  it('lista vazia não lê nada; a view de vida devolvendo 2 linhas para a mesma nota → 409 retryable (nunca "a primeira")', async () => {
    const empty = qOf()
    expect((await readFiscalSeals(empty as any, 'setes_setes', 1, [])).size).toBe(0)
    expect(empty.query).not.toHaveBeenCalled()
    const dup = qOf([{ invoiceId: 10, invoiceDeleted: 'N', lifeEvent: 1, lastEvent: 2, lastKind: 'C' }, { invoiceId: 10, invoiceDeleted: 'N', lifeEvent: 3, lastEvent: 3, lastKind: 'E' }])
    await expect(readFiscalSeals(dup as any, 'setes_setes', 1, [10])).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_BUSY' })
  })
})

describe('D-F112 — invoiceSerieFor: a série da nota é leitura só no ERP', () => {
  it('linha VIVA do modelo → série (até 10); sem linha (ou SE aposentada pelo ato da virada) → "1"', async () => {
    const q = qOf([{ serie: '2' }], [])
    expect(await invoiceSerieFor(q as any, 'setes_setes', 1, '55')).toBe('2')
    expect(await invoiceSerieFor(q as any, 'setes_setes', 1, 'SE')).toBe('1')
    const [sql, params] = q.query.mock.calls[0]
    expect(sql).toMatch(/^SELECT serie FROM `setes_setes`\.tb_establishment_issuer\s+WHERE tb_institution_id = \? AND model = \? AND deleted = 'N'/)
    expect(params).toEqual([1, '55'])
  })
  it('schema fora do padrão → recusa antes do SQL', async () => {
    const q = qOf()
    await expect(invoiceSerieFor(q as any, 'x`; DROP', 1, 'SE')).rejects.toThrow()
    expect(q.query).not.toHaveBeenCalled()
  })
})
