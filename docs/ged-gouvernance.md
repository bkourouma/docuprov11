# Docu-GED — Nettoyage et gouvernance (lot 5)

Détection de doublons, de données personnelles et proposition de niveau de sensibilité. L'IA et les règles PROPOSENT, un humain VALIDE ; rien n'est supprimé ni appliqué automatiquement.

## Principe

- Aucune table nouvelle : les propositions sont des lignes de `ged_ai_decision`, reconnues par `prompt_version = 'ged-governance-v1'` et `task` (5 Similarité pour les doublons, 7 Autre pour données personnelles et sensibilité). La nature est dans `output.kind` : `duplicate_exact`, `duplicate_near`, `pii`, `sensitivity`.
- Statuts visibles : 0 Proposée, 1 Validée, 2 Rejetée. Le statut « appliquée automatiquement » n'est jamais produit par la gouvernance.
- Le mode IA du journal ne peut pas valoir 0 (CHECK SQL) : une proposition purement déterministe est consignée avec mode 1, fournisseur `deterministe`, modèle `regles-gouvernance-v1`.
- Contrat partagé : `packages/types/src/ged-governance.ts` (schémas zod stricts, constantes) ; détections pures : `ged-governance-detect.ts`.

## Détections

| Nature | Méthode | IA requise |
| --- | --- | --- |
| Doublon exact | ensemble identique des empreintes `document_file.hash` (version courante) ou `ged_source_item.content_hash` | non |
| Quasi-doublon (titre) | même type, même date, similarité de titre (Jaccard) >= 0,9 | non |
| Quasi-doublon (sémantique) | cosinus des centroïdes d'embeddings >= 0,95 (pgvector) | oui |
| Données personnelles | motifs validés : e-mail, téléphone, IBAN (mod 97), carte (Luhn), NIR (clé), pièce d'identité (mot-clé) ; noms par le modèle LOCAL uniquement | noms seulement (local) |
| Sensibilité | score 0/1/2 depuis les données personnelles, mots-clés et avis du modèle, converti en niveau de la table des confidentialités (jamais d'abaissement proposé) | avis seulement |

IA désactivée : seules les détections déterministes tournent ; l'API et l'écran affichent un message clair.

L'original d'un groupe est le document le plus ancien ; les autres sont les doublons (`groupKey = dup:<idOriginal>`).

## Données personnelles : aucune valeur brute

Seuls des comptes, des scores et des contextes MASQUÉS sont stockés (`output`, `input_excerpt` tronqué comme le socle IA).

Noms de personnes : le masquage du socle ne les couvre pas. La détection des noms (et l'avis de sensibilité du modèle) n'est donc réalisée QU'EN MODE LOCAL ; en mode cloud elle est désactivée et aucun texte de document n'est envoyé au modèle par la gouvernance (`namesDetection: 'disabled_cloud'` dans le résultat d'analyse, message permanent dans l'écran). Les motifs (e-mail, téléphone, IBAN…) restent détectés par règles.

## Application d'une proposition validée

- Doublon : archivage LOGIQUE du doublon (`document.is_frozen = true`), lien vers l'original conservé dans `output` et l'audit. Réversible ; rien n'est supprimé. Refusé si l'original est lui-même gelé ou épuré.
- Sensibilité : pose de la confidentialité proposée. Direction recalculée sur l'état vivant. Élévation : un clic, niveau de permission >= 3. Abaissement : corps `confirmLowering: true` ET (administrateur OU niveau 5 avec rang propre >= rang du document).
- Données personnelles : prise d'acte, aucun effet sur le document.
- Rejet d'une proposition orpheline (document ou original supprimé) : possible pour un administrateur seulement (jamais la validation).
- La route générique `/ged/ai/decisions/:id/validate|reject` du module ai refuse (409) les décisions `ged-governance-v1` : « utilisez l'écran Gouvernance ».
- Validation et rejet : revendication atomique (409 si déjà traitée), journal d'audit (`DataChangeAudit`).

## API (`/governance`, menu `/gouvernance`, refusé par défaut)

`GET dashboard`, `GET proposals`, `GET proposals/:id`, `POST proposals/:id/validate`, `POST proposals/:id/reject`, `POST analyze` (202 ; `all` réservé aux administrateurs). Une proposition n'est visible que si l'utilisateur peut ouvrir le document ET, pour un doublon, l'original (filtre SQL `governance-access-filter.ts`, copie synchronisée des droits de `DocumentsService.canAccess` et du filtre de la recherche sémantique, test d'équivalence inclus). Les comptes du tableau de bord passent par le même filtre : aucun total global.

## Worker

File BullMQ `ged-governance` (concurrence 1) : jobs `analyze-document` et `analyze-batch` (liste d'identifiants, ou `all` paginé par curseur). Relancer une analyse ne recrée pas les propositions existantes.

## Limites connues

- `is_frozen` sert d'archivage logique ; une colonne `document.duplicate_of_id` / `archived_at` serait souhaitable plus tard (lien persistant vers l'original, distinct du gel).
- Refus de valider un doublon si l'original est gelé ou épuré.
- Totaux : le SQL contrôle les champs essentiels de `output` ; une ligne invalide seulement sur des champs secondaires peut être comptée sans être listée (écart d'un en plus au pire).
- Quasi-doublons sémantiques : `hnsw.iterative_scan` activé conditionnellement (pgvector >= 0.8), comme en recherche sémantique.

## Non vérifié sans base réelle

Le SQL (agrégats, `GROUPING SETS`, pgvector, filtres de droits, `FOR UPDATE`) n'a été validé que par la forme des requêtes avec un faux Prisma. Une recette sur PostgreSQL + pgvector avec jeux de droits reste à faire.
