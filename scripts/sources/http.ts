// Source downloads for the Phase 12 pipeline (offline scripts only).
//
// Every URL — the starting one AND every redirect hop — must pass the same
// allowlist the UI uses for outbound links (lib/sources/catalog.ts), so a
// register typo or a hijacked redirect cannot pull bytes from an arbitrary
// host into the corpus. Bodies are read with a hard byte cap.
//
// NRC's PDF edge (Akamai) intermittently answers 403 to automated clients;
// an identifying User-Agent plus spaced retries gets through (see
// docs/phase-12-sources.md).

import { isAllowedSourceUrl } from "../../lib/sources/catalog";

const USER_AGENT =
	"npxai-demo-source-fetcher/1.0 (+https://npx.curlycloud.dev; non-commercial regulatory research demo)";
const TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
export const DEFAULT_MAX_BYTES = 40_000_000;

export interface FetchedSource {
	bytes: Uint8Array;
	contentType: string;
	finalUrl: string;
}

export class SourceFetchError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "SourceFetchError";
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readCapped(
	res: Response,
	maxBytes: number,
): Promise<Uint8Array> {
	const declared = Number(res.headers.get("content-length") ?? "0");
	if (declared > maxBytes) {
		throw new SourceFetchError(
			`body too large: ${declared} > ${maxBytes} bytes`,
		);
	}
	const reader = res.body?.getReader();
	if (!reader) return new Uint8Array(await res.arrayBuffer());
	const parts: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new SourceFetchError(`body exceeded ${maxBytes} bytes`);
		}
		parts.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.byteLength;
	}
	return out;
}

async function fetchOnce(
	url: string,
	accept: string,
	acceptLanguage: string | undefined,
	maxBytes: number,
): Promise<FetchedSource> {
	let current = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		if (!isAllowedSourceUrl(current)) {
			throw new SourceFetchError(`refusing non-allowlisted URL: ${current}`);
		}
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
		try {
			const res = await fetch(current, {
				headers: {
					"user-agent": USER_AGENT,
					accept,
					...(acceptLanguage ? { "accept-language": acceptLanguage } : {}),
				},
				redirect: "manual",
				signal: ctrl.signal,
			});
			if (res.status >= 300 && res.status < 400) {
				const location = res.headers.get("location");
				if (!location) throw new SourceFetchError("redirect without location");
				const next = new URL(location, current);
				// The EU Publications Office resolver redirects to plain http on
				// the same host; upgrade instead of following it downgraded.
				if (
					next.protocol === "http:" &&
					next.hostname === new URL(current).hostname
				) {
					next.protocol = "https:";
				}
				current = next.toString();
				continue;
			}
			if (!res.ok) {
				throw new SourceFetchError(
					`HTTP ${res.status} for ${current}`,
					res.status,
				);
			}
			return {
				bytes: await readCapped(res, maxBytes),
				contentType: res.headers.get("content-type") ?? "",
				finalUrl: current,
			};
		} finally {
			clearTimeout(timer);
		}
	}
	throw new SourceFetchError(`too many redirects from ${url}`);
}

export async function fetchSource(
	url: string,
	opts: {
		accept?: string;
		acceptLanguage?: string;
		maxBytes?: number;
		attempts?: number;
	} = {},
): Promise<FetchedSource> {
	const accept = opts.accept ?? "*/*";
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const attempts = opts.attempts ?? 8;
	let lastErr: unknown;
	for (let i = 1; i <= attempts; i++) {
		try {
			return await fetchOnce(url, accept, opts.acceptLanguage, maxBytes);
		} catch (err) {
			lastErr = err;
			const status = err instanceof SourceFetchError ? err.status : undefined;
			// Only transient failures are retried; a policy refusal is final.
			const retryable =
				status === undefined
					? !(
							err instanceof SourceFetchError &&
							/refusing|too large|exceeded/.test(err.message)
						)
					: status === 403 || status === 429 || status >= 500;
			if (!retryable || i === attempts) break;
			await sleep(1500 * i);
		}
	}
	throw lastErr;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const buf = await crypto.subtle.digest(
		"SHA-256",
		bytes as Uint8Array<ArrayBuffer>,
	);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
