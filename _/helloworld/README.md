# Hello, World!

Hello, World! (`_/helloworld`) is a small starter corpus mainly for testing
that Corpus works end to end—adding a corpus, searching locally, and inspecting
results—rather than a dataset for real-world research. It indexes a fixed
selection of well-known website homepages such as Wikipedia, GitHub, MDN Web
Docs, CERN, and Project Gutenberg.

Add it locally with `corpus add helloworld` (or `corpus add _/helloworld`), then
try a quick test query such as `corpus search helloworld -q "wikipedia"` or an
everyday phrase like “open source projects”.
[Install Corpus](https://runcorpus.com/install).

## Coverage

Results return the homepage `url` along with its retained `title` and optional
`description` when provided by the page. Only the selected homepages are
indexed: linked pages are not included, JavaScript-only content may be missing,
and live website content can change after a build.
