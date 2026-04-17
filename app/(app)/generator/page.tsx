import { GeneratorForm } from "@/components/generator/GeneratorForm";

export const metadata = {
	title: "Shift Turnover Generator — NPX Innovation Demo",
	description:
		"CANDU shift turnover reports per CNSC REGDOC-2.3.4, generated from simulated Bruce Power plant data.",
};

export default function GeneratorPage() {
	return <GeneratorForm />;
}
