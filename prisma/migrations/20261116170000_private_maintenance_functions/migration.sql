-- Existing Supabase maintenance functions predate Prisma migration ownership.
-- They move records across tenants and must never be browser-callable RPCs.
-- Fresh databases may not contain them. Preserve owner/explicit trusted grants.
DO $$
DECLARE function_name text; browser_role text;
BEGIN
  FOR function_name IN
    SELECT format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind='f'
      AND p.proname IN ('archive_old_attendance','archive_old_messages')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=public,pg_temp', function_name);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', function_name);
    FOREACH browser_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname=browser_role) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', function_name, browser_role);
      END IF;
    END LOOP;
  END LOOP;
END $$;
