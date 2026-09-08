-- AlterTable
ALTER TABLE "acquisition_batch" ADD COLUMN     "processed_files" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "use_intercalaires" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "app_user" ADD COLUMN     "role_id" INTEGER;

-- CreateTable
CREATE TABLE "analytics_target" (
    "target_id" SERIAL NOT NULL,
    "scope" VARCHAR(20) NOT NULL DEFAULT 'global',
    "scope_ref_id" INTEGER,
    "period_kind" VARCHAR(10) NOT NULL,
    "period_start" DATE NOT NULL,
    "metric" VARCHAR(20) NOT NULL DEFAULT 'documents',
    "target_value" INTEGER NOT NULL,
    "note" VARCHAR(255),
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(0),

    CONSTRAINT "analytics_target_pkey" PRIMARY KEY ("target_id")
);

-- CreateTable
CREATE TABLE "role" (
    "role_id" SERIAL NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(400),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_pkey" PRIMARY KEY ("role_id")
);

-- CreateTable
CREATE TABLE "role_menu_permission" (
    "role_menu_permission_id" SERIAL NOT NULL,
    "role_id" INTEGER NOT NULL,
    "menu_key" VARCHAR(200) NOT NULL,

    CONSTRAINT "role_menu_permission_pkey" PRIMARY KEY ("role_menu_permission_id")
);

-- CreateIndex
CREATE INDEX "analytics_target_period_start_idx" ON "analytics_target"("period_start");

-- CreateIndex
CREATE INDEX "analytics_target_scope_scope_ref_id_idx" ON "analytics_target"("scope", "scope_ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_target_scope_scope_ref_id_period_kind_period_star_key" ON "analytics_target"("scope", "scope_ref_id", "period_kind", "period_start", "metric");

-- CreateIndex
CREATE INDEX "role_menu_permission_role_id_idx" ON "role_menu_permission"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_menu_permission_role_id_menu_key_key" ON "role_menu_permission"("role_id", "menu_key");

-- AddForeignKey
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("role_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_menu_permission" ADD CONSTRAINT "role_menu_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("role_id") ON DELETE CASCADE ON UPDATE CASCADE;
