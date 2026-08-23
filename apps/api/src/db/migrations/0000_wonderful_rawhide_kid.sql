CREATE TYPE "public"."audit_actor_type" AS ENUM('USER', 'SYSTEM', 'PAYGATE');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('DRAFT', 'HELD', 'PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED', 'EXPIRED', 'FAILED', 'CANCELLED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('CUSTOMER', 'VENUE_STAFF', 'VENUE_ADMIN', 'PLATFORM_ADMIN');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" uuid,
	"from_state" "booking_status",
	"to_state" "booking_status",
	"reason" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"equipment_type_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"rate_minor" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "booking_status" DEFAULT 'DRAFT' NOT NULL,
	"expires_at" timestamp with time zone,
	"rearm_count" smallint DEFAULT 0 NOT NULL,
	"policy_snapshot" jsonb,
	"total_minor" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) DEFAULT 'PKR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cancellation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid,
	"tiers" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "equipment_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"name" text NOT NULL,
	"hourly_rate_minor" bigint NOT NULL,
	"units_owned" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"charge_id" text NOT NULL,
	"event" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"charge_id" text,
	"amount_minor" bigint NOT NULL,
	"status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "payments_charge_id_unique" UNIQUE("charge_id")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"name" text NOT NULL,
	"capacity" integer NOT NULL,
	"hourly_rate_minor" bigint NOT NULL,
	"amenities" text[] DEFAULT '{}'::text[] NOT NULL,
	"min_duration_minutes" integer DEFAULT 60 NOT NULL,
	"max_duration_minutes" integer DEFAULT 480 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" NOT NULL,
	"venue_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"city" text NOT NULL,
	"timezone" text NOT NULL,
	"operating_hours" jsonb NOT NULL,
	"overbooking_buffer_pct" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" text NOT NULL,
	"charge_id" text,
	"signature_valid" boolean NOT NULL,
	"raw_body" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "webhook_deliveries_delivery_id_unique" UNIQUE("delivery_id")
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_line_items" ADD CONSTRAINT "booking_line_items_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_line_items" ADD CONSTRAINT "booking_line_items_equipment_type_id_equipment_types_id_fk" FOREIGN KEY ("equipment_type_id") REFERENCES "public"."equipment_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellation_policies" ADD CONSTRAINT "cancellation_policies_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_types" ADD CONSTRAINT "equipment_types_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_booking_idx" ON "audit_events" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "audit_events_occurred_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "booking_line_items_booking_idx" ON "booking_line_items" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "booking_line_items_equipment_idx" ON "booking_line_items" USING btree ("equipment_type_id");--> statement-breakpoint
CREATE INDEX "bookings_venue_idx" ON "bookings" USING btree ("venue_id");--> statement-breakpoint
CREATE INDEX "bookings_user_idx" ON "bookings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bookings_room_starts_idx" ON "bookings" USING btree ("room_id","starts_at");--> statement-breakpoint
CREATE INDEX "bookings_status_expires_idx" ON "bookings" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "cancellation_policies_venue_created_idx" ON "cancellation_policies" USING btree ("venue_id","created_at");--> statement-breakpoint
CREATE INDEX "equipment_types_venue_idx" ON "equipment_types" USING btree ("venue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_charge_event_uq" ON "payment_events" USING btree ("charge_id","event");--> statement-breakpoint
CREATE INDEX "payments_booking_idx" ON "payments" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "rooms_venue_idx" ON "rooms" USING btree ("venue_id");--> statement-breakpoint
CREATE INDEX "users_venue_idx" ON "users" USING btree ("venue_id");--> statement-breakpoint
CREATE INDEX "venues_city_idx" ON "venues" USING btree ("city");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_charge_idx" ON "webhook_deliveries" USING btree ("charge_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_unprocessed_idx" ON "webhook_deliveries" USING btree ("processed_at");