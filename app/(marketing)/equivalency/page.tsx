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
		body: "Vendor submissions rarely line up 1:1 with the CNSC clause they're meant to satisfy. Equivalency maps each claim to the exact section it's addressing and flags gaps where a claim doesn't cover the clause's intent.",
	},
	{
		icon: LayersIcon,
		title: "Defensible equivalency case",
		body: "Build the write-up your licensing team would actually hand to a regulator: what the clause requires, what the vendor approach does, why the two are equivalent or different, and the residual risk if any.",
	},
	{
		icon: CheckCircle2Icon,
		title: "Traceable evidence",
		body: "Every paragraph of the equivalency case links back to the source it's quoting — REGDOC section, CSA standard clause, or vendor submission page — with the same Sources-panel contract the Knowledge Hub uses.",
	},
];

export default function EquivalencyPage() {
	return (
		<div className="mx-auto flex max-w-4xl flex-col gap-12 px-4 py-16 md:px-6">
			<header className="flex flex-col gap-4">
				<p className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">
					Concept · not a working feature this sprint
				</p>
				<h1 className="font-semibold text-3xl text-[var(--text)] md:text-4xl">
					Equivalency Evaluator — structured case-building against CNSC
					expectations
				</h1>
				<p className="max-w-3xl text-[var(--text-muted)] md:text-lg">
					When a vendor proposes an alternative approach — a different cooling
					topology, a non-standard fuel handling sequence, a new digital I&amp;C
					architecture — the licensee has to make an equivalency case against
					CNSC expectations. Equivalency would take the vendor's submission, map
					it to the REGDOC framework, and produce a defensible write-up. This
					page is a scope-cut explainer for the hiring demo.
				</p>
			</header>

			<section className="grid gap-4 md:grid-cols-3">
				{PILLARS.map((p) => (
					<article
						key={p.title}
						className="flex flex-col gap-2 rounded-lg border border-border bg-[var(--surface)] p-5"
					>
						<p.icon
							className="size-5 text-[var(--accent-brand)]"
							aria-hidden="true"
						/>
						<h2 className="font-semibold text-[var(--text)]">{p.title}</h2>
						<p className="text-sm text-[var(--text-muted)] leading-relaxed">
							{p.body}
						</p>
					</article>
				))}
			</section>

			<section className="rounded-lg border border-border bg-[var(--surface)] p-6">
				<h2 className="font-semibold text-[var(--text)] text-xl">
					Why this pairs with the Knowledge Hub
				</h2>
				<p className="mt-3 text-sm text-[var(--text-muted)] leading-relaxed">
					The Knowledge Hub proves the retrieval + citation posture works on the
					regulatory side. Equivalency applies that same posture to the
					submission side: a vendor PDF becomes a set of claim-clause pairs,
					each pair is retrieved against the REGDOC corpus that already sits in
					the Knowledge Hub, and the comparison is rendered with the same
					requirement/guidance colour contract. Same engine, different entry
					point.
				</p>
			</section>

			<div className="flex items-center gap-3 text-sm">
				<Link
					href="/knowledge-hub"
					className="inline-flex items-center gap-1 text-[var(--accent-brand)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
				>
					See the Knowledge Hub <ArrowRightIcon className="size-4" />
				</Link>
				<span className="text-[var(--text-muted)]">·</span>
				<Link
					href="/insights"
					className="inline-flex items-center gap-1 text-[var(--accent-brand)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
				>
					See Insights <ArrowRightIcon className="size-4" />
				</Link>
			</div>
		</div>
	);
}
