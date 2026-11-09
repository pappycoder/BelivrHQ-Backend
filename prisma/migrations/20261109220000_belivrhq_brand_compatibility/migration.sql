-- Forward-only rebrand. Historic migrations and tenant records stay unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION belivrhq_effective_plan(church TEXT) RETURNS TEXT
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

CREATE OR REPLACE FUNCTION belivrhq_plan_limit(church TEXT, resource TEXT) RETURNS INTEGER
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE p TEXT; agreement JSONB;
BEGIN
 SELECT belivrhq_effective_plan(church),enterprise_limits INTO p,agreement FROM platform_subscriptions WHERE church_id=church;
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

CREATE OR REPLACE FUNCTION belivrhq_has_feature(church TEXT, feature TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT COALESCE((SELECT
  (CASE WHEN jsonb_array_length(COALESCE(access_grants->'grants','[]'::jsonb))=0 THEN paid_until>CURRENT_TIMESTAMP ELSE TRUE END) AND
  CASE WHEN feature IN ('giving','reports') THEN belivrhq_effective_plan(church) IN ('essentials','community','network','enterprise')
       WHEN feature IN ('events','groups','forms','email','media','staff_roles') THEN belivrhq_effective_plan(church) IN ('community','network','enterprise')
       WHEN feature IN ('tickets','pastoral','assets','analytics','sms','whatsapp','calls','webhooks','custom_roles') THEN belivrhq_effective_plan(church) IN ('network','enterprise') ELSE FALSE END
 FROM platform_subscriptions WHERE church_id=church),FALSE)
$$;

CREATE OR REPLACE FUNCTION belivrhq_notify_subscription(church TEXT, resource_name TEXT, band INTEGER, used_count BIGINT, allowance INTEGER) RETURNS VOID
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE period TIMESTAMP(3);
BEGIN
 SELECT paid_until INTO period FROM platform_subscriptions WHERE church_id=church;
 IF period IS NULL THEN RETURN; END IF;
 WITH fresh AS (
  INSERT INTO subscription_alert_keys(id,church_id,profile_id,resource,threshold,period_end)
  SELECT md5(random()::text||clock_timestamp()::text||p.id),church,p.id,resource_name,band,period
  FROM profiles p WHERE p.church_id=church AND p.status='active' AND p.archived_at IS NULL
   AND p.role && ARRAY['church_admin','super_admin']::TEXT[]
  ON CONFLICT DO NOTHING RETURNING profile_id
 ) INSERT INTO notifications(id,church_id,profile_id,type,title,body,data,created_at)
 SELECT md5(random()::text||clock_timestamp()::text||profile_id),church,profile_id,'system',
 CASE WHEN resource_name='renewal' THEN 'Subscription renewal reminder' ELSE 'Subscription allowance: '||resource_name END,
 CASE WHEN resource_name='renewal' THEN 'Your BelivrHQ subscription is due for manual renewal within seven days.' ELSE used_count||' of '||allowance||' '||resource_name||' used. Review Plan & Billing.' END,
 jsonb_build_object('url','/subscription','resource',resource_name,'threshold',band),CURRENT_TIMESTAMP FROM fresh;
END $$;

CREATE OR REPLACE FUNCTION belivrhq_notify_renewal(church TEXT) RETURNS VOID
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM platform_subscriptions WHERE church_id=church AND paid_until <= CURRENT_TIMESTAMP+interval '7 days') THEN
  PERFORM belivrhq_notify_subscription(church,'renewal',7,0,0);
 END IF;
END $$;

