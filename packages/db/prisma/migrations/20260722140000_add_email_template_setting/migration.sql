-- Identité affichée dans les e-mails de notification (§03.5) : logo, nom de l'organisation,
-- coordonnées. Ces valeurs vivaient dans les variables d'environnement `MAIL_*`, ce qui imposait un
-- redémarrage de l'API pour corriger un libellé. Elles passent en base, éditables depuis l'écran
-- « Paramétrage e-mail ».
--
-- LIGNE UNIQUE, garantie par un CHECK sur la clé primaire plutôt que par convention applicative :
-- sans lui, un `INSERT` distrait créerait une seconde identité et l'e-mail dépendrait de l'ordre de
-- lecture. Le CHECK n'est pas exprimable en Prisma, d'où le SQL brut (même procédé que les uniques
-- partiels du schéma courrier).
--
-- Aucune valeur n'est semée : une base vierge doit produire un e-mail neutre, sans marque, plutôt
-- que la marque du projet d'origine. Le gabarit omet chaque champ non renseigné.
--
-- NOTE — Migration écrite à la main. `prisma migrate diff` propose en plus de recréer deux clés
-- étrangères de `mail` (`mail_destinataire_expediteur_fkey`, `mail_destinataire_role_id_fkey`) pour
-- faire passer leur ON DELETE de RESTRICT / NO ACTION à SET NULL : dérive PRÉEXISTANTE entre le
-- schéma Prisma et la base, sans rapport avec ce paramétrage. La corriger ici modifierait
-- silencieusement le comportement de suppression d'une table de production.

-- CreateTable
CREATE TABLE "email_template_setting" (
    "email_template_setting_id" INTEGER NOT NULL DEFAULT 1,
    "org_name" VARCHAR(200),
    "org_tagline" VARCHAR(200),
    "product_name" VARCHAR(120),
    "baseline" VARCHAR(200),
    "logo_file_name" VARCHAR(260),
    "logo_original_name" VARCHAR(260),
    "logo_url" VARCHAR(500),
    "accent_color" VARCHAR(7),
    "address_line" VARCHAR(300),
    "phone" VARCHAR(60),
    "contact_email" VARCHAR(200),
    "website_url" VARCHAR(300),
    "footer_note" VARCHAR(500),
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "email_template_setting_pkey" PRIMARY KEY ("email_template_setting_id")
);

-- Singleton : une seule identité par déploiement.
ALTER TABLE "email_template_setting"
    ADD CONSTRAINT "ck_email_template_setting_singleton"
    CHECK ("email_template_setting_id" = 1);

-- Couleur d'accent : `#rrggbb` uniquement. Le gabarit l'injecte telle quelle dans un attribut
-- `style` ; une valeur libre y ouvrirait une injection CSS.
ALTER TABLE "email_template_setting"
    ADD CONSTRAINT "ck_email_template_setting_accent_color"
    CHECK ("accent_color" IS NULL OR "accent_color" ~ '^#[0-9A-Fa-f]{6}$');
