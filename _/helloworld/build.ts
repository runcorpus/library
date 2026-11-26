import { parseArgs } from "node:util";
import { SocketClient } from "@corpusd/api";
import * as corpus from "@corpusd/api/corpus";
import { loadDocuments } from "./source";

const tag = "_/helloworld:latest";
const labels = {
  name: "Hello, World!",
  description: "Small starter corpus of selected website homepages, mainly for testing Corpus add and search.",
};

const { values } = parseArgs({
  options: {
    refresh: { type: "boolean", default: false },
    untagged: { type: "boolean", default: false },
  },
});

const documents = await loadDocuments(values.refresh);
const client = new SocketClient();
const initial = await corpus.create(client, { labels });
const { writer } = await corpus.open(client, initial.id);
let inserted = 0;
let sealed: Awaited<ReturnType<typeof corpus.close>>;
try {
  ({ inserted } = await corpus.ingest(client, writer, documents));
} finally {
  sealed = await corpus.close(client, writer);
}

if (inserted !== documents.length || sealed.documents !== documents.length) {
  throw new Error("Could not verify Hello, World! snapshot; latest was not changed.");
}
if (!values.untagged) await corpus.tag(client, sealed.corpus, tag);

console.log(JSON.stringify({ corpus: sealed.corpus, documents: sealed.documents, tag: values.untagged ? null : tag }));
