import Link from "next/link";

export const metadata = {
	title: "FAQ — NPXai Demo",
	description:
		"Questions about the NPX Innovation hiring demo — what it is, what's real, what's simulated.",
};

const FAQS = [
	{
		q: "What is this?",
		a: "A working application Raj Dholakia built as a hiring demo for NPX Innovation. It's a CNSC Knowledge Hub (retrieval-augmented Q&A over 19 real REGDOCs) and a CANDU shift-turnover generator (from simulated Bruce Power plant data). Both surfaces are live.",
	},
	{
		q: "Is the plant data real?",
		a: "No. The plant_status, work_orders, and shift_log_entries rows are simulated — built from Appendix F of the project plan and carefully tuned to match CANDU-nominal parameters. The units, operator roles, and operating states are plausible; none of it mirrors any actual Bruce Power reading at any point in time.",
	},
	{
		q: "Is the REGDOC corpus real?",
		a: "Yes. The Knowledge Hub indexes 19 CNSC REGDOCs scraped from cnsc-ccsn.gc.ca, parsed and chunked per the CNSC section hierarchy, then embedded into Supabase pgvector. Every answer cites back to the REGDOC + section it came from and you can click through to the source on the CNSC site.",
	},
	{
		q: "How many questions can I ask?",
		a: "Anon (no sign-in): 3 per minute, 10 per hour, 5 per day. Sign in for a comfortable 50/day; evaluators from nuclear-industry domains (npxinnovation.ca, brucepower.com, opg.com, cnsc-ccsn.gc.ca, cameco.com, uwaterloo.ca) are auto-lifted to 100/day. The limits are tight because the demo runs on Raj's personal OpenAI wallet.",
	},
	{
		q: "What happens if I ask something outside the corpus?",
		a: "You'll see one of two fallback responses: a 'not in corpus' message when the question is clearly off-topic (medical advice, personal opinions, non-CNSC regulation), or a 'don't have enough confidence' message when the question is in-topic but not covered by the indexed documents. The assistant never guesses and never fabricates citations.",
	},
	{
		q: "Can I sign in?",
		a: "Yes. Click Sign In in the top nav. You'll get a magic link to your email — no password. Sessions are cookie-based. Your email is only used to resolve your rate-limit tier; it isn't sent to OpenAI or logged against your queries.",
	},
	{
		q: "Are my questions logged?",
		a: "Request metadata is logged (timestamp, route, latency, hashed IP with a daily-rotating salt, tier, prompt version, retrieval similarity scores) — never the raw question text or the raw answer. See PLAN.md Appendix H.6 for the full list of fields and the explicit 'what we never log' list.",
	},
	{
		q: "What stack is this on?",
		a: "Next.js 16 App Router, assistant-ui for the chat surface, Supabase Postgres + pgvector (HNSW) for the RAG index, OpenAI text-embedding-3-small + gpt-4o-mini, Upstash Redis for rate limits + the daily circuit breaker, @opennextjs/cloudflare for the Cloudflare Workers deploy. Bun as the package manager. Design tokens in globals.css map to Appendix G.",
	},
	{
		q: "Is the code public?",
		a: "It will be once the Loom walkthrough is recorded — that's the last gating step before outreach. Until then the repo is private.",
	},
	{
		q: "Who do I talk to about NPX Innovation?",
		a: "Visit npxai.com. This demo is separate from NPX Innovation's own work — it's a hiring application from a candidate.",
	},
] as const;

export default function FAQPage() {
	return (
		<div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-16 md:px-6">
			<header className="flex flex-col gap-3">
				<p className="text-xs uppercase tracking-[0.18em] text-fg-muted">FAQ</p>
				<h1 className="font-semibold text-3xl text-fg md:text-4xl">
					Frequently asked questions
				</h1>
			</header>
			<dl className="flex flex-col gap-4">
				{FAQS.map((f) => (
					<div
						key={f.q}
						className="rounded-lg border border-border bg-surface p-5"
					>
						<dt className="font-semibold text-fg">{f.q}</dt>
						<dd className="mt-2 text-sm text-fg-muted leading-relaxed">
							{f.a}
						</dd>
					</div>
				))}
			</dl>
			<footer className="text-sm text-fg-muted">
				Something missing? The{" "}
				<Link
					href="/"
					className="text-brand hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
				>
					homepage contact section
				</Link>{" "}
				has a newsletter capture — Raj will get back to you.
			</footer>
		</div>
	);
}
