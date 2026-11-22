-- Docu-Flow (workflow) — fondations de données (2026-11-21) : 16 tables `wf_*`.
-- Modèles : packages/db/prisma/models/wf.prisma. Miroir TS : packages/types/src/wf-*.ts.
--
-- Migration ADDITIVE : uniquement des CREATE TABLE / CREATE INDEX / ADD CONSTRAINT sur des objets
-- NEUFS, aucun DROP, aucun ALTER d'une table existante, aucune FK vers une table existante.
-- Écrite en deux temps : `prisma migrate diff` (CREATE TABLE / INDEX / FOREIGN KEY) puis SQL brut
-- (CHECK ck_*, uniques partiels ux_*, index partiels ix_*, déclencheurs wf_*, ligne budgétaire par
-- défaut) — la partie SQL brut est identique à prisma/sql/wf.sql.

-- CreateTable
CREATE TABLE "wf_definition" (
    "wf_definition_id" SERIAL NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "status" SMALLINT NOT NULL DEFAULT 0,
    "source" SMALLINT NOT NULL DEFAULT 0,
    "is_low_risk" BOOLEAN NOT NULL DEFAULT false,
    "low_risk_marked_by" INTEGER,
    "low_risk_marked_at" TIMESTAMPTZ(0),
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wf_definition_pkey" PRIMARY KEY ("wf_definition_id")
);

-- CreateTable
CREATE TABLE "wf_definition_version" (
    "wf_definition_version_id" SERIAL NOT NULL,
    "definition_id" INTEGER NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" SMALLINT NOT NULL DEFAULT 0,
    "graph" JSONB NOT NULL,
    "graph_hash" VARCHAR(64),
    "source_prompt" TEXT,
    "change_note" VARCHAR(500),
    "published_by" INTEGER,
    "published_at" TIMESTAMPTZ(0),
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wf_definition_version_pkey" PRIMARY KEY ("wf_definition_version_id")
);

-- CreateTable
CREATE TABLE "wf_instance" (
    "wf_instance_id" BIGSERIAL NOT NULL,
    "definition_id" INTEGER NOT NULL,
    "definition_version_id" INTEGER NOT NULL,
    "status" SMALLINT NOT NULL DEFAULT 0,
    "context" JSONB NOT NULL DEFAULT '{}',
    "started_by" INTEGER NOT NULL,
    "trigger_id" INTEGER,
    "parent_instance_id" BIGINT,
    "subject_type" VARCHAR(50),
    "subject_id" BIGINT,
    "idempotency_key" VARCHAR(200),
    "due_at" TIMESTAMPTZ(0),
    "error_message" TEXT,
    "row_version" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(0),
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wf_instance_pkey" PRIMARY KEY ("wf_instance_id")
);

-- CreateTable
CREATE TABLE "wf_task" (
    "wf_task_id" BIGSERIAL NOT NULL,
    "instance_id" BIGINT NOT NULL,
    "step_key" VARCHAR(100) NOT NULL,
    "task_type" SMALLINT NOT NULL,
    "status" SMALLINT NOT NULL DEFAULT 0,
    "title" VARCHAR(300) NOT NULL,
    "instructions" TEXT,
    "priority" SMALLINT NOT NULL DEFAULT 1,
    "assignee_user_group_id" INTEGER,
    "assignee_group_id" INTEGER,
    "assignee_role_id" INTEGER,
    "due_at" TIMESTAMPTZ(0),
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "input" JSONB,
    "result" JSONB,
    "started_at" TIMESTAMPTZ(0),
    "completed_at" TIMESTAMPTZ(0),
    "completed_by" INTEGER,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wf_task_pkey" PRIMARY KEY ("wf_task_id")
);

-- CreateTable
CREATE TABLE "wf_timer" (
    "wf_timer_id" BIGSERIAL NOT NULL,
    "instance_id" BIGINT NOT NULL,
    "task_id" BIGINT,
    "step_key" VARCHAR(100) NOT NULL,
    "kind" SMALLINT NOT NULL,
    "status" SMALLINT NOT NULL DEFAULT 0,
    "fire_at" TIMESTAMPTZ(0) NOT NULL,
    "fired_at" TIMESTAMPTZ(0),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB,
    "locked_by" VARCHAR(100),
    "locked_until" TIMESTAMPTZ(0),
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wf_timer_pkey" PRIMARY KEY ("wf_timer_id")
);

-- CreateTable
CREATE TABLE "wf_event_log" (
    "wf_event_log_id" BIGSERIAL NOT NULL,
    "instance_id" BIGINT NOT NULL,
    "task_id" BIGINT,
    "step_key" VARCHAR(100),
    "event_type" VARCHAR(80) NOT NULL,
    "actor_kind" SMALLINT NOT NULL DEFAULT 0,
    "actor_user_group_id" INTEGER,
    "instruction" TEXT,
    "sources" JSONB,
    "decision" JSONB,
    "explanation" TEXT,
    "confidence" DECIMAL(4,3),
    "autonomy_level" SMALLINT,
    "model" VARCHAR(200),
    "ai_decision_id" BIGINT,
    "prompt_tokens" INTEGER,
    "completion_tokens" INTEGER,
    "cost_amount" DECIMAL(14,4),
    "validated_by" INTEGER,
    "validated_at" TIMESTAMPTZ(0),
    "corrects_event_id" BIGINT,
    "occurred_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wf_event_log_pkey" PRIMARY KEY ("wf_event_log_id")
);

