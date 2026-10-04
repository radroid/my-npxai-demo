// The database-side collection gate (gate 5: "keep the DB-side searchable
// switch") — opens or closes one collection to match_source_chunks without a
// deploy. This is the per-collection kill switch; KH_SOURCE_CORPUS=legacy is
// the whole-feature one.
//
//   bun run sources:searchable                  # show every collection
//   bun run sources:searchable nrc on           # open NRC
//   bun run sources:searchable nrc off          # close NRC (instant rollback)
//   bun run sources:searchable nrc on --force   # against a non-local URL
//
// Opening a collection also needs it in KH_COLLECTIONS; closing it here is
// enough on its own. The database refuses to open IAEA.

import { isCollectionId } from "../../lib/sources/catalog";
import { checkClients } from "./db";

const argv = process.argv.slice(2);
const [collection, state] = argv.filter((a) => !a.startsWith("--"));

async function main() {
	const { admin, url } = checkClients(argv, { needOpenAI: false });
	if (collection !== undefined) {
		if (!isCollectionId(collection) || (state !== "on" && state !== "off")) {
			console.error(
				"usage: sources:searchable [<collection> on|off] [--force]",
			);
			process.exit(1);
		}
		const { error } = await admin.rpc("set_source_collection_searchable", {
			p_collection: collection,
			p_searchable: state === "on",
		});
		if (error) {
			console.error(`refused: ${error.message}`);
			process.exit(1);
		}
		console.log(
			`${collection} → ${state === "on" ? "searchable" : "closed"} on ${url}`,
		);
	}
	const { data, error } = await admin
		.from("source_collections")
		.select("id,searchable,updated_at")
		.order("id");
	if (error) throw error;
	for (const c of data ?? []) {
		console.log(
			`${String(c.id).padEnd(10)} ${c.searchable ? "searchable" : "closed"}   (updated ${c.updated_at})`,
		);
	}
}

await main();
