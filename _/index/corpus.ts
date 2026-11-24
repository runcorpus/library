import { SocketClient } from "@corpusd/api";
import * as corpus from "@corpusd/api/corpus";
import { loadCatalog } from "./registry";

const labels = {
  name: "Corpus Index",
  description: "Find a published corpus by name or topic so you can add it and search it locally.",
};

const documents = await loadCatalog();
const client = new SocketClient();
const initial = await corpus.create(client, { labels });
const { writer } = await corpus.open(client, initial.id);
console.error(`Opened writer ${writer} for ${documents.length} catalog entries`);
let sealed;
try {
  await corpus.ingest(client, writer, documents);
} finally {
  sealed = await corpus.close(client, writer);
}

console.log(JSON.stringify(sealed));
