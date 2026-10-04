// What a register checksum pins, per format.
//
//   cnsc-json — the extracted TEXT (section numbers, titles, anchors,
//               paragraphs). CNSC's Gatsby page-data bytes change on every
//               site build (build ids, timestamps) while the document stays
//               the same, so a byte hash would drift on every rebuild and stop
//               meaning anything. A text hash drifts exactly when the words do.
//   others    — the downloaded bytes.
//
// fetch.ts pins and verifies with this; publish.ts refuses cached input that
// does not match; lib/sources/manifest.ts folds the pins into corpusVersion()
// so a re-published text can never be answered from an old cache entry.

import type { RegisterEntry } from "../../lib/sources/register";
import { parseCnscPageData } from "./adapters/cnsc-html";
import { sha256Hex } from "./http";

export async function pinnedChecksum(
	e: RegisterEntry,
	bytes: Uint8Array,
): Promise<string> {
	if (e.format !== "cnsc-json") return sha256Hex(bytes);
	const { doc } = parseCnscPageData(
		JSON.parse(new TextDecoder().decode(bytes)),
		{
			ref: e.doc_ref,
			title: e.title,
			canonicalUrl: e.canonical_url,
		},
	);
	const text = JSON.stringify(
		doc.sections.map((s) => [
			s.section_number,
			s.section_title,
			s.anchor ?? "",
			s.paragraphs.map((p) => p.text),
		]),
	);
	return sha256Hex(new TextEncoder().encode(text));
}
