import Image from "next/image";
import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"group/brand-mark relative inline-block shrink-0 overflow-hidden rounded-md",
				className,
			)}
		>
			{/* Base: Raj avatar. In light/dark it fades out on hover; in NPX
			   theme it stays hidden so the brand logo is the permanent mark. */}
			<Image
				src="/avatar-raj.webp"
				alt=""
				fill
				sizes="32px"
				className="object-cover transition-opacity duration-200 ease-out group-hover/brand-mark:opacity-0 npx:opacity-0"
			/>
			{/* Light-bg variant (dark-filled glyph) — hover-reveal in light
			   mode only; hidden in dark and NPX (both dark surfaces). */}
			<Image
				src="/logo-npxai-light.svg"
				alt=""
				fill
				sizes="32px"
				className="object-contain opacity-0 transition-opacity duration-200 ease-out group-hover/brand-mark:opacity-100 dark:hidden npx:hidden"
			/>
			{/* Dark-bg variant (white glyph) — hover-reveal in dark mode, and
			   pinned visible in NPX theme so the logo is the permanent mark. */}
			<Image
				src="/logo-npxai-dark.svg"
				alt=""
				fill
				sizes="32px"
				className="hidden object-contain opacity-0 transition-opacity duration-200 ease-out group-hover/brand-mark:opacity-100 dark:block npx:block npx:opacity-100"
			/>
		</span>
	);
}
