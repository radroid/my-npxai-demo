import type { ReactNode } from "react";
import { AppShell } from "@/components/app/AppShell";
import { KnowledgeHubRuntimeProvider } from "@/components/knowledge-hub/KnowledgeHubRuntimeProvider";
import { createSupabaseServerClient } from "@/lib/supabase";

export default async function AppGroupLayout({
	children,
}: {
	children: ReactNode;
}) {
	const supabase = await createSupabaseServerClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	// Runtime provider hoisted above AppShell so the ThreadSidebar (rendered
	// in the shell's sidebar slot, not inside the page) can read from the
	// assistant-ui runtime. See the provider's header comment for the
	// tradeoff — one thread-list probe on every (app) route, in exchange for
	// not reshuffling the shell/page layout.
	return (
		<KnowledgeHubRuntimeProvider>
			<AppShell userEmail={user?.email ?? null}>{children}</AppShell>
		</KnowledgeHubRuntimeProvider>
	);
}
