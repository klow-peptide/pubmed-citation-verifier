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
              Why: title similarity 0.22 < 0.9; author differs; year differs
              Suggested PMID 10027483 (check by hand): Pharmacokinetics of thymosin alpha1 after subcutaneous injection of three differ
  3. OK       23099431  Pharmacokinetic study of Growth Hormone-Releasing Peptide 6 (GHRP-6) in nine mal

2 ok, 0 to review, 1 wrong, 0 without PMID (3 citations)
```

## How it decides

1. **Title similarity.** The cited title and the PubMed title are compared (Ratcliff/Obershelp similarity, as in Python `difflib`).
2. **Title words.** The content words of both titles are compared (small words such as "of", "in", "the" are ignored).
   Two distinct papers often have almost the same title: "... in healthy *Japanese* subjects" and "... in healthy *Chinese* subjects"
   score above 0.9. So any differing word (a population, a species, a number such as "type 1" / "type 2") prevents an `ok`.
3. **Metadata.** When the citation gives them, the **first author**, the **year** (one year of tolerance for e-publication
   versus print) and the **journal** are compared with the PubMed record.
4. **Status.**

| Status | Rule |
|---|---|
| `ok` | Similarity 0.9 or more, the same title words, and no cited author, year or journal contradicts PubMed |
| `review` | Probably the same paper, but not proven: similarity 0.55 to 0.9, or a differing title word, or one conflicting field |
| `mismatch` | Similarity below 0.55, or a differing title word plus a conflicting field, or two conflicting fields |
| `not_found` | PubMed does not know the PMID |
| `no_pmid` | The citation has no PMID |

Each result lists its `checks` (`title_similarity`, `title_words_differ`, `author`, `year`, `journal`: `match`, `conflict` or `unknown`)
and the `reasons` behind a `review` or a `mismatch`.

5. **Suggestion.** For a `mismatch` or `not_found`, PubMed is searched by exact title, then keywords and year, then first author.
   A candidate is suggested only when it would be judged `ok` itself, or when its title matches at 0.8 or more with the same title words
   and the same first author plus the same year or journal. A candidate whose title words differ is never suggested.
   Every suggestion is marked `needs_review: true`.
6. **Precision first.** A false suggestion would publish a wrong citation. A miss only tells you to check by hand.
   So when no candidate is reliable, the tool says so and suggests nothing.

Give `authors`, `year` and `journal` whenever you can: without them only the title can be checked, and more citations end in `review`.

## Limits: results need a manual review

This tool **helps** a manual review. It does not replace it.

- `ok` means the cited title and metadata agree with the PubMed record of that PMID. It does not mean the article supports the claim it is cited for.
- Two distinct papers can share the same title, first author and year (for example a conference abstract and the full paper,
  or an erratum). The tool cannot tell them apart.
- A `review` or `mismatch` can come from a correct PMID with a rewritten, shortened or translated title.
- Only PubMed is checked. Articles that PubMed does not index cannot be verified.
- Read the PubMed record before you change, keep or remove a citation.

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
| `--allow-review` | Exit `0` even when some citations need a manual review (`mismatch` and `not_found` still fail) |

Each citation needs a `title` and a `pmid` (or a `url` on pubmed.ncbi.nlm.nih.gov). `authors`, `year` and `journal`
improve the suggestions. A one-line `text` such as `Author A, et al. (2006). Title. Journal.` is also accepted.

**Exit code:** `0` all citations `ok`, `1` at least one `mismatch`, `not_found` or (without `--allow-review`) `review`, `2` usage error.
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
//    checks: { title_similarity: 0.32, title_words_differ: [...], author: 'conflict', year: 'conflict', journal: 'unknown' },
//    reasons: ['title similarity 0.32 < 0.9', 'author differs', 'year differs'],
//    pubmed: { title: 'Growth hormone-releasing activity of hexarelin in humans...', ... },
//    suggestion: { pmid: '10027483', title: 'Pharmacokinetics of thymosin alpha1...', similarity: 0.7, needs_review: true, ... } }]
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

The tests include near-duplicate titles (another population, another species, type 1 versus type 2) that must never be `ok`.

## Changelog

- **2.0.0**: stricter identity check. `ok` now needs similarity 0.9 or more, the same title words, and no conflicting
  first author, year or journal. New status `review`, new `checks` and `reasons` fields, `--allow-review` option.
  Suggestions are never made for a candidate whose title words differ. Breaking: citations that were `ok` in 1.x may now be `review`.
- **1.0.1**: first public release.

## License

MIT. Maintained by [Klow Peptide](https://klow-peptide.com).
