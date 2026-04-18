import {
	ArrowRightIcon,
	CheckCircle2Icon,
	GitCompareIcon,
	LayersIcon,
} from "lucide-react";
import Link from "next/link";

export const metadata = {
	title: "Equivalency Evaluator — NPXai Demo",
	description:
		"Concept explainer for the Equivalency Evaluator surface. Not a working feature in this sprint.",
};

const PILLARS = [
	{
		icon: GitCompareIcon,
		title: "Claim ↔ clause matching",
		body: "Each vendor claim mapped to the REGDOC section it addresses.",
	},
	{
		icon: LayersIcon,
		title: "Defensible case",
		body: "The write-up a licensing team would hand to a regulator.",
	},
	{
		icon: CheckCircle2Icon,
		title: "Traceable evidence",
		body: "Every paragraph links back to its source clause or submission.",
	},
];

export default function EquivalencyPage() {
	return (
		<div className="mx-auto flex max-w-4xl flex-col gap-12 px-4 py-16 md:px-6">
			<header className="flex flex-col gap-4">
				<p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
					Concept · not a working feature this sprint
				</p>
				<h1 className="font-semibold text-3xl text-fg md:text-4xl">
					Equivalency — structured case-building against CNSC expectations
				</h1>
				<p className="max-w-3xl text-fg-muted md:text-lg">
					Map a vendor submission to the REGDOC framework and produce a
					defensible equivalency write-up.
				</p>
			</header>

			<section className="grid gap-4 md:grid-cols-3">
				{PILLARS.map((p) => (
					<article
						key={p.title}
						className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-5"
					>
						<p.icon className="size-5 text-brand" aria-hidden="true" />
						<h2 className="font-semibold text-fg">{p.title}</h2>
						<p className="text-sm text-fg-muted leading-relaxed">{p.body}</p>
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
					href="/insights"
					className="inline-flex items-center gap-1 text-brand hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
				>
					See Insights <ArrowRightIcon className="size-4" />
				</Link>
			</div>
		</div>
	);
}
