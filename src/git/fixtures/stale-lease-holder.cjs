// t128 process-level stale-lease fixture: a separate Node process owns a
// worktree lease, is terminated, and leaves a stale lease_owner behind.
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(process.env.GIT_DB);
db.prepare("UPDATE git_worktrees SET lease_owner = ?, updated_at = ? WHERE run_id = ?").run(
  process.env.STALE_OWNER,
  new Date().toISOString(),
  process.env.RUN_ID,
);
console.log("READY");
setInterval(() => {}, 1000);
