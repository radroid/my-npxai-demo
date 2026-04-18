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
	// assistant-ui runtime. `initialMode` comes from the server-determined
	// session so the adapter spins up in the correct tier on first render —
	// without this the client starts in "unknown"/"anon", can run a stray
	// initialize() with an anon id, and later tries to load that localId as
	// a server uuid when the session probe flips mode to "signed_in".
	const initialMode = user ? "signed_in" : "anon";
	return (
		<KnowledgeHubRuntimeProvider initialMode={initialMode}>
			<AppShell userEmail={user?.email ?? null}>{children}</AppShell>
		</KnowledgeHubRuntimeProvider>
	);
}
