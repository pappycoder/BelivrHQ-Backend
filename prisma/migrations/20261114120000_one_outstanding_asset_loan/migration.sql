-- Existing duplicates must be resolved explicitly before deployment; never discard loan history.
CREATE UNIQUE INDEX "asset_loans_one_outstanding_per_asset"
ON "asset_loans" ("asset_id")
WHERE "status" IN ('borrowed', 'overdue');
