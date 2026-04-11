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
import { c } from "../utils/ui.js";
import type { OutputFormat } from "../renderer.js";

export function runTenantCommand(
  args: string[],
  values: Record<string, unknown>,
  output: OutputFormat,
): number {
  const sub = args[0];

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
          console.log(`${c.green}✓${c.reset} Tenant created: ${c.bold}${tenant.id}${c.reset}`);
          console.log(`  Name:         ${tenant.name}`);
          console.log(`  Role:         ${c.cyan}${tenant.role}${c.reset}`);
          console.log(`  Collections:  ${tenant.allowedCollections.join(", ") || "(none)"}`);
          console.log(`  Created:      ${tenant.createdAt}`);
          console.log();
          console.log(`  ${c.bold}Token (shown once — save it now):${c.reset}`);
          console.log(`  ${c.yellow}${plaintextToken}${c.reset}`);
          console.log();
          console.log(`  ${c.dim}Use: Authorization: Bearer ${plaintextToken.slice(0, 8)}...${c.reset}`);
        }
        return 0;
      } catch (err: any) {
        console.error(`${c.yellow}!${c.reset} ${err.message}`);
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
        console.log(`${c.green}✓${c.reset} Tenant '${id}' removed`);
        return 0;
      }
      console.error(`${c.yellow}!${c.reset} Tenant '${id}' not found`);
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
        console.log(`${c.dim}No tenants configured. KINDX is in single-tenant mode.${c.reset}`);
        console.log(`${c.dim}Run 'kindx tenant add <id> --role admin' to enable multi-tenant RBAC.${c.reset}`);
        return 0;
      }

      console.log(`${c.bold}Tenants (${tenants.length}):${c.reset}\n`);
      for (const t of tenants) {
        const status = t.active ? `${c.green}active${c.reset}` : `${c.yellow}disabled${c.reset}`;
        const roleColor = t.role === "admin" ? c.magenta : t.role === "editor" ? c.cyan : c.dim;
        console.log(`  ${c.bold}${t.id}${c.reset} ${c.dim}(${t.name})${c.reset}`);
        console.log(`    Role:         ${roleColor}${t.role}${c.reset}`);
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
        console.error(`${c.yellow}!${c.reset} Tenant '${id}' not found`);
        return 1;
      }

      if (output === "json") {
        const { tokenHash, ...safe } = tenant;
        console.log(JSON.stringify(safe, null, 2));
        return 0;
      }

      const status = tenant.active ? `${c.green}active${c.reset}` : `${c.yellow}disabled${c.reset}`;
      console.log(`${c.bold}Tenant: ${tenant.id}${c.reset}`);
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
          console.log(`${c.green}✓${c.reset} Token rotated for tenant '${id}'`);
          console.log();
          console.log(`  ${c.bold}New token (shown once — save it now):${c.reset}`);
          console.log(`  ${c.yellow}${newToken}${c.reset}`);
        }
        return 0;
      } catch (err: any) {
        console.error(`${c.yellow}!${c.reset} ${err.message}`);
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
        console.log(`${c.green}✓${c.reset} Granted access to [${collections.join(", ")}] for tenant '${id}'`);
        return 0;
      }
      console.error(`${c.yellow}!${c.reset} Tenant '${id}' not found`);
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
        console.log(`${c.green}✓${c.reset} Revoked access to [${collections.join(", ")}] for tenant '${id}'`);
        return 0;
      }
      console.error(`${c.yellow}!${c.reset} Tenant '${id}' not found`);
      return 1;
    }

    case "disable": {
      const id = args[1];
      if (!id) {
        console.error("Usage: kindx tenant disable <id>");
        return 1;
      }
      if (updateTenant(id, { active: false })) {
        console.log(`${c.green}✓${c.reset} Tenant '${id}' disabled`);
        return 0;
      }
      console.error(`${c.yellow}!${c.reset} Tenant '${id}' not found`);
      return 1;
    }

    case "enable": {
      const id = args[1];
      if (!id) {
        console.error("Usage: kindx tenant enable <id>");
        return 1;
      }
      if (updateTenant(id, { active: true })) {
        console.log(`${c.green}✓${c.reset} Tenant '${id}' enabled`);
        return 0;
      }
      console.error(`${c.yellow}!${c.reset} Tenant '${id}' not found`);
      return 1;
    }

    case "status": {
      const status = getRBACStatus();
      if (output === "json") {
        console.log(JSON.stringify(status, null, 2));
        return 0;
      }
      console.log(`${c.bold}RBAC Status${c.reset}`);
      console.log(`  Enabled:  ${status.enabled ? c.green + "yes" + c.reset : c.dim + "no (single-tenant)" + c.reset}`);
      console.log(`  Tenants:  ${status.tenantCount} active`);
      console.log(`  Roles:    admin=${status.roles.admin} editor=${status.roles.editor} viewer=${status.roles.viewer}`);
      return 0;
    }

    case "help":
    case undefined: {
      console.log("Usage: kindx tenant <subcommand> [options]");
      console.log();
      console.log("Subcommands:");
      console.log("  add <id> [collections...] --role <role>  Create tenant (shows token once)");
      console.log("  remove <id>                              Remove tenant");
      console.log("  list                                     List all tenants");
      console.log("  show <id>                                Show tenant details");
      console.log("  rotate <id>                              Rotate tenant token");
      console.log("  grant <id> <col1> [col2 ...]             Grant collection access");
      console.log("  revoke <id> <col1> [col2 ...]            Revoke collection access");
      console.log("  disable <id>                             Disable tenant (reject auth)");
      console.log("  enable <id>                              Re-enable tenant");
      console.log("  status                                   Show RBAC status summary");
      console.log();
      console.log("Roles:");
      console.log("  admin   Full access to all collections and operations");
      console.log("  editor  Read + write to assigned collections");
      console.log("  viewer  Read-only access to assigned collections");
      console.log();
      console.log("Examples:");
      console.log("  kindx tenant add ci-bot --role viewer notes docs");
      console.log("  kindx tenant add team-lead --role editor --name 'Team Lead'");
      console.log("  kindx tenant grant ci-bot meetings");
      console.log("  kindx tenant rotate ci-bot");
      return 0;
    }

    default:
      console.error(`Unknown tenant subcommand: ${sub}`);
      console.error("Run 'kindx tenant help' for usage");
      return 1;
  }
}
