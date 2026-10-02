// Download the bytes behind every text entry in corpus/register.json into
// corpus/.cache/ and check them against the pinned checksum.
//
//   bun run sources:fetch              # download what is not cached yet, then
//                                      # verify every cached file vs its pin
//   bun run sources:fetch --refresh    # RE-DOWNLOAD everything and verify —
//                                      # the upstream revision recheck (run on
//                                      # the register's recheck cadence)
//   bun run sources:fetch --pin        # record sha256 + length for entries
//                                      # that have none yet
//   bun run sources:fetch --repin-cnsc # re-pin CNSC text hashes from the
//                                      # CACHED page-data after a reviewed
//                                      # CNSC parser change (never with
//                                      # --refresh: new upstream text is a
//                                      # rights/edition re-check, not a re-pin)
//   bun run scripts/sources/fetch.ts --only nrc-rg-1.21,eu-dir-2014-87
//   bun run scripts/sources/fetch.ts --import <key@version> <file>
//                                               # a file a human downloaded
//                                               # (publisher blocks scripts)
//
// Without --refresh only the LOCAL cache is checked (offline, and what
// publish needs). With --refresh a mismatch means the publisher changed the
// file behind the same URL (a new revision, a re-upload, an erratum). That is
// exactly the moment a human must re-check edition and rights, so verify mode
// never re-pins on its own — it exits non-zero and names the entry.
//
// CNSC page-data is pinned by its extracted text, not its bytes (Gatsby
// rebuilds change the bytes, not the document) — see content-hash.ts.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { RegisterEntry } from "../../lib/sources/register";
import { cnscPageDataUrl } from "./adapters/cnsc-html";
import { pinnedChecksum } from "./content-hash";
import { fetchSource } from "./http";
import {
	cachePath,
	ensureDirs,
	entryId,
	parseOnly,
	readRegisterRaw,
	selected,
	writeRegister,
} from "./register-io";

const ACCEPT: Record<string, { accept: string; acceptLanguage?: string }> = {
	pdf: { accept: "application/pdf" },
	"cnsc-json": { accept: "application/json" },
	"ecfr-xml": { accept: "application/xml, text/xml" },
	// Without this Accept header the resolver returns a 4 MB RDF record.
	"eu-xhtml": { accept: "application/xhtml+xml", acceptLanguage: "eng" },
	docx: {
		accept:
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	},
};

const SPACING_MS = 1200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sniff(entry: RegisterEntry, bytes: Uint8Array): string | null {
	const head = new TextDecoder().decode(bytes.slice(0, 512)).trimStart();
	switch (entry.format) {
		case "pdf":
			return head.startsWith("%PDF-")
				? null
				: "not a PDF (missing %PDF- header)";
		case "docx":
			return bytes[0] === 0x50 && bytes[1] === 0x4b
				? null
				: "not a DOCX (zip) file";
		case "cnsc-json":
			return head.startsWith("{") ? null : "not JSON";
		case "ecfr-xml":
			return /<DIV[89]\b/.test(new TextDecoder().decode(bytes.slice(0, 4096)))
				? null
				: "eCFR XML without DIV8/DIV9";
		case "eu-xhtml":
			return /<html|<\?xml/i.test(head) ? null : "not XHTML";
		default:
			return "unknown format";
	}
}

// A publisher that refuses identifying scripted clients (NRA Japan answers
// 403 unless the User-Agent looks like a browser) is not worked around by
// spoofing one. A human downloads the file; --import sniffs, caches and
// pins it exactly as a fetch would.
async function importFile(id: string, file: string): Promise<void> {
	const register = await readRegisterRaw();
	const e = register.entries.find((x) => entryId(x) === id);
	if (!e) throw new Error(`no register entry ${id}`);
	if (!e.format || !e.fetch_url)
		throw new Error(`${id} has no fetch_url/format`);
	const bytes = new Uint8Array(await readFile(file));
	const bad = sniff(e, bytes);
	if (bad) throw new Error(`${id}: ${bad}`);
	await ensureDirs();
	await writeFile(cachePath(e), bytes);
	e.checksum_sha256 = await pinnedChecksum(e, bytes);
	e.content_length = bytes.byteLength;
	await writeRegister(register);
	console.log(
		`＋ ${id}: imported and pinned ${e.checksum_sha256.slice(0, 12)}… — review, set ingest=true, bump "version".`,
	);
}

