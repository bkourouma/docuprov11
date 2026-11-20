# Recherche sémantique et questions-réponses (lot 3)

Ce document décrit ce que fait le code de la copie de travail `ged-ia-lot-3`. Il s'appuie sur le socle IA décrit dans `docs/ged-ia.md`. L'exécution réelle sur PostgreSQL avec pgvector n'a pas pu être vérifiée (voir section 9).

## 1. Vue d'ensemble

- **Indexation** (worker) : le texte OCR de la version courante d'un document est découpé en segments, vectorisé, puis écrit dans `ged_document_chunk` (colonne `vector(1024)`).
- **Recherche** (API) : la requête est vectorisée par `AiService.embed`, puis comparée aux segments par distance cosinus (`<=>`, index HNSW). Le filtre de droits est dans la même requête SQL.
- **Questions-réponses** : les segments autorisés (8 au plus) sont envoyés à `AiService.run` (tâche `Question`), masqués selon le mode du client. La réponse cite ses sources (document, version, pages).
- **IA désactivée** : retombée sur la recherche plein texte existante, avec un message clair. Aucun appel d'embedding ni de génération.

Contrat partagé : `packages/types/src/ged-search.ts`.

## 2. Indexation (worker)

Fichiers : `apps/worker/src/processors/embedding-*.ts`. File BullMQ `ged-embedding`, concurrence 1.

| Job | Effet |
|---|---|
| `reindex-document` | Remplace les segments d'un document (version courante). Un document non archivé, épuré ou gelé est non indexable : ses segments sont supprimés. |
| `reindex-all` | Met en file un `reindex-document` par document archivé indexable (curseur, lots de 500). |
| `sweep` | Rattrapage planifié toutes les 10 minutes (200 documents au plus par passage) : index absent, rattaché à une autre version, ou antérieur à `modified_at`. |

- Découpage : environ 800 caractères, chevauchement 120, coupe sur fin de paragraphe, de phrase ou d'espace.
- Embeddings : appel HTTP `/embeddings` compatible OpenAI, par lots de 16. Le texte est masqué avant envoi (obligatoire en cloud). La dimension doit valoir exactement 1024.
- Écriture : une transaction (`DELETE` puis `INSERT` paramétré, `::vector`). Elle n'est ouverte qu'une fois tous les vecteurs reçus : un échec d'embedding laisse l'ancien index intact.
- Pages : `ocr_text` est agrégé sans saut de page à l'ingestion. Les pages d'un segment ne sont renseignées que si le texte contient des `\f` en nombre égal à `page_count`, ou si le fichier n'a qu'une page. Sinon `page_from` et `page_to` valent `NULL`.
- Pas de hook dans `doc-versions` (hors périmètre) : le `sweep` couvre un changement de version avec un délai de 10 minutes au plus.

## 3. Filtre de droits

Fichier : `apps/api/src/modules/semantic-search/semantic-access-filter.ts`. Il produit une expression SQL sur l'alias `d` (table `document`), insérée dans le `WHERE` de la requête de plus proches voisins. Les droits sont donc appliqués avant et pendant la recherche.

Règle, identique à `SearchService.buildWhere` et à `DocumentsService.canAccess` :

1. Document archivé, non épuré (`document_state <> 3`), non gelé (`is_frozen = false`) : pour tous, administrateurs compris.
2. Administrateur ou agent de numérisation : pas d'autre condition.
3. Autres utilisateurs : confidentialité (rang, créateur, droit nominatif sur le document) et permissions (refus explicite en vigueur, qui l'emporte sur tout ; créateur ; document ou type sans droit = non restreint ; droit sur le document ou sur le type).

Un test de synchronisation compare le SQL au `WHERE` de `/search` (hors conditions d'épuration et de gel). Toute dérive de `search.service.ts` fait échouer ce test.

## 4. Requête pgvector

Fichier : `semantic-vector.sql.ts`. Vecteur, modèle et limite sont des paramètres liés. Seuls les segments du modèle d'embedding courant et de la version courante (`dv.is_current`) remontent. Le service exécute une transaction qui lit `current_setting('hnsw.iterative_scan', true)` et ne fait `SET LOCAL hnsw.iterative_scan = relaxed_order` que si le réglage existe (pgvector 0.8 ou plus).

## 5. API

`POST /api/semantic-search` et `POST /api/semantic-search/ask` : menu RBAC `/recherche-ia` (« Recherche IA »), accès refusé par défaut, corps zod strict (question de 1000 caractères au plus). `POST /api/semantic-search/reindex` : administrateurs seulement.

Limite de débit : fenêtre glissante en mémoire par utilisateur, 20 requêtes par minute pour la recherche, 6 pour les questions (429 et `Retry-After`). Elle est propre à chaque processus et n'est pas partagée entre instances.

La réponse ne contient jamais de total global ni de message distinguant « existe mais interdit ».

## 6. Questions-réponses et sécurité

Fichier : `semantic-qa-prompt.ts`.

- Les extraits sont des données. Le message système interdit de suivre toute consigne contenue dans un extrait. Chaque extrait est entouré de balises portant un jeton aléatoire par requête, et le texte est neutralisé (chevrons, caractères de contrôle, jeton). La question vient après les extraits.
- `resolveCitations` ne retient que les numéros d'extraits fournis. Sans citation valide, la réponse est « Je ne sais pas ».
- Sans segment de similarité suffisante (seuil 0,30), le modèle n'est pas appelé. La décision est quand même journalisée dans `ged_ai_decision`, avec un libellé fixe, la longueur et le SHA-256 de la question, jamais son texte.
- `AiService.run` masque le texte et journalise chaque appel. Aucun texte non masqué n'est journalisé.
- Une erreur du fournisseur donne un 503 générique.

## 7. Page web

`apps/web/app/recherche-ia/` : question (Entrée envoie, Maj+Entrée saute une ligne), réponse en texte avec marqueurs `[n]` cliquables, sources citées, résultats, état « IA désactivée », clair et sombre. La visionneuse `/documents/<id>` n'accepte aucun paramètre de version ni de page : les liens pointent vers le document, version et pages sont affichées à côté.

## 8. Hypothèses métier

- Segments d'environ 800 caractères avec chevauchement de 120.
- 8 segments envoyés au modèle ; seuil de similarité 0,30 (à calibrer selon le modèle d'embedding).
- La recherche ne couvre que les documents indexés.
- Les documents gelés sont exclus (décision prudente, `/search` les inclut).
- L'état « Restreint » (2) n'est pas exclu, comme dans `/search`.

## 9. Non vérifié sans base réelle

- Exécution du SQL (droits, pgvector, HNSW, `iterative_scan`, contraintes CHECK et index unique partiel).
- Typage des paramètres entiers de Prisma dans `$executeRaw`.
- Comportement réel de BullMQ (`upsertJobScheduler`, déduplication par `jobId`).
- Efficacité des consignes anti-injection sur un vrai modèle.
- Rendu de la page dans un navigateur.
