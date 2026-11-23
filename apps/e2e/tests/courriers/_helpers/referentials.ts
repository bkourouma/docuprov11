import type { ApiClient } from '../../../fixtures';
import { uniqueSuffix } from './unique';

/**
 * Référentiels courrier UNIQUES pour un test (libellés préfixés + suffixe unique) : natures,
 * objets, confidentialités, correspondant (entité externe) et type de départ.
 *
 * Endpoints (`apps/api/src/modules/courriers/mail-referentials.controller.ts`), écritures en admin :
 *  - `POST /courriers/referentials/natures` `{ label }`            → `{ mailNatureId, label }`
 *  - `POST /courriers/referentials/objets` `{ label }`             → `{ mailObjetId, label, ... }`
 *  - `POST /courriers/referentials/confidentialites` `{ label }`   → `{ mailConfidentialiteId, label }`
 *    (le courrier la référence sous le nom `confidentialiteId`)
 *  - `POST /courriers/referentials/external-entities` `{ label, externalEntityTypeId? }`
 *    → `{ externalEntityId, label, ... }`
 *  - `POST /courriers/referentials/depart-types` `{ label }`       → `{ mailDepartTypeId, label }`
 *
 * Hypothèses à vérifier en phase B :
 *  - Natures / objets / confidentialités exigent des menus MASQUÉS (non assignables) : seul l'admin
 *    (qui contourne la garde) peut les créer — d'où l'usage du client admin.
 *  - Les libellés sont normalisés par l'API (`normaliseLabel`) : on renvoie le libellé RÉPONDU,
 *    à utiliser tel quel dans les sélecteurs.
 *  - Le correspondant est rattaché au type « Non défini » s'il existe (seed de base), sinon sans type.
 */
export interface CourrierRefs {
  natureId: number;
  natureLabel: string;
  objetId: number;
  objetLabel: string;
  confidentialiteId: number;
  confidentialiteLabel: string;
  externalEntityId: number;
  externalEntityLabel: string;
  departTypeId: number;
  departTypeLabel: string;
}

const REF = '/courriers/referentials';

export async function createCourrierRefs(api: ApiClient, prefix: string): Promise<CourrierRefs> {
  const s = uniqueSuffix();
  const label = (kind: string) => `${prefix} ${kind} ${s}`;

  const types = (await api.get(`${REF}/external-entity-types`)) as Array<{
    externalEntityTypeId: number;
    label: string;
  }>;
  const nonDefini = types.find((t) => t.label === 'Non défini');

  const nature = (await api.post(`${REF}/natures`, { label: label('nature') })) as {
    mailNatureId: number;
    label: string;
  };
  const objet = (await api.post(`${REF}/objets`, { label: label('objet') })) as {
    mailObjetId: number;
    label: string;
  };
  const conf = (await api.post(`${REF}/confidentialites`, { label: label('confidentialite') })) as {
    mailConfidentialiteId: number;
    label: string;
  };
  const entity = (await api.post(`${REF}/external-entities`, {
    label: label('correspondant'),
    ...(nonDefini ? { externalEntityTypeId: nonDefini.externalEntityTypeId } : {}),
  })) as { externalEntityId: number; label: string };
  const departType = (await api.post(`${REF}/depart-types`, { label: label('type depart') })) as {
    mailDepartTypeId: number;
    label: string;
  };

  return {
    natureId: nature.mailNatureId,
    natureLabel: nature.label,
    objetId: objet.mailObjetId,
    objetLabel: objet.label,
    confidentialiteId: conf.mailConfidentialiteId,
    confidentialiteLabel: conf.label,
    externalEntityId: entity.externalEntityId,
    externalEntityLabel: entity.label,
    departTypeId: departType.mailDepartTypeId,
    departTypeLabel: departType.label,
  };
}

/** Correspondant seul (plus léger que `createCourrierRefs` quand le test n'a besoin que de lui). */
export async function createExternalEntity(
  api: ApiClient,
  prefix: string,
): Promise<{ externalEntityId: number; label: string }> {
  return (await api.post(`${REF}/external-entities`, {
    label: `${prefix} correspondant ${uniqueSuffix()}`,
  })) as { externalEntityId: number; label: string };
}
