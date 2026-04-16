export default function KnowledgeHubPage() {
	return (
		<main className="flex h-dvh flex-col items-center justify-center gap-4 p-8">
			<h1 className="text-2xl font-semibold">Knowledge Hub</h1>
			<p className="text-muted-foreground max-w-md text-center">
				CNSC regulatory-document Q&amp;A. Phase 2 wires up the assistant-ui
				Thread and custom runtime adapter pointed at{" "}
				<code>/api/knowledge-hub/query</code>.
			</p>
		</main>
	);
}
