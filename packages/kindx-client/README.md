# @ambicuity/kindx-client

Typed TypeScript client for KINDX HTTP + MCP APIs.

## Usage

```ts
import { KindxClient } from "@ambicuity/kindx-client";

const client = new KindxClient({ baseUrl: "http://localhost:8181" });
const results = await client.query({
  searches: [{ type: "lex", query: "rate limiting" }],
  limit: 10,
});
```
