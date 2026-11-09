BEGIN;
ALTER TABLE platform_subscriptions ADD COLUMN access_grants JSONB;
ALTER TABLE subscription_payments
  ADD COLUMN provider_transaction_id TEXT,
  ADD COLUMN provider_reference TEXT,
  ADD COLUMN lifecycle JSONB,
  ADD COLUMN checkout_closed_at TIMESTAMP(3),
  ADD COLUMN checkout_close_reason TEXT;
ALTER TABLE transactions ADD COLUMN provider_transaction_id TEXT,
  ADD COLUMN provider_reference TEXT, ADD COLUMN lifecycle JSONB;
CREATE INDEX subscription_payments_gateway_provider_transaction_id_idx ON subscription_payments(gateway, provider_transaction_id);
CREATE INDEX subscription_payments_gateway_provider_reference_idx ON subscription_payments(gateway, provider_reference);
CREATE INDEX transactions_payment_gateway_provider_transaction_id_idx ON transactions(payment_gateway, provider_transaction_id);
CREATE INDEX transactions_payment_gateway_provider_reference_idx ON transactions(payment_gateway, provider_reference);
DROP INDEX subscription_payments_one_pending;
CREATE UNIQUE INDEX subscription_payments_one_pending ON subscription_payments(church_id)
  WHERE status = 'pending' AND checkout_closed_at IS NULL;

-- Database writers use the same independent paid intervals as API entitlements.
CREATE FUNCTION churchos_effective_plan(church TEXT) RETURNS TEXT
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT CASE WHEN jsonb_array_length(COALESCE(s.access_grants->'grants','[]'::jsonb)) = 0
    THEN s.plan::text ELSE (
      SELECT g.value->>'plan' FROM jsonb_array_elements(s.access_grants->'grants') WITH ORDINALITY g(value, ordinal)
      WHERE g.value->>'state'='clear' AND (g.value->>'start')::timestamptz <= CURRENT_TIMESTAMP
        AND (g.value->>'end')::timestamptz > CURRENT_TIMESTAMP
        AND (COALESCE((g.value->>'upgrade')::boolean,FALSE)=FALSE OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(s.access_grants->'grants') b
          WHERE COALESCE((b->>'upgrade')::boolean,FALSE)=FALSE AND b->>'state'='clear'
            AND (b->>'start')::timestamptz <= CURRENT_TIMESTAMP AND (b->>'end')::timestamptz > CURRENT_TIMESTAMP
        ))
      ORDER BY COALESCE((g.value->>'upgrade')::boolean,FALSE) DESC, g.ordinal DESC LIMIT 1
    ) END FROM platform_subscriptions s WHERE s.church_id=church
$$;
CREATE OR REPLACE FUNCTION churchos_has_feature(church TEXT, feature TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT COALESCE((SELECT
  (CASE WHEN jsonb_array_length(COALESCE(access_grants->'grants','[]'::jsonb))=0 THEN paid_until>CURRENT_TIMESTAMP ELSE TRUE END) AND
  CASE WHEN feature IN ('giving','reports') THEN churchos_effective_plan(church) IN ('essentials','community','network','enterprise')
       WHEN feature IN ('events','groups','forms','email','media','staff_roles') THEN churchos_effective_plan(church) IN ('community','network','enterprise')
       WHEN feature IN ('tickets','pastoral','assets','analytics','sms','whatsapp','calls','webhooks','custom_roles') THEN churchos_effective_plan(church) IN ('network','enterprise') ELSE FALSE END
 FROM platform_subscriptions WHERE church_id=church),FALSE)
$$;
CREATE OR REPLACE FUNCTION churchos_plan_limit(church TEXT, resource TEXT) RETURNS INTEGER
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE p TEXT; agreement JSONB;
BEGIN
 SELECT churchos_effective_plan(church),enterprise_limits INTO p,agreement FROM platform_subscriptions WHERE church_id=church;
 IF p='enterprise' THEN
   IF jsonb_typeof(agreement->resource)='number' AND (agreement->>resource) ~ '^[0-9]+$' THEN RETURN (agreement->>resource)::INTEGER; END IF;
   RETURN 0;
 END IF;
 IF p IS NULL THEN RETURN 0; END IF;
 RETURN CASE resource
 WHEN 'members' THEN CASE p WHEN 'essentials' THEN 100 WHEN 'community' THEN 300 ELSE 1500 END
 WHEN 'staff' THEN CASE p WHEN 'essentials' THEN 2 WHEN 'community' THEN 5 ELSE 15 END
 WHEN 'locations' THEN CASE p WHEN 'network' THEN 3 ELSE 1 END
 ELSE 0 END;
END $$;
CREATE OR REPLACE FUNCTION churchos_check_role_plan() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE current_plan TEXT; selected_role TEXT;
BEGIN
 IF TG_TABLE_NAME='roles' THEN
  IF NEW.church_id IS NOT NULL AND NOT churchos_has_feature(NEW.church_id,'custom_roles') THEN
   RAISE EXCEPTION 'PLAN_FEATURE_REQUIRED:custom_roles' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.status<>'active' OR NEW.archived_at IS NOT NULL OR cardinality(NEW.role)=0 THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.role=OLD.role AND OLD.status='active' AND OLD.archived_at IS NULL THEN RETURN NEW; END IF;
 IF 'super_admin'=ANY(NEW.role) THEN RETURN NEW; END IF;
 SELECT churchos_effective_plan(NEW.church_id) INTO current_plan;
 current_plan:=COALESCE(current_plan,'essentials');
 IF current_plan='essentials' THEN
  IF NEW.role=ARRAY['church_admin']::TEXT[] THEN
   IF TG_OP='UPDATE' AND 'church_admin'=ANY(OLD.role) THEN RETURN NEW; END IF;
   -- Registration may provision the first administrator before payment.
   PERFORM id FROM churches WHERE id=NEW.church_id FOR UPDATE;
   IF NOT EXISTS(SELECT 1 FROM profiles WHERE church_id=NEW.church_id AND 'church_admin'=ANY(role)) THEN RETURN NEW; END IF;
  END IF;
  IF cardinality(NEW.role)<>1 OR NOT (NEW.role <@ ARRAY['senior_pastor','branch_pastor','secretary']::TEXT[]) THEN
   RAISE EXCEPTION 'PLAN_FEATURE_REQUIRED:staff_roles' USING ERRCODE='P0001';
  END IF;
 ELSIF current_plan='community' THEN
  IF NOT (NEW.role <@ ARRAY['church_admin','senior_pastor','branch_pastor','secretary','treasurer','usher','department_head','cell_leader']::TEXT[]) THEN
   RAISE EXCEPTION 'PLAN_FEATURE_REQUIRED:custom_roles' USING ERRCODE='P0001';
  END IF;
 END IF;
 RETURN NEW;
END $$;

COMMIT;
