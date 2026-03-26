# Architecture

## Overview

Acme Store API follows a classic **3-tier architecture** optimized for simplicity and local development. Every component runs in a single Node.js process with no external service dependencies beyond the filesystem.

## Layers

### 1. Presentation Layer (`src/api.ts`)

- Express router that defines all HTTP endpoints.
- Handles request parsing, input validation, and response formatting.
- Delegates business logic to the service/data layer — never queries the DB directly.

### 2. Service / Auth Layer (`src/auth.ts`)

- JWT-based authentication using the `jsonwebtoken` library.
- `requireAuth` middleware gates protected routes and attaches the decoded user to the request object.
- Token generation, verification, and role checking are centralized here.
- Stateless sessions — no server-side session store. Tokens expire after 24 hours.

### 3. Data Layer (`src/db.ts`)

- Thin wrapper around `better-sqlite3` providing `query`, `insert`, and `update` helpers.
- Uses WAL journal mode for safe concurrent reads.
- Foreign keys are enforced at the SQLite level.
- Connection is lazily initialized and reused across requests (singleton pattern).

## Data Flow

```
Client → Express Router → Auth Middleware → Route Handler → DB Layer → SQLite
                                                ↓
                                          JSON Response
```

1. Incoming HTTP request hits the Express router.
2. If the route is protected, `requireAuth` validates the Bearer token.
3. The route handler calls `db.query` / `db.insert` / `db.update`.
4. Results are serialized to JSON and returned to the client.

## Auth Strategy

- Passwords are hashed with bcrypt before storage (12 salt rounds).
- On login, the server issues a signed JWT containing `userId`, `email`, and `role`.
- Protected endpoints read the token from the `Authorization: Bearer <token>` header.
- Role-based access control can be layered on top of `requireAuth` by inspecting `req.user.role`.

## Utility Belt (`src/utils.ts`)

Stateless helper functions — slug generation, date formatting, email validation, and random ID creation. These have zero side effects and are easy to unit-test.

## Design Decisions

| Decision              | Rationale                                            |
|-----------------------|------------------------------------------------------|
| SQLite over Postgres  | Zero-config, embedded, perfect for single-node apps  |
| WAL mode              | Allows concurrent readers without blocking writers   |
| Stateless JWT         | Horizontally scalable — no shared session store      |
| Single-process        | Simplicity; scale out behind a reverse proxy if needed |
