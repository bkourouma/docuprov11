-- §16 — Retrait de l'écran « Types d'entité externe ».
--
-- Le type de correspondant se crée désormais depuis l'écran « Entités externes » (bouton « + » du
-- champ Type), là où le besoin apparaît. L'écran dédié n'avait plus d'objet et sa clé de menu a été
-- retirée du catalogue (apps/api/src/modules/roles/menu-catalog.ts) et de la barre latérale.
--
-- `role_menu_permission.menu_key` est un libellé de route, sans FK vers un catalogue : la
-- suppression de l'écran laisse donc des lignes qui référencent un menu inexistant. Elles ne
-- gênent aucune contrainte, mais `effectiveMenuKeys()` les renvoie telles quelles dans /auth/me —
-- un rôle continuerait d'annoncer une permission sur un écran supprimé. On les retire.
--
-- Aucune perte d'accès : les endpoints de type d'entité externe (POST/PATCH/DELETE) sont désormais
-- gardés par « /admin/courriers/entites-externes », qui est l'écran qui les appelle.

DELETE FROM "role_menu_permission" WHERE "menu_key" = '/admin/courriers/types-entite-externe';
