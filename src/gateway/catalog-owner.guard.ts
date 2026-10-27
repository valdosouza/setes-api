import { Request, Response, NextFunction } from 'express'
import { ErrorCodes } from '@shared/errors/error-codes'
import { catalogOwnerOf, sourceKindOf, CATALOG_LEGACY_OWNED_MESSAGE } from '@shared/catalog-owner'

/**
 * Guard de ESCRITA dos cadastros que o LEGADO alimenta — pergunta "quem é o DONO do catálogo?" (cadastro de produtos, Rodada 7 —
 * D-PR47/D-PR51, Valdo 2026-10-20; substitui o `syncWriteGuard` da Rodada 6, que perguntava "a chave está ativa?"): lê o fato
 * `tb_institution.source_kind` pela peça `@shared/catalog-owner` — L (transição do desktop legado) = a web só CONSULTA; W/P = a web
 * escreve. Sem a guarda o id MAX+1 da web cairia no espaço do gerador do legado e haveria dois escritores na mesma linha (regra dos
 * dois grupos). Leitura passa (GET/HEAD/OPTIONS) sem consultar o banco; toda escrita — inclusive criar medida/embalagem na central —
 * recebe 409 legível. Sem exceção para super/admin: o problema é o segundo ESCRITOR, não o perfil. Falha fechado: institution sem
 * fato legível = 409 (nunca libera por erro).
 *
 * MÉTODO reutilizável: aplicado POR MÓDULO no gateway, na posição do superGuard/adminGuard, a cada cadastro cuja tabela está em
 * `LEGACY_OWNED_TABLES` (`LEGACY_OWNED_MODULES` = merchandise, services, price-lists, categories, financial-plans, bank-accounts).
 * Regra na skill `setes-api/skills/novo-modulo.md`. O que o legado NÃO produz fica FORA (rota própria montada ANTES do módulo guardado —
 * D-PR45: `services.fiscal.routes.ts`).
 *
 * Por que NÃO há reconferência dentro da transação do escritor (a `assertNoActiveSyncKey` da Rodada 6 morreu): o fato é MONOTÔNICO —
 * L → W/P pelo ato "encerrar a transição", nunca de volta a L. Quem passou pela guarda em W/P nunca é alcançado por um fechamento.
 */
export async function catalogOwnerGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') { next(); return }
  const inst = req.institution
  if (!inst) {
    res.status(401).json({ error: 'Não autenticado', code: 'UNAUTHORIZED', fields: [] })
    return
  }
  try {
    const kind = await sourceKindOf(inst.institutionId)
    if (kind === null || catalogOwnerOf(kind) === 'legacy') {
      res.status(409).json({ error: CATALOG_LEGACY_OWNED_MESSAGE, code: ErrorCodes.CATALOG_LEGACY_OWNED, fields: [] })
      return
    }
    next()
  } catch (err) {
    next(err)
  }
}
