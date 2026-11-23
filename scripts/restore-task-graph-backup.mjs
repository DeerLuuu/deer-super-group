#!/usr/bin/env node
/**
 * O1-4 contract rollback helper.
 *
 * The v4 schema has no task legacy mirror columns. Old code cannot read a v4
 * database, so rollback means restoring the pre-contract backup (normally the
 * v3 backup written immediately before the v4 migration).
 *
 * Usage:
 *   node scripts/restore-task-graph-backup.mjs [--force] <backup.db> <target.db>
 *
 * Stop DeerSuperGroup before running this script. By default the backup must
 * be user_version=3 and the existing target must be user_version=4; --force is
 * an explicit override for controlled recovery drills. The target is copied
 * aside to <target>.before-restore-<timestamp> before the backup is installed.
 */
import { copyFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function usage() {
  console.error(
    "usage: node scripts/restore-task-graph-backup.mjs [--force] <backup.db> <target.db>",
  );
}

function validateDatabase(file, label) {
  if (!existsSync(file)) throw new Error(`${label} does not exist: ${file}`);
  const db = new DatabaseSync(file);
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get();
    if (String(integrity?.integrity_check ?? "") !== "ok") {
      throw new Error(`${label} integrity_check failed: ${file}`);
    }
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(`${label} foreign_key_check failed: ${JSON.stringify(violations)}`);
    }
    const version = Number(
      (db.prepare("PRAGMA user_version").get() ?? {}).user_version ?? 0,
    );
    return { version };
  } finally {
    db.close();
  }
}

function removeSidecars(file) {
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${file}${suffix}`;
    if (existsSync(sidecar)) rmSync(sidecar, { force: true });
  }
}

const rawArgs = process.argv.slice(2);
const force = rawArgs.includes("--force");
const positional = rawArgs.filter((arg) => arg !== "--force");
const [backupArg, targetArg] = positional;
if (!backupArg || !targetArg || backupArg === "--help" || positional.length > 2) {
  usage();
  process.exitCode = 2;
} else {
  try {
    const backup = path.resolve(backupArg);
    const target = path.resolve(targetArg);
    if (backup === target) throw new Error("backup and target must differ");

    const backupInfo = validateDatabase(backup, "backup");
    if (backupInfo.version !== 3 && !force) {
      throw new Error(
        `backup must be user_version=3 (pre-contract); got ${backupInfo.version}; use --force for a controlled override`,
      );
    }

    const targetExists = existsSync(target);
    if (!targetExists && !force) {
      throw new Error(`target does not exist: ${target}; use --force to create it`);
    }
    if (targetExists) {
      const targetInfo = validateDatabase(target, "target");
      if (targetInfo.version !== 4 && !force) {
        throw new Error(
          `target must be user_version=4 (current contract); got ${targetInfo.version}; use --force for a controlled override`,
        );
      }
    }

    let safety = null;
    if (targetExists) {
      safety = `${target}.before-restore-${Date.now()}`;
      copyFileSync(target, safety);
    }

    removeSidecars(target);
    copyFileSync(backup, target);
    removeSidecars(target);
    try {
      const restored = validateDatabase(target, "restored target");
      if (restored.version !== 3 && !force) {
        throw new Error(`restored target must be user_version=3; got ${restored.version}`);
      }
    } catch (error) {
      if (safety) {
        copyFileSync(safety, target);
        removeSidecars(target);
      }
      throw error;
    }

    const current = validateDatabase(target, "restored target");
    console.log(
      `restored ${target} from ${backup} (user_version=${current.version}, backup_version=${backupInfo.version})`,
    );
    if (safety) console.log(`previous target saved at ${safety}`);
  } catch (error) {
    console.error(`rollback failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
