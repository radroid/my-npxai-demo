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
			<Image
				src="/avatar-raj.webp"
				alt=""
				fill
				sizes="32px"
				className="object-cover transition-opacity duration-200 ease-out group-hover/brand-mark:opacity-0"
			/>
			<Image
				src="/logo-npxai-light.svg"
				alt=""
				fill
				sizes="32px"
				className="object-contain opacity-0 transition-opacity duration-200 ease-out group-hover/brand-mark:opacity-100 dark:hidden"
			/>
			<Image
				src="/logo-npxai-dark.svg"
				alt=""
				fill
				sizes="32px"
				className="hidden object-contain opacity-0 transition-opacity duration-200 ease-out group-hover/brand-mark:opacity-100 dark:block"
			/>
		</span>
	);
}
