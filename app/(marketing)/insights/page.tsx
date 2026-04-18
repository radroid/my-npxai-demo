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
		title: "Trend summaries",
		body: "Parameter drift rolled into a 30-second narrative.",
	},
	{
		icon: AlertTriangleIcon,
		title: "Regulatory signal",
		body: "Operating anomalies cross-referenced against active CNSC clauses.",
	},
	{
		icon: LineChartIcon,
		title: "Shift-over-shift deltas",
		body: "What's actually new this shift vs last week — not the noise.",
	},
];

export default function InsightsPage() {
	return (
		<div className="mx-auto flex max-w-4xl flex-col gap-12 px-4 py-16 md:px-6">
			<header className="flex flex-col gap-4">
				<p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
					Concept · not a working feature this sprint
				</p>
				<h1 className="font-semibold text-3xl text-fg md:text-4xl">
					Insights — narrative layer over plant + regulatory signal
				</h1>
				<p className="max-w-3xl text-fg-muted md:text-lg">
					Continuous scan of plant data + CNSC signal for operator-relevant
					narratives.
				</p>
			</header>

			<section className="grid gap-4 md:grid-cols-3">
				{SIGNALS.map((s) => (
					<article
						key={s.title}
						className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-5"
					>
						<s.icon className="size-5 text-brand" aria-hidden="true" />
						<h2 className="font-semibold text-fg">{s.title}</h2>
						<p className="text-sm text-fg-muted leading-relaxed">{s.body}</p>
					</article>
				))}
			</section>

			<div className="flex items-center gap-3 text-sm">
				<Link
					href="/knowledge-hub"
					className="inline-flex items-center gap-1 text-brand hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
				>
					See the Knowledge Hub <ArrowRightIcon className="size-4" />
				</Link>
				<span className="text-fg-muted">·</span>
				<Link
					href="/generator"
					className="inline-flex items-center gap-1 text-brand hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
				>
					See the Generator <ArrowRightIcon className="size-4" />
				</Link>
			</div>
		</div>
	);
}
