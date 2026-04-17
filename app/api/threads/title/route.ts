// Auto-title a chat thread from its first exchange. ChatGPT-style: a small,
// cheap, one-shot gpt-4o-mini call invoked once per thread after the first
// user+assistant pair lands. Fire-and-forget from the client.

import { NextResponse } from "next/server";
import { withGuard } from "@/lib/guard";
import { getOpenAIClient, OPENAI_MODELS } from "@/lib/openai";
import { sanitizeQueryText, stripHtmlTags } from "@/lib/validators";

interface UIMessageLike {
	role: string;
	parts?: Array<{ type: string; text?: string }>;
	content?: string;
}

function extractText(m: UIMessageLike | undefined): string {
	if (!m) return "";
	if (Array.isArray(m.parts)) {
		const t = m.parts
			.filter((p) => p?.type === "text" && typeof p.text === "string")
			.map((p) => p.text as string)
			.join(" ");
		if (t) return t;
	}
	return typeof m.content === "string" ? m.content : "";
}

const SYSTEM_PROMPT = `You are a chat title generator for a Canadian Nuclear Safety Commission (CNSC) regulatory Q&A assistant. Given a user's question and the assistant's reply, produce a concise 3-6 word title that captures the topic. Rules: no quotes, no trailing punctuation, no emojis, title case, reference REGDOC numbers when they're central to the question.`;

function sanitizeTitle(raw: string): string {
	return raw
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/[.!?]+$/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 60);
}

export const POST = withGuard(
	{ route: "threads/title" },
	async ({ req, ctx }) => {
		const body = (await req.json().catch(() => null)) as {
			messages?: UIMessageLike[];
		} | null;
		const messages = body?.messages ?? [];
		const firstUser = messages.find((m) => m.role === "user");
		const firstAssistant = messages.find((m) => m.role === "assistant");
		const question = stripHtmlTags(
			sanitizeQueryText(extractText(firstUser)),
		).slice(0, 800);
		const answer = stripHtmlTags(
			sanitizeQueryText(extractText(firstAssistant)),
		).slice(0, 800);

		if (!question) {
			return NextResponse.json(
				{ error: "validation", message: "No user question in messages." },
				{ status: 400 },
			);
		}

		ctx.logFields.model = OPENAI_MODELS.chat;

		try {
			const openai = getOpenAIClient();
			const completion = await openai.chat.completions.create({
				model: OPENAI_MODELS.chat,
				max_tokens: 20,
				temperature: 0.3,
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{
						role: "user",
						content: `Question: ${question}\n\nAnswer: ${answer}\n\nTitle:`,
					},
				],
			});
			const raw = completion.choices[0]?.message?.content ?? "";
			const title = sanitizeTitle(raw);
			if (!title) {
				return NextResponse.json(
					{ error: "internal_error", message: "Empty title." },
					{ status: 500 },
				);
			}
			ctx.logFields.title_len = title.length;
			return NextResponse.json({ title });
		} catch (err) {
			console.error("threads_title_openai_error", err);
			return NextResponse.json(
				{ error: "internal_error", message: "Title generation failed." },
				{ status: 500 },
			);
		}
	},
);
