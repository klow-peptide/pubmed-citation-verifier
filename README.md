# PubMed Citation Verifier

Checks that each cited **PMID belongs to the cited article**. When it does not, it searches PubMed for the right one.
No dependencies. Node.js 18 or later.

## The problem

A PMID can exist and still point to another paper. Language models often write citations like this:
the number is real, the title is real, but the two do not belong together. A link checker sees HTTP 200 and passes it.

This tool reads the real title of each PMID from the [PubMed E-utilities API](https://www.ncbi.nlm.nih.gov/books/NBK25501/),
compares it with the cited title, and reports every mismatch.

```
$ node bin/pubmed-verify.js examples/citations.json
  1. OK       10027483  Pharmacokinetics of thymosin alpha1 after subcutaneous injection of three differ
  2. MISMATCH 7957536  Pharmacokinetics of thymosin alpha1 after subcutaneous injection of three differ
              PubMed title: Growth hormone-releasing activity of hexarelin in humans. A dose-response study (similarity 0.22)
              Suggested PMID 10027483: Pharmacokinetics of thymosin alpha1 after subcutaneous injection of three differ
  3. OK       23099431  Pharmacokinetic study of Growth Hormone-Releasing Peptide 6 (GHRP-6) in nine mal

2 ok, 1 wrong, 0 without PMID (3 citations)
```

## How it decides

1. **Identity check.** The cited title and the PubMed title are compared (Ratcliff/Obershelp similarity, as in Python `difflib`).
   At 0.55 or more, the citation is `ok`. Below, it is a `mismatch`. A PMID that PubMed does not know is `not_found`.
2. **Suggestion.** For each wrong citation, PubMed is searched by exact title, then keywords and year, then first author.
   A candidate is accepted only when its title matches at 0.8 or more, or at 0.6 or more with most of the title words,
   the same first author, and the same year (within one year) or the same journal.
3. **Precision first.** A false suggestion would publish a wrong citation. A miss only tells you to check by hand.
   So when no candidate is reliable, the tool says so and suggests nothing.

A low similarity can also mean that the PMID is right but the cited title was rewritten or translated.
Read the PubMed title before you change anything.

## Install

```
npm install pubmed-citation-verifier
```

Or run it without installing: `npx -p pubmed-citation-verifier pubmed-verify citations.json`. There are no dependencies.

## Command line

```
pubmed-verify citations.json        # JSON array, or an object with a "sources" array
pubmed-verify citations.csv         # columns: pmid,title[,authors,year,journal]
pubmed-verify --pmid 10027483 --title "Pharmacokinetics of thymosin alpha1 after subcutaneous injection"
```

| Option | Effect |
|---|---|
| `--json` | Machine-readable output |
| `--no-suggest` | Report only, do not search for the right PMID (faster) |

Each citation needs a `title` and a `pmid` (or a `url` on pubmed.ncbi.nlm.nih.gov). `authors`, `year` and `journal`
improve the suggestions. A one-line `text` such as `Author A, et al. (2006). Title. Journal.` is also accepted.

**Exit code:** `0` all citations match, `1` at least one mismatch or unknown PMID, `2` usage error.
So it can block a build or a pull request.

**Rate limit:** PubMed allows 3 requests per second. Set `NCBI_API_KEY` (free, from your NCBI account) to get 10.

## Library

```js
const { createClient } = require('pubmed-citation-verifier');

const client = createClient({ apiKey: process.env.NCBI_API_KEY });
const results = await client.verify([
  { pmid: '7957536', title: 'Pharmacokinetics of thymosin alpha1 after subcutaneous injection', authors: 'Rost KL', year: '1999' }
]);
// [{ status: 'mismatch', pmid: '7957536', similarity: 0.32,
//    pubmed: { title: 'Growth hormone-releasing activity of hexarelin in humans...', ... },
//    suggestion: { pmid: '10027483', title: 'Pharmacokinetics of thymosin alpha1...', similarity: 0.7 } }]
```

## In CI (GitHub Actions)

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- run: npx --yes -p pubmed-citation-verifier pubmed-verify references.json
  env: { NCBI_API_KEY: ${{ secrets.NCBI_API_KEY }} }
```

## Who uses it

[Klow Peptide](https://klow-peptide.com) runs the same check on every article before it is published,
in 12 languages. See also the [Peptide Pharmacokinetics Dataset](https://github.com/klow-peptide/peptide-pharmacokinetics-dataset),
where every value was checked this way.

## Tests

```
npm test    # offline, with a fake PubMed
```

## License

MIT. Maintained by [Klow Peptide](https://klow-peptide.com).
