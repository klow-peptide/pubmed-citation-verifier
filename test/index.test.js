const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, similarity, pmidOf, parseCitationText, titleWordDiff, compareMeta } = require('../src/index.js');

// Offline fake of the PubMed E-utilities API.
const DB = {
  '10027483': { title: 'Pharmacokinetics of thymosin alpha1 after subcutaneous injection of three different formulations in healthy volunteers.', sortfirstauthor: 'Rost KL', pubdate: '1999 Jan', source: 'Int J Clin Pharmacol Ther' },
  '7957536': { title: 'Growth hormone-releasing activity of hexarelin in humans. A dose-response study.', sortfirstauthor: 'Imbimbo BP', pubdate: '1994', source: 'Eur J Clin Pharmacol' }
};
function fakeFetch(url) {
  const u = new URL(url);
  const ep = u.pathname.split('/').pop();
  let body;
  if (ep === 'esummary.fcgi') {
    const result = {};
    for (const id of u.searchParams.get('id').split(',')) if (DB[id]) result[id] = DB[id];
    body = { result };
  } else {
    const term = u.searchParams.get('term').toLowerCase();
    body = { esearchresult: { idlist: term.includes('thymosin') ? ['10027483'] : [] } };
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
}
const client = () => createClient({ fetch: fakeFetch, pauseMs: 0 });

test('similarity', () => {
  assert.equal(similarity('Same Title.', 'same title'), 1);
  assert.ok(similarity('Pharmacokinetics of thymosin alpha1', 'Growth hormone-releasing activity of hexarelin') < 0.55);
});

test('pmidOf reads the field or the URL', () => {
  assert.equal(pmidOf({ pmid: '123456' }), '123456');
  assert.equal(pmidOf({ url: 'https://pubmed.ncbi.nlm.nih.gov/7957536/' }), '7957536');
  assert.equal(pmidOf({ url: 'https://doi.org/10.1/x' }), null);
});

test('parseCitationText', () => {
  assert.deepEqual(parseCitationText('Rost KL, et al. (1999). Pharmacokinetics of thymosin alpha1. Int J Clin Pharmacol Ther.'),
    { authors: 'Rost KL, et al.', year: '1999', title: 'Pharmacokinetics of thymosin alpha1', journal: 'Int J Clin Pharmacol Ther' });
});

test('verify: ok, mismatch with suggestion, not found, no pmid', async () => {
  const r = await client().verify([
    { pmid: '10027483', title: 'Pharmacokinetics of thymosin alpha1 after subcutaneous injection of three different formulations in healthy volunteers' },
    { pmid: '7957536', title: 'Pharmacokinetics of thymosin alpha1 after subcutaneous injection of three different formulations in healthy volunteers' },
    { pmid: '99999999', title: 'An article that does not exist anywhere' },
    { title: 'A citation without any PubMed identifier' }
  ]);
  assert.deepEqual(r.map(x => x.status), ['ok', 'mismatch', 'not_found', 'no_pmid']);
  assert.equal(r[1].suggestion.pmid, '10027483');
  assert.equal(r[2].suggestion, null);
});

test('verify: suggest can be turned off', async () => {
  const [r] = await client().verify([{ pmid: '7957536', title: 'Pharmacokinetics of thymosin alpha1 in volunteers' }], { suggest: false });
  assert.equal(r.status, 'mismatch');
  assert.equal('suggestion' in r, false);
});

// ---- Near-duplicate titles: distinct papers whose titles differ by one or two words. ----
// Fake records (PMIDs 900000xx do not refer to real papers).
const NEAR = {
  '90000001': { title: 'Pharmacokinetics of semaglutide in healthy Japanese subjects.', sortfirstauthor: 'Tanaka H', pubdate: '2015 Mar', source: 'Clin Pharmacol Drug Dev', fulljournalname: 'Clinical pharmacology in drug development' },
  '90000002': { title: 'Pharmacokinetics of semaglutide in healthy Chinese subjects.', sortfirstauthor: 'Li X', pubdate: '2019 Jun', source: 'Clin Ther', fulljournalname: 'Clinical therapeutics' },
  '90000003': { title: 'Efficacy of liraglutide in type 2 diabetes: a randomized trial.', sortfirstauthor: 'Moreau P', pubdate: '2012', source: 'Diabetes Care', fulljournalname: 'Diabetes care' },
  '90000004': { title: 'Half-life of BPC 157 in rats after intramuscular injection.', sortfirstauthor: 'Novak M', pubdate: '2021', source: 'Peptides', fulljournalname: 'Peptides' }
};
function nearFetch(url) {
  const u = new URL(url);
  const ep = u.pathname.split('/').pop();
  let body;
  if (ep === 'esummary.fcgi') {
    const result = {};
    for (const id of u.searchParams.get('id').split(',')) if (NEAR[id]) result[id] = NEAR[id];
    body = { result };
  } else {
    const term = u.searchParams.get('term').toLowerCase();
    // The search engine returns the near-duplicate for any semaglutide query.
    body = { esearchresult: { idlist: term.includes('semaglutide') ? ['90000001'] : [] } };
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
}
const nearClient = () => createClient({ fetch: nearFetch, pauseMs: 0 });

test('near-duplicate titles score above the old 0.55 threshold', () => {
  // This is why title similarity alone cannot decide.
  assert.ok(similarity(NEAR['90000001'].title, NEAR['90000002'].title) > 0.9);
  assert.deepEqual(titleWordDiff(NEAR['90000001'].title, NEAR['90000002'].title).sort(), ['chinese', 'japanese']);
});

test('near-duplicate: different population, no metadata -> review, never ok', async () => {
  const [r] = await nearClient().verify([{ pmid: '90000001', title: 'Pharmacokinetics of semaglutide in healthy Chinese subjects' }]);
  assert.equal(r.status, 'review');
  assert.deepEqual(r.checks.title_words_differ.sort(), ['chinese', 'japanese']);
  assert.equal('suggestion' in r, false);
});

test('near-duplicate: different population and different first author -> mismatch', async () => {
  const [r] = await nearClient().verify([{ pmid: '90000001', title: 'Pharmacokinetics of semaglutide in healthy Chinese subjects', authors: 'Li X', year: '2019' }]);
  assert.equal(r.status, 'mismatch');
  assert.equal(r.checks.author, 'conflict');
  assert.equal(r.checks.year, 'conflict');
});

test('near-duplicate: the search does not suggest the other paper', async () => {
  // Cited PMID is wrong, and PubMed search only returns the Japanese study: no suggestion.
  const [r] = await nearClient().verify([{ pmid: '90000003', title: 'Pharmacokinetics of semaglutide in healthy Chinese subjects', authors: 'Li X', year: '2019', journal: 'Clin Ther' }]);
  assert.equal(r.status, 'mismatch');
  assert.equal(r.suggestion, null);
});

test('near-duplicate: type 1 vs type 2 diabetes is not ok', async () => {
  const [r] = await nearClient().verify([{ pmid: '90000003', title: 'Efficacy of liraglutide in type 1 diabetes: a randomized trial', authors: 'Moreau P', year: '2012' }]);
  assert.equal(r.status, 'review');
  assert.deepEqual(r.checks.title_words_differ.sort(), ['1', '2']);
});

test('near-duplicate: rats vs mice is not ok', async () => {
  const [r] = await nearClient().verify([{ pmid: '90000004', title: 'Half-life of BPC 157 in mice after intramuscular injection' }]);
  assert.notEqual(r.status, 'ok');
});

test('same title, matching author, year and journal -> ok', async () => {
  const [r] = await nearClient().verify([{ pmid: '90000002', title: 'PHARMACOKINETICS of semaglutide in healthy Chinese subjects', authors: 'Li X, Wang Y, et al.', year: '2019', journal: 'Clin Ther' }]);
  assert.equal(r.status, 'ok');
  assert.deepEqual([r.checks.author, r.checks.year, r.checks.journal], ['match', 'match', 'match']);
});

test('same title but a conflicting year -> review', async () => {
  const [r] = await nearClient().verify([{ pmid: '90000002', title: 'Pharmacokinetics of semaglutide in healthy Chinese subjects', year: '2009' }]);
  assert.equal(r.status, 'review');
  assert.ok(r.reasons.includes('year differs'));
});

test('same title, year off by one (e-pub vs print) -> ok', async () => {
  const [r] = await nearClient().verify([{ pmid: '90000002', title: 'Pharmacokinetics of semaglutide in healthy Chinese subjects', year: '2018' }]);
  assert.equal(r.status, 'ok');
});

test('author formats: "Surname AB", "A. B. Surname", accents', () => {
  const real = { title: 't', author: 'Muller J', year: '2020' };
  assert.equal(compareMeta({ authors: 'Müller J, et al.' }, real).author, 'match');
  assert.equal(compareMeta({ authors: 'J. Muller' }, real).author, 'match');
  assert.equal(compareMeta({ authors: 'Schmidt K' }, real).author, 'conflict');
  assert.equal(compareMeta({}, real).author, 'unknown');
});
