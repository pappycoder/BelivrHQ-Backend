# Manual subscription testing

Run commands from `BelivrHQ-Backend`. The script uses `DATABASE_URL` from the process environment or backend `.env`; it prints the database host/name without credentials. Use a test database/church for these manual overrides.

```bash
# Find the church ID and inspect its current plan/expiry
npm run subscription:test -- --list

# Preview a plan switch
npm run subscription:test -- --church CHURCH_ID --plan network --dry-run

# Apply immediately (one calendar month of access by default)
npm run subscription:test -- --church CHURCH_ID --plan essentials
npm run subscription:test -- --church CHURCH_ID --plan community --days 30
npm run subscription:test -- --church CHURCH_ID --plan network --cycle annual

# Exercise expired-subscription screens
npm run subscription:test -- --church CHURCH_ID --plan essentials --expired

# Enterprise always needs explicit capacities
npm run subscription:test -- --church CHURCH_ID --plan enterprise --members 5000 --staff 50 --locations 10

npm run subscription:test -- --help
```

Replace `CHURCH_ID` with the exact ID from `--list`. Only that active church's subscription is updated (or created if absent). The script resets the billing period and clears scheduled plan/cycle changes. Switching away from Enterprise clears its custom capacities. No payment provider is contacted and no payment, member, staff or location records are created/deleted.

The new plan immediately controls API features and quotas, including when existing usage exceeds a lower plan's limits. Refresh the app/session to reload cached UI features. Existing payment history will not reflect these manual test grants. Pending checkouts remain unchanged; later payment verification can change the subscription, so avoid verifying an old checkout during plan testing.

To finish testing, run the command again with the desired plan and duration. This is a manual override, not automatic restoration of the previous subscription; the command output includes its previous values for reference. No migration or running API/worker is required, but the database must already have the current subscription schema.
