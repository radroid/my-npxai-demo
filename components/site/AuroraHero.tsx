"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

const BANDS = [
	{
		className: "aurora-band aurora-band-a",
		animate: { x: ["-6%", "8%"], y: ["-2%", "3%"], scale: [1.05, 1.15] },
		initial: { x: "-6%", y: "-2%", scale: 1.05 },
		duration: 22,
	},
	{
		className: "aurora-band aurora-band-b",
		animate: { x: ["4%", "-8%"], y: ["2%", "-4%"], scale: [1.1, 1] },
		initial: { x: "4%", y: "2%", scale: 1.1 },
		duration: 28,
	},
	{
		className: "aurora-band aurora-band-c",
		animate: { x: ["-2%", "6%"], y: ["3%", "-5%"], scale: [0.95, 1.2] },
		initial: { x: "-2%", y: "3%", scale: 0.95 },
		duration: 34,
	},
];

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
			{children}
		</div>
	);
}