CREATE OR REPLACE FUNCTION belivrhq_check_capacity() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE resource TEXT; used_count BIGINT; allowance INTEGER; increasing BOOLEAN; own_email TEXT;
BEGIN
 IF TG_OP='UPDATE' AND NEW.church_id <> OLD.church_id THEN RAISE EXCEPTION 'Church ownership cannot be changed'; END IF;
 IF TG_TABLE_NAME='members' THEN
  resource:='members'; increasing:=NEW.archived_at IS NULL;
  IF TG_OP='UPDATE' THEN increasing:=increasing AND OLD.archived_at IS NOT NULL; END IF;
 ELSIF TG_TABLE_NAME='branches' THEN
  resource:='locations'; increasing:=NEW.archived_at IS NULL;
  IF TG_OP='UPDATE' THEN increasing:=increasing AND OLD.archived_at IS NOT NULL; END IF;
 ELSIF TG_TABLE_NAME='profiles' THEN
  resource:='staff'; increasing:=NEW.archived_at IS NULL AND NEW.status='active' AND cardinality(NEW.role)>0;
  IF TG_OP='UPDATE' THEN increasing:=increasing AND (OLD.archived_at IS NOT NULL OR OLD.status<>'active' OR cardinality(OLD.role)=0); END IF;
  own_email:=lower(NEW.email);
 ELSE
  resource:='staff'; increasing:=NEW.expires_at > CURRENT_TIMESTAMP; own_email:=lower(NEW.email);
 END IF;
 IF NOT increasing THEN RETURN NEW; END IF;
 PERFORM id FROM churches WHERE id=NEW.church_id FOR UPDATE;
 allowance:=belivrhq_plan_limit(NEW.church_id,resource);
 IF resource='members' THEN SELECT count(*) INTO used_count FROM members WHERE church_id=NEW.church_id AND archived_at IS NULL;
 ELSIF resource='locations' THEN SELECT count(*) INTO used_count FROM branches WHERE church_id=NEW.church_id AND archived_at IS NULL;
 ELSE
  SELECT count(*) INTO used_count FROM profiles WHERE church_id=NEW.church_id AND archived_at IS NULL AND status='active' AND cardinality(role)>0;
  used_count:=used_count+(SELECT count(*) FROM staff_invitation_reservations WHERE church_id=NEW.church_id AND expires_at>CURRENT_TIMESTAMP AND lower(email) IS DISTINCT FROM own_email);
  -- An invitation for an already-enabled profile must not reserve another seat.
  IF TG_TABLE_NAME='staff_invitation_reservations' AND EXISTS(SELECT 1 FROM profiles WHERE church_id=NEW.church_id AND lower(email)=own_email AND status='active' AND archived_at IS NULL) THEN RAISE EXCEPTION 'A staff account already exists for this email'; END IF;
 END IF;
 IF used_count>=allowance THEN RAISE EXCEPTION 'PLAN_LIMIT_REACHED:%',resource USING ERRCODE='P0001'; END IF;
 IF resource IN ('members','staff') AND allowance>0 AND (used_count+1)::numeric/allowance >= .8 THEN
  PERFORM belivrhq_notify_subscription(NEW.church_id,resource,CASE WHEN used_count+1>=allowance THEN 100 WHEN (used_count+1)::numeric/allowance>=.9 THEN 90 ELSE 80 END,used_count+1,allowance);
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION belivrhq_check_feature() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE church TEXT; feature TEXT:=TG_ARGV[0];
BEGIN
 -- Archiving/reducing retained data is allowed after a downgrade.
 IF TG_OP='UPDATE' AND to_jsonb(NEW)->>'archived_at' IS NOT NULL THEN RETURN NEW; END IF;
 church:=to_jsonb(NEW)->>'church_id';
 IF church IS NULL AND TG_TABLE_NAME='tickets' THEN
 SELECT church_id INTO church FROM events WHERE id=NEW.event_id;
 IF NEW.registration_id IS NOT NULL AND NEW.payment_reference IS NOT NULL AND EXISTS(
  SELECT 1 FROM event_registrations r WHERE r.id=NEW.registration_id AND r.church_id=church
   AND r.payment_status='paid' AND r.payment_reference=NEW.payment_reference AND r.transaction_id=NEW.transaction_id
 ) THEN RETURN NEW; END IF;
 IF COALESCE(NEW.price_paid,0)=0 AND NEW.registration_id IS NOT NULL THEN feature:='events'; END IF;
 END IF;
 -- A charge accepted just before expiry still needs its immutable financial record.
 IF TG_TABLE_NAME='transactions' THEN
 IF NEW.type='digital' AND NEW.integration_account_id IS NOT NULL AND EXISTS(
  SELECT 1 FROM recurring_giving r WHERE r.id=NEW.metadata->>'recurring_giving_id'
   AND r.church_id=church AND r.integration_account_id=NEW.integration_account_id AND r.authorization_code IS NOT NULL
 ) THEN RETURN NEW; END IF;
 END IF;
 IF NOT belivrhq_has_feature(church,feature) THEN RAISE EXCEPTION 'PLAN_FEATURE_REQUIRED:%',feature USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION belivrhq_check_media_plan() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE feature TEXT;
