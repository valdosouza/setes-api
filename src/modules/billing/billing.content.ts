import pool from '@shared/db/connection'
import { assertSchema } from '@shared/db/schema'
import { getEntityFiscalFull } from '@shared/entity/entity-fiscal'
import { getEntityTax } from '@shared/entity-tax/entity-tax.repository'
import { isValidCnpj, isValidCpf, normalizeCnpj, normalizeCpf } from '@shared/validation'
import { ValidationIssue } from './billing.interface'

/**
 * CONFERÊNCIA DO CONTEÚDO da NF-e no faturamento (setes-api:NFE.E1.P2.T1 — D-NE43, D-NE49, D-NE260, D-NE267).
 *
 * Como no ERP Desktop (`Tributacao.Fc_Valida`), o faturamento confere ANTES de faturar o que a NF-e exige do destinatário e dos
 * itens — no SERVIDOR (web e mobile recebem a mesma lista, com o campo), e só quando a tela do faturamento manda a marcação de
 * emitir a NF-e (`authorizeNfe`). Texto acima do tamanho do leiaute é RECUSADO com o campo, nunca truncado (o Desktop trunca em 60).
 *
 * É AVISO ANTECIPADO: o cadastro não é congelado no faturamento (D-NE248), então a nfe-api confere de novo ao gerar o XML — a dela
 * é a garantia. Os limites são os do leiaute (XSD PL_010f, `leiauteNFe_v4.00.xsd`), não os das colunas: regra que a coluna de hoje
 * não deixa violar fica mesmo assim. Fora daqui, de propósito: modalidade de frete e transportadora (o pedido da web não tem quem
 * as grave), código do produto e natureza da operação (quem monta o XML escolhe a coluna).
 */
export interface InvoiceContentRecipient {
  /** 'F' pessoa física · 'J' pessoa jurídica · 'N' sem documento (estrangeiro ou "sem documento") */
  personType: 'F' | 'J' | 'N'
  name: string | null
  document: string | null
  stateRegistration: string | null
  /** indicador da IE do destinatário ('1' contribuinte, '2' isento, '9' não contribuinte) — aba Tributação */
  stateRegistrationIndicator: string | null
  /** endereço principal; null = não tem */
  address: {
    street: string | null; number: string | null; complement: string | null; neighborhood: string | null
    zipCode: string | null; cityCode: string | null; state: string | null
  } | null
  phone: string | null
  email: string | null
}
export interface InvoiceContentItem {
  itemId: number
  description: string | null
  ncm: string | null
  unit: string | null
  taxableUnit: string | null
  gtin: string | null
  /**
   * O CST de PIS e o de COFINS da REGRA de tributação vinculada ao item (NFE.E1.P4.T4). `null` = a regra NÃO tem a peça — os grupos
   * PIS e COFINS são obrigatórios em todo item do 55 (rej. 745 e 748); ausente (`undefined`) = não conferido (item ainda sem regra
   * vinculada, que já tem a pendência própria).
   */
  pisCst?: string | null
  cofinsCst?: string | null
}
export interface InvoiceContent {
  recipient: InvoiceContentRecipient
  items: InvoiceContentItem[]
}

/** Tamanho máximo do texto das informações complementares (`infCpl`) — o texto da nota, montado só no `/invoice`. */
export const NOTE_TEXT_MAX = 5000

const text = (v: string | null | undefined): string => (v ?? '').trim()
/**
 * Só os dígitos — a máscara (pontos, traços, barras, parênteses, espaços) sai antes de contar. Para CEP, IE, telefone, NCM e código
 * do IBGE. NUNCA para CNPJ/CPF (D-CJ12): o CNPJ alfanumérico perderia as letras e viraria outro número — esses passam pela peça da
 * inscrição federal (`isValidCnpj`/`isValidCpf`).
 */
const digits = (v: string | null | undefined): string => (v ?? '').replace(/\D/g, '')

