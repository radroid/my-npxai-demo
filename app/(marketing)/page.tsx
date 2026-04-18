import {
	ArrowRightIcon,
	BookOpenIcon,
	FileTextIcon,
	LayersIcon,
	LineChartIcon,
} from "lucide-react";
import Link from "next/link";
import { AuroraHero } from "@/components/site/AuroraHero";
import { NewsletterCapture } from "@/components/site/NewsletterCapture";
import { createSupabaseServerClient } from "@/lib/supabase";

const FEATURES = [
	{
		href: "/knowledge-hub",
		icon: BookOpenIcon,
		title: "Knowledge Hub",
		blurb: "Cited Q&A over 19 CNSC REGDOCs.",
		cta: "Try it",
	},
	{
		href: "/generator",
		icon: FileTextIcon,
		title: "Shift Turnover Generator",
		blurb: "REGDOC-2.3.4 turnovers from simulated Bruce Power data.",
		cta: "Generate one",
	},
	{
		href: "/insights",
		icon: LineChartIcon,
		title: "Insights",
		blurb: "Narrative layer over plant + regulatory signal.",
		cta: "Concept",
	},
	{
		href: "/equivalency",
		icon: LayersIcon,
		title: "Equivalency",
		blurb: "Map vendor claims to CNSC expectations.",
		cta: "Concept",
	},
] as const;

export default async function HomePage() {
	const supabase = await createSupabaseServerClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	const isSignedIn = Boolean(user);

	return (
		<div className="flex flex-col gap-24 pb-24">
			{/* Hero — aurora is scoped to this section only. */}
			<AuroraHero>
				<section className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-4 py-20 text-center md:px-6 md:py-28">
					<p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
						NPXai demo · built by Raj Dholakia
					</p>
					<h1 className="max-w-3xl text-balance font-semibold text-4xl leading-tight tracking-tight text-fg md:text-5xl lg:text-6xl">
						A CNSC Knowledge Hub and a CANDU shift generator — live, cited, and
						on the edge.
					</h1>
					<p className="max-w-2xl text-balance text-base text-fg-muted md:text-lg">
						A hiring demo for{" "}
						<a
							href="https://npxai.com"
							className="text-fg underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-sm"
							target="_blank"
							rel="noopener noreferrer"
						>
							NPX Innovation
						</a>
						.
					</p>
					<div className="mt-2 flex flex-col gap-3 sm:flex-row">
						<Link
							href="/knowledge-hub"
							className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-brand px-6 text-sm font-medium text-white transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
						>
							Try the Knowledge Hub
							<ArrowRightIcon className="size-4" aria-hidden="true" />
						</Link>
						<Link
							href="/generator"
							className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-border bg-surface px-6 text-sm font-medium text-fg transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
						>
							Open the Shift Generator
						</Link>
					</div>
				</section>
			</AuroraHero>

			{/* Showcase */}
			<section
				id="showcase"
				className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 md:px-6"
			>
				<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
					{FEATURES.map((f) => (
						<Link
							key={f.href}
							href={f.href}
							className="group flex flex-col gap-3 rounded-lg border border-border bg-surface p-5 transition-colors hover:border-brand/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
						>
							<div className="flex items-center justify-between">
								<f.icon className="size-4 text-fg-muted" aria-hidden="true" />
								<ArrowRightIcon
									className="size-4 text-fg-muted transition-transform group-hover:translate-x-0.5"
									aria-hidden="true"
								/>
							</div>
							<h3 className="font-semibold text-fg text-lg">{f.title}</h3>
							<p className="text-sm text-fg-muted leading-relaxed">{f.blurb}</p>
							<span className="mt-auto text-xs font-medium text-brand">
								{f.cta} →
							</span>
						</Link>
					))}
				</div>
			</section>

			{/* Contact / sign-up */}
			<section
				id="contact"
				className="mx-auto flex w-full max-w-6xl flex-col items-center gap-4 rounded-xl border border-border bg-surface p-8 text-center md:p-12"
			>
				<p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
					{isSignedIn ? "You're in" : "Sign up"}
				</p>
				<h2 className="max-w-2xl text-balance font-semibold text-2xl text-fg md:text-3xl">
					{isSignedIn
						? "Thanks for trying the demo."
						: "Drop your email — I'll send a sign-in link that logs you in directly."}
				</h2>
				<NewsletterCapture isSignedIn={isSignedIn} />
				{isSignedIn ? null : (
					<p className="text-[11px] text-fg-muted">
						Magic link via Supabase Auth. No password, no marketing list.
					</p>
				)}
			</section>
		</div>
	);
}
