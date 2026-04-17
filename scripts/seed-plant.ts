#!/usr/bin/env bun
// Seed the Bruce Power plant fixtures (Appendix F) into Supabase.
//
// Reads seeds/bruce-power.sql (the canonical reviewable artifact) and
// executes it against the database over a direct Postgres connection.
// Uses SUPABASE_DB_URL — a dev-machine-only variable pulled from the
// Supabase dashboard (Project Settings → Database → Connection string →
// "Transaction" pooler on port 6543). This is kept out of runtime code
// and only referenced by this offline script, same pattern as
// SUPABASE_SERVICE_ROLE_KEY used by scripts/ingest.ts.
//
// Why a direct Postgres connection rather than supabase-js: the fixtures
// are hand-written SQL (TRUNCATE + multi-row INSERT) so the .sql file
// stays the single source of truth reviewers read. supabase-js has no
// raw-SQL path; forcing parallel TS arrays would create a second source.
//
// Idempotent: seeds/bruce-power.sql wraps everything in BEGIN/COMMIT and
// truncates plant_status / work_orders / shift_log_entries with RESTART
// IDENTITY before inserting. Safe to rerun any number of times.
//
// Usage:
//   bun run seed:plant
//   bun run seed:plant --dry-run   # print the SQL + row counts, no writes

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";

const DRY_RUN = process.argv.slice(2).includes("--dry-run");

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
	console.error(
		"❌ SUPABASE_DB_URL is not set. Add it to .env.local from the Supabase\n" +
			"   dashboard: Project Settings → Database → Connection string →\n" +
			"   'Transaction' pooler (port 6543). Never commit this value.",
	);
	process.exit(1);
}

const sqlPath = join(import.meta.dir, "..", "seeds", "bruce-power.sql");
const sqlText = await readFile(sqlPath, "utf8");

console.log(`Loaded ${sqlPath}`);
console.log(`  ${sqlText.length.toLocaleString()} chars, ${sqlText.split("\n").length} lines`);

if (DRY_RUN) {
	const inserts = sqlText.match(/INSERT INTO (\w+)/g) ?? [];
	const tupleCount = (sqlText.match(/^\('/gm) ?? []).length;
	console.log(`\n[dry-run] ${inserts.length} INSERT statements, ~${tupleCount} tuples`);
	console.log("[dry-run] no connection opened, no writes performed");
	process.exit(0);
}

// postgres.js parses BEGIN/COMMIT and multi-statement SQL when passed via
// .unsafe(). max: 1 keeps the truncate+insert atomic; idle_timeout: 5
// ensures we don't hold the pooler connection after the script exits.
const sql = postgres(DB_URL, { max: 1, idle_timeout: 5, prepare: false });

try {
	console.log("\nApplying fixtures…");
	const t0 = Date.now();
	await sql.unsafe(sqlText);
	const ms = Date.now() - t0;
	console.log(`✅ Applied in ${ms} ms`);

	const [plant] = await sql`SELECT count(*)::int AS n FROM plant_status`;
	const [wos] = await sql`SELECT count(*)::int AS n FROM work_orders`;
	const [logs] = await sql`SELECT count(*)::int AS n FROM shift_log_entries`;
	const perUnit = await sql`
		SELECT unit_id, count(*)::int AS n
		FROM plant_status
		GROUP BY unit_id
		ORDER BY unit_id
	`;

	console.log("\nRow counts:");
	console.log(`  plant_status:      ${plant.n}   (expect 50)`);
	console.log(`  work_orders:       ${wos.n}   (expect 12)`);
	console.log(`  shift_log_entries: ${logs.n}   (expect 15)`);
	console.log("\nplant_status by unit:");
	for (const row of perUnit) {
		console.log(`  ${row.unit_id.padEnd(8)} ${row.n}`);
	}

	if (plant.n < 40) {
		console.error("\n❌ plant_status row count below Phase 2 gate (≥40). Seed may have partially applied.");
		process.exit(1);
	}
} finally {
	await sql.end({ timeout: 5 });
}
