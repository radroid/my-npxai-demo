// Defense-in-depth output scanner. Truncates streamed/accumulated LLM
// output on any match. See Appendix D.6 — the frontend also disables raw
// HTML passthrough; this is a second line of defense.

const DENY_PATTERNS: RegExp[] = [
	/<script/i,
	/<iframe/i,
	/javascript:/i,
	/data:text\/html/i,
	/onerror\s*=/i,
	/onload\s*=/i,
];

export interface GuardResult {
	safe: boolean;
	output: string;
	reason?: string;
}

export function scanOutput(output: string): GuardResult {
	for (const pattern of DENY_PATTERNS) {
		const match = pattern.exec(output);
		if (!match) continue;
		return {
			safe: false,
			output: `${output.slice(0, match.index)}\n\n[response truncated — unsafe content]`,
			reason: `output_deny_${pattern.source.replace(/[^a-z]/gi, "")}`,
		};
	}
	return { safe: true, output };
}

// Streaming helper: feed tokens as they arrive; returns `null` while safe,
// or a safe (truncated) final string once a deny pattern is hit.
export class StreamingGuard {
	private buffer = "";
	private tripped = false;

	push(token: string): {
		safeTokens: string;
		terminate: boolean;
		reason?: string;
	} {
		if (this.tripped) return { safeTokens: "", terminate: true };
		this.buffer += token;
		const result = scanOutput(this.buffer);
		if (result.safe) {
			return { safeTokens: token, terminate: false };
		}
		this.tripped = true;
		// Emit only the portion of the final safe output the caller hasn't seen yet.
		const safeTokens = result.output.slice(this.buffer.length - token.length);
		return { safeTokens, terminate: true, reason: result.reason };
	}
}
