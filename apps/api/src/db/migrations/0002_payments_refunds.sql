ALTER TABLE "payments" ADD COLUMN "refund_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refund_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "refunded_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "reference" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "event" text;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_id_unique" UNIQUE("refund_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_idempotency_key_unique" UNIQUE("refund_idempotency_key");