import {
	AlertTriangleIcon,
	ArrowRightIcon,
	LineChartIcon,
	TrendingUpIcon,
} from "lucide-react";
import Link from "next/link";

export const metadata = {
	title: "Insights — NPXai Demo",
	description:
		"Concept explainer for the Insights surface. Not a working feature in this sprint.",
};

const SIGNALS = [
	{
		icon: TrendingUpIcon,
		title: "Trend-aware summarisation",
		body: "Roll up parameter drift (temperature, pressure, oxygen) into plain-language narratives that a control-room supervisor can skim in 30 seconds — rather than hunt through 40 trend screens.",
	},
	{
		icon: AlertTriangleIcon,
		title: "Regulatory signal",
		body: "Cross-reference operating anomalies against active CNSC REGDOC sections and recent Commission letters. Flag the clauses a station needs to address before the next compliance inspection, not after.",
	},
	{
		icon: LineChartIcon,
		title: "Shift-over-shift deltas",
		body: "Compare the current shift's operating envelope + event log against the same shift last week / last cycle. Narratives highlight what's actually new — not the noise.",
	},
];

export default function InsightsPage() {
	return (
		<div className="mx-auto flex max-w-4xl flex-col gap-12 px-4 py-16 md:px-6">
			<header className="flex flex-col gap-4">
				<p className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
					Concept · not a working feature this sprint
				</p>
				<h1 className="font-semibold text-3xl text-[var(--text)] md:text-4xl">
					Insights — narrative layer over plant + regulatory signal
				</h1>
				<p className="max-w-3xl text-[var(--text-muted)] md:text-lg">
					The Insights surface would sit downstream of the Knowledge Hub and
					Generator: both of those tools pull structured data on demand, while
					Insights continuously scans the same data + CNSC signal for
					operator-relevant narratives. This page is a scope-cut explainer for
					the hiring demo — see the two working surfaces for the actual
					capability proof.
				</p>
			</header>

			<section className="grid gap-4 md:grid-cols-3">
				{SIGNALS.map((s) => (
					<article
						key={s.title}
						className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5"
					>
						<s.icon
							className="size-5 text-[var(--accent-brand)]"
							aria-hidden="true"
						/>
						<h2 className="font-semibold text-[var(--text)]">{s.title}</h2>
						<p className="text-sm text-[var(--text-muted)] leading-relaxed">
							{s.body}
						</p>
					</article>
				))}
			</section>

			<section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6">
				<h2 className="font-semibold text-[var(--text)] text-xl">
					What would it take to build this for real?
				</h2>
				<ul className="mt-3 space-y-2 text-sm text-[var(--text-muted)] leading-relaxed">
					<li>
						· Continuous ingestion of the same simulated (or real) plant data
						already seeded for the Generator.
					</li>
					<li>
						· An additional corpus: CNSC Commission meeting letters + Event
						Initial Report (EIR) summaries, parsed and embedded alongside the
						existing REGDOC chunks.
					</li>
					<li>
						· A scheduled worker (Cloudflare cron) that pulls the latest window,
						applies the same RAG + citation contract, and writes a rolling
						narrative to an append-only log.
					</li>
					<li>
						· A "what changed since last shift" surface in the UI, with the same
						Sources-panel contract as the Knowledge Hub.
					</li>
				</ul>
			</section>

			<div className="flex items-center gap-3 text-sm">
				<Link
					href="/knowledge-hub"
					className="inline-flex items-center gap-1 text-[var(--accent-brand)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded-sm"
				>
					See the Knowledge Hub <ArrowRightIcon className="size-4" />
				</Link>
				<span className="text-[var(--text-muted)]">·</span>
				<Link
					href="/generator"
					className="inline-flex items-center gap-1 text-[var(--accent-brand)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded-sm"
				>
					See the Generator <ArrowRightIcon className="size-4" />
				</Link>
			</div>
		</div>
	);
}
