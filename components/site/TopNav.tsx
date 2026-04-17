import { BookOpen, FileText } from "lucide-react";
import Link from "next/link";
import { ConceptsMenu } from "@/components/site/ConceptsMenu";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { createSupabaseServerClient } from "@/lib/supabase";
import { SignInButton } from "./SignInButton";
import { UserChip } from "./UserChip";

// Working apps (interactive) render as primary pill buttons so the two
// things evaluators should *try* are unmissable. Concept explainers hide
// behind the ConceptsMenu dropdown so the row isn't busy.
const WORKING_APPS = [
	{ href: "/knowledge-hub", label: "Knowledge Hub", Icon: BookOpen },
	{ href: "/generator", label: "Generator", Icon: FileText },
];

export async function TopNav() {
	const supabase = await createSupabaseServerClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	return (
		<header className="sticky top-0 z-40 w-full border-b border-border bg-surface/90 backdrop-blur supports-[backdrop-filter]:bg-surface/70">
			<nav
				aria-label="Primary"
				className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 md:px-6"
			>
				<Link
					href="/"
					className="flex items-center gap-2 text-sm font-semibold tracking-tight text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded-md"
				>
					<span
						aria-hidden="true"
						className="inline-block h-6 w-6 rounded-md bg-brand"
					/>
					<span>NPXai Demo</span>
				</Link>

				<ul className="hidden items-center gap-2 md:flex">
					{WORKING_APPS.map(({ href, label, Icon }) => (
						<li key={href}>
							<Link
								href={href}
								className="group inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:border-brand hover:bg-brand hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
							>
								<Icon
									className="h-3.5 w-3.5 text-fg-muted transition-colors group-hover:text-white"
									aria-hidden="true"
								/>
								<span>{label}</span>
							</Link>
						</li>
					))}
					<li>
						<ConceptsMenu />
					</li>
				</ul>

				<div className="flex items-center gap-3">
					<ThemeToggle />
					{user ? <UserChip email={user.email ?? ""} /> : <SignInButton />}
				</div>
			</nav>
		</header>
	);
}
