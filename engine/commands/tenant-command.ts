/**
 * tenant-command.ts — CLI subcommand handler for tenant / RBAC management
 *
 * Supports: kindx tenant <add|remove|list|show|rotate|grant|revoke|disable|enable>
 */

import {
  createTenant,
  removeTenant,
  listTenants,
  getTenant,
  rotateTenantToken,
  updateTenant,
  grantCollections,
  revokeCollections,
  getRBACStatus,
  type TenantRole,
} from "../rbac.js";
import { paletteFor, glyphsFor } from "../cli/output.js";
import { renderSubcommandList } from "../cli/help.js";
import type { OutputFormat } from "../renderer.js";

export function runTenantCommand(
  args: string[],
  values: Record<string, unknown>,
  output: OutputFormat,
): number {
  const sub = args[0];
  const useColor = !process.env.NO_COLOR && Boolean(process.stdout?.isTTY);
  const p = paletteFor(useColor);
  const g = glyphsFor();

  switch (sub) {
    case "add": {
      const id = args[1];
      const name = (values.name as string) || id;
      const role = ((values.role as string) || "viewer") as TenantRole;
      const collections = args.slice(2);

      if (!id) {
        console.error("Usage: kindx tenant add <id> [collections...] --role <admin|editor|viewer> [--name <name>]");
        return 1;
      }

      if (!["admin", "editor", "viewer"].includes(role)) {
        console.error(`Invalid role '${role}'. Must be one of: admin, editor, viewer`);
        return 1;
      }

      try {
        const { tenant, plaintextToken } = createTenant(id, name, role, collections);

        if (output === "json") {
          console.log(JSON.stringify({
            id: tenant.id,
            name: tenant.name,
            role: tenant.role,
            allowedCollections: tenant.allowedCollections,
            token: plaintextToken,
          }, null, 2));
        } else {
          console.log(`${p.green(g.ok)} Tenant created: ${p.bold(tenant.id)}`);
          console.log(`  Name:         ${tenant.name}`);
          console.log(`  Role:         ${p.cyan(tenant.role)}`);
          console.log(`  Collections:  ${tenant.allowedCollections.join(", ") || "(none)"}`);
          console.log(`  Created:      ${tenant.createdAt}`);
          console.log();
          console.log(`  ${p.bold("Token (shown once — save it now):")}`);
          console.log(`  ${p.yellow(plaintextToken)}`);
          console.log();
          console.log(`  ${p.dim(`Use: Authorization: Bearer ${plaintextToken.slice(0, 8)}...`)}`);
        }
        return 0;
      } catch (err: any) {
        console.error(`${p.yellow(g.warn)} ${err.message}`);
        return 1;
      }
    }

    case "remove":
    case "rm": {
      const id = args[1];
      if (!id) {
        console.error("Usage: kindx tenant remove <id>");
        return 1;
      }
      if (removeTenant(id)) {
        console.log(`${p.green(g.ok)} Tenant '${id}' removed`);
        return 0;
      }
      console.error(`${p.yellow(g.warn)} Tenant '${id}' not found`);
      return 1;
    }

    case "list":
    case "ls": {
      const tenants = listTenants();
      if (output === "json") {
        console.log(JSON.stringify(tenants, null, 2));
        return 0;
      }

      if (tenants.length === 0) {
        console.log(p.dim("No tenants configured. KINDX is in single-tenant mode."));
        console.log(p.dim("Run 'kindx tenant add <id> --role admin' to enable multi-tenant RBAC."));
        return 0;
      }

      console.log(`${p.bold(`Tenants (${tenants.length}):`)}\n`);
      for (const t of tenants) {
        const status = t.active ? p.green("active") : p.yellow("disabled");
        const roleColor = t.role === "admin" ? p.magenta : t.role === "editor" ? p.cyan : p.dim;
        console.log(`  ${p.bold(t.id)} ${p.dim(`(${t.name})`)}`);
        console.log(`    Role:         ${roleColor(t.role)}`);
        console.log(`    Status:       ${status}`);
        console.log(`    Collections:  ${t.allowedCollections.join(", ")}`);
        if (t.description) console.log(`    Description:  ${t.description}`);
        console.log();
      }
      return 0;
    }

    case "show": {
      const id = args[1];
      if (!id) {
        console.error("Usage: kindx tenant show <id>");
        return 1;
      }
      const tenant = getTenant(id);
      if (!tenant) {
        console.error(`${p.yellow(g.warn)} Tenant '${id}' not found`);
        return 1;
      }

      if (output === "json") {
        const { tokenHash, ...safe } = tenant;
        console.log(JSON.stringify(safe, null, 2));
        return 0;
      }

      const status = tenant.active ? p.green("active") : p.yellow("disabled");
      console.log(`${p.bold(`Tenant: ${tenant.id}`)}`);
      console.log(`  Name:         ${tenant.name}`);
      console.log(`  Role:         ${tenant.role}`);
      console.log(`  Status:       ${status}`);
      console.log(`  Collections:  ${tenant.allowedCollections.join(", ")}`);
      console.log(`  Created:      ${tenant.createdAt}`);
      if (tenant.description) console.log(`  Description:  ${tenant.description}`);
      console.log(`  Token hash:   ${tenant.tokenHash.slice(0, 16)}...`);
      return 0;
    }

    case "rotate": {
      const id = args[1];
      if (!id) {
        console.error("Usage: kindx tenant rotate <id>");
        return 1;
      }
      try {
        const newToken = rotateTenantToken(id);
        if (output === "json") {
          console.log(JSON.stringify({ id, token: newToken }, null, 2));
        } else {
          console.log(`${p.green(g.ok)} Token rotated for tenant '${id}'`);
          console.log();
          console.log(`  ${p.bold("New token (shown once — save it now):")}`);
          console.log(`  ${p.yellow(newToken)}`);
        }
        return 0;
      } catch (err: any) {
        console.error(`${p.yellow(g.warn)} ${err.message}`);
        return 1;
      }
    }

    case "grant": {
      const id = args[1];
      const collections = args.slice(2);
      if (!id || collections.length === 0) {
        console.error("Usage: kindx tenant grant <id> <collection1> [collection2 ...]");
        return 1;
      }
      if (grantCollections(id, collections)) {
        console.log(`${p.green(g.ok)} Granted access to [${collections.join(", ")}] for tenant '${id}'`);
        return 0;
      }
      console.error(`${p.yellow(g.warn)} Tenant '${id}' not found`);
      return 1;
    }

    case "revoke": {
      const id = args[1];
      const collections = args.slice(2);
      if (!id || collections.length === 0) {
        console.error("Usage: kindx tenant revoke <id> <collection1> [collection2 ...]");
        return 1;
      }
      if (revokeCollections(id, collections)) {
        console.log(`${p.green(g.ok)} Revoked access to [${collections.join(", ")}] for tenant '${id}'`);
        return 0;
      }
      console.error(`${p.yellow(g.warn)} Tenant '${id}' not found`);
      return 1;
    }

    case "disable": {
      const id = args[1];
      if (!id) {
        console.error("Usage: kindx tenant disable <id>");
        return 1;
      }
      if (updateTenant(id, { active: false })) {
        console.log(`${p.green(g.ok)} Tenant '${id}' disabled`);
        return 0;
      }
      console.error(`${p.yellow(g.warn)} Tenant '${id}' not found`);
      return 1;
    }

    case "enable": {
      const id = args[1];
      if (!id) {
        console.error("Usage: kindx tenant enable <id>");
        return 1;
      }
      if (updateTenant(id, { active: true })) {
        console.log(`${p.green(g.ok)} Tenant '${id}' enabled`);
        return 0;
      }
      console.error(`${p.yellow(g.warn)} Tenant '${id}' not found`);
      return 1;
    }

    case "status": {
      const status = getRBACStatus();
      if (output === "json") {
        console.log(JSON.stringify(status, null, 2));
        return 0;
      }
      console.log(p.bold("RBAC Status"));
      console.log(`  Enabled:  ${status.enabled ? p.green("yes") : p.dim("no (single-tenant)")}`);
      console.log(`  Tenants:  ${status.tenantCount} active`);
      console.log(`  Roles:    admin=${status.roles.admin} editor=${status.roles.editor} viewer=${status.roles.viewer}`);
      return 0;
    }

    case "help":
    case undefined: {
      console.log(renderSubcommandList("tenant", { color: useColor }) ?? "Usage: kindx tenant <subcommand> [options]");
      // Role taxonomy stays inline — it's a tenant-specific concept that
      // doesn't fit the generic SubcommandSpec shape.
      console.log();
      console.log(`${p.bold("Roles:")}`);
      console.log("  admin   Full access to all collections and operations");
      console.log("  editor  Read + write to assigned collections");
      console.log("  viewer  Read-only access to assigned collections");
      return 0;
    }

    default:
      console.error(`Unknown tenant subcommand: ${sub}`);
      console.error("Run 'kindx tenant help' for usage");
      return 1;
  }
}