-- CreateTable
CREATE TABLE "wf_trigger" (
    "wf_trigger_id" SERIAL NOT NULL,
    "definition_id" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "run_as_user_group_id" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_fired_at" TIMESTAMPTZ(0),
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wf_trigger_pkey" PRIMARY KEY ("wf_trigger_id")
);

-- CreateTable
CREATE TABLE "wf_tool" (
    "wf_tool_id" SERIAL NOT NULL,
    "tool_key" VARCHAR(100) NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "side_effect" SMALLINT NOT NULL DEFAULT 0,
    "requires_validation" BOOLEAN NOT NULL DEFAULT false,
    "input_schema" JSONB,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wf_tool_pkey" PRIMARY KEY ("wf_tool_id")
);

-- CreateTable
CREATE TABLE "wf_tool_grant" (
    "wf_tool_grant_id" SERIAL NOT NULL,
    "definition_id" INTEGER NOT NULL,
    "tool_id" INTEGER NOT NULL,
    "max_calls_per_instance" INTEGER,
    "granted_by" INTEGER,
    "granted_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wf_tool_grant_pkey" PRIMARY KEY ("wf_tool_grant_id")
);

-- CreateTable
CREATE TABLE "wf_agent_config" (
    "wf_agent_config_id" SERIAL NOT NULL,
    "definition_version_id" INTEGER NOT NULL,
    "step_key" VARCHAR(100) NOT NULL,
    "objective" TEXT NOT NULL,
    "autonomy_level" SMALLINT NOT NULL DEFAULT 0,
    "confidence_threshold" DECIMAL(4,3) NOT NULL DEFAULT 0.800,
    "model" VARCHAR(200),
    "max_steps" INTEGER NOT NULL DEFAULT 10,
    "max_cost_per_run" DECIMAL(14,4),
    "timeout_seconds" INTEGER NOT NULL DEFAULT 120,
    "eval_set_id" INTEGER,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wf_agent_config_pkey" PRIMARY KEY ("wf_agent_config_id")
);

-- CreateTable
CREATE TABLE "wf_agent_config_tool" (
    "agent_config_id" INTEGER NOT NULL,
    "tool_id" INTEGER NOT NULL,

    CONSTRAINT "wf_agent_config_tool_pkey" PRIMARY KEY ("agent_config_id","tool_id")
);

-- CreateTable
CREATE TABLE "wf_budget" (
    "wf_budget_id" SERIAL NOT NULL,
    "definition_id" INTEGER,
    "period_kind" SMALLINT NOT NULL DEFAULT 0,
    "period_start" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cap_amount" DECIMAL(14,4),
    "consumed_amount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "consumed_tokens" BIGINT NOT NULL DEFAULT 0,
    "alert_threshold" DECIMAL(4,3) NOT NULL DEFAULT 0.800,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'XOF',
    "emergency_stop" BOOLEAN NOT NULL DEFAULT false,
    "emergency_stop_at" TIMESTAMPTZ(0),
    "emergency_stop_by" INTEGER,
    "emergency_stop_reason" VARCHAR(500),
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "wf_budget_pkey" PRIMARY KEY ("wf_budget_id")
);

-- CreateTable
CREATE TABLE "wf_eval_set" (
    "wf_eval_set_id" SERIAL NOT NULL,
    "definition_id" INTEGER NOT NULL,
    "step_key" VARCHAR(100),
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "min_accuracy" DECIMAL(4,3) NOT NULL DEFAULT 0.900,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wf_eval_set_pkey" PRIMARY KEY ("wf_eval_set_id")
);

-- CreateTable
CREATE TABLE "wf_eval_case" (
    "wf_eval_case_id" SERIAL NOT NULL,
    "eval_set_id" INTEGER NOT NULL,
    "label" VARCHAR(300) NOT NULL,
    "input" JSONB NOT NULL,
    "expected" JSONB NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "wf_eval_case_pkey" PRIMARY KEY ("wf_eval_case_id")
);

-- CreateTable
CREATE TABLE "wf_eval_run" (
    "wf_eval_run_id" BIGSERIAL NOT NULL,
    "eval_set_id" INTEGER NOT NULL,
    "definition_version_id" INTEGER NOT NULL,
    "status" SMALLINT NOT NULL DEFAULT 0,
    "total_cases" INTEGER NOT NULL DEFAULT 0,
    "passed_cases" INTEGER NOT NULL DEFAULT 0,
    "accuracy" DECIMAL(4,3),
    "required_accuracy" DECIMAL(4,3) NOT NULL,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "model" VARCHAR(200),
    "results" JSONB,
    "cost_amount" DECIMAL(14,4),
    "error_message" TEXT,
    "run_by" INTEGER,
    "started_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(0),

    CONSTRAINT "wf_eval_run_pkey" PRIMARY KEY ("wf_eval_run_id")
);

-- CreateTable
CREATE TABLE "wf_inbox_item" (
    "wf_inbox_item_id" BIGSERIAL NOT NULL,
    "task_id" BIGINT NOT NULL,
    "instance_id" BIGINT NOT NULL,
    "kind" SMALLINT NOT NULL DEFAULT 0,
    "status" SMALLINT NOT NULL DEFAULT 0,
    "priority" SMALLINT NOT NULL DEFAULT 1,
    "title" VARCHAR(300) NOT NULL,
    "summary" TEXT,
    "proposal" JSONB,
    "explanation" TEXT,
    "sources" JSONB,
    "confidence" DECIMAL(4,3),
    "agent_event_id" BIGINT,
    "assignee_user_group_id" INTEGER,
    "assignee_group_id" INTEGER,
    "assignee_role_id" INTEGER,
    "due_at" TIMESTAMPTZ(0),
    "claimed_by" INTEGER,
    "claimed_at" TIMESTAMPTZ(0),
    "resolved_by" INTEGER,
    "resolved_at" TIMESTAMPTZ(0),
    "resolution" JSONB,
    "resolution_comment" TEXT,
    "created_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wf_inbox_item_pkey" PRIMARY KEY ("wf_inbox_item_id")
);

