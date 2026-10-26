# Tests

Requires Node.js 24, pnpm 12 (`corepack enable` picks the version pinned in `package.json`) and Docker with Compose v2. Run commands from the repository root.

```sh
pnpm install --frozen-lockfile  # Root, backend and frontend in one go

pnpm test                       # Vitest unit tests; no services needed
pnpm run test:watch             # Unit tests in watch mode
pnpm run test:typecheck         # Type-check tests and test configuration

pnpm run test:services          # Dedicated PostgreSQL and Mailpit
pnpm run test:integration       # Hono requests against a real database
pnpm exec playwright install chromium
pnpm run test:e2e               # Build backend + frontend, then test Chromium

pnpm run test:services:stop
```

With services and Chromium installed, `pnpm run test:all` runs all three suites.

## Isolation

`compose.test.yml` is independent of the application/deployment Compose file. PostgreSQL uses temporary storage and database `pulseboard_test` on port 55439. Mailpit exposes SMTP on 51025 and its UI/API on 58025. The browser test starts its own server on port 4300; it refuses to reuse another server. If that port is occupied, use `TEST_PORT=4317 pnpm run test:e2e` to run on a separate port.

Tests ignore the application's `DATABASE_URL`. Override the test database only with `TEST_DATABASE_URL`; the database name must end in `_test`. The Prisma contract is applied automatically before integration tests and before the E2E server starts, with generated files isolated in `.test-cache/` by `backend/prisma.test.config.ts`. Use a dedicated disposable database: tests create and remove their own accounts. E2E supports `TEST_SMTP_URL` and `TEST_MAILPIT_URL` for a dedicated alternative Mailpit instance.

API tests use `app.request()` without opening a port, real PostgreSQL queries and transactions, and a mocked mail sender. Each test uses unique account addresses and a separate rate-limit IP key, and removes its accounts afterward. Expired database records are seeded directly; unit tests use a fake clock for limiter boundaries.

The browser test uses the built Astro site, the real backend and SMTP through Mailpit. It registers a unique account, follows the verification link from its email, which starts the free trial and opens the dashboard, then selects a lifetime license and checks the dashboard and persisted session. Stripe HTTP responses are intercepted by Nock using dummy credentials: the checkout fixture redirects to the real success page, which confirms the session through the backend. No real payment or hosted Stripe form is exercised. API tests also check unpaid sessions and reject confirmation by another account. Google is enabled in the browser suite and answered by `tests/google.mjs`: the test plays Google's consent page and puts the profile it wants in the `code`. Facebook stays disabled there; its callbacks are covered by the API tests.

## Adding coverage

- `backend/tests/unit/`: isolated logic such as password hashing, rate limiting and public URLs.
- `frontend/tests/`: API error handling and access redirects, with mocked `fetch`.
- `backend/tests/integration/`: API contracts and persisted account/session behavior.
- `tests/e2e/`: critical browser journeys; prefer roles and labels, or Carbon host selectors when necessary for shadow DOM.

CI runs unit tests, API integration tests, both builds and the Chromium scenario on pull requests and pushes to main/staging. On failure it uploads the Playwright report, screenshots and traces. To inspect a local report, run `pnpm exec playwright show-report`.

## Imported metrics dashboard

`frontend/tests/dashboard.test.ts` runs the dashboard controller in Happy DOM,
covering selection changes, aborts and out-of-order responses, errors/retry,
empty datasets, single readings, actual timestamp spacing and keyboard chart
inspection. It runs with `pnpm test` and does not require a build or services.
`backend/tests/integration/dashboard.test.ts` checks authentication, verification,
licensing, owner isolation, literal host search, range selection and a real
500,000-row PostgreSQL history. The large fixture is removed with its test account.

Dashboard URLs accept `?dataset=<id>`. Authenticated, verified, licensed owners
can read `/api/datasets/:id/hosts?q=<literal-substring>` (at most 100 matches;
`hasMore` asks the UI to refine the search) and
`/api/datasets/:id/metrics?host=<hostname>&range=all|1h|24h|7d|30d`.
Ranges are inclusive and end at that host's last imported timestamp, not the
current clock. Responses are private and not cached. Charts return at most 600
original readings sampled uniformly by row, retaining both endpoints. The API
reports the total and sampling mode; the UI warns that sampling can omit peaks.
KPIs use the exact final reading; the expandable table contains the same points
as the charts. Times are displayed in UTC and values to at most three decimals.

The same owners can read aggregates over the same `host` and `range` selection:

- `/api/datasets/:id/stats?host=<hostname>&range=…` returns, for each of
  `cpuPercent`, `ramPercent`, `diskPercent`, `netInMbps` and `netOutMbps`, the
  reading count, `min`, `avg`, `max` and `p95` (`percentile_cont(0.95)`). The
  three percentage metrics also return `shareAbove80` and `shareAbove90`, the
  fraction (0–1) of readings strictly above 80% and 90%. With no readings,
  every value except the count is `null`.
