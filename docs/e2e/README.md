# Tests de bout en bout (E2E) — stratégie

Mode d'emploi détaillé (commandes, variables, API des fixtures, pièges) : [`apps/e2e/README.md`](../../apps/e2e/README.md).

## Périmètre

La suite E2E (`apps/e2e`, paquet `@archivage/e2e`, Playwright Test, Chromium seul) vérifie
l'application telle qu'un utilisateur la voit : navigateur → web Next.js → API NestJS →
PostgreSQL / Redis → worker BullMQ. Elle complète, sans les remplacer, les tests unitaires
(`jest` côté API et worker, `tsx --test` côté web) et les e2e jest de `apps/api/test`.

Modules couverts, un dossier de specs chacun :

| Module | Dossier des specs | Scénarios | Préfixe |
| --- | --- | --- | --- |
| Socle : connexion, navigation (smoke) | `apps/e2e/tests/smoke/` | ce document (§ Smoke) | `SMK-` |
| Docu-Courriers | `apps/e2e/tests/courriers/` | [scenarios-courriers.md](scenarios-courriers.md) | `COU-` |
| Docu-Archive / archivage par QR | `apps/e2e/tests/archives/` | [scenarios-archives.md](scenarios-archives.md) | `ARC-` |
| GED (espaces, documents, recherche) | `apps/e2e/tests/ged/` | [scenarios-ged.md](scenarios-ged.md) | `GED-` |
| Docu-Flow (workflows) | `apps/e2e/tests/workflows/` | [scenarios-workflows.md](scenarios-workflows.md) | `WF-` |
| Socle et administration | `apps/e2e/tests/socle/` | [scenarios-socle.md](scenarios-socle.md) | `SOC-` |

Chaque test porte l'identifiant de son scénario dans son titre, et le scénario existe dans le
document du module.

## Hermétisme

- **Pile jetable et isolée.** Une commande monte PostgreSQL (conteneur `pgvector/pgvector:pg17`
  propre à la pile, port E2E_PG_PORT), une base logique du Redis partagé `docupro-e2e-redis`
  (127.0.0.1:6399), l'API, le worker et le web, sur des ports propres à la pile. Rien n'écoute
  ailleurs que sur 127.0.0.1. Le PostgreSQL du service local (5432) n'est jamais utilisé.
- **Environnement en liste blanche.** Les processus de la pile n'héritent que des variables
  système (PATH, TEMP…) ; toute la configuration applicative est fabriquée par
  `apps/e2e/support/stack/services.ts`, avec des valeurs de test en clair (aucun vrai secret).
- **Aucun appel externe réel** : pas de clé IA, pas de SMTP, pas d'OAuth de connecteur, pas de
  webhook sortant. Une fonction qui dépend d'un service externe se teste par ses états sans
  service (désactivée, non configurée, erreur propre) ou avec un faux serveur local démarré par
  le test lui-même.
- **Plusieurs piles en parallèle.** Chaque lot a son jeu de ports (voir le tableau dans
  `apps/e2e/README.md`) ; dossiers de travail, dossier de sortie Next, conteneur PostgreSQL et
  base Redis sont dérivés de ces ports.

## Données

- **Base de référence.** À chaque montage neuf, la base est clonée d'une base modèle qui contient :
  migrations Prisma (`migrate deploy`), SQL brut idempotent (`prisma/sql/analytics.sql`), et les
  seeds de référence : `seed.ts` (socle : administrateur, rôle système, niveaux de permission,
  catégories QR, types de fichier), puis `seed-confidentialites`, `seed-correspondants`,
  `seed-document-types`, `seed-dossiers`, `seed-classification-plan`, `seed-type-settings`,
  `seed-metadata`, `seed-life-cycles`. Les jeux de démonstration (`seed-demo`,
  `seed-dashboard-demo`, `seed-agef*`) en sont exclus.
- **Administrateur** : `ADMIN_USER` / `ADMIN_PASSWORD` (`apps/e2e/support/constants.ts`), son
  changement de mot de passe forcé est réglé par le global setup.
- **Seeds de module** : `tests/<module>/_helpers/global-seed.ts`, idempotents, exécutés après le
  socle avec un client REST administrateur.
- **Indépendance des tests.** Chaque test crée ses données (API ou interface) avec `uniq()` et ne
  suppose rien des autres tests ni de leur ordre. Une pile gardée montée n'est pas remise à zéro
  entre deux lancements : un test ne doit jamais compter sur une base vide.

## Règles d'écriture

- Sélecteurs par rôle et libellé accessible (`getByRole`, `getByLabel`) ; `data-testid` en dernier
  recours.
- Aucune attente arbitraire (`waitForTimeout`) : attendre un état (réponse réseau, élément, URL).
- On n'affaiblit jamais une assertion pour faire passer un test ; un comportement attendu qui
  relève d'une question métier ouverte se marque `test.fixme` avec la raison.
- Une suite est déclarée verte quand elle passe deux fois de suite.

## Smoke (`SMK-`)

| Id | Scénario | Résultat attendu |
| --- | --- | --- |
| SMK-01 | Connexion de l'administrateur par l'écran | arrivée sur /dashboards, menu utilisateur visible, jeton en session |
| SMK-02 | Connexion avec un mauvais mot de passe | 401, alerte « Identifiants invalides », reste sur /login, aucun jeton |
| SMK-03 | Page protégée sans session | renvoi vers /login |
| SMK-04 | Déconnexion par le menu utilisateur | renvoi vers /login, jeton effacé, page protégée inaccessible |
| SMK-05 | API : santé, profil admin, refus sans jeton | `{status:'ok'}`, admin sans changement de mot de passe exigé, 401 anonyme |
| SMK-10 à SMK-19 | Ouverture de la page d'accueil de chaque module (dashboards, courriers, acquisition, intercalaires, recherche, communication, espaces GED, workflows, administration) | aucune réponse 5xx, aucune exception, aucune erreur console, pas de renvoi vers /login |
