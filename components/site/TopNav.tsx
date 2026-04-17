import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase";
import { SignInButton } from "./SignInButton";
import { UserChip } from "./UserChip";

const NAV_LINKS = [
	{ href: "/#why", label: "Why NPXai" },
	{ href: "/#showcase", label: "Features" },
	{ href: "/#faq", label: "FAQ" },
	{ href: "/#contact", label: "Contact" },
];

export async function TopNav() {
	const supabase = await createSupabaseServerClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	return (
		<header className="sticky top-0 z-40 w-full border-b border-[--border] bg-[--surface]/90 backdrop-blur supports-[backdrop-filter]:bg-[--surface]/70">
			<nav
				aria-label="Primary"
				className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 md:px-6"
			>
				<Link
					href="/"
					className="flex items-center gap-2 text-sm font-semibold tracking-tight text-[--text] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent] rounded-md"
				>
					<span
						aria-hidden="true"
						className="inline-block h-6 w-6 rounded-md bg-[--accent]"
					/>
					<span>NPXai Demo</span>
				</Link>

				<ul className="hidden items-center gap-6 md:flex">
					{NAV_LINKS.map((link) => (
						<li key={link.href}>
							<Link
								href={link.href}
								className="text-sm text-[--text-muted] transition-colors hover:text-[--text] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent] rounded-md"
							>
								{link.label}
							</Link>
						</li>
					))}
				</ul>

				<div className="flex items-center gap-2">
					{user ? <UserChip email={user.email ?? ""} /> : <SignInButton />}
				</div>
			</nav>
		</header>
	);
}
