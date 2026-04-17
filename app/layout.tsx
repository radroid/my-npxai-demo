import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Footer } from "@/components/site/Footer";
import { TopNav } from "@/components/site/TopNav";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const inter = Inter({
	variable: "--font-sans",
	subsets: ["latin"],
	display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
	variable: "--font-mono",
	subsets: ["latin"],
	display: "swap",
});

export const metadata: Metadata = {
	title: "NPXai Demo — CNSC Regulatory Knowledge Hub",
	description:
		"A demo app built for NPX Innovation: RAG-powered CNSC REGDOC Knowledge Hub and CANDU shift turnover generator.",
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en" className="dark">
			<body
				className={`${inter.variable} ${jetbrainsMono.variable} antialiased`}
			>
				<TooltipProvider>
					<div className="flex min-h-screen flex-col">
						<TopNav />
						<main className="flex-1">{children}</main>
						<Footer />
					</div>
				</TooltipProvider>
			</body>
		</html>
	);
}
