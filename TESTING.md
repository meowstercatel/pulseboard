# Tests

Requires Node.js 24, pnpm 12 and Docker with Compose v2. Run commands from the repository root.

```sh
npm ci
pnpm --dir backend install --frozen-lockfile
npm --prefix frontend ci

npm test                       # Vitest unit tests; no services needed
npm run test:watch              # Unit tests in watch mode
npm run test:typecheck          # Type-check tests and test configuration

npm run test:services           # Dedicated PostgreSQL and Mailpit
npm run test:integration        # Hono requests against a real database
npx playwright install chromium
npm run test:e2e                # Build backend + frontend, then test Chromium

npm run test:services:stop
```

With services and Chromium installed, `npm run test:all` runs all three suites.

## Isolation

`compose.test.yml` is independent of the application/deployment Compose file. PostgreSQL uses temporary storage and database `pulseboard_test` on port 55439. Mailpit exposes SMTP on 51025 and its UI/API on 58025. The browser test starts its own server on port 4300; it refuses to reuse another server.

Tests ignore the application's `DATABASE_URL`. Override the test database only with `TEST_DATABASE_URL`; the database name must end in `_test`. The Prisma contract is applied automatically before integration tests and before the E2E server starts, with generated files isolated in `.test-cache/` by `backend/prisma.test.config.ts`. Use a dedicated disposable database: tests create and remove their own accounts. E2E supports `TEST_SMTP_URL` and `TEST_MAILPIT_URL` for a dedicated alternative Mailpit instance.

API tests use `app.request()` without opening a port, real PostgreSQL queries and transactions, and a mocked mail sender. Each test uses unique account addresses and a separate rate-limit IP key, and removes its accounts afterward. Expired database records are seeded directly; unit tests use a fake clock for limiter boundaries.

The browser test uses the built Astro site, the real backend and SMTP through Mailpit. It registers a unique account, follows the verification link from its email, selects a lifetime license and checks the dashboard and persisted session. Stripe HTTP responses are intercepted by Nock using dummy credentials: the checkout fixture redirects to the real success page, which confirms the session through the backend. No real payment or hosted Stripe form is exercised. API tests also check unpaid sessions and reject confirmation by another account. OAuth providers are disabled in this initial suite; provider callback coverage can be added with controlled provider responses.

## Adding coverage

- `backend/tests/unit/`: isolated logic such as password hashing, rate limiting and public URLs.
- `frontend/tests/`: API error handling and access redirects, with mocked `fetch`.
- `backend/tests/integration/`: API contracts and persisted account/session behavior.
- `tests/e2e/`: critical browser journeys; prefer roles and labels, or Carbon host selectors when necessary for shadow DOM.

CI runs unit tests, API integration tests, both builds and the Chromium scenario on pull requests and pushes to main/staging. On failure it uploads the Playwright report, screenshots and traces. To inspect a local report, run `npx playwright show-report`.
