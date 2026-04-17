// Generator — shift turnover report (Appendix D.4 + F.5 "money shot" path).
// withGuard wraps rate-limit + circuit breaker (Appendix B), validates
// closed-enum body via generatorInputSchema (B.2), pulls the per-unit
// snapshot via get_turnover_snapshot RPC (A.4 SECURITY DEFINER, anon client),
// streams gpt-4o-mini through a non-streaming completion with max_tokens=1500
// (B.3), and runs the final text through scanOutput (D.6) before returning.

import { NextResponse } from "next/server";
import { recordOpenAICall, withGuard } from "@/lib/guard";
import { logGuardEvent } from "@/lib/logger";
import { getOpenAIClient, OPENAI_MODELS } from "@/lib/openai";
import { scanOutput } from "@/lib/output-guard";
import { GENERATOR_SYSTEM, PROMPT_VERSION } from "@/lib/prompts";
import { generatorInputSchema } from "@/lib/validators";

const GENERATOR_MAX_TOKENS = 1500;

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

		const userMessage = `UNIT: ${unit}   SHIFT: ${shift}   STATION: ${station}

DATA:
\`\`\`json
${JSON.stringify(snapshot, null, 2)}
\`\`\``;

		const openai = getOpenAIClient();
		let rawOutput: string;
		try {
			const completion = await openai.chat.completions.create({
				model: OPENAI_MODELS.chat,
				stream: false,
				max_tokens: GENERATOR_MAX_TOKENS,
				temperature: 0.2,
				messages: [
					{ role: "system", content: GENERATOR_SYSTEM },
					{ role: "user", content: userMessage },
				],
			});
			rawOutput = completion.choices[0]?.message?.content ?? "";
			ctx.logFields.output_tokens = completion.usage?.completion_tokens ?? 0;
			ctx.logFields.input_tokens = completion.usage?.prompt_tokens ?? 0;
			await recordOpenAICall(0);
		} catch (err) {
			console.error("generator_openai_error", err);
			return NextResponse.json(
				{ error: "internal_error", message: "Report generation failed." },
				{ status: 500 },
			);
		}

		const guarded = scanOutput(rawOutput);
		if (!guarded.safe) {
			logGuardEvent({
				route: "generator/turnover",
				reason: "output_guard",
				ip_hash: ctx.ipHash,
				tier: ctx.tier,
				user_hash: ctx.userHash,
				detail: guarded.reason,
			});
		}

		return NextResponse.json({
			station,
			unit,
			shift,
			report: guarded.output,
			generated_at: new Date().toISOString(),
		});
	},
);
