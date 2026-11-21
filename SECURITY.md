# Security and privacy

This package talks to the network only to query the [NCBI E-utilities API](https://www.ncbi.nlm.nih.gov/books/NBK25501/) at `https://eutils.ncbi.nlm.nih.gov/entrez/eutils`. It uses `esummary` (to read the PubMed record of a PMID) and, when suggestions are enabled, `esearch` (to search PubMed). Those requests include the PMIDs, titles, and any author or year used to build the search terms.

If you set `NCBI_API_KEY` or pass `apiKey` to `createClient()`, that key is sent to NCBI as the `api_key` query parameter so the rate limit can be raised. It is not sent anywhere else.

There is no telemetry, no analytics, and no other network destination. The library does not store results. You can pass a custom `fetch` function to `createClient()` if you need to inspect or proxy the requests.

Results are an aid to manual review, not a substitute for opening the PubMed record.
