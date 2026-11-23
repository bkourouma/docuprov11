/**
 * Sécurité Documentaire — EFFET réel des réglages sur la visibilité des documents (« le vrai test »
 * de la recette, plan sécurité §9). Règles : `DocumentsService.canAccess` (fiche, 404 si refus) et
 * `SearchService.buildWhere` (recherche), qui doivent dire la même chose.
 *
 * P3, non réalisés en phase A : l'API n'expose AUCUNE création directe de document. Un document
 * naît de l'acquisition par lot (`POST /batches`, `POST /batches/:id/files` avec un PDF porteur
 * de QR, puis traitement asynchrone par le worker BullMQ) et ne reçoit sa confidentialité que par
 * l'indexation (`PATCH /documents/:id/indexation`). Monter ce parcours ici toucherait le module
 * acquisition (autre lot) et dépendrait du worker. À reprendre en phase B dès qu'une aide
 * « créer un document indexé » existe dans la suite (lot acquisition), avec un type de document
 * CRÉÉ PAR LE TEST (un droit par type restreint tous les documents du type).
 */
import { test } from '../../../fixtures';

test.fixme(
  'SOC-60 droit par type : sans droit sur un type restreint, le document disparaît de la recherche et sa fiche rend 404',
  async () => {
    // Étapes prévues :
    // 1. admin : type T (uniq), document D de type T, sans confidentialité ;
    // 2. utilisateur U (rôle R, acteur) : D visible (`POST /documents/search`) et `GET /documents/:id` 200 —
    //    un type sans aucun droit n'est pas restreint ;
    // 3. admin : droit Consultation sur T pour un AUTRE rôle → U : D absent de la recherche, fiche 404 ;
    // 4. admin : droit Consultation sur T pour R → U : D visible, niveau effectif 2 (indexation 403) ;
    // 5. droit Administration (4) sur T pour R → `PATCH /documents/:id/indexation` permis ;
    // 6. droit daté échu (endDate < aujourd'hui) → sans effet, D de nouveau masqué.
  },
);

test.fixme(
  'SOC-61 confidentialité : un document de rang supérieur à l’habilitation est invisible (recherche + fiche 404), visible à rang égal',
  async () => {
    // Étapes prévues :
    // 1. admin : document D indexé avec le niveau de rang le plus élevé (liste triée par rang) ;
    // 2. U sans habilitation → D absent de la recherche, `GET /documents/:id` 404 ;
    // 3. `PATCH /users/confidentialite` U → niveau inférieur → toujours 404 ;
    // 4. U → même niveau que D → 200 ;
    // 5. le créateur de D garde l'accès même sous-habilité ;
    // 6. niveau de D désactivé ensuite : vérifier la règle effective (aujourd'hui TOUJOURS appliquée,
    //    le plan sécurité §5.3 annonce l'inverse — question ouverte, voir rapport tâche C).
  },
);
