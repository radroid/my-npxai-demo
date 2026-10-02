// Register file I/O for the offline source scripts. The app reads the same
// file through lib/sources/manifest.ts; only these scripts ever write it
// (fetch.ts --pin records checksums).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	parseRegister,
	type RegisterEntry,
	type SourceRegister,
	type SourceFormat,
} from "../../lib/sources/register";

export const REPO_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
export const REGISTER_PATH = join(REPO_ROOT, "corpus", "register.json");
export const CACHE_DIR = join(REPO_ROOT, "corpus", ".cache");
export const REPORTS_DIR = join(REPO_ROOT, "corpus", "reports");

/** Raw JSON (no cross-field validation) — for --pin, which fills checksums in. */
export async function readRegisterRaw(): Promise<SourceRegister> {
	return JSON.parse(await readFile(REGISTER_PATH, "utf8")) as SourceRegister;
}

/** Fully validated register; throws listing every rule violation. */
export async function loadRegister(): Promise<SourceRegister> {
	return parseRegister(JSON.parse(await readFile(REGISTER_PATH, "utf8")));
}

export async function writeRegister(register: SourceRegister): Promise<void> {
	await writeFile(REGISTER_PATH, `${JSON.stringify(register, null, "\t")}\n`);
}

const EXT: Record<SourceFormat, string> = {
	pdf: "pdf",
	"cnsc-json": "json",
	"ecfr-xml": "xml",
	"eu-xhtml": "xhtml",
	docx: "docx",
};

export function entryId(
	e: Pick<RegisterEntry, "document_key" | "version_key">,
): string {
	return `${e.document_key}@${e.version_key}`;
}

export function cachePath(e: RegisterEntry): string {
	if (!e.format) throw new Error(`${entryId(e)} has no format`);
	return join(CACHE_DIR, `${entryId(e)}.${EXT[e.format]}`);
}

export async function ensureDirs(): Promise<void> {
	await mkdir(CACHE_DIR, { recursive: true });
	await mkdir(REPORTS_DIR, { recursive: true });
}

/** --only a,b,c → set of document keys (or document_key@version_key ids). */
export function parseOnly(argv: string[]): Set<string> | null {
	const i = argv.indexOf("--only");
	if (i < 0) return null;
	const v = argv[i + 1];
	if (!v) throw new Error("--only needs a comma-separated list");
	return new Set(
		v
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

export function selected(e: RegisterEntry, only: Set<string> | null): boolean {
	return only === null || only.has(e.document_key) || only.has(entryId(e));
}
