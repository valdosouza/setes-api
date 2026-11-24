import {
  currentOf, isLiveTransmission, isAuthorized, isFiscalRecord, localCancelPending, isSubstitutionCancel, reconfirmationVerdict,
  fiscalStateOf, blocksNewAttempt, VOICE_READINGS,
} from 'fiscal-api/reading'
import type {
  ServiceTransmissionView, MerchandiseTransmissionView, ReadQueryable, ReconfirmReason, FiscalState,
} from 'fiscal-api/reading'
import { PoolConnection } from 'mysql2/promise'
import { readServiceVoiceOfLife, readServiceVoicesOfLives, readMerchandiseVoiceOfLife } from '@shared/fiscal-voice'
import { readInvoiceLives } from './invoice'

/**
 * A NOTA diante da voz do fisco — F2a, etapa A3 (`prompt_apis_fiscais_isoladas.md` §22.2/§22.6). Composição do ERP sobre os
 * PREDICADOS do núcleo (`fiscal-api/reading`) e os fatos do ERP (nota, vida, dispensa): nada decide por coluna crua da voz
 * (`accessKey`, `environment === 'H'|'P'`, `last_queried_at` — nota (8) e §22.5 item 8; cerca na suíte).
 *
 * Famílias: a NFS-e (`service`) e, desde o NFE.E1.P4, a NF-e (`merchandise` — saiu da lista de espera da D-NE245 junto com o plano
 * de cancelamento que a lê). A voz da NF-e só é lida para nota COM ramo de mercadoria (quem chama diz); a nota só de serviço faz
 * exatamente as leituras de sempre. O EFEITO (`fiscalEffectOf` — D-F114) segue só da NFS-e: a pendência do C local da NF-e é
 * resolvida pelo plano (a saga do app — D-NE22); a derivação do efeito para a NF-e nasce com a tela dela.
 * Cerca (nota (9)): família do catálogo que não é conhecida nem está em espera quebra o teste desta peça até alguém decidir.
 */

export interface InvoiceFiscalReading {
  /** As tentativas da NFS-e na vida vigente (vazia = nunca transmitida nesta vida, ou nota sem vida — sincronizada da origem). */
  service: ServiceTransmissionView[]
  /** A vigente da vida (D-N26 — `currentOf` do núcleo: a registrada pelo fisco, senão a última). */
  current: ServiceTransmissionView | null
  /** As tentativas da NF-e na vida vigente — só lidas para nota com ramo de mercadoria (ausente/vazia = não lida ou nunca transmitida). */
  merchandise?: MerchandiseTransmissionView[]
  /** A vigente da NF-e na vida. */
  merchandiseCurrent?: MerchandiseTransmissionView | null
}

/** Famílias que esta composição conhece — qualquer outra no catálogo é revisão OBRIGATÓRIA (nota (9) da F2a). */
export const KNOWN_FAMILIES = Object.freeze(['service', 'merchandise'] as const)

/**
 * Famílias do catálogo que o plano de cancelamento AINDA NÃO DECIDIU (D-NE245 — Valdo, 2026-11-23). Não são conhecidas nem
 * desconhecidas: esperam, com saída marcada. Hoje VAZIA: `merchandise` (NF-e) saiu daqui e entrou em `KNOWN_FAMILIES` no
 * NFE.E1.P4.T1, junto com o plano que lê a voz dela. Família nova do catálogo entra aqui (com o passo que a tira) ou em
 * `KNOWN_FAMILIES` (com o plano) — nunca fica sem decisão (a cerca da suíte quebra). As cercas de leitura valem SEMPRE: o catálogo
 * `VOICE_READINGS` só é citado NESTE arquivo, a porta `@shared/fiscal-voice` só passa leituras NOMEADAS ao leitor do núcleo, e os
 * nomes de uma família só aparecem na porta e nesta peça.
 */
export const FAMILIES_AWAITING_CANCEL_PLAN: readonly string[] = Object.freeze([])

/** Lê a voz da VIDA vigente. Quem DECIDE chama depois da trava da nota (D-F121) com a vida do `lockInvoice` (D-F126). */
export async function readInvoiceFiscal(
  q: ReadQueryable, institutionId: number, invoiceId: number, lifeEvent: number | null,
  opts: { merchandise?: boolean } = {},
): Promise<InvoiceFiscalReading> {
  if (lifeEvent == null) return { service: [], current: null }
  const service = await readServiceVoiceOfLife(q, institutionId, invoiceId, lifeEvent)
  if (opts.merchandise !== true) return { service, current: currentOf(service) }
  // NFE.E1.P4.T1: nota com ramo de mercadoria — a voz da NF-e na MESMA vida (depois da de serviço; mesma porta)
  const merchandise = await readMerchandiseVoiceOfLife(q, institutionId, invoiceId, lifeEvent)
  return { service, current: currentOf(service), merchandise, merchandiseCurrent: currentOf(merchandise) }
}

