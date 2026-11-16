-- Delivery intent commits or rolls back with the documented domain transition.
-- Do not backfill historical events: that would cause unsolicited external sends.
CREATE INDEX "webhook_deliveries_status_next_retry_at_id_idx"
  ON "webhook_deliveries" ("status", "next_retry_at", "id");

CREATE FUNCTION belivrhq_enqueue_domain_webhook() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE event_name text; event_payload jsonb;
BEGIN
  IF TG_TABLE_NAME = 'members' THEN
    event_name := 'member.created';
    event_payload := jsonb_build_object('memberId', NEW.id, 'branchId', NEW.branch_id);
  ELSIF TG_TABLE_NAME = 'transactions' THEN
    IF NEW.status <> 'success' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' THEN
      IF OLD.status = 'success' THEN RETURN NEW; END IF;
    END IF;
    event_name := 'transaction.completed';
    event_payload := jsonb_build_object('transactionId', NEW.id, 'amount', NEW.amount, 'currency', NEW.currency);
  ELSE
    RETURN NEW;
  END IF;
  INSERT INTO webhook_deliveries (id, subscription_id, event, payload, status, attempts, created_at)
  SELECT gen_random_uuid()::text, s.id, event_name, event_payload, 'pending', 0, now()
  FROM webhook_subscriptions s
  WHERE s.church_id = NEW.church_id AND s.is_active AND s.archived_at IS NULL
    AND event_name = ANY(s.events);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION belivrhq_enqueue_domain_webhook() FROM PUBLIC;

CREATE TRIGGER belivrhq_member_created_webhook AFTER INSERT ON members
FOR EACH ROW EXECUTE FUNCTION belivrhq_enqueue_domain_webhook();
CREATE TRIGGER belivrhq_transaction_completed_webhook AFTER INSERT OR UPDATE OF status ON transactions
FOR EACH ROW EXECUTE FUNCTION belivrhq_enqueue_domain_webhook();
