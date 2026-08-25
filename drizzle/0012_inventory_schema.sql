CREATE TABLE "inventory_locations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_locations_tenant_code_unique" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "inventory_products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_products_tenant_sku_unique" UNIQUE("tenant_id","sku")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"sku" text NOT NULL,
	"location_code" text NOT NULL,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_tenant_external_unique" UNIQUE("tenant_id","external_id"),
	CONSTRAINT "stock_movements_kind_check" CHECK ("stock_movements"."kind" in ('receipt', 'sale', 'adjustment')),
	CONSTRAINT "stock_movements_quantity_check" CHECK ("stock_movements"."quantity" <> 0)
);
--> statement-breakpoint
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_products" ADD CONSTRAINT "inventory_products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_fk" FOREIGN KEY ("tenant_id","sku") REFERENCES "public"."inventory_products"("tenant_id","sku") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_location_fk" FOREIGN KEY ("tenant_id","location_code") REFERENCES "public"."inventory_locations"("tenant_id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_locations_tenant_idx" ON "inventory_locations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "inventory_products_tenant_idx" ON "inventory_products" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "stock_movements_tenant_sku_location_idx" ON "stock_movements" USING btree ("tenant_id","sku","location_code");--> statement-breakpoint
CREATE INDEX "stock_movements_tenant_recorded_idx" ON "stock_movements" USING btree ("tenant_id","recorded_at");