import * as React from "react";

const MOBILE_BREAKPOINT = 768;

// useIsMobile on useSyncExternalStore — canonical §1.8 pattern for reading a
// browser API (matchMedia / window size) into React state. Tear-resistant,
// concurrent-safe, and SSRs cleanly by returning `false` from the server
// snapshot so the first client paint matches the HTML.
const MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

function subscribe(callback: () => void): () => void {
	const mql = window.matchMedia(MEDIA_QUERY);
	mql.addEventListener("change", callback);
	return () => mql.removeEventListener("change", callback);
}

function getSnapshot(): boolean {
	return window.matchMedia(MEDIA_QUERY).matches;
}

// Non-mobile on the server so desktop chrome renders first; on small viewports
// the initial paint flashes the desktop layout for one frame before
// hydration resolves — acceptable tradeoff against a hydration mismatch.
function getServerSnapshot(): boolean {
	return false;
}

export function useIsMobile() {
	return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
