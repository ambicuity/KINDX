# @ambicuity/kindx-schemas

Shared Zod schemas for KINDX MCP/HTTP contracts.

## Usage

```ts
import { KindxQueryInputSchema } from "@ambicuity/kindx-schemas";

const parsed = KindxQueryInputSchema.parse({
  searches: [{ type: "lex", query: "rate limiting" }],
  limit: 10,
});
```
