import {
	ArrowRightIcon,
	BookOpenIcon,
	FileTextIcon,
	LayersIcon,
	LineChartIcon,
	ShieldCheckIcon,
	SparklesIcon,
	ZapIcon,
} from "lucide-react";
import Link from "next/link";
import { AuroraHero } from "@/components/site/AuroraHero";
import { NewsletterCapture } from "@/components/site/NewsletterCapture";

const FEATURES = [
	{
		href: "/knowledge-hub",
		label: "Working feature",
		icon: BookOpenIcon,
		title: "Knowledge Hub",
		blurb:
			"Retrieval-augmented Q&A over 19 CNSC REGDOCs. Every answer cites the REGDOC and section it came from.",
		cta: "Try it",
	},
	{
		href: "/generator",
		label: "Working feature",
		icon: FileTextIcon,
		title: "Shift Turnover Generator",
		blurb:
			"Generates a CANDU shift turnover report per REGDOC-2.3.4 from simulated Bruce Power plant data.",
		cta: "Generate a report",
	},
	{
		href: "/insights",
		label: "Explainer",
		icon: LineChartIcon,
		title: "Insights",
		blurb:
			"Rolling narrative layer over plant trends + regulatory signal. Concept explainer for this sprint.",
		cta: "Read more",
	},
	{
		href: "/equivalency",
		label: "Explainer",
		icon: LayersIcon,
		title: "Equivalency Evaluator",
		blurb:
			"Maps vendor claims against CNSC expectations to produce a defensible equivalency case. Concept explainer.",
		cta: "Read more",
	},
] as const;

const WHY = [
	{
		icon: ShieldCheckIcon,
		title: "Security-first RAG",
		body: "Anon + tier-aware rate limits, HTML-escaped context envelopes, input + output deny lists, and a daily OpenAI circuit breaker. Threads stay client-side, so there's no server-side prompt log to leak.",
	},
	{
		icon: SparklesIcon,
		title: "Grounded answers only",
		body: "Every claim is cited back to the specific REGDOC section it came from, with a visible Sources panel under each answer. If the corpus doesn't cover the question, the assistant says so instead of guessing.",
	},
	{
		icon: ZapIcon,
		title: "Cloudflare-edge deploy",
		body: "Built on Next.js 16 + @opennextjs/cloudflare, Supabase pgvector (HNSW), and Upstash Redis. Portable to Azure OpenAI + Cosmos DB vector if the deployment posture calls for it.",
	},
];

export default function HomePage() {
	return (
		<div className="flex flex-col gap-24 pb-24">
			{/* Hero — aurora is scoped to this section only. */}
			<AuroraHero>
				<section className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-4 py-20 text-center md:px-6 md:py-28">
				<p className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
					NPXai demo · built by Raj Dholakia
				</p>
				<h1 className="max-w-3xl text-balance font-semibold text-4xl leading-tight tracking-tight text-[var(--text)] md:text-5xl lg:text-6xl">
					A CNSC Knowledge Hub and a CANDU shift generator — live, cited, and on
					the edge.
				</h1>
				<p className="max-w-2xl text-balance text-base text-[var(--text-muted)] md:text-lg">
					A working application for the Senior Full-Stack and Intermediate AI
					Developer roles at{" "}
					<a
						href="https://npxai.com"
						className="text-[var(--text)] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded-sm"
						target="_blank"
						rel="noopener noreferrer"
					>
						NPX Innovation
					</a>
					. Retrieval-augmented Q&amp;A over 19 REGDOCs, plus a shift-turnover
					generator that reads from simulated Bruce Power plant data.
				</p>
				<div className="mt-2 flex flex-col gap-3 sm:flex-row">
					<Link
						href="/knowledge-hub"
						className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-[var(--accent-brand)] px-6 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-brand-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
					>
						Try the Knowledge Hub
						<ArrowRightIcon className="size-4" aria-hidden="true" />
					</Link>
					<Link
						href="/generator"
						className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-6 text-sm font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
					>
						Open the Shift Generator
					</Link>
				</div>
				</section>
			</AuroraHero>

			{/* Showcase */}
			<section id="showcase" className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 md:px-6">
				<header className="flex flex-col gap-2">
					<p className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
						What's in the demo
					</p>
					<h2 className="font-semibold text-2xl text-[var(--text)] md:text-3xl">
						Four surfaces — two you can poke, two you can read about.
					</h2>
				</header>
				<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
					{FEATURES.map((f) => (
						<Link
							key={f.href}
							href={f.href}
							className="group flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 transition-colors hover:border-[var(--accent-brand)]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
						>
							<div className="flex items-center justify-between">
								<span className="inline-flex items-center gap-2 text-xs text-[var(--text-muted)]">
									<f.icon className="size-4" aria-hidden="true" />
									{f.label}
								</span>
								<ArrowRightIcon
									className="size-4 text-[var(--text-muted)] transition-transform group-hover:translate-x-0.5"
									aria-hidden="true"
								/>
							</div>
							<h3 className="font-semibold text-[var(--text)] text-lg">{f.title}</h3>
							<p className="text-sm text-[var(--text-muted)] leading-relaxed">
								{f.blurb}
							</p>
							<span className="mt-auto text-xs font-medium text-[var(--accent-brand)]">
								{f.cta} →
							</span>
						</Link>
					))}
				</div>
			</section>

			{/* Why */}
			<section id="why" className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 md:px-6">
				<header className="flex flex-col gap-2">
					<p className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
						Why NPX AI?
					</p>
					<h2 className="font-semibold text-2xl text-[var(--text)] md:text-3xl">
						Built with the posture a regulatory demo actually needs.
					</h2>
					<p className="max-w-3xl text-sm text-[var(--text-muted)] md:text-base">
						This isn't "throw ChatGPT at a PDF" — the corpus is parsed, chunked,
						embedded, and audited against a 20-question eval battery before it's
						wired into the UI. The ship bar is 17/20 with all three adversarial
						questions passing; the current build hits 20/20.
					</p>
				</header>
				<div className="grid gap-4 md:grid-cols-3">
					{WHY.map((w) => (
						<div
							key={w.title}
							className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5"
						>
							<w.icon
								className="size-5 text-[var(--accent-brand)]"
								aria-hidden="true"
							/>
							<h3 className="font-semibold text-[var(--text)]">{w.title}</h3>
							<p className="text-sm text-[var(--text-muted)] leading-relaxed">
								{w.body}
							</p>
						</div>
					))}
				</div>
			</section>

			{/* Contact / newsletter */}
			<section
				id="contact"
				className="mx-auto flex w-full max-w-6xl flex-col items-center gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center md:p-12"
			>
				<p className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
					Stay in touch
				</p>
				<h2 className="max-w-2xl text-balance font-semibold text-2xl text-[var(--text)] md:text-3xl">
					Following the demo? Drop your email and I'll send updates as this
					grows past the hiring sprint.
				</h2>
				<NewsletterCapture />
				<p className="text-[10px] text-[var(--text-muted)]">
					UI-only for this demo. Your email isn't stored anywhere.
				</p>
			</section>
		</div>
	);
}