-- CreateIndex
CREATE INDEX "wf_definition_status_idx" ON "wf_definition"("status");

-- CreateIndex
CREATE UNIQUE INDEX "wf_definition_version_definition_id_version_number_key" ON "wf_definition_version"("definition_id", "version_number");

-- CreateIndex
CREATE INDEX "wf_instance_status_due_at_idx" ON "wf_instance"("status", "due_at");

-- CreateIndex
CREATE INDEX "wf_instance_started_by_status_idx" ON "wf_instance"("started_by", "status");

-- CreateIndex
CREATE INDEX "wf_instance_subject_type_subject_id_idx" ON "wf_instance"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "wf_instance_definition_id_status_idx" ON "wf_instance"("definition_id", "status");

-- CreateIndex
CREATE INDEX "wf_instance_definition_version_id_idx" ON "wf_instance"("definition_version_id");

-- CreateIndex
CREATE INDEX "wf_instance_trigger_id_idx" ON "wf_instance"("trigger_id");

-- CreateIndex
CREATE INDEX "wf_instance_parent_instance_id_idx" ON "wf_instance"("parent_instance_id");

-- CreateIndex
CREATE INDEX "wf_task_status_due_at_idx" ON "wf_task"("status", "due_at");

-- CreateIndex
CREATE INDEX "wf_task_assignee_user_group_id_status_idx" ON "wf_task"("assignee_user_group_id", "status");

-- CreateIndex
CREATE INDEX "wf_task_assignee_group_id_status_idx" ON "wf_task"("assignee_group_id", "status");

-- CreateIndex
CREATE INDEX "wf_task_assignee_role_id_status_idx" ON "wf_task"("assignee_role_id", "status");

