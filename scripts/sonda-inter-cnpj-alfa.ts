// =====================================================================
// SONDA D-CJ10 (frente do CNPJ alfanumérico, passo setes-api:CNPJ.E5.P1.T1):
// o SANDBOX do Banco Inter aceita ou recusa um PAGADOR com CNPJ alfanumérico?
//
// Fala DIRETO com o canal da conta (openBankChannel → adaptador do Inter), sem
// passar pela API e SEM GRAVAR NADA no banco de dados: só LÊ o canal da conta
// (ambiente S obrigatório) e os segredos do cofre. Duas apresentações com o
// MESMO corpo, mudando só o documento do pagador:
//   CONTROLE — CNPJ numérico válido (11222333000181): separa "recusou a letra"
//              de "recusou o resto" (canal, corpo, janela);
//   ALFA     — CNPJ alfanumérico válido, forma canônica (12ABC34501DE35, o
//              exemplo da RFB).
// Toda cobrança aceita é CANCELADA na hora (sandbox; nada vai a ninguém).
// O veredito decide a T2 (D-CJ10): aceitou → envia a forma canônica; recusou →
// recusa local legível.
//
// Uso (no sandbox: seg–sex 8h–20h de Brasília):
//   npx tsx --require tsconfig-paths/register scripts/sonda-inter-cnpj-alfa.ts
//     [--schema=setes_setes] [--institution=1] [--account=5] [--forcar] [--pdf=<pasta>]
// --forcar: tenta mesmo fora da janela (para provar que a janela é o motivo).
// =====================================================================
import dotenv from 'dotenv'
dotenv.config()
import pool from '@shared/db/connection'
import { openBankChannel, BankHttpError, ChargePayer, ChargeRegisterInput } from '@shared/bank-channel'
import { readFederalIdFact, FederalId } from '@shared/validation'
import { DEFAULT_TIME_ZONE } from '@shared/time-zone'
import fs from 'fs'
import path from 'path'

const arg = (n: string) => process.argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1]
const SCHEMA  = arg('schema') ?? 'setes_setes'
const INST    = Number(arg('institution') ?? 1)
const ACCOUNT = Number(arg('account') ?? 5)
const FORCAR  = process.argv.includes('--forcar')
const PDF_DIR = arg('pdf')   // pasta onde guardar o PDF de cada cobrança aceita (prova do documento que o banco gravou)

const CONTROLE = '11222333000181'
const ALFA     = '12ABC34501DE35'
// NEGATIVOS — o sandbox DISCRIMINA? De FORMA (o schema do Pix `cobv.devedor.cnpj`) e de DV, separados: se aceitar
// forma errada, "aceitou" não prova nada sobre a letra; se só não conferir o DV, o aceite da letra vale para a FORMA.
const NEGATIVOS_FORMA = [['FORMA-LETRADV', 'XYZXYZXYZXYZXY'], ['FORMA-CURTA', '1122233300018']] as const
const NEGATIVOS_DV    = [['DV-ERRADO', '11222333000182']] as const
// INFORMATIVO (não decide): a caixa baixa. Nós SEMPRE enviamos a forma canônica (maiúscula); isto só diz se o banco diferencia caixa.
const INFORMATIVOS    = [['CAIXA-BAIXA', '12abc34501de35']] as const

// A janela é no horário de BRASÍLIA (a zona da Setes), não na do processo.
function foraDaJanela(now = new Date()): string | null {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: DEFAULT_TIME_ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]))
  const h = Number(parts.hour), m = parts.minute
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return `hoje é ${parts.weekday === 'Sun' ? 'domingo' : 'sábado'} em Brasília`
  if (h < 8 || h >= 20) return `são ${String(h).padStart(2, '0')}h${m} em Brasília`
  return null
}

function vencimento(): string {
  const d = new Date(Date.now() + 10 * 86_400_000)
  return d.toISOString().slice(0, 10)
}

function corpo(document: string, rotulo: string, negativo = false): ChargeRegisterInput {
  const fact = readFederalIdFact('cnpj', document)
  if (!negativo && fact.state !== 'valid') throw new Error(`${rotulo}: ${document} não é CNPJ válido pela peça — a sonda não roda com dado errado`)
  if (negativo && fact.state === 'valid') throw new Error(`${rotulo}: ${document} é válido — não serve de negativo`)
  // O negativo monta o FederalId À MÃO, de propósito FORA da forma (a peça nunca produz forma errada): é a única forma de perguntar ao
  // banco se ele discrimina. Fora desta sonda, todo FederalId vem da peça.
  const federalId: FederalId = fact.state === 'valid' ? fact.id : { kind: 'cnpj', value: document } as FederalId
  const payer: ChargePayer = {
    federalId, name: `SONDA D-CJ10 ${rotulo}`,
    street: 'Rua da Sonda, 1', neighborhood: 'Centro', city: 'Belo Horizonte', state: 'MG', zipCode: '30130000',
  }
  const ref = `SD${rotulo.slice(0, 1)}${Date.now().toString().slice(-10)}`
  return { reference: ref, amount: 10, dueDate: vencimento(), payer }
}

interface Resultado { rotulo: string; document: string; aceitou: boolean; requestCode?: string; detalhe: string; cancelado?: string }

