# Contrat — Charge utile du QR d'intercalaire (P1 ↔ P2)

**Feature**: `001-archivage-qr` · **Decision**: D-18 (research.md) · **Spec**: FR-005, FR-035, §5.4 PRD

Ce contrat lie la **génération** (P1) et la **lecture** (P2). Le modèle de données n'en dépend pas : seules la **catégorie** et l'**id cible** sont persistés, via `intercalaire_category`.

## Format retenu — délimité, ASCII, versionné

```
DOCUPRO|1|INTERCALAIRE|{categorie}|{id}
```

| Segment | Valeur | Rôle |
|---|---|---|
| 1 | `DOCUPRO` | **Namespace** — fixe. Tout QR dont le 1er segment ≠ `DOCUPRO` est **ignoré** (QR étranger sur la feuille). |
| 2 | `1` | **Version** du contrat. Version inconnue ⇒ **rejet**. |
| 3 | `INTERCALAIRE` | **Type d'objet** — fixe pour cette feature. |
| 4 | `{categorie}` | ∈ `TYPE_DOCUMENT \| PLAN \| LOCALISATION \| DOSSIER \| BLANK`. Validée contre `intercalaire_category.category_code`. |
| 5 | `{id}` | Entier de l'élément cible. `0` pour `BLANK`. |

- **Délimiteur** : `|` (pipe, ASCII 0x7C) — sûr, sans piège d'encodage (remplace le `¦` U+00A6 legacy).
- **Encodage QR** : mode **alphanumeric** possible (payload ASCII majuscule/chiffres/`|`), QR plus dense.
- **Correction d'erreur** : niveau **Q (25 %)**. Zone de silence ≥ 4 modules. Taille de module ≥ ~0,5 mm à l'impression.

### Exemples
```
DOCUPRO|1|INTERCALAIRE|TYPE_DOCUMENT|42      # intercalaire « type de document » id 42
DOCUPRO|1|INTERCALAIRE|DOSSIER|1387          # intercalaire « dossier » id 1387 (prévaut sur dossier choisi)
DOCUPRO|1|INTERCALAIRE|BLANK|0               # séparateur vierge (clôt le document courant)
```

## Règles de validation à la lecture (P2)

1. Segment 1 ≠ `DOCUPRO` → **ignorer** (traiter la page comme « sans QR »).
2. Segment 2 ∉ versions connues (`1`) → **rejeter** le QR (page « sans QR », journaliser).
3. Segment 3 ≠ `INTERCALAIRE` → **ignorer**.
4. Segment 4 ∉ `intercalaire_category.category_code` → **rejeter**.
5. `categorie = BLANK` → `id` doit être `0` ; agit comme **séparateur** (clôt le document courant, FR-014).
6. `categorie` ouvrante → résoudre `target_table`/`target_column` via `intercalaire_category`, vérifier que `{id}` existe (et est actif) dans la table cible ; **ouvrir un nouveau document** et poser l'attribut (FR-013, FR-016).

## Comportement de découpage (rappel FR-013→016)

| Élément lu | Effet |
|---|---|
| QR catégorie **ouvrante** (TYPE/PLAN/LOCALISATION/DOSSIER) | clôt le document courant, **ouvre un nouveau document**, applique l'attribut. DOSSIER **prévaut** sur le dossier choisi à l'ouverture. |
| QR **BLANK** | **séparateur** : clôt le document courant, aucun attribut. |
| Page **sans QR** (ou QR ignoré/illisible) | **rattachée au document courant** ; si aucun document ouvert → document « sans type ». |

## Alternative documentée — JSON (non retenue)

```json
{"ns":"docupro","v":1,"k":"intercalaire","cat":"type_document","id":42}
```
Auto-descriptif et extensible, mais plus dense (force le mode byte). À adopter si le contrat doit porter davantage d'attributs ; **sans impact sur le modèle de données**.
