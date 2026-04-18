"use client";

import { motion, useReducedMotion } from "motion/react";

type Tint = "bright" | "mid" | "faint";

type Ribbon = {
	key: string;
	left: string;
	top: string;
	width: string;
	height: string;
	rotate: number;
	blur: number;
	opacity: number;
	tint: Tint;
	duration: number;
	drift: {
		x: [string, string];
		skewX: [number, number];
		opacity: [number, number];
	};
};

const RIBBONS: Ribbon[] = [
	{
		key: "r1",
		left: "58%",
		top: "-6%",
		width: "220px",
		height: "86%",
		rotate: -8,
		blur: 36,
		opacity: 0.95,
		tint: "bright",
		duration: 26,
		drift: { x: ["-3%", "4%"], skewX: [-4, 3], opacity: [0.9, 1] },
	},
	{
		key: "r2",
		left: "68%",
		top: "-10%",
		width: "180px",
		height: "78%",
		rotate: -4,
		blur: 32,
		opacity: 0.9,
		tint: "bright",
		duration: 32,
		drift: { x: ["2%", "-4%"], skewX: [3, -5], opacity: [0.85, 1] },
	},
	{
		key: "r3",
		left: "76%",
		top: "-4%",
		width: "160px",
		height: "70%",
		rotate: 2,
		blur: 40,
		opacity: 0.7,
		tint: "mid",
		duration: 38,
		drift: { x: ["-2%", "5%"], skewX: [-2, 4], opacity: [0.6, 0.8] },
	},
	{
		key: "r4",
		left: "22%",
		top: "-6%",
		width: "110px",
		height: "70%",
		rotate: -10,
		blur: 44,
		opacity: 0.42,
		tint: "faint",
		duration: 44,
		drift: { x: ["2%", "-3%"], skewX: [2, -3], opacity: [0.35, 0.5] },
	},
	{
		key: "r5",
		left: "34%",
		top: "0%",
		width: "140px",
		height: "65%",
		rotate: -6,
		blur: 48,
		opacity: 0.38,
		tint: "faint",
		duration: 50,
		drift: { x: ["-2%", "4%"], skewX: [-2, 3], opacity: [0.3, 0.45] },
	},
	{
		key: "r6",
		left: "50%",
		top: "28%",
		width: "90px",
		height: "40%",
		rotate: 4,
		blur: 36,
		opacity: 0.4,
		tint: "mid",
		duration: 40,
		drift: { x: ["-1%", "2%"], skewX: [1, -2], opacity: [0.3, 0.45] },
	},
];

const TINT_GRADIENT: Record<Tint, string> = {
	bright:
		"linear-gradient(180deg, transparent 0%, rgba(168, 230, 207, 0.85) 18%, rgba(94, 234, 212, 0.75) 45%, rgba(132, 204, 195, 0.25) 75%, transparent 92%)",
	mid: "linear-gradient(180deg, transparent 0%, rgba(168, 230, 207, 0.6) 20%, rgba(110, 220, 200, 0.45) 50%, transparent 85%)",
	faint:
		"linear-gradient(180deg, transparent 0%, rgba(168, 230, 207, 0.4) 22%, rgba(110, 220, 200, 0.28) 55%, transparent 85%)",
};

const EDGE_MASK =
	"linear-gradient(90deg, transparent 0%, black 30%, black 70%, transparent 100%)";

export function NpxAuroraSky() {
	const prefersReducedMotion = useReducedMotion();

	return (
		<div
			aria-hidden="true"
			className="npx-aurora-root pointer-events-none fixed inset-0 overflow-hidden"
		>
			{RIBBONS.map((r) => (
				<motion.div
					key={r.key}
					className="absolute"
					style={{
						left: r.left,
						top: r.top,
						width: r.width,
						height: r.height,
						background: TINT_GRADIENT[r.tint],
						filter: `blur(${r.blur}px)`,
						opacity: r.opacity,
						transform: `rotate(${r.rotate}deg)`,
						mixBlendMode: "screen",
						maskImage: EDGE_MASK,
						WebkitMaskImage: EDGE_MASK,
						willChange: "transform, opacity",
					}}
					initial={{
						x: r.drift.x[0],
						skewX: r.drift.skewX[0],
						opacity: r.drift.opacity[0],
					}}
					animate={
						prefersReducedMotion
							? {
									x: r.drift.x[0],
									skewX: r.drift.skewX[0],
									opacity: r.drift.opacity[0],
								}
							: {
									x: r.drift.x,
									skewX: r.drift.skewX,
									opacity: r.drift.opacity,
								}
					}
					transition={{
						duration: r.duration,
						repeat: prefersReducedMotion ? 0 : Infinity,
						repeatType: "mirror",
						ease: "easeInOut",
					}}
				/>
			))}
		</div>
	);
}
