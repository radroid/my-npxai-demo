// Knowledge Hub chat endpoint. The handler (legacy CNSC path + the Phase 12
// multi-source branch behind KH_SOURCE_CORPUS) lives in
// lib/knowledge-hub/query-handler.ts; this file only binds it to the guard.

import { withGuard } from "@/lib/guard";
import { knowledgeHubQueryHandler } from "@/lib/knowledge-hub/query-handler";

export const POST = withGuard(
	{ route: "knowledge-hub/query" },
	knowledgeHubQueryHandler,
);
