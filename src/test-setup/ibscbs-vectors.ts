/**
 * Leitor dos VETORES NEUTROS do IBS/CBS (setes-api:IBS.E9.P1). Os JSON de `src/__tests__/vectors/ibscbs/` são cópia fiel de
 * `D:\Vault\projetos\fiscal-api\SUBJECT\VETORES_TESTE\` — os mesmos que o ERP Desktop lê. O sha256 é conferido sobre o texto
 * com fim de linha LF (o repositório tem `core.autocrlf=true`): cópia editada à mão ou desatualizada quebra o teste.
 * Para trocar um vetor: gere-o no Vault, copie e atualize o sha256 aqui.
 */
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

export const IBSCBS_VECTOR_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'conta-por-dentro.json': '483beb564ce7e8b90067a5f5afced23433958ced3cffe1a247acbd6756d3ffef',
  'nfe-diversos.json': '2619786d47b70427e869f6e7d24a8ba03f3fb6c43fa94d5e8791c854bb7d85db',
  'ibscbs-item.json': 'f7334d3b975bb80e8ca36a72556df329bd0b6e536f41a1bdffd6b420ac6277f2',
})

export interface VectorCase<I = Record<string, string>, O = Record<string, unknown>> {
  id: string
  descricao: string
  grau: string
  fonte: string
  entrada: I
  saida: O
}

export function loadIbscbsVector(name: string): Record<string, any> {
  const expected = IBSCBS_VECTOR_SHA256[name]
  if (!expected) throw new Error(`vetor sem sha256 registrado: ${name}`)
  const text = readFileSync(join(__dirname, '..', '__tests__', 'vectors', 'ibscbs', name), 'utf8').replace(/\r\n/g, '\n')
  const actual = createHash('sha256').update(text, 'utf8').digest('hex')
  if (actual !== expected) {
    throw new Error(`vetor ${name} difere do publicado no Vault (sha256 ${actual}; esperado ${expected})`)
  }
  return JSON.parse(text)
}

/** "123.64" → 12364 (centavos), sem ponto flutuante. */
export function centsOf(text: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text)
  if (!match) throw new Error(`valor inválido no vetor: ${text}`)
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
}

/** Fração "0.087" → 87000 (milionésimos), sem ponto flutuante. */
export function ppmOfFraction(text: string): number {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text)
  if (!match) throw new Error(`fração inválida no vetor: ${text}`)
  return Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(6, '0'))
}

/** 12364 → "123.64". */
export function reaisOf(cents: number): string {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}

/** 34800 → "0.034800". */
export function fractionOf(ppm: number): string {
  return `${Math.trunc(ppm / 1_000_000)}.${String(ppm % 1_000_000).padStart(6, '0')}`
}
