```
pnpm install    # at the repository root; installs backend and frontend
pnpm run dev
```

```
open http://localhost:3000
```

## Changing the database schema

The schema is applied with migrations from `migrations/`, never with `prisma db update`.

1. Edit `src/prisma/contract.prisma`.
2. `pnpm prisma contract emit`
3. `pnpm prisma migration plan --name <what-changed>` writes a new folder under `migrations/app/`. Review it and commit it together with the contract.
4. On deploy, the `migrate` service runs `prisma db migrate` before the server starts.

`pnpm prisma migration status --db $DATABASE_URL` shows what is pending on a database. The tests apply the same migrations and then run `prisma db verify`, so a contract change without a migration fails them.

## Payments

Production and staging both use the Stripe sandbox. Checkout charges in US dollars, the prices shown in `frontend/src/lib/pricing.ts` and the Terms of Service:

| Plan     | Price      | Variable                    | Checkout mode |
| -------- | ---------- | --------------------------- | ------------- |
| Monthly  | $5 / month | `STRIPE_PRICE_SUBSCRIPTION` | subscription  |
| Yearly   | $50 / year | `STRIPE_PRICE_YEARLY`       | subscription  |
| Lifetime | $99 once   | `STRIPE_PRICE_LIFETIME`     | payment       |

`STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-prices.mjs` (from the repository root) creates the products and prices, lets the default Customer Portal configuration switch between monthly and yearly (monthly to yearly is charged right away, yearly to monthly waits for the paid year to end), checks that a USD Checkout still offers cards, and prints the `gh variable set` commands for the `production` and `staging` environments. It is safe to run again. A changed amount becomes a new price that takes over the lookup key; existing subscribers stay on the price they signed up with.

A lifetime purchase cancels the buyer's active subscription, monthly or yearly. Receipts are Stripe's: lifetime payments set `receipt_email`, and subscription payments need **Settings → Business → Customer emails → Successful payments** switched on in the Stripe Dashboard (sandboxes don't send receipts automatically; send one from the payment's page to preview it). Checkout keeps the Stripe customer's email equal to the account's.

New accounts get a 14-day free trial with full access, no card required. It starts when the email address is first verified (`User.trialEndsAt`); accounts that existed before the trial have `trialEligible = false`. A background job emails a reminder three days before the end and on the last day; `User.trialRemindersSent` records which went out, so each is sent once across restarts and instances.

## Backups & restore

The `backup` service runs `pg_dump -Fc` every day at 03:00 UTC (and once on first start). Dumps live on the host in `/var/backups/pulseboard/<compose project>/` (`BACKUP_DIR` overrides the base), so `pulseboard` and `pulseboard-staging` each have their own folder:

- `daily/` keeps the last 7 dumps, `weekly/` the last 4 Sunday dumps
- `manual/` and `pre-restore/` are never pruned, delete old ones by hand

The backups are on the same disk as the database, copy important ones off the server.

The scripts only need `docker`, so run them from your own clone of the repo on the server (the runner's checkout under `/home/runner` isn't readable by other users). They default to `$COMPOSE_PROJECT_NAME`, or `pulseboard` (production):

```
scripts/db-backup.sh --project pulseboard-staging    # take a backup now, e.g. before a risky migration
scripts/db-restore.sh <file> --project pulseboard-staging
scp italy:/var/backups/pulseboard/pulseboard/daily/pulseboard-2026-10-24T0300Z.dump .
```

`db-restore.sh` asks you to type the project name (skip with `--yes`) and refuses production without `--prod`. It takes a `pre-restore/` backup, stops `server` and `pgweb`, recreates the database from the dump, runs `migrate` and starts them again. If it fails, it leaves the app stopped and prints the command to roll back to the safety backup.

If `docker ps` shows the backup container as unhealthy, there has been no daily dump for over 26 hours, check `docker logs <project>-backup-1`.
