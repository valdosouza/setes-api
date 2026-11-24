/// <reference types="jest" />
// NFE.E1.P4.T1: o que a voz da NF-e (família `merchandise`) diz sobre cancelar a nota LOCALMENTE — por estado, pelos predicados do
// núcleo, olhando TODAS as tentativas da vida (§3.9 item 1 da onda da NF-e, D-NE270, D-E7, D-E11, Q-CA5b). Peça pura, com linhas
// REAIS da view passadas pelo mapa da família (`src/test-setup/fiscal-voice-rows.ts`). O plano inteiro está em invoice-cancel.test.ts.
import {
  merchandiseCancelBarrier, fiscalCancelBarriers, invoiceFiscalRecord, InvoiceFiscalReading,
} from '../shared/invoice/invoice-fiscal-effect'
import { fiscalStateOf, currentOf } from 'fiscal-api/reading'
import { merchandiseView, serviceView, unrecorded, RawMerchandiseRow } from '../test-setup/fiscal-voice-rows'

/** Tentativa da NF-e SEM registro do fisco (em voo, P, R, F): a chave existe (é nossa), o registro não. */
const pending = (over: Partial<RawMerchandiseRow> = {}) =>
  merchandiseView({ authorityRecorded: 'N', lastKind: null, lastCode: null, lastEvent: null, lastDh: null, lastEventAt: null, lastSource: null, ...over })
const reading = (merchandise: ReturnType<typeof merchandiseView>[], service: InvoiceFiscalReading['service'] = []): InvoiceFiscalReading =>
  ({ service, current: currentOf(service), merchandise, merchandiseCurrent: currentOf(merchandise) })