- `/api/datasets/:id/history?host=<hostname>&range=…&bucket=5m|1h|1d` returns
  the `avg` and `max` of each metric per bucket. Buckets are aligned to UTC
  clock boundaries and cover the first to the last reading in the range. Empty
  buckets have `count: 0` and `null` values, so gaps stay visible. The default
  bucket is `5m` for `1h` and `24h`, `1h` for `7d` and `30d`, and for `all` the
  finest bucket that fits. A request over 2,000 buckets returns 400 with
  `buckets` and `maxBuckets`. For fixed ranges the count comes from the range
  length (`7d` with `5m` is always rejected); for `all` it comes from the
  host's data span.

`backend/tests/integration/dashboard.test.ts` checks exact statistics on a known
fixture, range and host isolation, empty hosts, per-bucket values across a gap,
default and partial buckets, invalid buckets and the bucket limit. The existing
authorization and owner-isolation checks also cover both endpoints.

For manual verification with the built app and a disposable licensed account:

1. Use `sc instructions browser`, then `sc browser open <app-url>/datasets`.
2. Import `samples/servers-30d.csv` using `sc browser upload`; open the resulting
   dataset's dashboard link.
3. Check `db-01`'s final values: CPU 20.3%, RAM 46.4%, disk 42.5%, incoming
   8.92 Mbps and outgoing 3.6 Mbps, at `2026-09-30T23:45:00Z`.
4. Switch to `web-01` and the last 24 hours. Expect 97 readings (both boundaries
   included), CPU 28.1%, RAM 53.2%, disk 70.9%, incoming 15.85 Mbps and outgoing
   6.75 Mbps. Compare plotted table values with the CSV.
5. Import a second, single-reading CSV and switch datasets. Verify a visible
   point, exact timestamp, and the single-reading explanation.
6. Capture the metrics and charts with `sc browser screenshot --out <path>`.
7. With the session cookie, request
   `/api/datasets/<id>/stats?host=web-01&range=24h`. Expect 97 readings with
   CPU min 22.2, max 48 and p95 46.3. Import
   `samples/gaps-and-anomalies-14d.csv` and request
   `/api/datasets/<id>/history?host=web-01&bucket=1h`. Expect empty buckets
   from `2026-09-04T09:00:00.000Z` to `2026-09-04T14:00:00.000Z`.

Browser control uses documented `sc browser` commands. The existing Playwright
suite remains available for CI; manual `sc` verification does not run that suite.

## Sessions

`backend/tests/integration/sessions.test.ts` seeds session rows directly to
cover sliding expiry (a session used with under 15 of its 30 days left is
extended and its cookie re-sent), the at-most-every-5-minutes `lastSeenAt`
write, the recorded user agent and client IP, listing, revoking one session,
"log out everywhere else", CSRF and cleanup of expired rows.
`authorization.test.ts` checks that no session route lists or revokes another
user's sessions. `frontend/tests/sessions.test.ts` covers the settings list in
Happy DOM and `tests/e2e/sessions.spec.ts` signs a second browser context out
from the settings page, one device and then all others.

## Connected accounts and setting a password

`backend/tests/integration/connectedAccounts.test.ts` covers the "set a
password" link for social-only accounts (a password reset token, sent only to
verified, password-less accounts), the notice emails, and linking from the
settings: password or fresh-sign-in re-authentication, attaching to the signed-in
user rather than by email, the session binding of the state cookie, provider
accounts already used elsewhere, and unverified provider emails. Unlinking asks for the same re-authentication, stays disconnected (Google no
longer links by email to an account with a password), checks
the last-login rule (including parallel requests and disabled providers) and
signs out other sessions. `authorization.test.ts` checks that no one lists or
disconnects another user's logins. `frontend/tests/connectedAccounts.test.ts`
covers the settings section in Happy DOM, and `tests/e2e/connected-accounts.spec.ts`
signs in with Google, sets a password from the Mailpit link, then disconnects and
reconnects Google.

## Verification links and password pre-hijack

Anyone can register someone else's address with a password. Opened outside the
account's own session, the verification link of an account with a password asks
for that password before it verifies or signs in; the attempts share the login
rate limits. "I didn't create this account" verifies the address instead, ends
every session, removes the password and logins that don't prove the address,
and emails a set-password link. `backend/tests/integration/passwordPreHijack.test.ts`
covers both paths, the trial starting once, links already used up by a reset,
the rate limits and a login racing the takeover. `frontend/tests/auth.test.ts`
covers the verify page's requests and messages, and
`tests/e2e/password-prehijack.spec.ts` plays both paths in the browser, the
second with an intruder's browser signed in to the account.