/**
 * Registro FISCAL da nota (Q-CA5/D3/D4): o fisco registrou o documento EM PRODUÇÃO — fato da view (D-NE56), nunca a chave. Em
 * QUALQUER ramo (D-E11): a nota com NF-e autorizada em produção — ou denegada antiga (D-E7/D-NE61: publicada sempre registrada) —
 * nunca some, mesmo com a NFS-e nunca transmitida.
 */
export function invoiceFiscalRecord(r: InvoiceFiscalReading): boolean {
  return isFiscalRecord(r.current) || isFiscalRecord(r.merchandiseCurrent ?? null)
}

/**
 * A IDENTIDADE do documento registrado em produção (a chave) — lida só DEPOIS do fato do registro (F2A3-SOC-08, gate socrático da
 * A3; nota (8)): a chave é identidade, nunca a pergunta "foi registrado?" (na NF-e a chave é nossa desde a reserva). Sem registro
 * fiscal → null; registro fiscal SEM chave é linha incoerente da view e falha ALTO (nunca "não registrado" calado).
 */
export function fiscalRecordKey(cur: ServiceTransmissionView | null): string | null {
  if (!cur || !isFiscalRecord(cur)) return null
  if (!cur.accessKey) {
    throw new Error(`registro fiscal sem chave (nota ${cur.invoiceId}, tentativa ${cur.attempt}) — linha da view incoerente`)
  }
  return cur.accessKey
}

export type FiscalCancelBarrier =
  | { kind: 'none' }
  | { kind: 'authorized' | 'cancel-in-flight' | 'in-flight'; attempt: number; nfseNumber: string | null }
  | { kind: 'reconfirm'; reason: Exclude<ReconfirmReason, 'provada' | 'nao-exigida' | 'irma-viva'>; attempt: number | null }

/**
 * O que o FISCO diz sobre cancelar a nota LOCALMENTE (o bloco `fiscal` do plano — D-F29/D-F109):
 *  1. barreira pela VIGENTE (fatos do núcleo — §22.2): VIVA (em voo, S, K) bloqueia sempre; AUTORIZADA bloqueia só com REGISTRO
 *     FISCAL (produção — a de homologação não prende a nota, Q-CA5b). Nunca `isLive || isFiscalRecord` (barraria a voz C de produção,
 *     que é o caminho do efeito);
 *  2. a PROVA da reconferência (D-F29/D-F90): o VEREDITO do núcleo (D-F109) — irmã viva = em andamento; `provada`/`nao-exigida`
 *     liberam; o resto pede reconferir na nfse-api (o setes-api nunca pergunta ao fisco — D-F4).
 */
export function fiscalCancelBarrier(r: InvoiceFiscalReading): FiscalCancelBarrier {
  const cur = r.current
  if (cur && isLiveTransmission(cur)) {
    // o estado é o do núcleo (F2A3-SOC-08: nada pela letra crua — `fiscalStateOf` é o switch exaustivo do vocabulário)
    const kind = fiscalStateOf(cur) === 'cancel_in_flight' ? 'cancel-in-flight' : 'in-flight'
    return { kind, attempt: cur.attempt, nfseNumber: cur.nfseNumber }
  }
  if (cur && isAuthorized(cur) && isFiscalRecord(cur)) return { kind: 'authorized', attempt: cur.attempt, nfseNumber: cur.nfseNumber }
  const verdict = reconfirmationVerdict(r.service)
  switch (verdict.reason) {
    case 'provada':
    case 'nao-exigida':
      return { kind: 'none' }
    case 'irma-viva': {
      const live = r.service.find(t => isLiveTransmission(t))!          // o veredito só diz irmã viva se ela existe
      return { kind: 'in-flight', attempt: live.attempt, nfseNumber: live.nfseNumber }
    }
    default:
      return { kind: 'reconfirm', reason: verdict.reason, attempt: verdict.candidate?.attempt ?? null }
  }
}

/** A barreira da NF-e (família `merchandise`) ao cancelamento LOCAL — NFE.E1.P4.T1. `unanswered` = sem resposta conclusiva (D-NE270). */
export type MerchandiseCancelBarrier =
  | { kind: 'none' }
  | { kind: 'authorized' | 'cancel-in-flight' | 'in-flight' | 'unanswered'; attempt: number }

