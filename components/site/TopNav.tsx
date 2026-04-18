import { BookOpen, FileText, Home } from "lucide-react";
import Link from "next/link";
import { BrandThemeToggle } from "@/components/site/BrandThemeToggle";
import { ConceptsMenu } from "@/components/site/ConceptsMenu";
import { MobileNav } from "@/components/site/MobileNav";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { createSupabaseServerClient } from "@/lib/supabase";
import { SignInButton } from "./SignInButton";
import { UserChip } from "./UserChip";

// Working apps (interactive) render as primary pill buttons so the two
// things evaluators should *try* are unmissable. Concept explainers hide
// behind the ConceptsMenu dropdown so the row isn't busy. Home lives
// outside this list (always visible, even on mobile) because the brand
// lockup is no longer a home-link — clicking it toggles the NPX brand
// theme easter-egg instead.
const WORKING_APPS = [
	{ href: "/knowledge-hub", label: "Knowledge Hub", Icon: BookOpen },
	{ href: "/generator", label: "Generator", Icon: FileText },
];

const PILL_CLASSES =
	"group inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:border-brand hover:bg-brand hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand";
const PILL_ICON_CLASSES =
	"h-3.5 w-3.5 text-fg-muted transition-colors group-hover:text-white";

export async function TopNav() {
	const supabase = await createSupabaseServerClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	return (
		<header className="sticky top-0 z-40 w-full overflow-x-clip border-b border-border bg-surface/90 backdrop-blur supports-[backdrop-filter]:bg-surface/70">
			<nav
				aria-label="Primary"
				className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 px-3 sm:gap-4 sm:px-4 md:px-6"
			>
				<div className="flex min-w-0 items-center gap-1 sm:gap-2">
					<MobileNav />
					<BrandThemeToggle />
					<Link
						href="/"
						aria-label="Home"
						className={`${PILL_CLASSES} hidden md:inline-flex`}
					>
						<Home className={PILL_ICON_CLASSES} aria-hidden="true" />
						<span>Home</span>
					</Link>
				</div>

				<ul className="hidden items-center gap-2 md:flex">
					{WORKING_APPS.map(({ href, label, Icon }) => (
						<li key={href}>
							<Link href={href} className={PILL_CLASSES}>
								<Icon className={PILL_ICON_CLASSES} aria-hidden="true" />
								<span>{label}</span>
							</Link>
						</li>
					))}
					<li>
						<ConceptsMenu />
					</li>
				</ul>

				<div className="flex min-w-0 shrink-0 items-center gap-2 sm:gap-3">
					<div className="hidden sm:flex">
						<ThemeToggle />
					</div>
					{user ? <UserChip email={user.email ?? ""} /> : <SignInButton />}
				</div>
			</nav>
		</header>
	);
}
