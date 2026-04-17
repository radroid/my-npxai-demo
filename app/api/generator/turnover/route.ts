// Generator — shift turnover report (Appendix D.4 + F.5 "money shot" path).
// withGuard (B rate-limit + breaker) → generatorInputSchema enum validation →
// get_turnover_snapshot RPC (A.4 SECURITY DEFINER) → SSE stream of gpt-4o-mini
// via StreamingGuard. Phase 6C persistence: signed-in users dedupe by snapshot
// hash against generated_reports (find_report_by_hash short-circuits OpenAI;
// save_report persists post-stream). Anon users persist in the browser only.

import { NextResponse } from "next/server";
import { recordOpenAICall, withGuard } from "@/lib/guard";
import { logGuardEvent } from "@/lib/logger";
import { getOpenAIClient, OPENAI_MODELS } from "@/lib/openai";
import { StreamingGuard } from "@/lib/output-guard";
import { GENERATOR_SYSTEM, PROMPT_VERSION } from "@/lib/prompts";
import { generatorInputSchema } from "@/lib/validators";

const GENERATOR_MAX_TOKENS = 1500;

type SseEvent = "meta" | "token" | "cached" | "done" | "error";

function sseFrame(event: SseEvent, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export const POST = withGuard(
	{ route: "generator/turnover" },
	async ({ req, ctx, supabase }) => {
		const body = await req.json().catch(() => null);
		const parsed = generatorInputSchema.safeParse(body);
		if (!parsed.success) {
			logGuardEvent({
				route: "generator/turnover",
				reason: "validation",
				ip_hash: ctx.ipHash,
				tier: ctx.tier,
				user_hash: ctx.userHash,
				detail: "enum_reject",
			});
			return NextResponse.json(
				{
					error: "validation",
					message: "station, unit, and shift must match the allowed enums.",
				},
				{ status: 400 },
			);
		}
		const { station, unit, shift } = parsed.data;
		const url = new URL(req.url);
		const force = url.searchParams.get("force") === "true";
		ctx.logFields.prompt_version = PROMPT_VERSION;
		ctx.logFields.model = OPENAI_MODELS.chat;
		ctx.logFields.unit = unit;
		ctx.logFields.shift = shift;

		const { data: snapshot, error: rpcErr } = await supabase.rpc(
			"get_turnover_snapshot",
			{ p_unit: unit },
		);
		if (rpcErr) {
			console.error("get_turnover_snapshot_error", rpcErr);
			return NextResponse.json(
				{ error: "internal_error", message: "Snapshot retrieval failed." },
				{ status: 500 },
			);
		}

		const snapshotJson = JSON.stringify(snapshot ?? null);
		const snapshotHash = await sha256Hex(
			`${station}|${unit}|${shift}|${snapshotJson}`,
		);

		// auth.uid() is non-null inside the RPCs below when the cookie session is signed in.
		const {
			data: { user },
		} = await supabase.auth.getUser();
		const isSignedIn = Boolean(user?.id);

		// Dedupe lookup — best-effort: missing RPC / unapplied migration must not break generation.
		type CachedHit = {
			id: string;
			report_markdown: string;
			generated_at: string;
		};
		let cachedHit: CachedHit | null = null;
		if (isSignedIn && !force) {
			const { data: hit, error: hitErr } = await supabase.rpc(
				"find_report_by_hash",
				{
					p_station: station,
					p_unit: unit,
					p_shift: shift,
					p_snapshot_hash: snapshotHash,
				},
			);
			if (hitErr) {
				console.warn("find_report_by_hash_warn", hitErr.message);
			} else if (Array.isArray(hit) && hit.length > 0) {
				cachedHit = hit[0] as CachedHit;
			}
		}

		const encoder = new TextEncoder();
		const generatedAt = new Date().toISOString();

		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				const send = (event: SseEvent, data: unknown) =>
					controller.enqueue(encoder.encode(sseFrame(event, data)));

				send("meta", {
					station,
					unit,
					shift,
					generated_at: generatedAt,
					snapshot_hash: snapshotHash,
					signed_in: isSignedIn,
				});

				// Fast path: cached report exists, short-circuit OpenAI.
				if (cachedHit) {
					send("cached", {
						id: cachedHit.id,
						report: cachedHit.report_markdown,
						generated_at: cachedHit.generated_at,
					});
					send("done", { cached: true });
					controller.close();
					return;
				}

				const openai = getOpenAIClient();
				const guard = new StreamingGuard();
				const userMessage = `UNIT: ${unit}   SHIFT: ${shift}   STATION: ${station}

DATA:
\`\`\`json
${JSON.stringify(snapshot, null, 2)}
\`\`\``;

				let accumulated = "";
				try {
					const completion = await openai.chat.completions.create({
						model: OPENAI_MODELS.chat,
						stream: true,
						max_tokens: GENERATOR_MAX_TOKENS,
						temperature: 0.2,
						messages: [
							{ role: "system", content: GENERATOR_SYSTEM },
							{ role: "user", content: userMessage },
						],
					});

					let outputTokens = 0;
					let promptTokens = 0;
					for await (const chunk of completion) {
						const token = chunk.choices[0]?.delta?.content ?? "";
						if (chunk.usage) {
							outputTokens = chunk.usage.completion_tokens ?? outputTokens;
							promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
						}
						if (!token) continue;
						const result = guard.push(token);
						if (result.safeTokens) {
							accumulated += result.safeTokens;
							send("token", result.safeTokens);
						}
						if (result.terminate) {
							if (result.reason) {
								logGuardEvent({
									route: "generator/turnover",
									reason: "output_guard",
									ip_hash: ctx.ipHash,
									tier: ctx.tier,
									user_hash: ctx.userHash,
									detail: result.reason,
								});
							}
							break;
						}
					}

					ctx.logFields.output_tokens = outputTokens;
					ctx.logFields.input_tokens = promptTokens;
					await recordOpenAICall(0);

					// Best-effort save for signed-in users. Failures are logged but
					// don't surface to the client — the report still rendered.
					let savedId: string | null = null;
					if (isSignedIn && accumulated) {
						const { data: saved, error: saveErr } = await supabase.rpc(
							"save_report",
							{
								p_station: station,
								p_unit: unit,
								p_shift: shift,
								p_markdown: accumulated,
								p_snapshot_hash: snapshotHash,
							},
						);
						if (saveErr) {
							console.warn(
								`save_report failed: ${JSON.stringify({
									message: saveErr.message,
									code: saveErr.code,
									details: saveErr.details,
									hint: saveErr.hint,
								})}`,
							);
						} else if (Array.isArray(saved) && saved.length > 0) {
							savedId = (saved[0] as { id: string }).id;
						}
					}

					send("done", {
						cached: false,
						saved_id: savedId,
						snapshot_hash: snapshotHash,
					});
				} catch (err) {
					console.error("generator_openai_error", err);
					send("error", { message: "Report generation failed." });
				} finally {
					controller.close();
				}
			},
		});

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-store, must-revalidate",
				"x-accel-buffering": "no",
			},
		});
	},
);