BEGIN
 IF NEW.folder IN ('profiles','churches','branches') THEN RETURN NEW; END IF;
 feature := CASE WHEN NEW.folder='assets' THEN 'assets'
                 WHEN NEW.folder='form-attachments' THEN 'forms' ELSE 'media' END;
 IF NOT belivrhq_has_feature(NEW.church_id,feature) THEN
   RAISE EXCEPTION 'PLAN_FEATURE_REQUIRED:%',feature USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION belivrhq_check_paid_event_plan() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF (NOT NEW.is_free OR COALESCE(NEW.price,0)>0) AND NOT belivrhq_has_feature(NEW.church_id,'tickets') THEN
   RAISE EXCEPTION 'PLAN_FEATURE_REQUIRED:tickets' USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION belivrhq_check_role_plan() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE current_plan TEXT; selected_role TEXT;
BEGIN
 IF TG_TABLE_NAME='roles' THEN
  IF NEW.church_id IS NOT NULL AND NOT belivrhq_has_feature(NEW.church_id,'custom_roles') THEN
   RAISE EXCEPTION 'PLAN_FEATURE_REQUIRED:custom_roles' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.status<>'active' OR NEW.archived_at IS NOT NULL OR cardinality(NEW.role)=0 THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.role=OLD.role AND OLD.status='active' AND OLD.archived_at IS NULL THEN RETURN NEW; END IF;
 IF 'super_admin'=ANY(NEW.role) THEN RETURN NEW; END IF;
 SELECT belivrhq_effective_plan(NEW.church_id) INTO current_plan;
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

CREATE OR REPLACE FUNCTION churchos_has_feature(church TEXT, feature TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT COALESCE((SELECT
  (CASE WHEN jsonb_array_length(COALESCE(access_grants->'grants','[]'::jsonb))=0 THEN paid_until>CURRENT_TIMESTAMP ELSE TRUE END) AND
  CASE WHEN feature IN ('giving','reports') THEN churchos_effective_plan(church) IN ('essentials','community','network','enterprise')
       WHEN feature IN ('events','groups','forms','email','media','staff_roles') THEN churchos_effective_plan(church) IN ('community','network','enterprise')
       WHEN feature IN ('tickets','pastoral','assets','analytics','sms','whatsapp','calls','webhooks','custom_roles') THEN churchos_effective_plan(church) IN ('network','enterprise') ELSE FALSE END
 FROM platform_subscriptions WHERE church_id=church),FALSE)
$$;

CREATE OR REPLACE FUNCTION churchos_notify_subscription(church TEXT, resource_name TEXT, band INTEGER, used_count BIGINT, allowance INTEGER) RETURNS VOID
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE period TIMESTAMP(3);
BEGIN
 SELECT paid_until INTO period FROM platform_subscriptions WHERE church_id=church;
 IF period IS NULL THEN RETURN; END IF;
 WITH fresh AS (
  INSERT INTO subscription_alert_keys(id,church_id,profile_id,resource,threshold,period_end)
  SELECT md5(random()::text||clock_timestamp()::text||p.id),church,p.id,resource_name,band,period
  FROM profiles p WHERE p.church_id=church AND p.status='active' AND p.archived_at IS NULL
   AND p.role && ARRAY['church_admin','super_admin']::TEXT[]
  ON CONFLICT DO NOTHING RETURNING profile_id
 ) INSERT INTO notifications(id,church_id,profile_id,type,title,body,data,created_at)
 SELECT md5(random()::text||clock_timestamp()::text||profile_id),church,profile_id,'system',
 CASE WHEN resource_name='renewal' THEN 'Subscription renewal reminder' ELSE 'Subscription allowance: '||resource_name END,
 CASE WHEN resource_name='renewal' THEN 'Your BelivrHQ subscription is due for manual renewal within seven days.' ELSE used_count||' of '||allowance||' '||resource_name||' used. Review Plan & Billing.' END,
 jsonb_build_object('url','/subscription','resource',resource_name,'threshold',band),CURRENT_TIMESTAMP FROM fresh;
END $$;

CREATE OR REPLACE FUNCTION churchos_notify_renewal(church TEXT) RETURNS VOID
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM platform_subscriptions WHERE church_id=church AND paid_until <= CURRENT_TIMESTAMP+interval '7 days') THEN
  PERFORM churchos_notify_subscription(church,'renewal',7,0,0);
 END IF;