/**
 * O que a NF-e diz sobre cancelar a nota LOCALMENTE — pelos predicados do núcleo, nunca pela letra crua (§3.9 item 1 da onda da
 * NF-e, com a D-NE270), olhando TODAS as tentativas da vida:
 *  1. alguma tentativa VIVA (em voo, em processamento, cancelamento sem resposta) → barra (`in-flight` / `cancel-in-flight`);
 *  2. a vigente AUTORIZADA com registro fiscal (produção) → `authorized`: cancele a NF-e no fisco primeiro. A autorizada em
 *     homologação não prende a nota (Q-CA5b);
 *  3. a vigente REGISTRADA pelo fisco (o documento da vida é esse; as tentativas anteriores sem resposta foram resolvidas por ele),
 *     pelo ESTADO dela — nunca "registrada, logo liberada" (gate adversarial do NFE.E1.P4: `blocksNewAttempt` só diz que registrou):
 *      · cancelada no fisco (o caminho do efeito) ou denegada antiga (D-E7: não vai ao fisco; a nota fica pelo
 *        `invoiceFiscalRecord`) → nada;
 *      · autorizada em homologação → nada (Q-CA5b);
 *      · registrada com última voz de FALHA (ex.: o pedido de cancelamento ficou sem resposta) → `unanswered` (D-NE270);
 *      · registrada com última voz de REJEIÇÃO (ex.: o fisco recusou o cancelamento): o documento segue vivo no fisco → em
 *        produção `authorized`; em homologação nada;
 *  4. sem registro: alguma tentativa `failed` (sem resposta conclusiva) → `unanswered` — D-NE270: a NF-e pendente de retorno pode
 *     já estar autorizada (RF-NFE-17); barra até a nfe-api consultar e a voz mudar, mesmo que uma tentativa POSTERIOR tenha sido
 *     rejeitada;
 *  5. nunca transmitida ou só rejeitada → nada.
 */
export function merchandiseCancelBarrier(list: readonly MerchandiseTransmissionView[] | undefined): MerchandiseCancelBarrier {
  if (!list || list.length === 0) return { kind: 'none' }
  const cur = currentOf(list)
  const live = (cur && isLiveTransmission(cur) ? cur : null) ?? list.find(t => isLiveTransmission(t)) ?? null
  if (live) {
    return { kind: fiscalStateOf(live) === 'cancel_in_flight' ? 'cancel-in-flight' : 'in-flight', attempt: live.attempt }
  }
  if (cur && isAuthorized(cur) && isFiscalRecord(cur)) return { kind: 'authorized', attempt: cur.attempt }
  if (cur && blocksNewAttempt(cur)) {                             // final e REGISTRADA pelo fisco (D-NE56) — regra 3, pelo estado
    const state = fiscalStateOf(cur)
    if (state === 'failed') return { kind: 'unanswered', attempt: cur.attempt }
    if (state === 'rejected' && isFiscalRecord(cur)) return { kind: 'authorized', attempt: cur.attempt }
    return { kind: 'none' }                                       // cancelada, denegada, autorizada/rejeitada em homologação
  }
  const unanswered = list.filter(t => fiscalStateOf(t) === 'failed')
  if (unanswered.length > 0) return { kind: 'unanswered', attempt: Math.max(...unanswered.map(t => t.attempt)) }
  return { kind: 'none' }
}

/**
 * As barreiras do FISCO ao cancelamento local da nota, por RAMO — a conjugada (NF-e + NFS-e) compõe os dois (D-E11/D-NE22: o C
 * local só quando nenhum ramo barra; o parcial é fato visível). Serviço PRIMEIRO (o app de hoje lê o primeiro bloco fiscal).
 */
export type BranchCancelBarrier =
  | { branch: 'service'; barrier: Exclude<FiscalCancelBarrier, { kind: 'none' }> }
  | { branch: 'merchandise'; barrier: Exclude<MerchandiseCancelBarrier, { kind: 'none' }> }

export function fiscalCancelBarriers(r: InvoiceFiscalReading): BranchCancelBarrier[] {
  const out: BranchCancelBarrier[] = []
  const service = fiscalCancelBarrier(r)
  if (service.kind !== 'none') out.push({ branch: 'service', barrier: service })
  const merchandise = merchandiseCancelBarrier(r.merchandise)
  if (merchandise.kind !== 'none') out.push({ branch: 'merchandise', barrier: merchandise })
  return out
}

