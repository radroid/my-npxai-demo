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

const SITE_URL = "https://npx.curlycloud.dev";
const SITE_TITLE = "NPXai Demo — CNSC Regulatory Knowledge Hub";
const SITE_DESCRIPTION =
	"A working demo for NPX Innovation: retrieval-augmented Q&A over 19 CNSC REGDOCs with inline citations, plus a CANDU shift turnover generator over simulated Bruce Power data.";

export const metadata: Metadata = {
	metadataBase: new URL(SITE_URL),
	title: {
		default: SITE_TITLE,
		template: "%s — NPXai Demo",
	},
	description: SITE_DESCRIPTION,
	applicationName: "NPXai Demo",
	authors: [
		{ name: "Raj Dholakia", url: "https://www.linkedin.com/in/rajdholakia" },
	],
	keywords: [
		"NPX Innovation",
		"CNSC",
		"REGDOC",
		"CANDU",
		"nuclear regulatory",
		"RAG",
		"shift turnover",
		"Bruce Power",
	],
	openGraph: {
		type: "website",
		url: SITE_URL,
		title: SITE_TITLE,
		description: SITE_DESCRIPTION,
		siteName: "NPXai Demo",
		locale: "en_CA",
	},
	twitter: {
		card: "summary_large_image",
		title: SITE_TITLE,
		description: SITE_DESCRIPTION,
	},
	robots: {
		index: true,
		follow: true,
	},
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
						<div className="flex-1">{children}</div>
						<Footer />
					</div>
				</TooltipProvider>
			</body>
		</html>
	);
}
