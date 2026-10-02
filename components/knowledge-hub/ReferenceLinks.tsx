"use client";

// Official pages of reference-only documents a scope notice names (an IAEA
// standard: no text here, titles and links only). Server-supplied from the
// register; every URL is re-checked against the source allowlist before it
// becomes a link. Token utilities only, so it reads in light and dark.

import { ExternalLinkIcon } from "lucide-react";
import { displayHost, isAllowedSourceUrl } from "@/lib/sources/catalog";
import type { ScopeNoticePayload } from "@/lib/sources/payload";

export function ReferenceLinks({
	references,
}: {
	references: ScopeNoticePayload["references"];
}) {
	const links = (references ?? []).filter((r) => isAllowedSourceUrl(r.url));
	if (links.length === 0) return null;
	return (
		<ul className="mt-2 space-y-1 text-xs">
			{links.map((r) => (
				<li key={r.url} className="text-fg-muted">
					<a
						href={r.url}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 text-brand underline underline-offset-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					>
						{r.label}
						<ExternalLinkIcon aria-hidden="true" className="size-3" />
					</a>{" "}
					— {r.title} (official page on {displayHost(r.url)}, not searchable
					here)
				</li>
			))}
		</ul>
	);
}