function sized(label: string, value: string, min: number, max: number): string | null {
  if (value.length === 0) return `${label} não informado`
  if (value.length < min) return `${label} com ${value.length} caractere(s) — o mínimo da NF-e é ${min}`
  if (value.length > max) return `${label} com ${value.length} caracteres — o máximo da NF-e é ${max}`
  return null
}

/** CNPJ/CPF com ou sem máscara: a peça canonicaliza (nunca apaga letra) e confere forma e dígitos verificadores. */
const validCnpj = (raw: string): boolean => { const n = normalizeCnpj(raw); return n !== null && isValidCnpj(n) }
const validCpf = (raw: string): boolean => { const n = normalizeCpf(raw); return n !== null && isValidCpf(n) }

/** As regras, puras: devolve TODAS as pendências (nunca para na primeira, nunca trunca). */
export function invoiceContentIssues(content: InvoiceContent): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const r = content.recipient
  const recipient = (field: string, message: string | null): void => {
    if (message) issues.push({ scope: 'recipient', field, message })
  }

  recipient('name', sized('Nome do destinatário', text(r.name), 2, 60))

  // CNPJ (numérico ou alfanumérico) e CPF pela peça ÚNICA da inscrição federal — a mesma do cadastro
  const federalId = text(r.document)
  if (r.personType === 'N') {
    recipient('document', 'Destinatário sem CNPJ/CPF — NF-e para destinatário sem documento ainda não é atendida')
  } else if (r.personType === 'J' && !validCnpj(federalId)) {
    recipient('document', federalId.length === 0 ? 'CNPJ do destinatário não informado' : 'CNPJ do destinatário inválido')
  } else if (r.personType === 'F' && !validCpf(federalId)) {
    recipient('document', federalId.length === 0 ? 'CPF do destinatário não informado' : 'CPF do destinatário inválido')
  }

  // IE só é exigida de pessoa jurídica contribuinte: a pessoa física não tem onde guardar a IE no cadastro de hoje
  if (r.personType === 'J' && r.stateRegistrationIndicator === '1') {
    const ie = digits(r.stateRegistration)
    if (ie.length === 0) recipient('stateRegistration', 'Destinatário contribuinte do ICMS sem inscrição estadual')
    else if (ie.length < 2 || ie.length > 14) recipient('stateRegistration', `Inscrição estadual do destinatário com ${ie.length} dígitos — a NF-e aceita de 2 a 14`)
  }

  if (!r.address) {
    recipient('address', 'Destinatário sem endereço principal')
  } else {
    const a = r.address
    recipient('street', sized('Logradouro do destinatário', text(a.street), 2, 60))
    recipient('number', sized('Número do endereço do destinatário', text(a.number), 1, 60))
    recipient('neighborhood', sized('Bairro do destinatário', text(a.neighborhood), 2, 60))
    if (text(a.complement).length > 0) recipient('complement', sized('Complemento do endereço do destinatário', text(a.complement), 1, 60))
    const zip = digits(a.zipCode)
    if (zip.length !== 8) recipient('zipCode', zip.length === 0 ? 'CEP do destinatário não informado' : `CEP do destinatário com ${zip.length} dígitos — são 8`)
    if (digits(a.cityCode).length !== 7) recipient('cityCode', 'Cidade do destinatário sem código do IBGE (7 dígitos)')
    if (!/^[A-Za-z]{2}$/.test(text(a.state))) recipient('state', 'UF do destinatário não informada')
  }

  const phone = digits(r.phone)
  if (phone.length > 0 && (phone.length < 6 || phone.length > 14)) {
    recipient('phone', `Telefone do destinatário com ${phone.length} dígitos — a NF-e aceita de 6 a 14`)
  }
  const email = text(r.email)
  if (email.length > 60) recipient('email', `E-mail do destinatário com ${email.length} caracteres — o máximo da NF-e é 60`)

  for (const it of content.items) {
    const item = (field: string, message: string | null): void => {
      if (message) issues.push({ scope: 'item', itemId: it.itemId, field, message: `Item ${it.itemId}: ${message}` })
    }
    item('description', sized('descrição do produto', text(it.description), 1, 120))
    const ncm = digits(it.ncm)
    if (ncm.length !== 8) item('ncm', ncm.length === 0 ? 'produto sem NCM no cadastro' : `NCM com ${ncm.length} dígitos — são 8`)
    if (text(it.unit).length === 0) item('unit', 'produto sem unidade de venda cadastrada')
    else item('unit', sized('unidade de venda', text(it.unit), 1, 6))
    // a unidade tributável nula é a própria unidade de venda (migration 071) — quem lê já resolveu; aqui só o tamanho
    if (text(it.taxableUnit).length > 0) item('taxableUnit', sized('unidade tributável', text(it.taxableUnit), 1, 6))
    const gtin = text(it.gtin)
    if (gtin.length > 0 && !/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(gtin)) {
      item('gtin', `código de barras (GTIN) "${gtin}" inválido — são 8, 12, 13 ou 14 dígitos`)
    }
    // só `null` acusa: a regra vinculada não tem a peça (o item ficaria sem o CST que a NF-e exige em todo item)
    if (it.pisCst === null) item('pis', 'regra de tributação sem PIS')
    if (it.cofinsCst === null) item('cofins', 'regra de tributação sem COFINS')
  }
  return issues
}

