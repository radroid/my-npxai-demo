// Per-collection retrieval gates (PLAN.md Phase 12: "recalibrate
// similarity/fallback thresholds per collection").
//
// Cosine similarity is not comparable across corpora: an eCFR paragraph, a
// 600-page NUREG chunk and a CNSC REGDOC section embed against the same
// question at different absolute levels. Each collection therefore carries
// its own refusal (oos), limited-context (disclaimer) and per-chunk floor
// (minChunk). The refusal gate is checked by scripts/sources/calibrate.ts
// against that collection's in-scope questions and an off-topic battery and
// moved only when the legacy value misclassifies one; the two floors stay at
// legacy until something measures them. CNSC keeps the legacy values
// exactly, so a pinned-CNSC answer gates as before.

import { DEFAULT_THRESHOLDS, type RetrievalThresholds } from "../retrieval";
import type { CollectionId } from "./catalog";

export interface CalibratedThresholds extends RetrievalThresholds {
	/** How the numbers were chosen — shown in reports, not used at runtime. */
	basis: string;
}

export const COLLECTION_THRESHOLDS: Record<CollectionId, CalibratedThresholds> =
	{
		cnsc: {
			...DEFAULT_THRESHOLDS,
			basis: "legacy D.3 calibration (2026-04-17), unchanged",
		},
		// scripts/sources/calibrate.ts, 2026-10-01 (corpus/reports/calibration.json):
		// "What is the melting point of uranium-235?" reached 0.401 top-1 on NRC
		// text, just past the legacy 0.40 refusal gate; the lowest of 14 in-scope
		// NRC questions was 0.681. Smallest move with a 0.03 margin → 0.44.
		nrc: {
			...DEFAULT_THRESHOLDS,
			oos: 0.44,
			basis:
				"calibrated 2026-10-01: 14 in-scope (min top-1 0.681) vs 12 off-topic (max 0.401); refusal gate raised 0.40→0.44, floors legacy",
		},
		onr: {
			...DEFAULT_THRESHOLDS,
			basis:
				"calibrated 2026-10-01: 10 in-scope (min top-1 0.616) vs 12 off-topic (max 0.292); legacy values classify all",
		},
		eu: {
			...DEFAULT_THRESHOLDS,
			basis:
				"calibrated 2026-10-01: 8 in-scope (min top-1 0.616) vs 12 off-topic (max 0.175); legacy values classify all",
		},
		aerb: { ...DEFAULT_THRESHOLDS, basis: "no text documents" },
		fukushima: { ...DEFAULT_THRESHOLDS, basis: "no text documents" },
		iaea: { ...DEFAULT_THRESHOLDS, basis: "reference-only collection" },
	};

export function thresholdsFor(collection: CollectionId): RetrievalThresholds {
	const { basis: _basis, ...t } = COLLECTION_THRESHOLDS[collection];
	return t;
}
