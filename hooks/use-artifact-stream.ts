"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SourceChunk } from "@/components/knowledge-hub/SourcesPanel";

// Parses the SSE frames /api/knowledge-hub/artifact streams into workbench
// state (item-1 slice 1.2). Frame-parsing follows the useGenerateStream
// precedent (components/generator/use-generate-stream.ts). Protocol (see
// docs/orchestration/specs/item-1-artifact-mode.md §Execution notes PR #6):
// - non-2xx → JSON { error, message } (400 validation / 429 guard / 500) —
//   check res.ok BEFORE reading the body as a stream;
// - 200 → SSE: meta { model, chunks, cached } → progress { tokens } →
//   artifact { html, sources, truncated, limitedCoverage, cached } → done;
//   failures emit error { code, message } (jailbreak/OOS responses are
//   one-shot SSE bodies carrying only the error frame).

export type ArtifactStatus =
	| "idle"
	| "retrieving"
	| "drafting"
	| "ready"
	| "error";

export type ArtifactErrorKind =
	| "validation"
	| "rate_limit"
	| "out_of_scope"
	| "output_guard"
	| "generation_failed"
	| "server"
	| "network";

export interface ArtifactError {
	kind: ArtifactErrorKind;
	message: string;
}

export interface ArtifactResult {
	html: string;
	sources: SourceChunk[];
	truncated: boolean;
	limitedCoverage: boolean;
	cached: boolean;
	query: string;
	generatedAt: string;
}

interface ArtifactEventPayload {
	html: string;
	sources: SourceChunk[];
	truncated: boolean;
	limitedCoverage: boolean;
	cached: boolean;
}

interface ErrorEventPayload {
	code?: string;
	message?: string;
}

function errorKindFromCode(code: string | undefined): ArtifactErrorKind {
	if (
		code === "out_of_scope" ||
		code === "output_guard" ||
		code === "generation_failed"
	) {
		return code;
	}
	return "generation_failed";
}

export function useArtifactStream() {
	const [status, setStatus] = useState<ArtifactStatus>("idle");
	const [error, setError] = useState<ArtifactError | null>(null);
	const [tokens, setTokens] = useState(0);
	const [artifact, setArtifact] = useState<ArtifactResult | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => () => abortRef.current?.abort(), []);

	const stop = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setStatus((s) => (s === "retrieving" || s === "drafting" ? "idle" : s));
	}, []);

	const generate = useCallback(async (query: string) => {
		// Rapid double-submit guard: cancel any in-flight run before starting.
		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;

		setStatus("retrieving");
		setError(null);
		setTokens(0);
		setArtifact(null);

		const fail = (kind: ArtifactErrorKind, message: string) => {
			setError({ kind, message });
			setStatus("error");
		};

		try {
			const res = await fetch("/api/knowledge-hub/artifact", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query }),
				signal: controller.signal,
			});

			// Non-2xx responses are plain JSON, never SSE — read them first.
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as {
					message?: string;
				} | null;
				const message = body?.message ?? `Request failed (${res.status}).`;
				if (res.status === 429) fail("rate_limit", message);
				else if (res.status === 400) fail("validation", message);
				else fail("server", message);
				return;
			}

			const reader = res.body?.getReader();
			if (!reader) {
				fail("network", "Stream not available.");
				return;
			}

			const decoder = new TextDecoder();
			let buffer = "";
			let gotArtifact = false;

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
						setStatus("drafting");
					} else if (event === "progress") {
						setTokens((data as { tokens?: number })?.tokens ?? 0);
					} else if (event === "artifact") {
						const payload = data as ArtifactEventPayload;
						gotArtifact = true;
						setArtifact({
							html: payload.html,
							sources: payload.sources ?? [],
							truncated: Boolean(payload.truncated),
							limitedCoverage: Boolean(payload.limitedCoverage),
							cached: Boolean(payload.cached),
							query,
							generatedAt: new Date().toISOString(),
						});
						setStatus("ready");
					} else if (event === "error") {
						const payload = data as ErrorEventPayload;
						fail(
							errorKindFromCode(payload?.code),
							payload?.message ?? "Artifact generation failed.",
						);
						return;
					}
					// "done" carries no state the artifact event didn't already set.
				}
			}

			if (!gotArtifact) {
				fail("network", "The stream ended before an artifact arrived.");
			}
		} catch (err) {
			if ((err as Error)?.name === "AbortError") return;
			console.error(err);
			fail("network", "Network error — please retry.");
		}
	}, []);

	return { status, error, tokens, artifact, generate, stop };
}
