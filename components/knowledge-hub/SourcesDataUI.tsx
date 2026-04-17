"use client";

import { makeAssistantDataUI } from "@assistant-ui/react";
import {
	SourcesPanel,
	type SourcesPanelProps,
} from "@/components/knowledge-hub/SourcesPanel";

// assistant-ui normalises AI SDK `data-sources` frames into a
// `DataMessagePart` with `{ type: "data", name: "sources", data }`.
// Registering a renderer for name="sources" inserts <SourcesPanel />
// inline after the text part, keyed correctly within the Thread scroll.
export const SourcesDataUI = makeAssistantDataUI<SourcesPanelProps["data"]>({
	name: "sources",
	render: ({ data }) => <SourcesPanel data={data} />,
});
