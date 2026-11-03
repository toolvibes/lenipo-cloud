CREATE TABLE "usage_samples" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"persons" integer NOT NULL,
	"agents" integer NOT NULL,
	"storage_mb" real NOT NULL,
	CONSTRAINT "usage_samples_tenant_id_day_pk" PRIMARY KEY("tenant_id","day")
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "plan" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "interval" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "seats" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "subscription_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "payment_state" text;--> statement-breakpoint
ALTER TABLE "usage_samples" ADD CONSTRAINT "usage_samples_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;