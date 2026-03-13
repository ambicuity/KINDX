# Technical Debt Tracker

Tracking known tech debt items across the stack. Reviewed during sprint planning to decide what to pay down.

*Last updated: 2025-03-10*

---

## Critical (blocks feature work)

### TD-001: Monolithic route handler in `api.ts`
- **Severity:** Critical
- **Effort:** 3-5 days
- **Description:** All 30+ routes live in a single file. Adding new endpoints causes merge conflicts and makes the code hard to navigate. Need to split into domain-specific route modules (auth, users, products, orders).
- **Owner:** Sarah Chen
- **Status:** Planned for Sprint S6

### TD-002: No database migrations framework
- **Severity:** Critical
- **Effort:** 2-3 days
- **Description:** Schema changes are applied via ad-hoc SQL scripts. No versioning, no rollback capability. Adopt a migration tool like `knex` migrations or `drizzle-kit`.
- **Owner:** Marcus Johnson
- **Status:** In progress

---

## High (causes ongoing friction)

### TD-003: Hardcoded configuration values
- **Severity:** High
- **Effort:** 1-2 days
- **Description:** Several modules read `process.env` directly with inline fallbacks. Centralize config into a validated schema (e.g., `zod` + a `config.ts` module).

### TD-004: Missing error handling middleware
- **Severity:** High
- **Effort:** 1 day
- **Description:** Unhandled errors in route handlers crash the process. Need a global Express error handler that logs the error, returns a 500 response, and reports to Sentry.

### TD-005: Test coverage gaps in auth module
- **Severity:** High
- **Effort:** 2 days
- **Description:** `auth.ts` has 42% test coverage. Token expiry, role validation, and edge cases (malformed tokens, missing headers) are untested. Add unit and integration tests.

---

## Medium (should fix eventually)

### TD-006: Raw SQL strings everywhere
- **Severity:** Medium
- **Effort:** 3-5 days
- **Description:** All database queries use raw SQL strings. Consider adopting a query builder (Knex) or ORM (Drizzle) to reduce SQL injection risk and improve type safety.

### TD-007: No request validation library
- **Severity:** Medium
- **Effort:** 2 days
- **Description:** Request body validation is done with manual if-checks. Adopt `zod` or `joi` for declarative schema validation with automatic error responses.

### TD-008: Console.log used for logging
- **Severity:** Medium
- **Effort:** 1 day
- **Description:** Production code uses `console.log`. Replace with a structured logger (pino or winston) that supports log levels and JSON output.

---

## Low (nice-to-have cleanup)

### TD-009: Unused dependencies in package.json
- **Severity:** Low
- **Effort:** 0.5 days
- **Description:** At least 6 packages in `dependencies` are no longer imported anywhere. Run `depcheck` and remove them to reduce install time and attack surface.

### TD-010: Inconsistent naming conventions
- **Severity:** Low
- **Effort:** 1 day
- **Description:** Mix of camelCase and snake_case in database column names and API response fields. Standardize on camelCase for API responses with a serialization layer.

---

## Summary

| Severity | Count | Total Effort (est.) |
|----------|-------|---------------------|
| Critical | 2     | 5-8 days            |
| High     | 3     | 4-5 days            |
| Medium   | 3     | 6-8 days            |
| Low      | 2     | 1.5 days            |
| **Total**| **10**| **16.5-22.5 days**  |

---

*Next debt review: Sprint S7 planning (March 28, 2025)*