async function apresenta(ch: Awaited<ReturnType<typeof openBankChannel>>, rotulo: string, document: string, negativo = false): Promise<Resultado> {
  const input = corpo(document, rotulo, negativo)
  try {
    const { requestCode } = await ch.adapter.register(ch.ctx, input)
    const r: Resultado = { rotulo, document, aceitou: true, requestCode, detalhe: `codigoSolicitacao ${requestCode}` }
    try {
      const st = await ch.adapter.query(ch.ctx, requestCode)
      r.detalhe += ` · situação ${st.status}${st.digitableLine ? ' · com linha digitável' : ''}`
    } catch (e) { r.detalhe += ` · consulta falhou: ${(e as Error).message}` }
    if (PDF_DIR) {
      try {
        const pdf = await ch.adapter.pdf(ch.ctx, requestCode)
        const file = path.join(PDF_DIR, `sonda-${rotulo.toLowerCase()}-${requestCode}.pdf`)
        fs.writeFileSync(file, pdf)
        r.detalhe += ` · PDF ${file}`
      } catch (e) { r.detalhe += ` · PDF falhou: ${(e as Error).message}` }
    }
    try {
      await ch.adapter.cancel(ch.ctx, requestCode, 'SONDA D-CJ10 sandbox')
      r.cancelado = 'cancelamento aceito'
    } catch (e) { r.cancelado = `cancelamento falhou: ${(e as Error).message}` }
    return r
  } catch (e) {
    if (e instanceof BankHttpError) {
      const be = e as any
      return { rotulo, document, aceitou: false,
        detalhe: `${be.statusCode ?? ''} ${be.code ?? ''} banco=${be.bankStatus ?? ''} ${String(be.bankBody ?? e.message).slice(0, 600)}` }
    }
    return { rotulo, document, aceitou: false, detalhe: `erro local: ${(e as Error).message}` }
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') { console.error('a sonda NÃO roda em produção'); process.exit(2) }
  const fora = foraDaJanela()
  console.log(`\nSONDA D-CJ10 — Inter SANDBOX · schema ${SCHEMA} · institution ${INST} · conta ${ACCOUNT} · ${new Date().toString()}\n`)
  if (fora && !FORCAR) {
    console.log(`[ PARADA ] o sandbox do Inter só atende seg–sex 8h–20h — ${fora}. Rode na janela (ou --forcar para provar a janela).`)
    process.exit(3)
  }
  if (fora) console.log(`[ AVISO ] fora da janela (${fora}) — espere BANK_UNAVAILABLE`)

  const ch = await openBankChannel(SCHEMA, INST, ACCOUNT)
  if (ch.channel.environment !== 'S') { console.error(`canal da conta ${ACCOUNT} está em ${ch.channel.environment}: a sonda só roda no sandbox (S)`); process.exit(2) }

  const linha = (r: Resultado) =>
    console.log(`[${r.aceitou ? 'ACEITOU' : 'RECUSOU'}] ${r.rotulo.padEnd(12)} ${r.document} · ${r.detalhe}${r.cancelado ? ` · ${r.cancelado}` : ''}`)
  const resultados: Resultado[] = []
  for (const [rotulo, doc] of [['CONTROLE', CONTROLE], ['ALFA', ALFA]] as const) {
    const r = await apresenta(ch, rotulo, doc); resultados.push(r); linha(r)
  }
  const forma: Resultado[] = []
  for (const [rotulo, doc] of NEGATIVOS_FORMA) { const r = await apresenta(ch, rotulo, doc, true); forma.push(r); linha(r) }
  const dv: Resultado[] = []
  for (const [rotulo, doc] of NEGATIVOS_DV) { const r = await apresenta(ch, rotulo, doc, true); dv.push(r); linha(r) }
  for (const [rotulo, doc] of INFORMATIVOS) linha(await apresenta(ch, rotulo, doc, true))

  const [ctrl, alfa] = resultados
  const confereDv = dv.every(n => !n.aceitou)
  let veredito: string
  if (forma.some(n => n.aceitou)) veredito = 'SEM VALOR — o sandbox ACEITOU documento de forma errada: ele não valida o pagador, então "aceitou" não prova nada sobre a letra'
  else if (!ctrl.aceitou) veredito = 'INCONCLUSIVA — o CONTROLE numérico também foi recusado (canal, janela ou corpo): nada se conclui sobre a letra'
  else if (alfa.aceitou) veredito = 'ACEITOU — o schema do banco aceita pagador com CNPJ alfanumérico na forma canônica e recusa forma errada '
    + `(D-CJ10: envia a forma canônica); ${confereDv ? 'o sandbox também confere o DV' : 'o sandbox NÃO confere o DV (o nosso é conferido antes, pela peça)'}`
  else veredito = 'RECUSOU — o sandbox recusa pagador com CNPJ alfanumérico e aceita o numérico (D-CJ10: recusa local legível)'
  console.log(`\nVEREDITO: ${veredito}\n`)
}

main()
  .catch(e => { console.error('sonda falhou:', e?.code ?? '', e?.message ?? e); process.exitCode = 1 })
  .finally(() => pool.end())