/** O CST de PIS e o de COFINS das peças de UMA regra de tributação — `null` onde a regra não tem a peça (NFE.E1.P4.T4). */
export function pisCofinsCstOf(pieces: { pisCofins?: ReadonlyArray<{ kind: 'P' | 'C'; cst: string }> } | null | undefined): {
  pisCst: string | null; cofinsCst: string | null
} {
  const cst = (kind: 'P' | 'C'): string | null => {
    const found = pieces?.pisCofins?.find(p => p.kind === kind)?.cst
    return found != null && String(found).trim() !== '' ? String(found) : null
  }
  return { pisCst: cst('P'), cofinsCst: cst('C') }
}

/** O texto da nota (`infCpl`) acima do tamanho do leiaute — pendência com o campo, nunca truncado. */
export function noteTextIssue(noteText: string | null | undefined): ValidationIssue | null {
  const len = (noteText ?? '').length
  if (len <= NOTE_TEXT_MAX) return null
  return { scope: 'order', field: 'note', message: `Observações da nota com ${len} caracteres — o máximo da NF-e é ${NOTE_TEXT_MAX}` }
}

/**
 * Lê do CADASTRO, ao vivo, o que a conferência usa — só é chamada com a marcação `authorizeNfe` (cerca de 10 consultas, pelo pool).
 * Destinatário: a cadeia fiscal da entidade (`getEntityFiscalFull`), o endereço principal (`main = 'S'`, senão o primeiro) com o
 * código do IBGE e a sigla da UF, o primeiro telefone, o e-mail (grupo 3 "nfe", senão o 1 "principal" — seed central) e o
 * indicador de IE da aba Tributação. Itens de mercadoria: a unidade do nível de venda padrão (nulo = nível 1), a do nível tributável
 * (nulo = a própria unidade de venda) e o GTIN do nível de venda; mercadoria sem unidade cadastrada volta com a unidade nula.
 */
