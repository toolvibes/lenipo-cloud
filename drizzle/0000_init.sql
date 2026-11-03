CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "login_links" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notices" (
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"token_hash" text NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tenant_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"secrets" text NOT NULL,
	"custom_domain" text,
	"custom_domain_verified_at" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"cancel_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"suspend_reason" text,
	"delete_after" timestamp with time zone,
	"export_file" text,
	"export_ready_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_links" ADD CONSTRAINT "login_links_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_events" ADD CONSTRAINT "tenant_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_email_unique" ON "customers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "jobs_queue_idx" ON "jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "login_links_customer_idx" ON "login_links" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notices_unique" ON "notices" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "signups_token_unique" ON "signups" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "signups_email_idx" ON "signups" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "tenant_events_tenant_idx" ON "tenant_events" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_unique" ON "tenants" USING btree ("slug") WHERE "tenants"."status" <> 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_domain_unique" ON "tenants" USING btree ("custom_domain") WHERE "tenants"."status" <> 'deleted';--> statement-breakpoint
CREATE INDEX "tenants_customer_idx" ON "tenants" USING btree ("customer_id");