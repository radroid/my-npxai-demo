"use client";

import {
	animate,
	motion,
	useMotionValue,
	useReducedMotion,
} from "motion/react";
import { type ReactNode, useEffect } from "react";

const BANDS = [
	{
		className: "aurora-band aurora-band-a",
		animate: { x: ["-3%", "5%"], y: ["-4%", "2%"], scale: [1.02, 1.12] },
		initial: { x: "-3%", y: "-4%", scale: 1.02 },
		duration: 24,
	},
	{
		className: "aurora-band aurora-band-b",
		animate: { x: ["5%", "-6%"], y: ["0%", "-5%"], scale: [1.08, 0.98] },
		initial: { x: "5%", y: "0%", scale: 1.08 },
		duration: 30,
	},
	{
		className: "aurora-band aurora-band-c",
		animate: { x: ["-1%", "4%"], y: ["1%", "-6%"], scale: [0.98, 1.16] },
		initial: { x: "-1%", y: "1%", scale: 0.98 },
		duration: 36,
	},
];

// Pale green accents layered on the hero on dark / NPX themes — mimic the
// soft pale-green light on the left side of the NPXai reference photo.
//
// Animation model (per streak):
//   1. Intro (INTRO_SECS): continuous 5× bursts immediately on page load.
//   2. Steady state: 10-second cycles. Each cycle = BASELINE_HALF_SECS of
//      slow drift + BURST_HALF_SECS of quick spike. The spike is the
//      "every 10s" accelerator; each streak then "slows down to current
//      pace" via the next slow drift.
//
// Timings derive from BURST_MULTIPLIER so the ratio is always 5:1 in speed:
//   one slow drift + one spike = one cycle = CYCLE_SECS total.
// Each streak runs on its own phase-offset so the spikes never sync up.
const INTRO_SECS = 5;
const CYCLE_SECS = 10;
const BURST_MULTIPLIER = 5;
const BASELINE_HALF_SECS =
	(CYCLE_SECS * BURST_MULTIPLIER) / (BURST_MULTIPLIER + 1);
const BURST_HALF_SECS = CYCLE_SECS / (BURST_MULTIPLIER + 1);

type StreakCfg = {
	key: string;
	className: string;
	fromPct: number;
	toPct: number;
	phaseOffsetMs: number;
};

const GREEN_STREAKS: StreakCfg[] = [
	{
		key: "a",
		className: "aurora-green-streak aurora-green-streak-a",
		fromPct: -25,
		toPct: 25,
		phaseOffsetMs: 0,
	},
	{
		key: "b",
		className: "aurora-green-streak aurora-green-streak-b",
		fromPct: 20,
		toPct: -30,
		phaseOffsetMs: Math.round((CYCLE_SECS * 1000) / 3),
	},
	{
		key: "c",
		className: "aurora-green-streak aurora-green-streak-c",
		fromPct: -15,
		toPct: 30,
		phaseOffsetMs: Math.round((CYCLE_SECS * 2000) / 3),
	},
];

function GreenStreak({
	cfg,
	prefersReducedMotion,
}: {
	cfg: StreakCfg;
	prefersReducedMotion: boolean | null;
}) {
	const x = useMotionValue(`${cfg.fromPct}%`);

	useEffect(() => {
		if (prefersReducedMotion) {
			x.set(`${cfg.fromPct}%`);
			return;
		}

		let cancelled = false;
		let currentAnim: { stop: () => void } | null = null;

		const moveTo = (
			targetPct: number,
			durSecs: number,
			ease: "easeInOut" | "easeOut",
		) => {
			const a = animate(x, `${targetPct}%`, { duration: durSecs, ease });
			currentAnim = a;
			return a;
		};

		const sleep = (ms: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, ms));

		const run = async () => {
			// Stagger the animation start so each streak spikes at a different
			// moment within the 10s cycle.
			if (cfg.phaseOffsetMs > 0) {
				await sleep(cfg.phaseOffsetMs);
				if (cancelled) return;
			}

			let atStart = true;
			const opposite = () => (atStart ? cfg.toPct : cfg.fromPct);

			// Phase 1 — intro: continuous bursts for INTRO_SECS.
			const introEnd = performance.now() + INTRO_SECS * 1000;
			while (performance.now() < introEnd && !cancelled) {
				await moveTo(opposite(), BURST_HALF_SECS, "easeInOut");
				atStart = !atStart;
			}
			if (cancelled) return;

			// Phase 2 — steady state: slow drift, then brief spike, on loop.
			while (!cancelled) {
				await moveTo(opposite(), BASELINE_HALF_SECS, "easeInOut");
				atStart = !atStart;
				if (cancelled) return;

				await moveTo(opposite(), BURST_HALF_SECS, "easeOut");
				atStart = !atStart;
			}
		};

		run();

		return () => {
			cancelled = true;
			currentAnim?.stop();
		};
	}, [cfg.fromPct, cfg.toPct, cfg.phaseOffsetMs, prefersReducedMotion, x]);

	return (
		<motion.div className={cfg.className} style={{ x }} aria-hidden="true" />
	);
}

export function AuroraHero({ children }: { children: ReactNode }) {
	const prefersReducedMotion = useReducedMotion();

	return (
		<div className="relative isolate overflow-hidden">
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 -z-10 npx:hidden"
			>
				{BANDS.map((band) => (
					<motion.div
						key={band.className}
						className={band.className}
						initial={band.initial}
						animate={prefersReducedMotion ? band.initial : band.animate}
						transition={{
							duration: band.duration,
							repeat: prefersReducedMotion ? 0 : Infinity,
							repeatType: "mirror",
							ease: "easeInOut",
						}}
					/>
				))}
				<div className="absolute inset-0 bg-linear-to-b from-transparent via-transparent to-bg" />
			</div>
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 -z-10 hidden dark:block npx:block"
			>
				{GREEN_STREAKS.map((cfg) => (
					<GreenStreak
						key={cfg.key}
						cfg={cfg}
						prefersReducedMotion={prefersReducedMotion}
					/>
				))}
			</div>
			{children}
		</div>
	);
}
