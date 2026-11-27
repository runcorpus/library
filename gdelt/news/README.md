# GDELT News

GDELT News (`gdelt/news`) is a rolling English-language news corpus built from
[GDELT 2.0](https://www.gdeltproject.org/) Global Knowledge Graph (GKG) 15-minute
updates across worldwide web publishers.

## What you can do

- **Search global news coverage by headline, person, organization, place, or theme.**
  Query in everyday language—for example, "semiconductor export controls",
  "ECB president", "Bangkok refinery", or "Rheinmetall"—using extracted people,
  organizations, locations, and themes alongside article titles.
- **Route to original publisher articles.** Each match returns its canonical
  article `url` along with retained metadata (`title`, `date`, `source`, and
  optional `authors`).
- **Use the rolling 24-hour snapshot.** Run `corpus add gdelt/news` for
  `latest` (which aliases `today`, covering the trailing 24 hours).
  [Install Corpus](https://runcorpus.com/install).

## Attribution and coverage

Article metadata, entity extractions, locations, and themes originate from
[The GDELT Project](https://www.gdeltproject.org/). Full publisher article
bodies and extracted quotations are not stored; open `url` to read the article
at its source.
