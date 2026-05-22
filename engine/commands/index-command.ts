import { existsSync, unlinkSync } from "node:fs";
import { c } from "../utils/ui.js";
import {
  registerIndex,
  unregisterIndex,
  listIndexes,
  getIndex,
  ensureDefaultIndexRegistered,
  getDefaultIndexName,
} from "../index-manager.js";
import { getDefaultDbPath } from "../repository/paths.js";
import { openDatabase } from "../runtime.js";
import { initializeDatabase } from "../repository/store-init.js";
import { getConfigForIndex } from "../catalogs.js";

export async function runIndexCommand(
  args: string[],
  values: Record<string, unknown>,
): Promise<number> {
  const sub = args[0];

  switch (sub) {
    case "list":
    case "ls": {
      ensureDefaultIndexRegistered();
      const indexes = listIndexes();
      const defaultName = getDefaultIndexName();

      if (indexes.length === 0) {
        console.log(`${c.dim}No named indexes found. Create one with: kindx index create <name>${c.reset}`);
        return 0;
      }

      console.log(`${c.bold}Named Indexes (${indexes.length}):${c.reset}\n`);
      for (const idx of indexes) {
        const isDefault = idx.name === defaultName ? ` ${c.cyan}(default)${c.reset}` : "";
        console.log(`  ${c.bold}${idx.name}${c.reset}${isDefault}`);
        if (idx.description) console.log(`    ${c.dim}${idx.description}${c.reset}`);
        console.log(`    Created: ${idx.created_at}`);
        console.log();
      }
      return 0;
    }

    case "create": {
      const name = args[1];
      if (!name) {
        console.error("Usage: kindx index create <name> [--description <desc>]");
        return 1;
      }

      try {
        const entry = registerIndex(name, values.description as string | undefined);
        const dbPath = getDefaultDbPath(name);
        const db = openDatabase(dbPath);
        initializeDatabase(db);
        db.close();
        console.log(`${c.green}✓${c.reset} Created index '${c.bold}${name}${c.reset}'`);
        console.log(`  Database: ${dbPath}`);
        return 0;
      } catch (err: any) {
        console.error(`${c.yellow}!${c.reset} ${err.message}`);
        return 1;
      }
    }

    case "delete":
    case "rm": {
      const name = args[1];
      if (!name) {
        console.error("Usage: kindx index delete <name> [--force]");
        return 1;
      }

      const force = !!values.force;
      if (!force) {
        const defaultName = getDefaultIndexName();
        if (name === defaultName) {
          console.error(`${c.yellow}!${c.reset} Cannot delete the default index '${name}'`);
          return 1;
        }
        console.log(`${c.yellow}This will permanently delete index '${name}' and all its data.${c.reset}`);
        console.log(`${c.yellow}Use --force to confirm.${c.reset}`);
        return 1;
      }

      try {
        unregisterIndex(name);
        const dbPath = getDefaultDbPath(name);
        [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach(p => {
          if (existsSync(p)) unlinkSync(p);
        });
        console.log(`${c.green}✓${c.reset} Deleted index '${c.bold}${name}${c.reset}'`);
        return 0;
      } catch (err: any) {
        console.error(`${c.yellow}!${c.reset} ${err.message}`);
        return 1;
      }
    }

    case "migrate": {
      const collection = args[1];
      const fromIndex = values.from as string | undefined;
      const toIndex = values.to as string | undefined;

      if (!collection || !fromIndex || !toIndex) {
        console.error("Usage: kindx index migrate <collection> --from <src> --to <dst>");
        return 1;
      }

      try {
        const srcDbPath = getDefaultDbPath(fromIndex);
        const dstDbPath = getDefaultDbPath(toIndex);

        if (!existsSync(srcDbPath)) {
          console.error(`${c.yellow}!${c.reset} Source index '${fromIndex}' database not found`);
          return 1;
        }
        if (!existsSync(dstDbPath)) {
          console.error(`${c.yellow}!${c.reset} Destination index '${toIndex}' database not found`);
          return 1;
        }

        const srcDb = openDatabase(srcDbPath);
        const dstDb = openDatabase(dstDbPath);

        const contentCount = (srcDb.prepare(
          `SELECT COUNT(*) as c FROM content WHERE collection = ?`
        ).get(collection) as any)?.c || 0;

        if (contentCount === 0) {
          console.log(`${c.yellow}!${c.reset} Collection '${collection}' is empty in source index`);
          srcDb.close();
          dstDb.close();
          return 0;
        }

        // ATTACH source DB for cross-DB SQL
        dstDb.prepare(`ATTACH DATABASE ? AS src`).run(srcDbPath);

        const insertContent = dstDb.prepare(
          `INSERT OR IGNORE INTO main.content SELECT * FROM src.content WHERE collection = ?`
        );
        const insertDocs = dstDb.prepare(
          `INSERT OR IGNORE INTO main.documents SELECT * FROM src.documents WHERE collection = ?`
        );
        const insertLinks = dstDb.prepare(
          `INSERT OR IGNORE INTO main.document_links SELECT dl.* FROM src.document_links dl WHERE EXISTS (SELECT 1 FROM src.content c WHERE c.hash = dl.hash AND c.collection = ?)`
        );
        const insertVectors = dstDb.prepare(
          `INSERT OR IGNORE INTO main.content_vectors SELECT cv.* FROM src.content_vectors cv WHERE EXISTS (SELECT 1 FROM src.content c WHERE c.hash = cv.hash AND c.collection = ?)`
        );
        const insertIngest = dstDb.prepare(
          `INSERT OR IGNORE INTO main.document_ingest SELECT di.* FROM src.document_ingest di WHERE EXISTS (SELECT 1 FROM src.documents d WHERE d.docid = di.docid AND d.collection = ?)`
        );

        insertContent.run(collection);
        insertDocs.run(collection);
        insertLinks.run(collection);
        insertVectors.run(collection);
        insertIngest.run(collection);

        dstDb.prepare(`DETACH DATABASE src`).run();

        // Copy collection config entry
        const srcConfig = getConfigForIndex(fromIndex);
        if (srcConfig.collections[collection]) {
          const { addCollection, setConfigIndexName } = await import("../catalogs.js");
          setConfigIndexName(toIndex);
          addCollection(collection, srcConfig.collections[collection]!.path, srcConfig.collections[collection]!.pattern);
        }

        srcDb.close();
        dstDb.close();

        console.log(`${c.green}✓${c.reset} Migrated collection '${c.bold}${collection}${c.reset}' from '${c.bold}${fromIndex}${c.reset}' to '${c.bold}${toIndex}${c.reset}': ${contentCount} documents`);
        return 0;
      } catch (err: any) {
        console.error(`${c.yellow}!${c.reset} Migration failed: ${err.message}`);
        return 1;
      }
    }

    case "help":
    case undefined: {
      console.log("Usage: kindx index <subcommand> [options]");
      console.log();
      console.log("Subcommands:");
      console.log("  list                      List all named indexes");
      console.log("  create <name>             Create a new named index");
      console.log("  delete <name> --force     Permanently delete a named index");
      console.log("  migrate <collection>      Copy collection data between indexes");
      console.log("         --from <src> --to <dst>");
      console.log();
      console.log("Examples:");
      console.log("  kindx index create my-project --description 'Project Alpha'");
      console.log("  kindx index list");
      console.log("  kindx index delete old-project --force");
      console.log("  kindx index migrate logs --from alpha --to beta");
      return 0;
    }

    default:
      console.error(`Unknown index subcommand: ${sub}`);
      console.error("Run 'kindx index help' for usage");
      return 1;
  }
}