export async function loadInvoiceContent(
  schemaName: string, institutionId: number, recipientEntityId: number,
  items: ReadonlyArray<{
    id: number; productId: number; productKind: string; productDescription?: string | null; ncm: string | null
    pisCst?: string | null; cofinsCst?: string | null
  }>,
): Promise<InvoiceContent> {
  const s = assertSchema(schemaName)
  const full = await getEntityFiscalFull(recipientEntityId)
  const tax = await getEntityTax(schemaName, institutionId, recipientEntityId)
  const main = full?.addresses.find(a => a.main === 'S') ?? full?.addresses[0] ?? null

  let cityCode: string | null = null
  let state: string | null = null
  if (main) {
    const [geo] = await pool.query<any[]>(
      `SELECT c.ibge AS cityCode, st.abbreviation AS state
         FROM setes_central.tb_city c
         JOIN setes_central.tb_state st ON st.id = ?
        WHERE c.id = ?`,
      [main.tbStateId, main.tbCityId])
    cityCode = geo[0]?.cityCode ?? null
    state = geo[0]?.state ?? null
  }
  const [mail] = await pool.query<any[]>(
    `SELECT m.email
       FROM setes_central.tb_entity_has_mailing em
       JOIN setes_central.tb_mailing m ON m.id = em.tb_mailing_id AND m.deleted = 'N'
      WHERE em.tb_entity_id = ? AND em.deleted = 'N' AND em.tb_mailing_group_id IN (3, 1)
      ORDER BY em.tb_mailing_group_id DESC
      LIMIT 1`,
    [recipientEntityId])

  const merch = items.filter(i => i.productKind !== 'S')
  const units = new Map<number, { unit: string | null; taxableUnit: string | null; gtin: string | null }>()
  if (merch.length > 0) {
    const [rows] = await pool.query<any[]>(
      `SELECT m.id AS productId, su.abbreviation AS unit, COALESCE(tu2.abbreviation, su.abbreviation) AS taxableUnit, sale.gtin
         FROM \`${s}\`.tb_merchandise m
         LEFT JOIN \`${s}\`.tb_merchandise_trade_unit sale
           ON sale.tb_institution_id = m.tb_institution_id AND sale.tb_merchandise_id = m.id
          AND sale.level = COALESCE(m.default_sale_trade_level, 1) AND sale.deleted = 'N'
         LEFT JOIN setes_central.tb_measure su ON su.id = sale.tb_measure_id
         LEFT JOIN \`${s}\`.tb_merchandise_trade_unit taxable
           ON taxable.tb_institution_id = m.tb_institution_id AND taxable.tb_merchandise_id = m.id
          AND taxable.level = m.taxable_trade_level AND taxable.deleted = 'N'
         LEFT JOIN setes_central.tb_measure tu2 ON tu2.id = taxable.tb_measure_id
        WHERE m.tb_institution_id = ? AND m.id IN (?)`,
      [institutionId, [...new Set(merch.map(i => i.productId))]])
    for (const row of rows as any[]) {
      units.set(Number(row.productId), { unit: row.unit ?? null, taxableUnit: row.taxableUnit ?? null, gtin: row.gtin ?? null })
    }
  }

  return {
    recipient: {
      personType: full?.personType ?? 'N',
      name: full?.entity.nameCompany ?? null,
      document: (full?.personType === 'F' ? full?.person?.cpf : full?.company?.cnpj) ?? null,
      stateRegistration: full?.company?.ie ?? null,
      stateRegistrationIndicator: tax?.indIeDest ?? null,
      address: main
        ? {
            street: main.street, number: main.nmbr, complement: main.complement, neighborhood: main.neighborhood,
            zipCode: main.zipCode, cityCode, state,
          }
        : null,
      phone: full?.phones.find(p => (p.number ?? '').trim() !== '')?.number ?? null,
      email: mail[0]?.email ?? null,
    },
    items: merch.map(i => ({
      itemId: i.id, description: i.productDescription ?? null, ncm: i.ncm,
      unit: units.get(i.productId)?.unit ?? null, taxableUnit: units.get(i.productId)?.taxableUnit ?? null,
      gtin: units.get(i.productId)?.gtin ?? null,
      ...(i.pisCst !== undefined ? { pisCst: i.pisCst } : {}),
      ...(i.cofinsCst !== undefined ? { cofinsCst: i.cofinsCst } : {}),
    })),
  }
}
