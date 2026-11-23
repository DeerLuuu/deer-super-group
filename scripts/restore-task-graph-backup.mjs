#!/usr/bin/env node
/**
 * O1-4 contract rollback helper.
 *
 * The v4 schema has no task legacy mirror columns. Old code cannot read a v4
 * database, so rollback means restoring the pre-contract backup (normally the
 * v3 backup written immediately before the v4 migration).
 *
 * Usage:
 *   node scripts/restore-task-graph-backup.mjs <backup.db> <target.db>
 *
 * Stop DeerSuperGroup before running this script. The target is copied aside
 * to <target>.before-restore-<timestamp> before the backup is installed.
 */
import { copyFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function usage() {
  console.error(
    "usage: node scripts/restore-task-graph-backup.mjs <backup.db> <target.db>",
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

const [backupArg, targetArg] = process.argv.slice(2);
if (!backupArg || !targetArg || backupArg === "--help") {
  usage();
  process.exitCode = 2;
} else {
  try {
    const backup = path.resolve(backupArg);
    const target = path.resolve(targetArg);
    if (backup === target) throw new Error("backup and target must differ");

    const backupInfo = validateDatabase(backup, "backup");
    const targetExists = existsSync(target);
    let safety = null;
    if (targetExists) {
      safety = `${target}.before-restore-${Date.now()}`;
      copyFileSync(target, safety);
    }

    removeSidecars(target);
    copyFileSync(backup, target);
    removeSidecars(target);
    try {
      validateDatabase(target, "restored target");
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
