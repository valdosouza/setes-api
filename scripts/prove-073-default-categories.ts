/**
 * PROVA da migration 073 (categorias padrão "Produtos"/"Serviços" — cadastro de produtos, Rodada 6: Q-PR38' (a) + Q-PR49 (a); Rodada 7:
 * a regra olha o FATO `tb_institution.source_kind` — D-PR47/D-PR48) e das peças `@shared/category-kind` em SCHEMA DESCARTÁVEL:
 *  1. a 073 TAL COMO ESTÁ roda no schema descartável contra o `setes_central` REAL (sintaxe + collation do `DATABASE()` × schema_name) e
 *     não cria nada (nenhum estabelecimento aponta para o schema descartável) — só LEITURA na central; exige a 072 já aplicada na central
 *     real (a coluna `source_kind`) — se ainda não estiver, este passo é pulado e dito;
 *  2. a 073 com a tabela da central trocada por CÓPIA no descartável (a 072 aplicada na cópia; estabelecimentos fictícios W/L/P) — cada
 *     caso da regra, duas vezes (idempotente);
 *  3. `ensureDefaultCategory`/`ensureDefaultCategories` (o ato "encerrar a transição") e `serviceCategorySql` (lookup/save do serviço
 *     pelo FATO).
 * Apaga o schema descartável no fim (inclusive em falha). NUNCA escreve em `setes_central` nem no schema de origem.
 *
 * Uso: npx tsx --require tsconfig-paths/register scripts/prove-073-default-categories.ts [schema-origem=setes_setes]
 */
import fs from 'fs'
import path from 'path'
import pool from '@shared/db/connection'
import { splitStatements } from '../src/migrations/runner'
import { ensureDefaultCategory, ensureDefaultCategories, serviceCategorySql, DEFAULT_CATEGORY_DESCRIPTION } from '@shared/category-kind'

const SOURCE = process.argv[2] ?? 'setes_setes'
const PROBE = `setes_cat_probe_${process.pid}`
const M072 = path.join(__dirname, '..', 'src', 'migrations', 'sql', '072_institution_source_kind.sql')
const M073 = path.join(__dirname, '..', 'src', 'migrations', 'sql', '073_default_categories.sql')
// estabelecimentos FICTÍCIOS (ids altos — não existem em setes_central.tb_institution: a trava da peça não acha linha e não espera)
const A = 900101, B = 900102, C = 900103, D = 900104, E = 900105, F = 900106, G = 900107, H = 900108, K = 900111

