CREATE TABLE "acceptances" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"document" text NOT NULL,
	"version" integer NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "legal_announcements" (
	"document" text NOT NULL,
	"version" integer NOT NULL,
	"announced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	CONSTRAINT "legal_announcements_document_version_pk" PRIMARY KEY("document","version")
);
--> statement-breakpoint
CREATE TABLE "legal_notices" (
	"customer_id" uuid NOT NULL,
	"document" text NOT NULL,
	"version" integer NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_notices_customer_id_document_version_pk" PRIMARY KEY("customer_id","document","version")
);
--> statement-breakpoint
ALTER TABLE "signups" ADD COLUMN "accepted" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "acceptances" ADD CONSTRAINT "acceptances_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_notices" ADD CONSTRAINT "legal_notices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acceptances_customer_idx" ON "acceptances" USING btree ("customer_id","document");