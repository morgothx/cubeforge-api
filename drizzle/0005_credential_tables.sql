CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"role" text NOT NULL,
	"secret_digest" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_secret_digest_unique" UNIQUE("secret_digest"),
	CONSTRAINT "api_keys_tenant_label_unique" UNIQUE("tenant_id","label"),
	CONSTRAINT "api_keys_role_check" CHECK ("api_keys"."role" in ('admin', 'editor', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "credential_setup_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"person_id" uuid NOT NULL,
	"secret_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_setup_tokens_secret_digest_unique" UNIQUE("secret_digest")
);
--> statement-breakpoint
CREATE TABLE "person_credentials" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"password_digest" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_operators" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sign_in_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"secret_digest" text NOT NULL,
	"session_expires_at" timestamp with time zone NOT NULL,
	"exchanged_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_secret_digest_unique" UNIQUE("secret_digest")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_setup_tokens" ADD CONSTRAINT "credential_setup_tokens_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_credentials" ADD CONSTRAINT "person_credentials_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_operators" ADD CONSTRAINT "platform_operators_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_tenant_idx" ON "api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "credential_setup_tokens_person_idx" ON "credential_setup_tokens" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_sign_in_idx" ON "refresh_tokens" USING btree ("sign_in_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_person_idx" ON "refresh_tokens" USING btree ("person_id");