/**
 * D-F114 (= Q-F120 (a)): a pendência do EFEITO no ERP é UMA classificação derivada da vigente da vida vigente × nota × dispensa:
 *  - `none`   — sem voz C vigente, nota já cancelada, ou substituição já DISPENSADA ("manter a nota" — D-F67/D-F81);
 *  - `apply`  — o app aplica o C local sozinho (= `localCancelPending` do núcleo: C comum — 101101/105104/sem código);
 *  - `decide` — SUBSTITUIÇÃO (105102) em produção sem dispensa: o humano decide manter ou cancelar (D-F64/D-F67);
 *  - `cancel` — o humano cancela a nota: DE OFÍCIO (305101 — D-F82) ou substituição em HOMOLOGAÇÃO (sem "manter" — D-F80/D-F83).
 * "Pendência" nunca sozinha (glossário): esta é a do EFEITO; a contagem por `invoice_event IS NULL` era maquete (D-F28) e saiu.
 */
export type FiscalEffect = 'none' | 'apply' | 'decide' | 'cancel'

export function fiscalEffectOf(
  current: ServiceTransmissionView | null, invoiceLastKind: string | null, waived: boolean,
): FiscalEffect {
  // voz C vigente = estado `cancelled` do núcleo (F2A3-SOC-08); `invoiceLastKind` é o evento da NOTA (fato do ERP, não voz do fisco)
  if (!current || fiscalStateOf(current) !== 'cancelled' || invoiceLastKind === 'C') return 'none'
  if (localCancelPending(current, invoiceLastKind)) return 'apply'
  if (isSubstitutionCancel(current) && isFiscalRecord(current)) return waived ? 'none' : 'decide'
  return 'cancel'
}

/** Cerca da nota (9): o catálogo de famílias desta versão da biblioteca é o que esta composição conhece. */
export function unknownFamilies(): string[] {
  const decided: readonly string[] = [...KNOWN_FAMILIES, ...FAMILIES_AWAITING_CANCEL_PLAN]
  return Object.keys(VOICE_READINGS).filter(f => !decided.includes(f))
}

/**
 * O trecho do log do BOOT sobre as famílias em espera (D-NE245): estão no catálogo e o boot NÃO conferiu a view delas. Vazio quando a
 * lista esvaziar. Derivado da constante — nunca texto fixo.
 */
export function awaitingFamiliesBootNote(families: readonly string[] = FAMILIES_AWAITING_CANCEL_PLAN): string {
  if (!families.length) return ''
  return `; no catálogo sem conferência (esperando o plano de cancelamento, NFE.E1.P4): ${families.join(', ')}`
}

/**
 * Estado do selo: o do núcleo (`fiscalStateOf`) ou `unavailable` — a voz do fisco ILEGÍVEL em execução (D-F130): a lista não cai por
 * causa do selo (informativo); o alarme com a referência fica na tb_crashlytics (porta `@shared/fiscal-voice`).
 */
export type FiscalSealState = FiscalState | 'unavailable'

/** Selo fiscal de uma linha de lista (OS): situação da NFS-e pela VIGENTE da vida vigente — o mesmo leitor do plano. */
export interface FiscalSeal {
  state:       FiscalSealState
  environment: 'H' | 'P' | null
  nfseNumber:  string | null
}

/** D-F130: o selo quando a voz do fisco está ilegível — sem ambiente nem número (nada inventado). */
export const UNAVAILABLE_SEAL: Readonly<FiscalSeal> = Object.freeze({ state: 'unavailable', environment: null, nfseNumber: null })

/**
 * Selos de VÁRIAS notas (lista paginada de OS): vidas pela `vw_invoice_life` (sem trava — leitura consultiva) e a voz em UM lote
 * pelos pares nota × vida (D-F119 — nota (9): nunca um WHERE próprio). Nota sem vida (sincronizada) ou sem tentativa → 'none'.
 */
export async function readFiscalSeals(
  q: Pick<PoolConnection, 'query'> & ReadQueryable, s: string, institutionId: number, invoiceIds: readonly number[],
): Promise<Map<number, FiscalSeal>> {
  const out = new Map<number, FiscalSeal>()
  if (!invoiceIds.length) return out
  const lives = await readInvoiceLives(q, s, institutionId, invoiceIds)
  const pairs = [...lives.values()].filter(l => l.lifeEvent != null).map(l => ({ invoiceId: l.invoiceId, lifeEvent: l.lifeEvent as number }))
  const rows = await readServiceVoicesOfLives(q, institutionId, pairs)
  const byInvoice = new Map<number, ServiceTransmissionView[]>()
  for (const r of rows) byInvoice.set(r.invoiceId, [...(byInvoice.get(r.invoiceId) ?? []), r])
  for (const id of invoiceIds) {
    const cur = currentOf(byInvoice.get(id) ?? [])
    out.set(id, { state: fiscalStateOf(cur), environment: cur?.environment ?? null, nfseNumber: cur?.nfseNumber ?? null })
  }
  return out
}
