"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReadySource } from "@/components/generator/ReportView";
import { saveAnonReport } from "@/lib/report-store";

export type GeneratorMeta = {
	station: string;
	unit: string;
	shift: string;
	generated_at: string;
	snapshot_hash: string;
	signed_in: boolean;
};

export type Status =
	| "idle"
	| "pulling"
	| "drafting"
	| "finalizing"
	| "ready"
	| "error";

type Params = {
	station: string;
	unit: string;
	shift: string;
};

// Parses the SSE frames Next's /api/generator/turnover streams into the
// component-level state the form needs. Keeps the reducer-ish SSE loop out
// of the render component so GeneratorForm stays layout-focused.
export function useGenerateStream() {
	const [status, setStatus] = useState<Status>("idle");
	const [error, setError] = useState<string | null>(null);
	const [meta, setMeta] = useState<GeneratorMeta | null>(null);
	const [report, setReport] = useState<string>("");
	const [readySource, setReadySource] = useState<ReadySource>("stream");
	const [recentRefreshKey, setRecentRefreshKey] = useState(0);
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => () => abortRef.current?.abort(), []);

	const generate = useCallback(
		async (params: Params, opts: { force?: boolean } = {}) => {
			abortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;

			setStatus("pulling");
			setError(null);
			setMeta(null);
			setReport("");
			setReadySource("stream");

			try {
				const qs = opts.force ? "?force=true" : "";
				const res = await fetch(`/api/generator/turnover${qs}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(params),
					signal: controller.signal,
				});

				if (!res.ok) {
					const body = await res.json().catch(() => null);
					setError(body?.message ?? `Request failed (${res.status}).`);
					setStatus("error");
					return;
				}

				const reader = res.body?.getReader();
				if (!reader) {
					setError("Stream not available.");
					setStatus("error");
					return;
				}

				const decoder = new TextDecoder();
				let buffer = "";
				let accumulated = "";
				let currentMeta: GeneratorMeta | null = null;
				let cachedHit = false;

				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });

					const frames = buffer.split("\n\n");
					buffer = frames.pop() ?? "";

					for (const frame of frames) {
						if (!frame.trim()) continue;
						const lines = frame.split("\n");
						const eventLine = lines.find((l) => l.startsWith("event: "));
						const dataLine = lines.find((l) => l.startsWith("data: "));
						if (!eventLine || !dataLine) continue;
						const event = eventLine.slice("event: ".length).trim();
						const raw = dataLine.slice("data: ".length);
						let data: unknown;
						try {
							data = JSON.parse(raw);
						} catch {
							continue;
						}

						if (event === "meta") {
							currentMeta = data as GeneratorMeta;
							setMeta(currentMeta);
							setStatus("drafting");
						} else if (event === "token") {
							accumulated += data as string;
							setReport(accumulated);
						} else if (event === "cached") {
							const payload = data as {
								id: string;
								report: string;
								generated_at: string;
							};
							cachedHit = true;
							accumulated = payload.report;
							setReport(payload.report);
							if (currentMeta) {
								setMeta({ ...currentMeta, generated_at: payload.generated_at });
							}
							setReadySource("cached");
						} else if (event === "done") {
							setStatus("finalizing");
						} else if (event === "error") {
							setError(
								(data as { message?: string })?.message ?? "Stream error.",
							);
							setStatus("error");
							return;
						}
					}
				}

				// Stream completed cleanly — persist for anon users, refresh the rail.
				if (
					!cachedHit &&
					currentMeta &&
					accumulated &&
					!currentMeta.signed_in
				) {
					saveAnonReport({
						station: currentMeta.station,
						unit: currentMeta.unit,
						shift: currentMeta.shift,
						snapshot_hash: currentMeta.snapshot_hash,
						generated_at: currentMeta.generated_at,
						report_markdown: accumulated,
					});
				}
				setRecentRefreshKey((k) => k + 1);
				setStatus("ready");
			} catch (err) {
				if ((err as Error)?.name === "AbortError") return;
				console.error(err);
				setError("Network error — please retry.");
				setStatus("error");
			}
		},
		[],
	);

	// Manually load a stored report into the view (history click).
	const loadExisting = useCallback(
		(next: { meta: GeneratorMeta; report: string; source: ReadySource }) => {
			abortRef.current?.abort();
			setStatus("ready");
			setError(null);
			setReport(next.report);
			setMeta(next.meta);
			setReadySource(next.source);
		},
		[],
	);

	return {
		status,
		error,
		meta,
		report,
		readySource,
		recentRefreshKey,
		generate,
		loadExisting,
	};
}