END $$;

CREATE OR REPLACE FUNCTION churchos_check_capacity() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE resource TEXT; used_count BIGINT; allowance INTEGER; increasing BOOLEAN; own_email TEXT;
BEGIN
 IF TG_OP='UPDATE' AND NEW.church_id <> OLD.church_id THEN RAISE EXCEPTION 'Church ownership cannot be changed'; END IF;
 IF TG_TABLE_NAME='members' THEN
  resource:='members'; increasing:=NEW.archived_at IS NULL;
  IF TG_OP='UPDATE' THEN increasing:=increasing AND OLD.archived_at IS NOT NULL; END IF;
 ELSIF TG_TABLE_NAME='branches' THEN
  resource:='locations'; increasing:=NEW.archived_at IS NULL;
  IF TG_OP='UPDATE' THEN increasing:=increasing AND OLD.archived_at IS NOT NULL; END IF;
 ELSIF TG_TABLE_NAME='profiles' THEN
  resource:='staff'; increasing:=NEW.archived_at IS NULL AND NEW.status='active' AND cardinality(NEW.role)>0;
  IF TG_OP='UPDATE' THEN increasing:=increasing AND (OLD.archived_at IS NOT NULL OR OLD.status<>'active' OR cardinality(OLD.role)=0); END IF;
  own_email:=lower(NEW.email);
 ELSE
  resource:='staff'; increasing:=NEW.expires_at > CURRENT_TIMESTAMP; own_email:=lower(NEW.email);
 END IF;
 IF NOT increasing THEN RETURN NEW; END IF;
 PERFORM id FROM churches WHERE id=NEW.church_id FOR UPDATE;
 allowance:=churchos_plan_limit(NEW.church_id,resource);
 IF resource='members' THEN SELECT count(*) INTO used_count FROM members WHERE church_id=NEW.church_id AND archived_at IS NULL;
 ELSIF resource='locations' THEN SELECT count(*) INTO used_count FROM branches WHERE church_id=NEW.church_id AND archived_at IS NULL;
 ELSE
  SELECT count(*) INTO used_count FROM profiles WHERE church_id=NEW.church_id AND archived_at IS NULL AND status='active' AND cardinality(role)>0;
  used_count:=used_count+(SELECT count(*) FROM staff_invitation_reservations WHERE church_id=NEW.church_id AND expires_at>CURRENT_TIMESTAMP AND lower(email) IS DISTINCT FROM own_email);
  -- An invitation for an already-enabled profile must not reserve another seat.
  IF TG_TABLE_NAME='staff_invitation_reservations' AND EXISTS(SELECT 1 FROM profiles WHERE church_id=NEW.church_id AND lower(email)=own_email AND status='active' AND archived_at IS NULL) THEN RAISE EXCEPTION 'A staff account already exists for this email'; END IF;
 END IF;
 IF used_count>=allowance THEN RAISE EXCEPTION 'PLAN_LIMIT_REACHED:%',resource USING ERRCODE='P0001'; END IF;
 IF resource IN ('members','staff') AND allowance>0 AND (used_count+1)::numeric/allowance >= .8 THEN
  PERFORM churchos_notify_subscription(NEW.church_id,resource,CASE WHEN used_count+1>=allowance THEN 100 WHEN (used_count+1)::numeric/allowance>=.9 THEN 90 ELSE 80 END,used_count+1,allowance);
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION churchos_check_feature() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE church TEXT; feature TEXT:=TG_ARGV[0];
BEGIN
 -- Archiving/reducing retained data is allowed after a downgrade.
 IF TG_OP='UPDATE' AND to_jsonb(NEW)->>'archived_at' IS NOT NULL THEN RETURN NEW; END IF;
 church:=to_jsonb(NEW)->>'church_id';
 IF church IS NULL AND TG_TABLE_NAME='tickets' THEN
 SELECT church_id INTO church FROM events WHERE id=NEW.event_id;
 IF NEW.registration_id IS NOT NULL AND NEW.payment_reference IS NOT NULL AND EXISTS(
  SELECT 1 FROM event_registrations r WHERE r.id=NEW.registration_id AND r.church_id=church
   AND r.payment_status='paid' AND r.payment_reference=NEW.payment_reference AND r.transaction_id=NEW.transaction_id
 ) THEN RETURN NEW; END IF;
 IF COALESCE(NEW.price_paid,0)=0 AND NEW.registration_id IS NOT NULL THEN feature:='events'; END IF;
 END IF;
 -- A charge accepted just before expiry still needs its immutable financial record.
 IF TG_TABLE_NAME='transactions' THEN
 IF NEW.type='digital' AND NEW.integration_account_id IS NOT NULL AND EXISTS(
  SELECT 1 FROM recurring_giving r WHERE r.id=NEW.metadata->>'recurring_giving_id'
   AND r.church_id=church AND r.integration_account_id=NEW.integration_account_id AND r.authorization_code IS NOT NULL
 ) THEN RETURN NEW; END IF;
 END IF;
 IF NOT churchos_has_feature(church,feature) THEN RAISE EXCEPTION 'PLAN_FEATURE_REQUIRED:%',feature USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION churchos_check_media_plan() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE feature TEXT;
