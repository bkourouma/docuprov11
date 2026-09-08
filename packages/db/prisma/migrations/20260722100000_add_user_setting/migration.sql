-- Préférences utilisateur en clé-valeur JSON — équivalent du `SettingManager` d'ABP (table
-- `AbpSettings`), sans dimension tenant (V6 est mono-tenant).
--
-- Aucune table ne modélise les widgets ni leurs positions : le tableau de bord personnalisable
-- range son agencement complet sous UNE clé, en `jsonb`. Toute autre fonctionnalité peut réutiliser
-- ce magasin sans nouvelle migration.
--
-- NOTE — Cette migration est écrite à la main plutôt que reprise telle quelle de
-- `prisma migrate diff`. Le diff proposait aussi de recréer deux clés étrangères de `mail`
-- (`mail_destinataire_expediteur_fkey`, `mail_destinataire_role_id_fkey`) pour passer leur
-- ON DELETE de RESTRICT / NO ACTION à SET NULL : c'est une DÉRIVE PRÉEXISTANTE entre le schéma
-- Prisma et la base, sans rapport avec le tableau de bord. La corriger ici modifierait
-- silencieusement le comportement de suppression sur une table de production — à traiter
-- séparément, en connaissance de cause.

-- CreateTable
CREATE TABLE "user_setting" (
    "user_setting_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "setting_key" VARCHAR(200) NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_setting_pkey" PRIMARY KEY ("user_setting_id")
);

-- CreateIndex
CREATE INDEX "user_setting_user_id_idx" ON "user_setting"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_setting_user_id_setting_key_key" ON "user_setting"("user_id", "setting_key");

-- AddForeignKey
ALTER TABLE "user_setting" ADD CONSTRAINT "user_setting_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
