# CorpusQA (helloworld)

`suite.yaml` retains the original ten task-to-website questions, reference
answers, and approved homepage URLs in their original order.

The questions distinguish MDN from WHATWG, IETF from RFC Editor, MIT
OpenCourseWare from OpenStax, IEA from EIA, and Wikidata from DBpedia.
Evaluate against an explicitly selected immutable snapshot with a compatible
CorpusQA runner. Record the snapshot and model configuration with results;
these cases alone do not establish a score. Homepage captures are cached locally
and are not frozen evaluation inputs.
