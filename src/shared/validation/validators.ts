/**
 * Validadores COMPARTILHADOS (Fase 2 campos configuráveis, decisão 18):
 * funções puras usadas pelos DTOs Zod e services de qualquer módulo.
 * Espelho no app: package setes_validators (decisão 22) — manter as regras
 * IDÊNTICAS nos dois lados (API = fonte da verdade, decisão 1).
 *
 * Dados chegam e são gravados SEM máscara (decisão 19).
 *
 * INSCRIÇÃO FEDERAL (CPF/CNPJ — D-CJ2, frente do CNPJ alfanumérico, 2026-10-15): a regra NÃO mora mais aqui — é a peça pura do núcleo
 * (`fiscal-api/federal-id`), reexportada abaixo (a superfície da decisão 18 fica; a implementação vira uma só, com o espelho Dart lendo o
 * MESMO vetor de casos). CNPJ = 12 alfanuméricos MAIÚSCULOS + 2 DV numéricos (DV ASCII − 48); "normalizar" = canonicalizar, NUNCA apagar.
 * O antigo "tira o que não é dígito" morreu com a pesquisa por documento (D-CJ9): aplicado a um CNPJ alfanumérico dá OUTRO número.
 */
export {
  isValidCpf, isValidCnpj, normalizeCnpj, normalizeCpf, canonicalizeFederalIdText, formatCnpj, formatCpf, readFederalIdFact,
} from 'fiscal-api/federal-id'
export type { FederalId, FederalIdKind, FederalIdFact } from 'fiscal-api/federal-id'

/**
 * NCM PLENO: exatamente 8 dígitos (D36 da fase Faturamento — o motor casa por IGUALDADE EXATA; rejeição 777 da NF-e exige o
 * código completo). D-PR13 da frente do cadastro de produtos (2026-10-17): o seletor da regra de tributação aceitava 2–8 dígitos e o
 * NCM parcial nunca casava. Só a FORMA: a existência no catálogo é da carga própria (D-PR6). Sem tirar separador aqui — quem recebe
 * máscara canoniza antes (nunca `replace(/\D/g…)` — cerca D-CJ12).
 */
export function isNcm(value: string): boolean {
  return /^\d{8}$/.test(value)
}

/**
 * CEST: exatamente 7 dígitos (Convênio ICMS 142/2018 — cadastro de produtos, D-PR6). Só a FORMA — a existência no catálogo central
 * é da carga própria. A presença do CEST é o que DERIVA a ST do produto (R5-Q5) — nunca uma flag.
 */
export function isCest(value: string): boolean {
  return /^\d{7}$/.test(value)
}

/**
 * GTIN GS1 (cEAN/cEANTrib da NF-e — cadastro de produtos, D-PR15/D-PR19): 8, 12, 13 ou 14 dígitos com o dígito verificador do módulo
 * 10 da GS1 (pesos 3 e 1 alternados a partir do dígito à esquerda do DV). Só forma + DV: os PREFIXOS GS1 são dado versionado
 * (D-NE116) e entram com o consumidor (NE-6); código próprio/de balança (prefixo 2) não é GTIN (D-PR17) e não é recusado aqui.
 * Ausência de GTIN = NULL — o literal "SEM GTIN" é só do XML. Espelho Dart: `SetesValidators.isGtin`, mesmo vetor
 * (`gtin.vector.json`).
 */
export function isGtin(value: string): boolean {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(value)) return false
  if (/^0+$/.test(value)) return false   // todo zero fecha o DV mas não é GTIN de ninguém (ADV2-03 — o 1º produto o "capturaria")
  const digits = value.split('').map(Number)
  const check = digits.pop() as number
  let sum = 0
  for (let i = digits.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) sum += digits[i] * weight
  return (10 - (sum % 10)) % 10 === check
}

/**
 * IDENTIDADE GS1 do GTIN: a forma de 14 dígitos (zeros à esquerda). O GTIN-13 7891234567895 e o GTIN-14 07891234567895 são o MESMO
 * código — a unicidade (D-PR19) compara por aqui; o que se GRAVA é o digitado (é o cEAN impresso). A-PR3 (gate adversarial ADV-05,
 * 2026-10-18); espelho no banco: `live_gtin` da migration 071 = LPAD(gtin, 14, '0').
 */
export function gtinIdentity(gtin: string): string {
  return gtin.padStart(14, '0')
}

/** true se o valor contém apenas dígitos (vazio conta como true). */
export function isOnlyDigits(value: string): boolean {
  return /^\d*$/.test(value)
}

/**
 * Valor casa com a máscara? Padrão técnico da casa (decisão 16):
 * `#` = dígito, `A` = letra, qualquer outro caractere é literal obrigatório.
 * Ex.: matchesMask('(##) #-####-####', '(31) 9-8888-7777') === true.
 * Máscara vazia/nula = sem restrição.
 */
export function matchesMask(mask: string | null | undefined, value: string): boolean {
  if (!mask) return true
  if (mask.length !== value.length) return false
  for (let i = 0; i < mask.length; i++) {
    const m = mask[i]
    const c = value[i]
    if (m === '#') { if (!/\d/.test(c)) return false }
    else if (m === 'A') { if (!/[a-zA-ZÀ-ÿ]/.test(c)) return false }
    else if (m !== c) return false
  }
  return true
}

/**
 * Data de CALENDÁRIO em 'YYYY-MM-DD'. O regex de formato sozinho aceita
 * '2026-13-45', e o MariaDB sem strict mode grava isso como '0000-00-00' —
 * o gate adversarial da Onda 1 (fase Primeiro Cliente) faturou uma ordem com
 * vencimento zerado no título E no BOLETO, que é imutável por decisão.
 * Aqui a data tem que EXISTIR: o round-trip prova mês e dia.
 */
export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1) return false
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y
      && date.getUTCMonth() === m - 1
      && date.getUTCDate() === d
}
