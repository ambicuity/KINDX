# Acme Store API

A lightweight RESTful API for the Acme online store, built with Express and SQLite.

## Setup

```bash
# Install dependencies
npm install

# Set environment variables (or copy the example)
cp .env.example .env

# Initialize the database
npm run db:init

# Start the dev server
npm run dev
```

The server starts on `http://localhost:3000` by default.

## Environment Variables

| Variable     | Default              | Description              |
|-------------|----------------------|--------------------------|
| `PORT`      | `3000`               | HTTP listen port         |
| `JWT_SECRET`| `dev-secret-...`     | Secret for signing JWTs  |
| `DB_PATH`   | `./data/store.db`    | Path to SQLite database  |

## API Endpoints

### Authentication
- `POST /auth/login` — Obtain a JWT (`{ email, password }`)
- `POST /auth/logout` — Invalidate current session (requires auth)

### Users (all require auth)
- `GET /users` — List all users
- `GET /users/:id` — Get user by ID
- `PUT /users/:id` — Update user profile

### Products
- `GET /products` — List active products (public)
- `GET /products/:slug` — Get product by slug (public)
- `POST /products` — Create a product (requires auth)
- `DELETE /products/:id` — Deactivate a product (requires auth)

### Health
- `GET /health` — Returns `{ status: "ok" }`

## License

MIT
