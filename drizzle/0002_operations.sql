CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"file" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_alerts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"subject" text NOT NULL,
	"text" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rollouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"wave_size" integer NOT NULL,
	"waves" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"pause_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "payload" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "version" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "canary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "sleeping_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "last_active_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "health_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "healthy_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "down_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backups_tenant_idx" ON "backups" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_alerts_open_unique" ON "ops_alerts" USING btree ("key") WHERE "ops_alerts"."closed_at" is null;