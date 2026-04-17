import Link from "next/link";

// Phase 2 placeholder. Phase 4 builds the real landing page (hero +
// 4-up feature grid + #why/#showcase/#faq/#contact sections targeted by
// the TopNav anchors). Until then this page just introduces the demo
// and links to the two working surfaces so evaluators don't land on a
// blank screen.

export default function HomePage() {
	return (
		<main className="mx-auto flex min-h-[calc(100dvh-3.5rem-8rem)] max-w-3xl flex-col items-center justify-center gap-6 px-6 py-16 text-center">
			<p className="text-xs uppercase tracking-widest text-[--text-muted]">
				NPXai Demo
			</p>
			<h1 className="text-4xl font-semibold text-[--text] md:text-5xl">
				A working CNSC Knowledge Hub and CANDU shift generator.
			</h1>
			<p className="max-w-2xl text-base text-[--text-muted]">
				Built as a hiring application for{" "}
				<a
					href="https://npxai.com"
					className="text-[--text] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent] rounded-sm"
					target="_blank"
					rel="noopener noreferrer"
				>
					NPX Innovation
				</a>
				. Retrieval-augmented Q&amp;A over the CNSC REGDOCs, plus a
				turnover-report generator over simulated Bruce Power plant data.
			</p>
			<div className="mt-4 flex flex-col gap-3 sm:flex-row">
				<Link
					href="/knowledge-hub"
					className="inline-flex h-10 items-center justify-center rounded-md bg-[--accent] px-5 text-sm font-medium text-[--bg] transition-colors hover:bg-[--accent-hover] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent] focus-visible:ring-offset-2 focus-visible:ring-offset-[--bg]"
				>
					Try the Knowledge Hub
				</Link>
				<Link
					href="/generator"
					className="inline-flex h-10 items-center justify-center rounded-md border border-[--border] bg-[--surface] px-5 text-sm font-medium text-[--text] transition-colors hover:bg-[--surface-2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent] focus-visible:ring-offset-2 focus-visible:ring-offset-[--bg]"
				>
					Shift Generator
				</Link>
			</div>
		</main>
	);
}
