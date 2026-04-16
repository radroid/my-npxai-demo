import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({
	// Minimal config — relies on @opennextjs/cloudflare defaults for the
	// Workers runtime. Incremental cache, tag cache, and queue bindings
	// can be added later if we introduce ISR / on-demand revalidation.
});
