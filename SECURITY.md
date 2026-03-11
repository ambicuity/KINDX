# Security Policy

## Supported Versions

The following versions of KINDX are currently receiving security updates:

| Version | Supported          |
| ------- | ------------------ |
| 0.x.x   | Active support     |

## Reporting a Vulnerability

**Please do NOT open a public GitHub Issue for security vulnerabilities.**

Opening a public issue exposes the vulnerability to all users -- including malicious actors -- before a patch is available.

### Private Disclosure Process

1. **Email the maintainer directly at:** `contact@riteshrana.engineer`
2. Use the subject line: `[SECURITY] KINDX - <brief description>`
3. Include the following in your report:
   - A description of the vulnerability and its potential impact
   - Steps to reproduce the issue
   - Any proof-of-concept code or screenshots
   - The version(s) affected
   - Your suggested fix (if you have one)

### What to Expect

| Timeline         | Action                                           |
| ---------------- | ------------------------------------------------ |
| Within 48 hours  | Acknowledgement of your report                   |
| Within 7 days    | Initial assessment and severity classification   |
| Within 30 days   | Patch released and CVE filed (if applicable)     |
| Post-patch       | Public disclosure with credit to the reporter    |

We will keep you informed throughout the process and, with your permission, will credit you in the security advisory upon public disclosure.

## Scope

The following are **in scope** for security reports:

- **CLI tool** (`engine/kindx.ts`): Arbitrary code execution, path traversal, command injection
- **SQLite operations** (`engine/repository.ts`, `engine/runtime.ts`): SQL injection, data corruption, unauthorized data access
- **LLM model loading** (`engine/inference.ts`): Model supply chain attacks, unsafe deserialization
- **MCP server** (`engine/protocol.ts`): Unauthorized access, data exfiltration, SSRF
- **Collection management** (`engine/catalogs.ts`): Path traversal via collection paths
- **GitHub Actions workflows** (`.github/workflows/`): Secrets exposure, workflow injection, supply-chain attacks
- **Dependency vulnerabilities**: Known CVEs in `package.json` dependencies

The following are **out of scope**:

- Vulnerabilities in upstream GGUF models or HuggingFace infrastructure -- report to those vendors
- Local file system access (KINDX is designed to read local files -- this is expected behavior)
- Social engineering attacks

## Security Best Practices for Contributors

When contributing to this project, please observe the following:

- **Never hardcode credentials, tokens, or API keys** -- use environment variables
- **Validate all external data** -- data from LLM responses and file paths should be treated as untrusted
- **Pin dependency versions** -- use exact versions in `package.json` to prevent supply-chain attacks
- **Review GitHub Actions permissions** -- workflows should request the minimum permissions required

## MCP HTTP Server Security

When running KINDX in HTTP daemon mode (`kindx mcp --http`), the MCP endpoint is bound to `localhost` only but is unauthenticated by default, since the primary use case is single-user local access.

**For any shared server or networked deployment**, authentication MUST be enabled:

```bash
# Generate a token and export it before starting the daemon:
export KINDX_MCP_TOKEN="$(openssl rand -hex 32)"
kindx mcp --http --port 7700
```

When `KINDX_MCP_TOKEN` is set:
- All requests to `/mcp`, `/query`, and `/search` must include `Authorization: Bearer <token>`
- The `/health` endpoint is intentionally exempt (monitoring probe compatibility)
- Any request with a missing or incorrect token receives `401 Unauthorized`

**MCP client configuration:** Pass the token via the `Authorization` header in your MCP client config. For Claude Desktop and most MCP-compatible clients, set the `headers` field in the server configuration:

```json
{
  "mcpServers": {
    "kindx": {
      "url": "http://localhost:7700/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

Failure to set `KINDX_MCP_TOKEN` in a networked environment allows any process on the host to query your knowledge base and retrieve document content.

Thank you for helping keep KINDX and its users safe.