async function main() {
	const argv = process.argv.slice(2);
	const imp = argv.indexOf("--import");
	if (imp >= 0) {
		const [id, file] = [argv[imp + 1], argv[imp + 2]];
		if (!id || !file) throw new Error("usage: --import <key@version> <file>");
		await importFile(id, file);
		return;
	}
	const pin = argv.includes("--pin");
	const refresh = argv.includes("--refresh");
	const repinCnsc = argv.includes("--repin-cnsc");
	if (repinCnsc && refresh) {
		throw new Error(
			"--repin-cnsc re-pins the cached, already-reviewed page-data only; it cannot be combined with --refresh",
		);
	}
	const only = parseOnly(argv);
	const register = await readRegisterRaw();
	await ensureDirs();

	const targets = register.entries.filter(
		(e) =>
			e.ingest &&
			e.fetch_url &&
			e.format &&
			!e.backfill_from_regdoc &&
			selected(e, only),
	);
	let failures = 0;
	let pinned = 0;
	let lastHost = "";
	for (const e of targets) {
		const id = entryId(e);
		const path = cachePath(e);
		const url =
			e.format === "cnsc-json"
				? cnscPageDataUrl(e.fetch_url as string)
				: (e.fetch_url as string);
		let bytes: Uint8Array;
		if (existsSync(path) && !refresh) {
			bytes = new Uint8Array(await readFile(path));
		} else {
			const host = new URL(url).hostname;
			if (host === lastHost) await sleep(SPACING_MS);
			lastHost = host;
			try {
				const res = await fetchSource(url, ACCEPT[e.format as string]);
				bytes = res.bytes;
			} catch (err) {
				failures += 1;
				console.error(`✗ ${id}: ${(err as Error).message}`);
				continue;
			}
			const bad = sniff(e, bytes);
			if (bad) {
				failures += 1;
				console.error(`✗ ${id}: ${bad}`);
				continue;
			}
			await writeFile(path, bytes);
		}
		let sha: string;
		try {
			sha = await pinnedChecksum(e, bytes);
		} catch (err) {
			failures += 1;
			console.error(`✗ ${id}: ${(err as Error).message}`);
			continue;
		}
		if (e.checksum_sha256 === null) {
			if (pin) {
				e.checksum_sha256 = sha;
				e.content_length = bytes.byteLength;
				pinned += 1;
				console.log(
					`＋ ${id}: pinned ${sha.slice(0, 12)}… (${bytes.byteLength} bytes)`,
				);
			} else {
				failures += 1;
				console.error(
					`✗ ${id}: no pinned checksum (run with --pin after reviewing)`,
				);
			}
		} else if (e.checksum_sha256 !== sha) {
			const cachedCnsc = e.format === "cnsc-json" && !refresh;
			if (cachedCnsc && repinCnsc) {
				e.checksum_sha256 = sha;
				pinned += 1;
				console.log(`↻ ${id}: re-pinned text hash ${sha.slice(0, 12)}…`);
				continue;
			}
			failures += 1;
			console.error(
				cachedCnsc
					? `✗ ${id}: CNSC TEXT-HASH MISMATCH on the cached page-data — pinned ${e.checksum_sha256.slice(0, 12)}…, got ${sha.slice(0, 12)}…. No download happened, so this usually means the CNSC parser changed (adapters/cnsc-html.ts): review the extracted-text diff, then rerun with --repin-cnsc.`
					: `✗ ${id}: CHECKSUM DRIFT — pinned ${e.checksum_sha256.slice(0, 12)}…, got ${sha.slice(0, 12)}…. Re-check edition and rights, then update the entry by hand.`,
			);
		} else {
			console.log(`✓ ${id}`);
		}
	}
	if (pinned > 0) {
		await writeRegister(register);
		console.log(
			`\nPinned ${pinned} checksum(s) in corpus/register.json — bump its "version".`,
		);
	}
	console.log(`\n${targets.length} entries, ${failures} failure(s).`);
	if (failures > 0) process.exit(1);
}

await main();
