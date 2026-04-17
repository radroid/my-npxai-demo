import type { ReactNode } from "react";
import { AppShell } from "@/components/app/AppShell";
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

	return <AppShell userEmail={user?.email ?? null}>{children}</AppShell>;
}
