const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, similarity, pmidOf, parseCitationText } = require('../src/index.js');

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
