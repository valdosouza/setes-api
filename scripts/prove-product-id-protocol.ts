/**
 * PROVA do protocolo do id de `tb_product` (peça `@shared/product-id` — D-PR2 da frente do cadastro de produtos; regra 7 do PADROES §9):
 * N CRIADORES concorrentes (trava da institution como 1º statement → MAX sem FOR UPDATE → INSERT) disputando com M transações no
 * padrão do FATURAMENTO (trava linhas de produto e DEPOIS a institution, como o `nextSettledCode`). Esperado: zero erro, ids únicos e
 * contíguos — e, se houver deadlock, o `withDeadlockRetry` resolve (nunca 500).
 *
 * Isolamento: SCHEMA DESCARTÁVEL `setes_pid_probe_<pid>` (cópia VAZIA de tb_product) — nada é gravado fora dele. A trava, porém, é a
 * da LINHA REAL `setes_central.tb_institution` id 1 (só leitura travante, rajadas de milissegundos — a prova inteira segura a linha por
 * ~1 s; um faturamento real da Setes no meio só ESPERA). Apaga o schema no fim.
 *
 * ⚠️ CONHECIMENTO NEGATIVO (1ª rodada desta prova, 2026-10-18): com uma institution FICTÍCIA (id sem linha) a prova FALHOU — 11 de 12
 * criadores pegaram o MESMO id. `SELECT … WHERE id = ? FOR UPDATE` sobre PK INEXISTENTE vira trava de GAP, e travas de gap são
 * COMPATÍVEIS entre si: ninguém espera ninguém. A regra 7 só serializa porque a institution do JWT EXISTE (trava de REGISTRO).
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-product-id-protocol.ts [criadores=12] [faturamentos=6]
 */
import pool from '@shared/db/connection'
import { withDeadlockRetry } from '@shared/db/deadlock-retry'
import { lockInstitutionCounters, detectLockWaitSupport } from '@shared/db/counters'
import { allocateProductId } from '@shared/product-id'

const CREATORS = Number(process.argv[2] ?? 12)
const BILLINGS = Number(process.argv[3] ?? 6)
const PROBE = `setes_pid_probe_${process.pid}`
const INST = 1
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function creator(n: number): Promise<number> {
  return withDeadlockRetry('prova creator', { n }, 5, async () => {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const id = await allocateProductId(conn, PROBE, INST)
      await sleep(Math.random() * 10)                       // o trabalho do form dentro da transação
      await conn.query(
        `INSERT INTO \`${PROBE}\`.tb_product (id, identifier, tb_institution_id, description, kind, tb_category_id, created_at, updated_at, deleted)
         VALUES (?, ?, ?, 'PROVA', 'P', 0, NOW(), NOW(), 'N')`, [id, String(id), INST])
      await conn.commit()
      return id
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }
  })
}

async function billing(n: number): Promise<void> {
  return withDeadlockRetry('prova billing', { n }, 5, async () => {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      await conn.query(`SELECT id FROM \`${PROBE}\`.tb_product WHERE id = 1 AND tb_institution_id = ? FOR UPDATE`, [INST])
      await sleep(Math.random() * 10)
      await lockInstitutionCounters(conn, INST)               // o nextSettledCode do faturamento
      await conn.commit()
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }
  })
}

async function main() {
  await detectLockWaitSupport()
  const conn = await pool.getConnection()
  let ok = true
  try {
    await conn.query(`CREATE DATABASE \`${PROBE}\``)
    await conn.query(`CREATE TABLE \`${PROBE}\`.tb_product LIKE setes_setes.tb_product`)
    await conn.query(
      `INSERT INTO \`${PROBE}\`.tb_product (id, identifier, tb_institution_id, description, kind, tb_category_id, created_at, updated_at, deleted)
       VALUES (1, '1', ?, 'JÁ FATURADO', 'P', 0, NOW(), NOW(), 'N')`, [INST])
    conn.release()

    const jobs: Promise<unknown>[] = []
    for (let i = 0; i < CREATORS; i++) jobs.push(creator(i))
    for (let i = 0; i < BILLINGS; i++) jobs.push(billing(i))
    const results = await Promise.allSettled(jobs)
    const failures = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
    for (const f of failures) console.log('FALHA', f.reason?.code ?? '', f.reason?.message ?? f.reason)
    const ids = (results.slice(0, CREATORS).filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<number>[]).map(r => r.value)
    const sorted = [...ids].sort((a, b) => a - b)
    const expected = Array.from({ length: CREATORS }, (_, i) => i + 2)
    console.log(`${failures.length === 0 ? 'OK  ' : 'FALHA'} ${CREATORS} criadores + ${BILLINGS} faturamentos concorrentes sem erro (${failures.length} falhas)`)
    console.log(`${JSON.stringify(sorted) === JSON.stringify(expected) ? 'OK  ' : 'FALHA'} ids únicos e contíguos: ${sorted.join(',')}`)
    ok = failures.length === 0 && JSON.stringify(sorted) === JSON.stringify(expected)
  } finally {
    const c2 = await pool.getConnection()
    await c2.query(`DROP DATABASE IF EXISTS \`${PROBE}\``).catch(() => undefined)
    c2.release()
    await pool.end()
  }
  console.log(ok ? '\nPROVA OK — schema descartável apagado' : '\nPROVA FALHOU — schema descartável apagado')
  process.exit(ok ? 0 : 1)
}

main().catch(e => { console.error('FALHA', e?.message ?? e); process.exit(1) })