describe('NFE.E1.P4.T1 — barreira da NF-e ao cancelamento local, por estado', () => {
  it('as linhas do teste produzem os oito estados COM tentativa do vocabulário — o nono, `none`, é a nota sem tentativa (a tabela abaixo testa o que diz)', () => {
    expect([
      fiscalStateOf(pending()), fiscalStateOf(pending({ lastKind: 'P' })), fiscalStateOf(merchandiseView()),
      fiscalStateOf(merchandiseView({ lastKind: 'D', lastCode: '110' })), fiscalStateOf(pending({ lastKind: 'R', lastCode: '225' })),
      fiscalStateOf(pending({ lastKind: 'F' })), fiscalStateOf(merchandiseView({ lastKind: 'C', lastCode: '135' })),
      fiscalStateOf(merchandiseView({ lastKind: 'K' })),
    ]).toEqual(['in_flight', 'processing', 'authorized', 'denied', 'rejected', 'failed', 'cancelled', 'cancel_in_flight'])
  })

  it('nunca transmitida → não barra (nota sem voz, lista vazia ou não lida)', () => {
    expect(merchandiseCancelBarrier([])).toEqual({ kind: 'none' })
    expect(merchandiseCancelBarrier(undefined)).toEqual({ kind: 'none' })
  })

  it('rejeitada → não barra (o fisco descartou; nada gravado lá)', () => {
    expect(merchandiseCancelBarrier([pending({ lastKind: 'R', lastCode: '225' })])).toEqual({ kind: 'none' })
  })

  it('autorizada em PRODUÇÃO → barra `authorized` (cancele a NF-e no fisco primeiro); em HOMOLOGAÇÃO não prende a nota (Q-CA5b)', () => {
    expect(merchandiseCancelBarrier([merchandiseView({ attempt: 3 })])).toEqual({ kind: 'authorized', attempt: 3 })
    expect(merchandiseCancelBarrier([merchandiseView({ environment: 'H' })])).toEqual({ kind: 'none' })
  })

  it('cancelada no fisco → não barra (é o caminho do efeito: o app cancelou a NF-e e agora manda o C local)', () => {
    expect(merchandiseCancelBarrier([merchandiseView({ lastKind: 'C', lastCode: '135' })])).toEqual({ kind: 'none' })
  })

  it('D-E7 — denegada (só nota antiga; a denegação do 55 acabou): não vai ao fisco, não barra — e a nota FICA pelo registro fiscal (em produção)', () => {
    const denied = [merchandiseView({ lastKind: 'D', lastCode: '110' })]
    expect(merchandiseCancelBarrier(denied)).toEqual({ kind: 'none' })
    expect(invoiceFiscalRecord(reading(denied))).toBe(true)
    // em homologação a denegada segue o caminho da pendente (sem valor jurídico)
    const deniedH = [merchandiseView({ lastKind: 'D', lastCode: '110', environment: 'H' })]
    expect(merchandiseCancelBarrier(deniedH)).toEqual({ kind: 'none' })
    expect(invoiceFiscalRecord(reading(deniedH))).toBe(false)
  })

  it('em voo e em processamento → barra `in-flight`; cancelamento sem resposta → `cancel-in-flight` (inclusive em homologação)', () => {
    expect(merchandiseCancelBarrier([pending({ attempt: 2 })])).toEqual({ kind: 'in-flight', attempt: 2 })
    expect(merchandiseCancelBarrier([pending({ lastKind: 'P' })])).toEqual({ kind: 'in-flight', attempt: 1 })
    expect(merchandiseCancelBarrier([merchandiseView({ lastKind: 'K' })])).toEqual({ kind: 'cancel-in-flight', attempt: 1 })
    expect(merchandiseCancelBarrier([merchandiseView({ lastKind: 'K', environment: 'H' })])).toEqual({ kind: 'cancel-in-flight', attempt: 1 })
  })

  it('D-NE270 — sem resposta conclusiva (`failed`) BARRA com `unanswered`, em produção e em homologação', () => {
    expect(merchandiseCancelBarrier([pending({ lastKind: 'F' })])).toEqual({ kind: 'unanswered', attempt: 1 })
    expect(merchandiseCancelBarrier([pending({ lastKind: 'F', environment: 'H' })])).toEqual({ kind: 'unanswered', attempt: 1 })
  })

  it('D-NE270 — olha TODAS as tentativas: a 1ª sem resposta + a 2ª REJEITADA continua barrando (a 1ª pode estar autorizada — RF-NFE-17)', () => {
    const list = [pending({ attempt: 1, lastKind: 'F' }), pending({ attempt: 2, lastKind: 'R', lastCode: '225' })]
    expect(fiscalStateOf(currentOf(list))).toBe('rejected')                       // a vigente é a última: sozinha, liberaria
    expect(merchandiseCancelBarrier(list)).toEqual({ kind: 'unanswered', attempt: 1 })
    // duas sem resposta: aponta a mais recente
    expect(merchandiseCancelBarrier([pending({ attempt: 1, lastKind: 'F' }), pending({ attempt: 2, lastKind: 'F' })]))
      .toEqual({ kind: 'unanswered', attempt: 2 })
  })

  it('a tentativa REGISTRADA pelo fisco resolve as anteriores sem resposta: F depois autorizada → `authorized`; F depois cancelada no fisco → libera', () => {
    expect(merchandiseCancelBarrier([pending({ attempt: 1, lastKind: 'F' }), merchandiseView({ attempt: 2 })]))
      .toEqual({ kind: 'authorized', attempt: 2 })
    expect(merchandiseCancelBarrier([pending({ attempt: 1, lastKind: 'F' }), merchandiseView({ attempt: 2, lastKind: 'C', lastCode: '135' })]))
      .toEqual({ kind: 'none' })
  })

  it('gate adversarial — "registrada" não é "liberada": registrada com última voz de FALHA (cancelamento sem resposta) → `unanswered`; com REJEIÇÃO (o fisco recusou o cancelamento) em produção → `authorized`, em homologação → nada', () => {
    // a NF-e foi autorizada (registrada) e a última voz é uma falha: o documento pode seguir vivo no fisco
    expect(merchandiseCancelBarrier([merchandiseView({ attempt: 4, lastKind: 'F' })])).toEqual({ kind: 'unanswered', attempt: 4 })
    expect(merchandiseCancelBarrier([merchandiseView({ lastKind: 'F', environment: 'H' })])).toEqual({ kind: 'unanswered', attempt: 1 })
    // registrada e a última voz é rejeição: a NF-e continua autorizada no fisco
    expect(merchandiseCancelBarrier([merchandiseView({ attempt: 2, lastKind: 'R', lastCode: '501' })])).toEqual({ kind: 'authorized', attempt: 2 })
    expect(merchandiseCancelBarrier([merchandiseView({ lastKind: 'R', lastCode: '501', environment: 'H' })])).toEqual({ kind: 'none' })
    expect(invoiceFiscalRecord(reading([merchandiseView({ lastKind: 'R', lastCode: '501' })]))).toBe(true)   // e a nota fica
  })

  it('tentativa VIVA em qualquer posição barra antes de tudo: rejeitada + nova em voo → `in-flight` na nova', () => {
    expect(merchandiseCancelBarrier([pending({ attempt: 1, lastKind: 'R', lastCode: '225' }), pending({ attempt: 2 })]))
      .toEqual({ kind: 'in-flight', attempt: 2 })
  })
})

