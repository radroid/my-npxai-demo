"use client";

// Single source of truth for the Knowledge Hub's auth mode. Replaces the
// old localStorage-persisted useThreadStore — that store mirrored auth
// state in three places (server cookie, Zustand persist, Supabase client
// localStorage), which drifted on stale sessions and surfaced as
// "Anon daily quota reached" while the sidebar said you were signed in.
//
// Contract:
// - Server renders with an `initialMode` derived from supabase.auth.getUser()
//   inside the layout. That's the first paint.
// - Client hits /api/auth/whoami on mount + on window focus. whoami calls
//   getUser() server-side (authoritative — validates the refresh token)
//   so the client can reconcile against reality rather than its own
//   cached view.
// - On anon → signed_in transition we wipe localStorage anon threads
//   (option C; user confirmed 2026-04-18).
// - When the chat transport sees a "server says anon, client thought
//   signed_in" mismatch it calls markSessionExpired(), which flips mode
//   to anon and raises a visible banner. The transport is not React, so
//   it reads the context via the module-level snapshot below.

import { useRouter } from "next/navigation";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";

export type AuthMode = "anon" | "signed_in";

interface AuthContextValue {
	mode: AuthMode;
	// True once the client has reconciled with /api/auth/whoami at least once.
	// Adapters can gate their first fetch on this to avoid listing the wrong
	// tier's threads when the server's SSR guess was stale.
	reconciled: boolean;
	sessionExpired: boolean;
	dismissSessionExpired: () => void;
	reconcile: () => Promise<AuthMode>;
	markSessionExpired: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
	const ctx = useContext(AuthContext);
	if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
	return ctx;
}

// Non-reactive accessor for code that runs outside React's render — the
// custom fetch passed to AssistantChatTransport in particular. AuthProvider
// keeps this in sync with the latest context value; null before first mount.
let authSnapshot: AuthContextValue | null = null;
export function getAuthSnapshot(): AuthContextValue | null {
	return authSnapshot;
}

const ANON_THREADS_KEY = "npxai-kh-anon-threads";
const ANON_MESSAGES_PREFIX = "npxai-kh-anon-msgs:";

function wipeAnonLocalStorage(): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.removeItem(ANON_THREADS_KEY);
		const toRemove: string[] = [];
		for (let i = 0; i < window.localStorage.length; i++) {
			const key = window.localStorage.key(i);
			if (key?.startsWith(ANON_MESSAGES_PREFIX)) toRemove.push(key);
		}
		for (const key of toRemove) window.localStorage.removeItem(key);
	} catch {
		// Private mode / quota — silent.
	}
}

export function AuthProvider({
	initialMode,
	children,
}: {
	initialMode: AuthMode;
	children: ReactNode;
}) {
	const router = useRouter();
	const [mode, setMode] = useState<AuthMode>(initialMode);
	const [reconciled, setReconciled] = useState(false);
	const [sessionExpired, setSessionExpired] = useState(false);
	const prevModeRef = useRef<AuthMode>(initialMode);

	const reconcile = useCallback(async (): Promise<AuthMode> => {
		try {
			const res = await fetch("/api/auth/whoami", {
				credentials: "include",
				cache: "no-store",
			});
			if (!res.ok) {
				setReconciled(true);
				return prevModeRef.current;
			}
			const body = (await res.json()) as { signedIn: boolean };
			const next: AuthMode = body.signedIn ? "signed_in" : "anon";
			setReconciled(true);
			if (next !== prevModeRef.current) {
				if (prevModeRef.current === "anon" && next === "signed_in") {
					wipeAnonLocalStorage();
				}
				prevModeRef.current = next;
				setMode(next);
				// Re-run the server layout so supabase.auth.getUser() resolves
				// against the new cookie state and the sidebar/adapters rebuild
				// in the correct tier. Without this the client mode flips but
				// the already-mounted signed-in adapter keeps rendering Supabase
				// threads under an anon tier (or vice versa).
				router.refresh();
			}
			if (next === "signed_in") setSessionExpired(false);
			return next;
		} catch {
			setReconciled(true);
			return prevModeRef.current;
		}
	}, [router]);

	useEffect(() => {
		// Sign-in via magic link is a full-page redirect (/auth/callback →
		// /knowledge-hub), so the client mounts with initialMode already
		// stamped as "signed_in" — there's no anon→signed_in transition for
		// reconcile() to catch. Wipe any anon leftovers on mount whenever
		// we come in already authenticated so option-C stays enforced.
		if (initialMode === "signed_in") {
			wipeAnonLocalStorage();
		}
		void reconcile();
		const onFocus = () => void reconcile();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [reconcile, initialMode]);

	const dismissSessionExpired = useCallback(() => {
		setSessionExpired(false);
	}, []);

	const markSessionExpired = useCallback(() => {
		// Called by the transport fetch wrapper when a refresh couldn't
		// rescue a tier mismatch. Flip both state slots so the adapters
		// switch to localStorage and the banner surfaces. The router.refresh
		// re-runs the server layout so the sidebar re-lists from the correct
		// data source (anon localStorage, now empty) instead of continuing
		// to display the signed-in thread list.
		prevModeRef.current = "anon";
		setMode("anon");
		setSessionExpired(true);
		router.refresh();
	}, [router]);

	const value: AuthContextValue = {
		mode,
		reconciled,
		sessionExpired,
		dismissSessionExpired,
		reconcile,
		markSessionExpired,
	};

	authSnapshot = value;

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
