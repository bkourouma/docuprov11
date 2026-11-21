# Rédaction assistée par l'IA (lot 4c)

Ce document décrit le code livré par le lot 4c. Le brouillon de l'IA est toujours une proposition : l'API ne l'enregistre jamais et ne l'insère jamais dans un document.

## 1. Parcours

1. **Nouveau document depuis un modèle** : bouton « Nouveau document » de `/espaces/[spaceId]` (visible pour les contributeurs) vers `/editeur/nouveau?spaceId=<id>`. On choisit un modèle ; `POST /api/drafting/documents` crée le document avec le squelette du modèle (droit de contribution requis, même règle que la création collab) puis ouvre `/editeur/<id>?assist=1`.
2. **Panneau « Rédiger avec l'IA »** (éditeur) : modèle, consigne, case « Utiliser ce document comme contexte ». Le brouillon s'affiche en texte, comme proposition. Boutons Insérer, Remplacer la sélection, Rejeter, Régénérer. Aucune insertion sans clic.
3. **IA désactivée** : le panneau l'explique et ne propose que l'insertion des squelettes de modèles.

## 2. Modèles

Catalogue versionné dans le dépôt : `apps/api/src/modules/drafting/drafting-templates.ts` (8 modèles, dont `vide`). Aucun schéma Prisma. Chaque modèle porte un squelette HTML (liste blanche de l'éditeur) et une consigne de structure pour l'IA. Ajouter un modèle = ajouter une entrée et lancer `drafting-templates.spec.ts`.

## 3. API (`apps/api/src/modules/drafting`)

| Route | Rôle |
|---|---|
| `GET /drafting/templates` | catalogue + `aiEnabled` |
| `GET /drafting/templates/:id` | squelette HTML |
| `POST /drafting/draft` | génère un brouillon (5 par minute et par utilisateur, 429 + `Retry-After`) |
| `POST /drafting/documents` | crée un document depuis un modèle |

Contrat : `packages/types/src/ged-drafting.ts` (zod strict, limites : consigne 2000 caractères, 5 documents de contexte, 4000 caractères par document, 16000 au total, brouillon 20000).

Génération (`DraftingService.generate`) : compte humain avec profil, modèle connu, IA active (sinon réponse `disabled`, rien n'est lu), contexte, prompt, `AiService.run`, assainissement.

## 4. Sécurité

- **Droits** (`DraftingContextService`) : chaque document de contexte passe `DocumentsService.canAccess`, tous les droits sont vérifiés avant toute lecture ; un refus donne le même 404 « Document introuvable ». Un dossier ne fournit que ses documents autorisés ; sans document accessible : 404. Documents épurés exclus. Seules les métadonnées et les segments de la version courante sont lus.
- **Isolation** (`drafting-prompt.ts`) : balises à jeton aléatoire par requête, tout texte tiers (libellés, résumés, extraits, consigne) neutralisé (NFKC, caractères invisibles, chevrons), contexte avant la consigne, rappel de règle, aucun identifiant interne dans le prompt.
- **Masquage et journal** : faits par `AiService` (masquage obligatoire en cloud, tâche « Autre », `prompt_version` = `drafting-v1`, entrée masquée tronquée, SHA-256). Aucun texte de consigne, de contexte ou de brouillon dans les logs.
- **Sortie** : JSON strict, `sanitizeEditorHtml`, suppression des `span` (aucune mention ni commentaire fabriqué), validation de structure, bornes de taille. Le client n'affiche jamais le HTML : il l'insère via Tiptap, puis la salle collab valide la structure comme pour toute saisie.

## 5. Points d'attention

- Modification additive hors module : `CollabDocumentsService.createDocumentFromHtml` et son export dans `collab.module.ts`.
- Liens de notification : une mention ouvre `/editeur/<id>` (cloche) et l'e-mail utilise `TARGET_LINK.document`.
- Non vérifié sans modèle réel : qualité du français, respect des règles d'isolation par un vrai modèle, troncature à 3000 jetons de sortie. Non vérifié sans navigateur : rendu clair/sombre, focus clavier, insertion Tiptap réelle.