describe('NFE.E1.P4.T1 — nota conjugada: os dois ramos compõem (D-E11, D-NE22)', () => {
  it('NF-e autorizada + NFS-e nunca transmitida → UMA barreira, do ramo de mercadoria; a nota tem registro fiscal', () => {
    const r = reading([merchandiseView()])
    expect(fiscalCancelBarriers(r)).toEqual([{ branch: 'merchandise', barrier: { kind: 'authorized', attempt: 1 } }])
    expect(invoiceFiscalRecord(r)).toBe(true)
  })

  it('as duas autorizadas em produção → DUAS barreiras, serviço PRIMEIRO (o app de hoje lê o primeiro bloco fiscal)', () => {
    const r = reading([merchandiseView({ attempt: 2 })], [serviceView()])
    expect(fiscalCancelBarriers(r).map(b => [b.branch, b.barrier.kind])).toEqual([['service', 'authorized'], ['merchandise', 'authorized']])
  })

  it('NF-e cancelada no fisco + NFS-e ainda autorizada → só o serviço barra (o C local espera o outro ramo)', () => {
    const r = reading([merchandiseView({ lastKind: 'C', lastCode: '135' })], [serviceView()])
    expect(fiscalCancelBarriers(r).map(b => b.branch)).toEqual(['service'])
    expect(invoiceFiscalRecord(r)).toBe(true)
  })

  it('NFS-e nunca transmitida + NF-e sem resposta → barra pela NF-e (`unanswered`)', () => {
    expect(fiscalCancelBarriers(reading([pending({ lastKind: 'F' })]))).toEqual([{ branch: 'merchandise', barrier: { kind: 'unanswered', attempt: 1 } }])
  })

  it('nenhum ramo barra → lista vazia: as duas canceladas no fisco, ou as duas nunca transmitidas, ou rejeitadas', () => {
    expect(fiscalCancelBarriers(reading([merchandiseView({ lastKind: 'C', lastCode: '135' })], [serviceView({ lastKind: 'C', lastCode: '101101' })]))).toEqual([])
    expect(fiscalCancelBarriers(reading([]))).toEqual([])
    expect(fiscalCancelBarriers(reading([pending({ lastKind: 'R', lastCode: '225' })], [unrecorded({ lastKind: 'R' })]))).toEqual([])
  })

  it('nota SÓ de serviço (a voz da NF-e nem é lida): as barreiras são as de sempre, sem ramo de mercadoria', () => {
    const service = [serviceView()]
    const r: InvoiceFiscalReading = { service, current: currentOf(service) }
    expect(fiscalCancelBarriers(r).map(b => [b.branch, b.barrier.kind])).toEqual([['service', 'authorized']])
    expect(fiscalCancelBarriers({ service: [], current: null })).toEqual([])
    expect(invoiceFiscalRecord({ service: [], current: null })).toBe(false)
  })
})
