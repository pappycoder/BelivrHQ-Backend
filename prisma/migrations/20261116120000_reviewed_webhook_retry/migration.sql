ALTER TABLE webhook_deliveries ADD COLUMN dispatch_generation integer NOT NULL DEFAULT 0;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_delivery_generation_nonnegative CHECK (dispatch_generation >= 0);
