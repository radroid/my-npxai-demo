import type { ReactNode } from "react";
import { Footer } from "@/components/site/Footer";
import { TopNav } from "@/components/site/TopNav";

export default function MarketingLayout({ children }: { children: ReactNode }) {
	return (
		<div className="flex min-h-dvh flex-col">
			<TopNav />
			<div className="flex-1">{children}</div>
			<Footer />
		</div>
	);
}