BEGIN
 IF NEW.folder IN ('profiles','churches','branches') THEN RETURN NEW; END IF;
 feature := CASE WHEN NEW.folder='assets' THEN 'assets'
                 WHEN NEW.folder='form-attachments' THEN 'forms' ELSE 'media' END;
 IF NOT churchos_has_feature(NEW.church_id,feature) THEN
   RAISE EXCEPTION 'PLAN_FEATURE_REQUIRED:%',feature USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION churchos_check_paid_event_plan() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF (NOT NEW.is_free OR COALESCE(NEW.price,0)>0) AND NOT churchos_has_feature(NEW.church_id,'tickets') THEN
   RAISE EXCEPTION 'PLAN_FEATURE_REQUIRED:tickets' USING ERRCODE='P0001';
 END IF;
 RETURN NEW;
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

CREATE OR REPLACE FUNCTION churchos_effective_plan(church TEXT) RETURNS TEXT
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

DO $brand$
DECLARE item RECORD; definition TEXT; renamed TEXT;
BEGIN
 FOR item IN SELECT t.oid,t.tgname,c.relname,n.nspname,p.proname
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
   WHERE NOT t.tgisinternal AND n.nspname='public' AND p.proname LIKE 'churchos\_%' ESCAPE '\'
 LOOP
   definition := pg_get_triggerdef(item.oid);
   renamed := replace(item.tgname,'churchos_','belivrhq_');
   EXECUTE format('DROP TRIGGER %I ON %I.%I',item.tgname,item.nspname,item.relname);
   definition := replace(definition, item.tgname, renamed);
   definition := replace(definition, item.proname, replace(item.proname,'churchos_','belivrhq_'));
   EXECUTE definition;
 END LOOP;
END $brand$;

COMMIT;
