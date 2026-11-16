-- Business tables are reached through the backend's verified tenant/permission boundary.
-- Supabase browser roles must not bypass that boundary through REST/GraphQL/RPC.
-- Scope changes to application-owned public objects; leave Auth, Storage and extensions alone.
DO $$
DECLARE table_name text; browser_role text; function_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'churches',
    'branches',
    'church_configs',
    'platform_subscriptions',
    'subscription_payments',
    'subscription_alert_keys',
    'profiles',
    'profile_authenticators',
    'verified_mfa_sessions',
    'staff_invitation_reservations',
    'roles',
    'permissions',
    'role_permissions',
    'church_role_permissions',
    'members',
    'visitors',
    'families',
    'family_members',
    'custom_field_definitions',
    'intake_links',
    'intake_submissions',
    'services',
    'attendance_sessions',
    'attendance',
    'giving_categories',
    'transactions',
    'recurring_giving',
    'events',
    'event_ticket_tiers',
    'event_registrations',
    'tickets',
    'departments',
    'department_members',
    'department_attendance',
    'cell_groups',
    'cell_group_members',
    'cell_group_attendance',
    'messages',
    'templates',
    'broadcasts',
    'broadcast_recipients',
    'email_messages',
    'email_recipients',
    'company_email_notifications',
    'notifications',
    'integration_accounts',
    'integration_channels',
    'sermons',
    'sermon_bookmarks',
    'media_assets',
    'pastoral_notes',
    'life_events',
    'risk_scores',
    'engagement_scores',
    'appointments',
    'asset_categories',
    'assets',
    'asset_maintenance',
    'asset_depreciation',
    'asset_loans',
    'asset_scan_logs',
    'forms',
    'form_submissions',
    'sync_devices',
    'sync_queue',
    'offline_receipts',
    'audit_logs',
    'webhook_subscriptions',
    'webhook_deliveries',
    '_prisma_migrations'
  ] LOOP
    -- Avoid an unnecessary ACCESS EXCLUSIVE lock on already-hardened hosted tables.
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=format('public.%I', table_name)::regclass) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    END IF;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);
    FOREACH browser_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname=browser_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, browser_role);
      END IF;
    END LOOP;
  END LOOP;

  -- App helpers include billing/capacity functions. Their API is internal, including legacy aliases.
  FOR function_name IN
    SELECT format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind='f' AND p.proname ~ '^(belivrhq_|churchos_)'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', function_name);
    FOREACH browser_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname=browser_role) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', function_name, browser_role);
      END IF;
    END LOOP;
  END LOOP;

  -- Undo automatic per-schema browser grants for future objects made by this migration role.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
  FOREACH browser_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=browser_role) THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', browser_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', browser_role);
    END IF;
  END LOOP;
END $$;
