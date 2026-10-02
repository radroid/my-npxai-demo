import { KnowledgeHubShell } from "@/components/knowledge-hub/KnowledgeHubShell";
import { getScopeOptions } from "@/lib/sources/config";

// The (app) layout reads the auth cookie, so this renders per request and
// the source flags below are read from the runtime environment, not baked
// in at build time. null (legacy corpus) renders no source selector.
export default function KnowledgeHubPage() {
	return <KnowledgeHubShell sourceOptions={getScopeOptions()} />;
}