-- CreateIndex
CREATE INDEX "wf_task_instance_id_status_idx" ON "wf_task"("instance_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "wf_task_instance_id_step_key_attempt_key" ON "wf_task"("instance_id", "step_key", "attempt");

-- CreateIndex
CREATE INDEX "wf_timer_status_fire_at_idx" ON "wf_timer"("status", "fire_at");

-- CreateIndex
CREATE INDEX "wf_timer_instance_id_status_idx" ON "wf_timer"("instance_id", "status");

-- CreateIndex
CREATE INDEX "wf_timer_task_id_idx" ON "wf_timer"("task_id");

-- CreateIndex
CREATE INDEX "wf_event_log_instance_id_occurred_at_idx" ON "wf_event_log"("instance_id", "occurred_at");

-- CreateIndex
CREATE INDEX "wf_event_log_task_id_idx" ON "wf_event_log"("task_id");

-- CreateIndex
CREATE INDEX "wf_event_log_event_type_occurred_at_idx" ON "wf_event_log"("event_type", "occurred_at");

-- CreateIndex
CREATE INDEX "wf_event_log_occurred_at_idx" ON "wf_event_log"("occurred_at");

-- CreateIndex
CREATE INDEX "wf_trigger_event_type_is_active_idx" ON "wf_trigger"("event_type", "is_active");

-- CreateIndex
CREATE INDEX "wf_trigger_definition_id_idx" ON "wf_trigger"("definition_id");

-- CreateIndex
CREATE UNIQUE INDEX "wf_tool_tool_key_key" ON "wf_tool"("tool_key");

-- CreateIndex
CREATE INDEX "wf_tool_grant_tool_id_idx" ON "wf_tool_grant"("tool_id");

-- CreateIndex
CREATE UNIQUE INDEX "wf_tool_grant_definition_id_tool_id_key" ON "wf_tool_grant"("definition_id", "tool_id");

-- CreateIndex
CREATE INDEX "wf_agent_config_eval_set_id_idx" ON "wf_agent_config"("eval_set_id");

-- CreateIndex
CREATE UNIQUE INDEX "wf_agent_config_definition_version_id_step_key_key" ON "wf_agent_config"("definition_version_id", "step_key");

-- CreateIndex
CREATE INDEX "wf_agent_config_tool_tool_id_idx" ON "wf_agent_config_tool"("tool_id");

-- CreateIndex
CREATE UNIQUE INDEX "wf_budget_definition_id_key" ON "wf_budget"("definition_id");

-- CreateIndex
CREATE INDEX "wf_eval_set_definition_id_idx" ON "wf_eval_set"("definition_id");

-- CreateIndex
CREATE INDEX "wf_eval_case_eval_set_id_sort_order_idx" ON "wf_eval_case"("eval_set_id", "sort_order");

-- CreateIndex
CREATE INDEX "wf_eval_run_eval_set_id_definition_version_id_passed_idx" ON "wf_eval_run"("eval_set_id", "definition_version_id", "passed");

-- CreateIndex
CREATE INDEX "wf_eval_run_definition_version_id_idx" ON "wf_eval_run"("definition_version_id");

-- CreateIndex
CREATE INDEX "wf_inbox_item_status_due_at_idx" ON "wf_inbox_item"("status", "due_at");

-- CreateIndex
CREATE INDEX "wf_inbox_item_assignee_user_group_id_status_idx" ON "wf_inbox_item"("assignee_user_group_id", "status");

-- CreateIndex
CREATE INDEX "wf_inbox_item_assignee_group_id_status_idx" ON "wf_inbox_item"("assignee_group_id", "status");

-- CreateIndex
CREATE INDEX "wf_inbox_item_assignee_role_id_status_idx" ON "wf_inbox_item"("assignee_role_id", "status");

-- CreateIndex
CREATE INDEX "wf_inbox_item_task_id_idx" ON "wf_inbox_item"("task_id");

-- CreateIndex
CREATE INDEX "wf_inbox_item_instance_id_idx" ON "wf_inbox_item"("instance_id");

-- AddForeignKey
ALTER TABLE "wf_definition_version" ADD CONSTRAINT "wf_definition_version_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "wf_definition"("wf_definition_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_instance" ADD CONSTRAINT "wf_instance_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "wf_definition"("wf_definition_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_instance" ADD CONSTRAINT "wf_instance_definition_version_id_fkey" FOREIGN KEY ("definition_version_id") REFERENCES "wf_definition_version"("wf_definition_version_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_instance" ADD CONSTRAINT "wf_instance_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "wf_trigger"("wf_trigger_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_instance" ADD CONSTRAINT "wf_instance_parent_instance_id_fkey" FOREIGN KEY ("parent_instance_id") REFERENCES "wf_instance"("wf_instance_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_task" ADD CONSTRAINT "wf_task_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "wf_instance"("wf_instance_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_timer" ADD CONSTRAINT "wf_timer_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "wf_instance"("wf_instance_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_timer" ADD CONSTRAINT "wf_timer_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "wf_task"("wf_task_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_event_log" ADD CONSTRAINT "wf_event_log_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "wf_instance"("wf_instance_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_event_log" ADD CONSTRAINT "wf_event_log_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "wf_task"("wf_task_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_trigger" ADD CONSTRAINT "wf_trigger_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "wf_definition"("wf_definition_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_tool_grant" ADD CONSTRAINT "wf_tool_grant_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "wf_definition"("wf_definition_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_tool_grant" ADD CONSTRAINT "wf_tool_grant_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "wf_tool"("wf_tool_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_agent_config" ADD CONSTRAINT "wf_agent_config_definition_version_id_fkey" FOREIGN KEY ("definition_version_id") REFERENCES "wf_definition_version"("wf_definition_version_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_agent_config" ADD CONSTRAINT "wf_agent_config_eval_set_id_fkey" FOREIGN KEY ("eval_set_id") REFERENCES "wf_eval_set"("wf_eval_set_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_agent_config_tool" ADD CONSTRAINT "wf_agent_config_tool_agent_config_id_fkey" FOREIGN KEY ("agent_config_id") REFERENCES "wf_agent_config"("wf_agent_config_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_agent_config_tool" ADD CONSTRAINT "wf_agent_config_tool_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "wf_tool"("wf_tool_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_budget" ADD CONSTRAINT "wf_budget_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "wf_definition"("wf_definition_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_eval_set" ADD CONSTRAINT "wf_eval_set_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "wf_definition"("wf_definition_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_eval_case" ADD CONSTRAINT "wf_eval_case_eval_set_id_fkey" FOREIGN KEY ("eval_set_id") REFERENCES "wf_eval_set"("wf_eval_set_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_eval_run" ADD CONSTRAINT "wf_eval_run_eval_set_id_fkey" FOREIGN KEY ("eval_set_id") REFERENCES "wf_eval_set"("wf_eval_set_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_eval_run" ADD CONSTRAINT "wf_eval_run_definition_version_id_fkey" FOREIGN KEY ("definition_version_id") REFERENCES "wf_definition_version"("wf_definition_version_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_inbox_item" ADD CONSTRAINT "wf_inbox_item_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "wf_task"("wf_task_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wf_inbox_item" ADD CONSTRAINT "wf_inbox_item_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "wf_instance"("wf_instance_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- SQL brut — contraintes, index partiels et déclencheurs non exprimables en Prisma (cf. prisma/sql/wf.sql)
-- ============================================================================

-- 1) wf_definition ----------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "wf_definition" ADD CONSTRAINT "ck_wf_definition_status" CHECK ("status" BETWEEN 0 AND 2);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_definition" ADD CONSTRAINT "ck_wf_definition_source" CHECK ("source" IN (0, 1));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_definition" ADD CONSTRAINT "ck_wf_definition_name" CHECK (btrim("name") <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Le marquage « faible risque » est une décision tracée : il porte une date.
  ALTER TABLE "wf_definition" ADD CONSTRAINT "ck_wf_definition_low_risk"
    CHECK (NOT "is_low_risk" OR "low_risk_marked_at" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Deux workflows non archivés ne portent pas le même nom (insensible à la casse).
CREATE UNIQUE INDEX IF NOT EXISTS "ux_wf_definition_name_active"
  ON "wf_definition" (lower("name")) WHERE "status" <> 2;

-- 2) wf_definition_version --------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "wf_definition_version" ADD CONSTRAINT "ck_wf_definition_version_status" CHECK ("status" BETWEEN 0 AND 2);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_definition_version" ADD CONSTRAINT "ck_wf_definition_version_number" CHECK ("version_number" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_definition_version" ADD CONSTRAINT "ck_wf_definition_version_graph"
    CHECK (jsonb_typeof("graph") = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_definition_version" ADD CONSTRAINT "ck_wf_definition_version_hash"
    CHECK ("graph_hash" IS NULL OR "graph_hash" ~ '^[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Publiée => date de publication. Un publicateur suppose une date (pas l'inverse : le compte peut disparaître).
  ALTER TABLE "wf_definition_version" ADD CONSTRAINT "ck_wf_definition_version_published"
    CHECK (("status" <> 1 OR "published_at" IS NOT NULL) AND ("published_by" IS NULL OR "published_at" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Une seule version publiée par workflow.
CREATE UNIQUE INDEX IF NOT EXISTS "ux_wf_definition_version_published"
  ON "wf_definition_version" ("definition_id") WHERE "status" = 1;

-- 3) wf_instance ------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "wf_instance" ADD CONSTRAINT "ck_wf_instance_status" CHECK ("status" BETWEEN 0 AND 5);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Terminée (2), échouée (3) ou annulée (4) <=> date de fin renseignée.
  ALTER TABLE "wf_instance" ADD CONSTRAINT "ck_wf_instance_finished"
    CHECK (("status" IN (2, 3, 4)) = ("finished_at" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Objet lié polymorphe : type et identifiant vont ensemble.
  ALTER TABLE "wf_instance" ADD CONSTRAINT "ck_wf_instance_subject"
    CHECK (("subject_type" IS NULL) = ("subject_id" IS NULL)
       AND ("subject_type" IS NULL OR "subject_type" ~ '^[a-z0-9_.]+$'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_instance" ADD CONSTRAINT "ck_wf_instance_context" CHECK (jsonb_typeof("context") = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_instance" ADD CONSTRAINT "ck_wf_instance_not_own_parent"
    CHECK ("parent_instance_id" IS NULL OR "parent_instance_id" <> "wf_instance_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Un événement ne crée pas deux instances d'un même workflow.
CREATE UNIQUE INDEX IF NOT EXISTS "ux_wf_instance_idempotency"
  ON "wf_instance" ("definition_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
-- Reprise après redémarrage : les instances non terminales.
CREATE INDEX IF NOT EXISTS "ix_wf_instance_open"
  ON "wf_instance" ("started_at") WHERE "status" IN (0, 1, 5);

-- 4) wf_task ----------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "wf_task" ADD CONSTRAINT "ck_wf_task_type" CHECK ("task_type" BETWEEN 0 AND 6);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_task" ADD CONSTRAINT "ck_wf_task_status" CHECK ("status" BETWEEN 0 AND 5);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_task" ADD CONSTRAINT "ck_wf_task_priority" CHECK ("priority" BETWEEN 0 AND 2);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_task" ADD CONSTRAINT "ck_wf_task_attempt" CHECK ("attempt" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Au plus un bénéficiaire : utilisateur, groupe OU rôle (aucun = tâche système / agent).
  ALTER TABLE "wf_task" ADD CONSTRAINT "ck_wf_task_assignee"
    CHECK (num_nonnulls("assignee_user_group_id", "assignee_group_id", "assignee_role_id") <= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Terminée => date de fin ; un exécutant suppose une date (le compte peut disparaître, pas la date).
  ALTER TABLE "wf_task" ADD CONSTRAINT "ck_wf_task_completed"
    CHECK (("status" <> 2 OR "completed_at" IS NOT NULL) AND ("completed_by" IS NULL OR "completed_at" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Tâches ouvertes à échéance (relances, expiration).
CREATE INDEX IF NOT EXISTS "ix_wf_task_open_due"
  ON "wf_task" ("due_at") WHERE "status" IN (0, 1) AND "due_at" IS NOT NULL;

-- 5) wf_timer ---------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "wf_timer" ADD CONSTRAINT "ck_wf_timer_kind" CHECK ("kind" BETWEEN 0 AND 3);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_timer" ADD CONSTRAINT "ck_wf_timer_status" CHECK ("status" BETWEEN 0 AND 2);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Déclenchée <=> date de déclenchement.
  ALTER TABLE "wf_timer" ADD CONSTRAINT "ck_wf_timer_fired" CHECK (("status" = 1) = ("fired_at" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_timer" ADD CONSTRAINT "ck_wf_timer_lease" CHECK (("locked_by" IS NULL) = ("locked_until" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_timer" ADD CONSTRAINT "ck_wf_timer_attempts" CHECK ("attempts" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Une seule minuterie ACTIVE par (instance, étape, nature) : pas de double relance.
CREATE UNIQUE INDEX IF NOT EXISTS "ux_wf_timer_active"
  ON "wf_timer" ("instance_id", "step_key", "kind") WHERE "status" = 0;
-- Balayage du moteur : « quelles minuteries sont échues ? »
CREATE INDEX IF NOT EXISTS "ix_wf_timer_due"
  ON "wf_timer" ("fire_at") WHERE "status" = 0;

-- 6) wf_event_log (journal) -------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "wf_event_log" ADD CONSTRAINT "ck_wf_event_log_type" CHECK ("event_type" ~ '^[a-z0-9_.]+$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_event_log" ADD CONSTRAINT "ck_wf_event_log_actor_kind" CHECK ("actor_kind" BETWEEN 0 AND 2);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Un événement d'utilisateur nomme l'utilisateur.
  ALTER TABLE "wf_event_log" ADD CONSTRAINT "ck_wf_event_log_actor"
    CHECK ("actor_kind" <> 1 OR "actor_user_group_id" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_event_log" ADD CONSTRAINT "ck_wf_event_log_autonomy"
    CHECK ("autonomy_level" IS NULL OR "autonomy_level" BETWEEN 0 AND 2);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_event_log" ADD CONSTRAINT "ck_wf_event_log_confidence"
    CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Un valideur suppose une date de validation (la date survit à la suppression du compte).
  ALTER TABLE "wf_event_log" ADD CONSTRAINT "ck_wf_event_log_validation"
    CHECK ("validated_by" IS NULL OR "validated_at" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_event_log" ADD CONSTRAINT "ck_wf_event_log_values"
    CHECK (("prompt_tokens" IS NULL OR "prompt_tokens" >= 0)
       AND ("completion_tokens" IS NULL OR "completion_tokens" >= 0)
       AND ("cost_amount" IS NULL OR "cost_amount" >= 0)
       AND ("corrects_event_id" IS NULL OR "corrects_event_id" <> "wf_event_log_id"));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Journal APPEND-ONLY : aucune modification, aucune suppression, aucune troncature.
-- Une correction est un NOUVEL événement (corrects_event_id). Le propriétaire de la base peut
-- techniquement supprimer le déclencheur : c'est une barrière applicative forte, pas une preuve
-- cryptographique (cf. docs/workflow-donnees.md).
CREATE OR REPLACE FUNCTION wf_event_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wf_event_log est en ajout seul : % refusé (corriger par un nouvel événement)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "wf_event_log_no_update" BEFORE UPDATE ON "wf_event_log"
  FOR EACH ROW EXECUTE FUNCTION wf_event_log_append_only();
CREATE OR REPLACE TRIGGER "wf_event_log_no_delete" BEFORE DELETE ON "wf_event_log"
  FOR EACH ROW EXECUTE FUNCTION wf_event_log_append_only();
CREATE OR REPLACE TRIGGER "wf_event_log_no_truncate" BEFORE TRUNCATE ON "wf_event_log"
  FOR EACH STATEMENT EXECUTE FUNCTION wf_event_log_append_only();

-- 7) wf_trigger -------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "wf_trigger" ADD CONSTRAINT "ck_wf_trigger_event_type" CHECK ("event_type" ~ '^[a-z0-9_.]+$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_trigger" ADD CONSTRAINT "ck_wf_trigger_conditions" CHECK (jsonb_typeof("conditions") = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 8) wf_tool / wf_tool_grant ------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "wf_tool" ADD CONSTRAINT "ck_wf_tool_key" CHECK ("tool_key" ~ '^[a-z0-9_.]+$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_tool" ADD CONSTRAINT "ck_wf_tool_side_effect" CHECK ("side_effect" BETWEEN 0 AND 2);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Un outil externe / irréversible exige TOUJOURS une validation humaine.
  ALTER TABLE "wf_tool" ADD CONSTRAINT "ck_wf_tool_irreversible_validated"
    CHECK ("side_effect" <> 2 OR "requires_validation");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_tool" ADD CONSTRAINT "ck_wf_tool_input_schema"
    CHECK ("input_schema" IS NULL OR jsonb_typeof("input_schema") = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_tool_grant" ADD CONSTRAINT "ck_wf_tool_grant_max_calls"
    CHECK ("max_calls_per_instance" IS NULL OR "max_calls_per_instance" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 9) wf_agent_config + garde-fous d'autonomie -------------------------------
DO $$ BEGIN
  ALTER TABLE "wf_agent_config" ADD CONSTRAINT "ck_wf_agent_config_autonomy" CHECK ("autonomy_level" BETWEEN 0 AND 2);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_agent_config" ADD CONSTRAINT "ck_wf_agent_config_threshold"
    CHECK ("confidence_threshold" BETWEEN 0 AND 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_agent_config" ADD CONSTRAINT "ck_wf_agent_config_limits"
    CHECK ("max_steps" BETWEEN 1 AND 50 AND "timeout_seconds" > 0
       AND ("max_cost_per_run" IS NULL OR "max_cost_per_run" >= 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Autonome (2) => un jeu d'évaluation est lié (la vérification du run réussi est dans le déclencheur).
  ALTER TABLE "wf_agent_config" ADD CONSTRAINT "ck_wf_agent_config_autonomous_eval"
    CHECK ("autonomy_level" <> 2 OR "eval_set_id" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Niveau 'autonome' : (a) la définition est marquée faible risque ET (b) le jeu d'évaluation lié a un
-- run RÉUSSI (terminé, précision >= seuil) sur CETTE version. Les CHECK ne voient pas les autres
-- tables : d'où le déclencheur.
CREATE OR REPLACE FUNCTION wf_agent_config_autonomy_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."autonomy_level" = 2 THEN
    IF NOT EXISTS (
      SELECT 1
        FROM "wf_definition_version" v
        JOIN "wf_definition" d ON d."wf_definition_id" = v."definition_id"
       WHERE v."wf_definition_version_id" = NEW."definition_version_id" AND d."is_low_risk"
    ) THEN
      RAISE EXCEPTION 'autonomie « autonome » refusée : le workflow n''est pas marqué faible risque'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM "wf_eval_run" r
        JOIN "wf_eval_set" s ON s."wf_eval_set_id" = r."eval_set_id"
        JOIN "wf_definition_version" v ON v."wf_definition_version_id" = r."definition_version_id"
       WHERE r."eval_set_id" = NEW."eval_set_id"
         AND s."definition_id" = v."definition_id"  -- le jeu appartient bien au workflow
         AND r."definition_version_id" = NEW."definition_version_id"
         AND r."status" = 1 AND r."passed"
         AND s."is_active"
         AND r."required_accuracy" >= s."min_accuracy"  -- seuil non abaissé après coup
         AND r."total_cases" > 0
    ) THEN
      RAISE EXCEPTION 'autonomie « autonome » refusée : aucun run d''évaluation réussi pour cette version'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "wf_agent_config_autonomy_guard" BEFORE INSERT OR UPDATE ON "wf_agent_config"
  FOR EACH ROW EXECUTE FUNCTION wf_agent_config_autonomy_guard();

-- Retirer le marquage « faible risque » est refusé tant qu'une étape agent autonome existe.
CREATE OR REPLACE FUNCTION wf_definition_low_risk_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."is_low_risk" AND NOT NEW."is_low_risk" AND EXISTS (
    SELECT 1
      FROM "wf_agent_config" c
      JOIN "wf_definition_version" v ON v."wf_definition_version_id" = c."definition_version_id"
     WHERE v."definition_id" = NEW."wf_definition_id" AND c."autonomy_level" = 2
  ) THEN
    RAISE EXCEPTION 'retrait du marquage faible risque refusé : une étape agent autonome existe (la repasser en non autonome d''abord)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "wf_definition_low_risk_guard" BEFORE UPDATE OF "is_low_risk" ON "wf_definition"
  FOR EACH ROW EXECUTE FUNCTION wf_definition_low_risk_guard();

-- 10) wf_definition_version : une version publiée est IMMUABLE ---------------
CREATE OR REPLACE FUNCTION wf_definition_version_immutable() RETURNS trigger AS $$
BEGIN
  -- « Publiée un jour » = published_at renseigné (même une fois archivée) : le contenu est figé à vie.
  IF OLD."published_at" IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'version publiée : suppression refusée (l''archiver)'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."graph" IS DISTINCT FROM OLD."graph"
       OR NEW."graph_hash" IS DISTINCT FROM OLD."graph_hash"
       OR NEW."source_prompt" IS DISTINCT FROM OLD."source_prompt"
       OR NEW."definition_id" <> OLD."definition_id"
       OR NEW."version_number" <> OLD."version_number"
       OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
       OR NEW."published_by" IS DISTINCT FROM OLD."published_by"
       OR NEW."status" < OLD."status"          -- pas de retour 2 -> 1 / 0 ni 1 -> 0
       OR NEW."status" NOT IN (1, 2)
    THEN
      RAISE EXCEPTION 'version publiée immuable : créer une nouvelle version (seul le passage à « archivée » est permis)'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "wf_definition_version_immutable" BEFORE UPDATE OR DELETE ON "wf_definition_version"
  FOR EACH ROW EXECUTE FUNCTION wf_definition_version_immutable();

-- 10 bis) La configuration agent d'une version publiée est figée aussi (objectif, seuil, autonomie,
-- outils) : sans cela, on pourrait abaisser le seuil de confiance d'une étape autonome après coup.
-- Les configurations se créent donc sur la version en BROUILLON, AVANT sa publication.
CREATE OR REPLACE FUNCTION wf_agent_config_frozen() RETURNS trigger AS $$
DECLARE
  v_new integer;  -- version visée par la nouvelle ligne (INSERT / UPDATE)
  v_old integer;  -- version portée par l'ancienne ligne (UPDATE / DELETE)
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF TG_TABLE_NAME = 'wf_agent_config_tool' THEN
      SELECT c."definition_version_id" INTO v_new FROM "wf_agent_config" c
       WHERE c."wf_agent_config_id" = NEW."agent_config_id";
    ELSE
      v_new := NEW."definition_version_id";
    END IF;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF TG_TABLE_NAME = 'wf_agent_config_tool' THEN
      SELECT c."definition_version_id" INTO v_old FROM "wf_agent_config" c
       WHERE c."wf_agent_config_id" = OLD."agent_config_id";
    ELSE
      v_old := OLD."definition_version_id";
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "wf_definition_version" v
     WHERE v."published_at" IS NOT NULL
       AND v."wf_definition_version_id" IN (v_new, v_old)
  ) THEN
    RAISE EXCEPTION 'configuration agent d''une version publiée : % refusé (créer une nouvelle version)', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "wf_agent_config_frozen" BEFORE INSERT OR UPDATE OR DELETE ON "wf_agent_config"
  FOR EACH ROW EXECUTE FUNCTION wf_agent_config_frozen();
CREATE OR REPLACE TRIGGER "wf_agent_config_tool_frozen" BEFORE INSERT OR UPDATE OR DELETE ON "wf_agent_config_tool"
  FOR EACH ROW EXECUTE FUNCTION wf_agent_config_frozen();

-- 11) wf_budget -------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "wf_budget" ADD CONSTRAINT "ck_wf_budget_period_kind" CHECK ("period_kind" BETWEEN 0 AND 2);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_budget" ADD CONSTRAINT "ck_wf_budget_amounts"
    CHECK (("cap_amount" IS NULL OR "cap_amount" >= 0) AND "consumed_amount" >= 0 AND "consumed_tokens" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_budget" ADD CONSTRAINT "ck_wf_budget_alert" CHECK ("alert_threshold" BETWEEN 0 AND 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_budget" ADD CONSTRAINT "ck_wf_budget_currency" CHECK ("currency" ~ '^[A-Z]{3}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Arrêt d'urgence actif => date d'activation (qui et pourquoi sont tracés mais facultatifs).
  ALTER TABLE "wf_budget" ADD CONSTRAINT "ck_wf_budget_emergency"
    CHECK (NOT "emergency_stop" OR "emergency_stop_at" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Une seule ligne GLOBALE (plafond du client) ; une ligne par workflow est garantie par @unique(definition_id).
CREATE UNIQUE INDEX IF NOT EXISTS "ux_wf_budget_global"
  ON "wf_budget" ((true)) WHERE "definition_id" IS NULL;
-- Ligne globale par défaut : AUCUN plafond chiffré (montant et devise à fixer par le client), arrêt
-- d'urgence inactif. Aucun agent ne tourne de toute façon tant que l'IA est désactivée (ged_ai_setting.mode = 0).
INSERT INTO "wf_budget" ("period_kind") VALUES (0) ON CONFLICT DO NOTHING;

-- 12) wf_eval_set / wf_eval_case / wf_eval_run ------------------------------
DO $$ BEGIN
  ALTER TABLE "wf_eval_set" ADD CONSTRAINT "ck_wf_eval_set_accuracy" CHECK ("min_accuracy" BETWEEN 0 AND 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_eval_case" ADD CONSTRAINT "ck_wf_eval_case_weight" CHECK ("weight" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_eval_run" ADD CONSTRAINT "ck_wf_eval_run_status" CHECK ("status" BETWEEN 0 AND 2);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_eval_run" ADD CONSTRAINT "ck_wf_eval_run_counts"
    CHECK ("total_cases" >= 0 AND "passed_cases" BETWEEN 0 AND "total_cases");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_eval_run" ADD CONSTRAINT "ck_wf_eval_run_accuracy"
    CHECK (("accuracy" IS NULL OR "accuracy" BETWEEN 0 AND 1) AND "required_accuracy" BETWEEN 0 AND 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- « Réussi » exige un run terminé dont la précision atteint le seuil figé au lancement.
  ALTER TABLE "wf_eval_run" ADD CONSTRAINT "ck_wf_eval_run_passed"
    CHECK (NOT "passed" OR ("status" = 1 AND "total_cases" > 0 AND "accuracy" IS NOT NULL AND "accuracy" >= "required_accuracy"));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Un run terminé a au moins un cas et sa précision est celle des cas réussis (arrondie à 3 décimales) :
  -- on ne peut pas déclarer une précision sans rapport avec passed_cases / total_cases.
  ALTER TABLE "wf_eval_run" ADD CONSTRAINT "ck_wf_eval_run_accuracy_consistent"
    CHECK ("status" <> 1 OR ("total_cases" > 0 AND "accuracy" IS NOT NULL
       AND abs("accuracy" - ("passed_cases"::numeric / "total_cases")) <= 0.0005));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Fini <=> date de fin.
  ALTER TABLE "wf_eval_run" ADD CONSTRAINT "ck_wf_eval_run_finished" CHECK (("status" <> 0) = ("finished_at" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Un run terminé est figé (ni modification, ni suppression) : sinon on pourrait effacer la preuve
-- qui justifie une autonomie. Seul le passage « en cours » -> « terminé / en erreur » est permis.
CREATE OR REPLACE FUNCTION wf_eval_run_finished_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 0 THEN
    RAISE EXCEPTION 'run d''évaluation terminé : % refusé (lancer un nouveau run)', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "wf_eval_run_finished_immutable" BEFORE UPDATE OR DELETE ON "wf_eval_run"
  FOR EACH ROW EXECUTE FUNCTION wf_eval_run_finished_immutable();

-- 13) wf_inbox_item ---------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "wf_inbox_item" ADD CONSTRAINT "ck_wf_inbox_item_kind" CHECK ("kind" BETWEEN 0 AND 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_inbox_item" ADD CONSTRAINT "ck_wf_inbox_item_status" CHECK ("status" BETWEEN 0 AND 5);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_inbox_item" ADD CONSTRAINT "ck_wf_inbox_item_priority" CHECK ("priority" BETWEEN 0 AND 2);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_inbox_item" ADD CONSTRAINT "ck_wf_inbox_item_assignee"
    CHECK (num_nonnulls("assignee_user_group_id", "assignee_group_id", "assignee_role_id") <= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Validation d'agent => la proposition ET son explication sont présentes.
  ALTER TABLE "wf_inbox_item" ADD CONSTRAINT "ck_wf_inbox_item_proposal"
    CHECK ("kind" <> 1 OR ("proposal" IS NOT NULL AND "explanation" IS NOT NULL AND btrim("explanation") <> ''));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "wf_inbox_item" ADD CONSTRAINT "ck_wf_inbox_item_confidence"
    CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  -- Traitée (2) ou rejetée (3) => date de résolution ; un résolveur / un preneur suppose sa date.
  ALTER TABLE "wf_inbox_item" ADD CONSTRAINT "ck_wf_inbox_item_resolution"
    CHECK (("status" NOT IN (2, 3) OR "resolved_at" IS NOT NULL)
       AND ("resolved_by" IS NULL OR "resolved_at" IS NOT NULL)
       AND ("claimed_by" IS NULL OR "claimed_at" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Une seule entrée OUVERTE (ouverte ou prise) par tâche et par nature.
CREATE UNIQUE INDEX IF NOT EXISTS "ux_wf_inbox_item_open"
  ON "wf_inbox_item" ("task_id", "kind") WHERE "status" IN (0, 1);
-- Boîte personnelle : mes entrées à traiter.
CREATE INDEX IF NOT EXISTS "ix_wf_inbox_item_open_user"
  ON "wf_inbox_item" ("assignee_user_group_id", "due_at") WHERE "status" IN (0, 1);
