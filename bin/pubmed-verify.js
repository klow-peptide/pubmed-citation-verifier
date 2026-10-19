#!/usr/bin/env node
// Usage:
//   pubmed-verify citations.json          JSON array, or an object with a "sources" array
//   pubmed-verify citations.csv           columns: pmid,title[,authors,year,journal]
//   pubmed-verify --pmid 10027483 --title "Pharmacokinetics of thymosin alpha1 ..."
// Options: --json (machine output), --no-suggest (do not search for the right PMID)
// Exit code: 0 all citations match, 1 at least one mismatch or unknown PMID, 2 usage error.
// Set NCBI_API_KEY to raise the PubMed rate limit from 3 to 10 requests per second.
'use strict';
const fs = require('fs');
const path = require('path');
const { createClient } = require('../src/index.js');

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : null; };
const has = n => args.includes(n);

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur); rows.push(cells);
  }
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] || '').trim()])));
}

function load() {
  if (opt('--pmid')) return [{ pmid: opt('--pmid'), title: opt('--title') || '' }];
  const file = args.find(a => !a.startsWith('--') && a !== opt('--pmid') && a !== opt('--title'));
  if (!file) return null;
  const text = fs.readFileSync(file, 'utf8');
  if (path.extname(file).toLowerCase() === '.csv') return parseCsv(text);
  const j = JSON.parse(text);
  return Array.isArray(j) ? j : j.sources || j.citations || [];
}

(async () => {
  const citations = load();
  if (!citations) {
    console.error('Usage: pubmed-verify <file.json|file.csv> | --pmid <id> --title "<title>"  [--json] [--no-suggest]');
    process.exit(2);
  }
  const client = createClient({ apiKey: process.env.NCBI_API_KEY });
  const results = await client.verify(citations, { suggest: !has('--no-suggest') });
  const bad = results.filter(r => r.status === 'mismatch' || r.status === 'not_found');

  if (has('--json')) console.log(JSON.stringify(results, null, 2));
  else {
    results.forEach((r, i) => {
      const tag = { ok: 'OK      ', mismatch: 'MISMATCH', not_found: 'NOT FOUND', no_pmid: 'NO PMID ' }[r.status];
      console.log(`${String(i + 1).padStart(3)}. ${tag} ${r.pmid || '-'}  ${String(r.cited_title || '').slice(0, 80)}`);
      if (r.status === 'mismatch') console.log(`              PubMed title: ${r.pubmed.title.slice(0, 90)} (similarity ${r.similarity})`);
      if (r.suggestion) console.log(`              Suggested PMID ${r.suggestion.pmid}: ${r.suggestion.title.slice(0, 80)}`);
      else if (bad.includes(r) && 'suggestion' in r) console.log('              No reliable match found: remove the link or check by hand.');
    });
    const ok = results.filter(r => r.status === 'ok').length;
    console.log(`\n${ok} ok, ${bad.length} wrong, ${results.length - ok - bad.length} without PMID (${results.length} citation${results.length === 1 ? '' : 's'})`);
  }
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(2); });
