import { Request, Response, NextFunction } from 'express'
import { ErrorCodes } from '@shared/errors/error-codes'
import { hasActiveSyncKey, SYNC_MANAGED_MESSAGE } from '@shared/sync-key'

/**
 * Guard de ESCRITA dos catálogos que o sistema LEGADO alimenta (D-PR32 = Q-PR32 (a), Valdo 2026-10-18 — gate técnico da D-PR14 do
 * cadastro de produtos, `Infra-IA/prompts/prompt_modulo_products.md` §18): institution com `tb_sync_api_key` ATIVA recebe o cadastro do
 * sincronizador; a web nela é só CONSULTA. Sem a guarda o id MAX+1 da web cairia no espaço do código do legado e haveria dois escritores
 * na mesma linha (regra dos dois grupos). Leitura passa (GET/HEAD); toda escrita — inclusive criar marca/unidade/embalagem na central —
 * recebe 409 legível. Sem exceção para super/admin: o problema é o segundo ESCRITOR, não o perfil.
 *
 * MÉTODO reutilizável (D-PR41 revista, Rodada 6): aplicado POR MÓDULO no gateway, na posição do superGuard/adminGuard, a cada cadastro
 * que o legado alimenta — hoje `merchandise`, `services`, `price-lists` e `categories`. A tabela do cadastro entra também em
 * `SYNC_FED_TABLES` (`@shared/sync-key`): é por ela que religar a chave confere o que nasceu na web no período desligado (Q-PR47).
 * Regra na skill `setes-api/skills/novo-modulo.md`.
 *
 * A guarda lê a chave FORA da transação do escritor: quem CUNHA id numa tabela do legado reconfere a chave DEPOIS da trava da institution
 * (`assertNoActiveSyncKey` — produto/serviço pela `@shared/product-id`, categoria e tabela de preço nos repositórios), que é a trava que o
 * ato de religar segura — o escritor que esperou o religar desiste com o mesmo 409 (gate socrático da Rodada 6). Edição/exclusão de linha
 * existente não cunha id e não é reconferida (o religar só conta o que NASCEU).
 */
export async function syncWriteGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') { next(); return }
  const inst = req.institution
  if (!inst) {
    res.status(401).json({ error: 'Não autenticado', code: 'UNAUTHORIZED', fields: [] })
    return
  }
  try {
    if (await hasActiveSyncKey(inst.institutionId)) {
      res.status(409).json({
        error: SYNC_MANAGED_MESSAGE,
        code: ErrorCodes.SYNC_MANAGED_CATALOG, fields: [],
      })
      return
    }
    next()
  } catch (err) {
    next(err)
  }
}