async function main() {
  if (!/^setes_[a-z0-9_]+$/.test(SOURCE)) throw new Error(`schema de origem inválido: ${SOURCE}`)
  const conn = await pool.getConnection()
  let ok = true
  const check = (label: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? 'OK  ' : 'FALHA'} ${label}${cond || got === undefined ? '' : `  (obtido: ${JSON.stringify(got)})`}`)
    ok &&= cond
  }
  const cats = async (inst: number) => (await conn.query<any[]>(
    `SELECT id, description, posit_level AS p, kind, deleted, created_at AS c FROM \`${PROBE}\`.tb_category
      WHERE tb_institution_id = ? ORDER BY id`, [inst]))[0] as any[]
  const live = (rows: any[]) => rows.filter(r => r.deleted === 'N').map(r => `${r.id}:${r.kind}:${r.p}:${r.description}`)
  try {
    await conn.query(`CREATE DATABASE \`${PROBE}\``)
    await conn.query(`CREATE TABLE \`${PROBE}\`.tb_category LIKE \`${SOURCE}\`.tb_category`)            // LIKE não copia FK
    await conn.query(`CREATE TABLE \`${PROBE}\`.tb_institution LIKE setes_central.tb_institution`)
    await conn.query(`CREATE TABLE \`${PROBE}\`.tb_sync_api_key LIKE setes_central.tb_sync_api_key`)
    // a cópia aceita vários estabelecimentos no MESMO schema (o futuro grupo) — tira o UNIQUE do schema_name só nela
    const [uq] = await conn.query<any[]>(
      `SELECT DISTINCT index_name AS n FROM information_schema.statistics
        WHERE table_schema = ? AND table_name = 'tb_institution' AND column_name = 'schema_name' AND non_unique = 0`, [PROBE])
    for (const u of uq as any[]) await conn.query(`ALTER TABLE \`${PROBE}\`.tb_institution DROP INDEX \`${u.n}\``)
    // a 072 na CÓPIA (a central real pode ainda não tê-la): a coluna source_kind nasce aqui
    for (const st of splitStatements(fs.readFileSync(M072, 'utf8')).map(s => s.replace(/setes_central/g, PROBE))) await conn.query(st)

    const statements = splitStatements(fs.readFileSync(M073, 'utf8'))
    check('073 tem os 2 INSERTs (Produtos, Serviços)', statements.length === 2, statements.length)

    // 1. TAL COMO ESTÁ, contra a central real (só se a 072 já rodou lá)
    const [centralCol] = await conn.query<any[]>(
      `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'setes_central' AND TABLE_NAME = 'tb_institution' AND COLUMN_NAME = 'source_kind'`)
    await conn.query(`USE \`${PROBE}\``)
    if ((centralCol as any[]).length > 0) {
      for (const st of statements) await conn.query(st)
      const [[{ n: none }]] = await conn.query<any[]>(`SELECT COUNT(*) AS n FROM tb_category`) as any
      check('1. 073 tal como está roda contra o setes_central real (sintaxe/collation) e não cria nada no schema sem estabelecimento',
        Number(none) === 0, none)
    } else {
      console.log('     1. (pulado) a central real ainda não tem source_kind — a 072 roda no boot ANTES da 073; o passo 2 prova a 073 na cópia')
    }

    // 2. estabelecimentos fictícios na CÓPIA da central — o FATO decide (D-PR47), nunca a chave
    const inst = (id: number, schema: string, kind: 'W' | 'L' | 'P', deleted = 'N') => conn.query(
      `INSERT INTO \`${PROBE}\`.tb_institution (id, schema_name, source_kind, active, created_at, updated_at, deleted) VALUES (?, ?, ?, 'S', NOW(), NOW(), ?)`,
      [id, schema, kind, deleted])
    const key = (id: number, instId: number, active: string, deleted = 'N') => conn.query(
      `INSERT INTO \`${PROBE}\`.tb_sync_api_key (id, api_key, tb_institution_id, establishment_code, active, created_at, updated_at, deleted)
       VALUES (?, ?, ?, 'PROVA', ?, NOW(), NOW(), ?)`, [id, `k-${id}`, instId, active, deleted])
    const cat = (id: number, instId: number, kind: string | null, deleted = 'N', active = 'S') => conn.query(
      `INSERT INTO \`${PROBE}\`.tb_category (id, tb_institution_id, description, posit_level, kind, active, created_at, updated_at, deleted)
       VALUES (?, ?, 'LEGADO', ?, ?, ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00', ?)`,
      [id, instId, String(id).padStart(3, '0'), kind, active, deleted])
    await inst(A, PROBE, 'W')                                    // nativo web, vazio → as duas
    await inst(B, PROBE, 'L'); await key(1, B, 'S')              // transição do legado → nada
    await inst(C, PROBE, 'P'); await key(2, C, 'S')              // PDV (web dona): P viva, S só excluída → só Serviços
    await cat(5, C, 'P'); await cat(7, C, 'S', 'S')
    await inst(D, PROBE, 'W'); await cat(999, D, 'P', 'S')       // MAX = 999 (excluída) → próximo 1000
    await inst(E, PROBE, 'W', 'S')                               // estabelecimento excluído → nada
    await inst(F, 'setes_outro_schema', 'W')                     // outro schema → nada
    await inst(G, PROBE, 'W'); await key(3, G, 'S')              // W COM chave viva (ex.: L encerrado para W antes de a chave cair): o FATO manda → as duas
    await inst(H, PROBE, 'W'); await cat(3, H, 'S')              // só S viva → cria só P
    await inst(K, PROBE, 'P'); await cat(6, K, 'S', 'N', 'N')    // só S INATIVA (não é viva) + P viva → cria só Serviços
    await cat(2, K, 'P')

    const swapped = statements.map(st => st.replace(/setes_central\.tb_institution\b/g, `\`${PROBE}\`.tb_institution`))
    check('a troca alcançou a tabela da central nos 2 INSERTs (a 073 não lê mais a chave)',
      swapped.every(st => !/setes_central\./.test(st) && !/tb_sync_api_key/.test(st)), swapped.map(st => (st.match(/setes_central\.\w+|tb_sync_api_key/g) ?? [])))
    for (let pass = 1; pass <= 2; pass++) for (const st of swapped) await conn.query(st)

    check('A (W, vazio): Produtos id 1 "001" e Serviços id 2 "002"',
      JSON.stringify(live(await cats(A))) === JSON.stringify(['1:P:001:Produtos', '2:S:002:Serviços']), live(await cats(A)))
    check('B (L — transição do legado): nada', (await cats(B)).length === 0, await cats(B))
    check('C (P, P viva, S excluída id 7): só Serviços id 8 "008" — MAX conta a excluída',
      JSON.stringify(live(await cats(C))) === JSON.stringify(['5:P:005:LEGADO', '8:S:008:Serviços']), live(await cats(C)))
    check('D (MAX 999 excluída): Produtos id 1000 com posit "1000" (sem truncar) e Serviços 1001',
      JSON.stringify(live(await cats(D))) === JSON.stringify(['1000:P:1000:Produtos', '1001:S:1001:Serviços']), live(await cats(D)))
    check('E (estabelecimento excluído): nada', (await cats(E)).length === 0)
    check('F (outro schema): nada', (await cats(F)).length === 0)
    check('G (W com chave viva): recebe as duas — o fato decide, a chave não',
      JSON.stringify(live(await cats(G)).map(x => x.split(':')[1])) === JSON.stringify(['P', 'S']), live(await cats(G)))
    check('H (só S viva): recebe só Produtos',
      JSON.stringify(live(await cats(H))) === JSON.stringify(['3:S:003:LEGADO', '4:P:004:Produtos']), live(await cats(H)))
    check('K (S só INATIVA, P viva): recebe só Serviços id 7 — inativa não é viva (gate adversarial R6)',
      JSON.stringify(live(await cats(K))) === JSON.stringify(['2:P:002:LEGADO', '6:S:006:LEGADO', '7:S:007:Serviços']), live(await cats(K)))
    const [[{ n: total }]] = await conn.query<any[]>(`SELECT COUNT(*) AS n FROM tb_category WHERE description IN ('Produtos', 'Serviços')`) as any
    check('passada 2 idempotente: 9 categorias padrão no total (A2 C1 D2 G2 H1 K1 — nenhuma duplicada)', Number(total) === 9, total)
    const [[raw]] = await conn.query<any[]>(`SELECT HEX(description) AS h FROM tb_category WHERE tb_institution_id = ? AND kind = 'S'`, [A]) as any
    check('"Serviços" gravado em UTF-8 (ç = C3A7)', raw.h === Buffer.from('Serviços', 'utf8').toString('hex').toUpperCase(), raw.h)
    check('as descrições da 073 são as da peça', DEFAULT_CATEGORY_DESCRIPTION.P === 'Produtos' && DEFAULT_CATEGORY_DESCRIPTION.S === 'Serviços')

    // 3. a peça do ato "encerrar a transição" + o predicado do serviço
    const I = 900109
    await cat(1, I, 'P'); await cat(2, I, 'P', 'S'); await cat(12, I, 'S', 'S')
    await cat(4, I, null)                                        // kind NULL (de antes da árvore P/S)
    await cat(5, I, 'S', 'N', 'N')                               // S viva? não: INATIVA
    const lookup = async (instId: number) => ((await conn.query<any[]>(
      `SELECT c.id FROM \`${PROBE}\`.tb_category c WHERE c.tb_institution_id = ? AND c.deleted = 'N' AND ${serviceCategorySql(PROBE, 'c')} ORDER BY c.id`,
      [instId]))[0] as any[]).map(r => Number(r.id))
    check('serviceCategorySql sem S VIVA (a única S é inativa): TODAS as não excluídas — P, kind NULL e a S inativa',
      JSON.stringify(await lookup(I)) === '[1,4,5]', await lookup(I))
    await conn.beginTransaction()
    const made = await ensureDefaultCategory(conn, PROBE, I, 'S')
    const again = await ensureDefaultCategory(conn, PROBE, I, 'S')
    await conn.commit()
    const mine = (await cats(I)).find(r => r.id === made)
    check('ensureDefaultCategory cria Serviços com id MAX+1 (13, contando excluídas) e posit "013"; 2ª chamada não cria',
      made === 13 && again === null && mine?.p === '013' && mine?.kind === 'S' && mine?.description === 'Serviços', { made, again, mine })
    check('serviceCategorySql com S viva: só as de kind S (a inativa 5 segue listada — o lookup não filtra ativo)',
      JSON.stringify(await lookup(I)) === '[5,13]', await lookup(I))
    const L = 900112                                             // o ato numa institution L vazia: as DUAS nascem; repetir não cria
    await conn.beginTransaction()
    const both = await ensureDefaultCategories(conn, PROBE, L)
    const none = await ensureDefaultCategories(conn, PROBE, L)
    await conn.commit()
    check('ensureDefaultCategories (o ato): Produtos 1 e Serviços 2 numa institution vazia; 2ª chamada { P: null, S: null }',
      JSON.stringify(both) === JSON.stringify({ P: 1, S: 2 }) && JSON.stringify(none) === JSON.stringify({ P: null, S: null }), { both, none })
  } finally {
    await conn.query(`DROP DATABASE IF EXISTS \`${PROBE}\``).catch(() => undefined)
    conn.release()
    await pool.end()
  }
  console.log(ok ? '\nPROVA OK — schema descartável apagado' : '\nPROVA FALHOU — schema descartável apagado')
  process.exit(ok ? 0 : 1)
}

main().catch(e => { console.error('FALHA', e?.message ?? e); process.exit(1) })
