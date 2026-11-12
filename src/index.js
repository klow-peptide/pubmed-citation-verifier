/**
 * Checks that each cited PMID really belongs to the cited article.
 *
 * A PMID can exist and still point to another paper. A link check (HTTP 200)
 * cannot see that. This module reads the real title of each PMID from the
 * PubMed E-utilities API, compares it with the cited title and, when they
 * differ, searches PubMed for the article the citation describes.
 *
 * A title match alone is not proof: two distinct papers can have almost the
 * same title ("... in Japanese subjects" / "... in Chinese subjects"). So a
 * citation is `ok` only when the titles have the same content words and no
 * cited first author, year or journal contradicts PubMed. Anything in between
 * is `review`: a person must read both records. Results are an aid to manual
 * review, not a replacement for it.
 */
'use strict';

const API = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const OK_RATIO = 0.55;     // cited title vs real title: below this the PMID is wrong (mismatch)
const STRICT_RATIO = 0.9;  // at or above this, with the same content words, the titles are the same
const ACCEPT_RATIO = 0.8;  // a search candidate needs this, plus the checks in accept()

// Words that do not tell two papers apart. Everything else (numbers, species, populations,
// drug names, "type 1"/"type 2") must be identical for an `ok`.
const STOP = new Set('a an the of in on and or for with without to by at from after before as vs versus into its their is are was were be study trial'.split(' '));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const yearOf = s => { const m = String(s || '').match(/(19|20)\d{2}/); return m ? parseInt(m[0], 10) : null; };

/** Ratcliff/Obershelp similarity of two titles, 0..1 (same measure as Python difflib). */
function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  const longest = (lo1, hi1, lo2, hi2) => {
    let best = [lo1, lo2, 0];
    for (let i = lo1; i < hi1; i++) {
      for (let j = lo2; j < hi2; j++) {
        let k = 0;
        while (i + k < hi1 && j + k < hi2 && a[i + k] === b[j + k]) k++;
        if (k > best[2]) best = [i, j, k];
      }
    }
    return best;
  };
  const rec = (lo1, hi1, lo2, hi2) => {
    const [i, j, k] = longest(lo1, hi1, lo2, hi2);
    return k ? k + rec(lo1, i, lo2, j) + rec(i + k, hi1, j + k, hi2) : 0;
  };
  return (2 * rec(0, a.length, 0, b.length)) / (a.length + b.length);
}

const stem = w => (w.length > 4 && w.endsWith('s') && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);
const contentWords = t => new Set(norm(t).split(' ').filter(w => w && !STOP.has(w)).map(stem));

/** Content words found in one title but not the other, e.g. ['japanese', 'chinese']. */
function titleWordDiff(a, b) {
  const A = contentWords(a), B = contentWords(b);
  return [...[...A].filter(w => !B.has(w)), ...[...B].filter(w => !A.has(w))];
}

const nameNorm = s => norm(String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
const firstAuthorTokens = s => nameNorm(String(s || '').split(/[,;]/)[0].replace(/\bet al\b\.?/i, '')).split(' ').filter(w => w.length > 1);
const venueWords = j => new Set(norm(j).replace(/\b(the|of|and|journal|in|for)\b/g, ' ').split(' ').filter(w => w.length > 2));

/**
 * Compares the cited metadata with the PubMed record. Each field is 'match', 'conflict'
 * or 'unknown' (not cited, or not in PubMed).
 */
function compareMeta(cited, real) {
  const out = {};
  // PubMed gives "Surname AB"; a citation may give "Surname AB", "A. B. Surname" or "Surname, A.".
  const ca = firstAuthorTokens(cited.authors), ra = nameNorm(real.author).split(' ')[0] || '';
  out.author = !ca.length || !ra ? 'unknown' : (ca.includes(ra) ? 'match' : 'conflict');
  const cy = yearOf(cited.year), ry = (real.years || [yearOf(real.year)]).filter(Boolean);
  // One year of tolerance: e-publication and print years often differ.
  out.year = !cy || !ry.length ? 'unknown' : (ry.some(y => Math.abs(y - cy) <= 1) ? 'match' : 'conflict');
  const cv = venueWords(cited.journal);
  const rv = new Set([...venueWords(real.journal), ...venueWords(real.journalAbbr)]);
  if (!cv.size || !rv.size) out.journal = 'unknown';
  else {
    const shared = [...cv].filter(w => [...rv].some(r => r.startsWith(w) || w.startsWith(r))).length;
    out.journal = shared >= Math.max(1, Math.ceil(cv.size / 2)) ? 'match' : 'conflict';
  }
  return out;
}

/**
 * Decides the status of a cited PMID from the title similarity, the content-word
 * difference and the metadata checks.
 *   ok       same content words, similarity >= 0.9, no conflicting author/year/journal
 *   mismatch similarity < 0.55; or a conflicting field with different title words; or 2+ conflicts
 *   review   everything else: probably the same paper, but a person must check
 */
function judge(citedTitle, real, cited) {
  const ratio = similarity(citedTitle, real.title);
  const diff = titleWordDiff(citedTitle, real.title);
  const meta = compareMeta(cited, real);
  const conflicts = Object.keys(meta).filter(k => meta[k] === 'conflict');
  const reasons = [];
  if (ratio < STRICT_RATIO) reasons.push(`title similarity ${round(ratio)} < ${STRICT_RATIO}`);
  if (diff.length && ratio >= OK_RATIO) reasons.push(`title words differ: ${diff.slice(0, 6).join(', ')}`);
  for (const k of conflicts) reasons.push(`${k} differs`);
  let status;
  if (ratio < OK_RATIO || conflicts.length >= 2 || (conflicts.length && diff.length)) status = 'mismatch';
  else if (ratio >= STRICT_RATIO && !diff.length && !conflicts.length) status = 'ok';
  else status = 'review';
  return { status, ratio, checks: { title_similarity: round(ratio), title_words_differ: diff, ...meta }, reasons };
}

/** Reads a PMID from a citation: `pmid` field, or a pubmed.ncbi.nlm.nih.gov URL. */
function pmidOf(c) {
  if (c.pmid && /^\d{1,9}$/.test(String(c.pmid))) return String(c.pmid);
  const m = String(c.url || '').match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/);
  return m ? m[1] : null;
}

/** "Author A, et al. (2006). Title. Journal." -> { authors, year, title, journal } */
function parseCitationText(text) {
  const m = String(text || '').match(/^(.*?)\s*\((\d{4})\)\.?\s*(.*?)(?:\.\s+([^.]{3,80})\.?)?\s*$/);
  if (!m) return { title: String(text || '') };
  return { authors: m[1], year: m[2], title: m[3], journal: m[4] || '' };
}

function createClient(opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const key = opts.apiKey || '';
  const pause = opts.pauseMs != null ? opts.pauseMs : (key ? 120 : 400); // NCBI: 3 req/s, 10 with a key
  const cache = new Map();

  async function api(endpoint, params) {
    const q = new URLSearchParams({ db: 'pubmed', retmode: 'json', ...params });
    if (key) q.set('api_key', key);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetchFn(`${API}/${endpoint}.fcgi?${q}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (pause) await sleep(pause);
        return j;
      } catch (e) {
        if (attempt === 4) throw new Error(`PubMed ${endpoint} failed: ${e.message}`);
        await sleep(pause ? 1500 * (attempt + 1) : 0);
      }
    }
  }

  async function summaries(ids) {
    const todo = [...new Set(ids)].filter(i => !cache.has(i));
    for (let i = 0; i < todo.length; i += 50) {
      const chunk = todo.slice(i, i + 50);
      const r = ((await api('esummary', { id: chunk.join(',') })) || {}).result || {};
      for (const id of chunk) {
        const x = r[id];
        cache.set(id, x && x.title ? {
          pmid: id,
          title: x.title.replace(/\.$/, ''),
          journal: x.fulljournalname || x.source || '',
          journalAbbr: x.source || '',
          year: (x.pubdate || '').slice(0, 4),
          years: [yearOf(x.pubdate), yearOf(x.epubdate)].filter(Boolean),
          author: x.sortfirstauthor || ((x.authors || [])[0] || {}).name || ''
        } : null);
      }
    }
    return ids.map(i => cache.get(i));
  }

  async function search(term) {
    const j = await api('esearch', { term, retmax: 8 });
    return (j && j.esearchresult && j.esearchresult.idlist) || [];
  }

  // Finds the article a citation describes. Precision first: a false match
  // publishes a wrong citation, a miss only leaves the citation unverified.
  async function locate(c) {
    const title = String(c.title || '').trim();
    if (norm(title).length < 15) return null;
    const year = yearOf(c.year);
    const firstAuthor = String(c.authors || '').split(/[,;]/)[0].replace(/[^A-Za-zÀ-ɏ' -]/g, '').trim().split(' ')[0];
    const words = norm(title).split(' ').filter(w => w.length > 3);
    const keywords = words.slice(0, 12).join(' ');
    const byAuthor = firstAuthor && firstAuthor.length > 2;
    const queries = [
      `"${title.replace(/[[\]"]/g, ' ').slice(0, 250)}"[Title]`,
      keywords + (year ? ` AND ${year}[DP]` : ''),
      keywords,
      byAuthor ? `${firstAuthor}[Author] AND ${words.slice(0, 5).join(' ')}` + (year ? ` AND ${year - 1}:${year + 1}[DP]` : '') : null
    ].filter(Boolean);

    // A candidate is accepted when it would itself be judged `ok`, or when its title is close
    // (>= 0.8, same content words) and the cited first author plus the year or journal match.
    // A candidate whose title words differ (e.g. another population) is never accepted.
    const accept = cand => {
      const j = judge(title, cand.real, c);
      cand.checks = j.checks;
      if (j.status === 'ok') return true;
      if (j.status === 'mismatch' || cand.ratio < ACCEPT_RATIO || j.checks.title_words_differ.length) return false;
      return j.checks.author === 'match' && (j.checks.year === 'match' || j.checks.journal === 'match');
    };

    let best = null;
    for (const q of queries) {
      const ids = await search(q);
      if (!ids.length) continue;
      const reals = await summaries(ids);
      ids.forEach((id, k) => {
        if (!reals[k]) return;
        const cand = { pmid: id, ratio: similarity(title, reals[k].title), real: reals[k] };
        cand.accepted = accept(cand);
        if (!best || (cand.accepted && !best.accepted) || (cand.accepted === best.accepted && cand.ratio > best.ratio)) best = cand;
      });
      if (best && best.accepted && best.ratio >= ACCEPT_RATIO) break;
    }
    return best && best.accepted
      ? { pmid: best.pmid, title: best.real.title, similarity: round(best.ratio), checks: best.checks, needs_review: true }
      : null;
  }

  /**
   * @param {Array<{pmid?, url?, title?, text?, authors?, year?, journal?}>} citations
   * @param {{suggest?: boolean}} [o] suggest: search PubMed for the right PMID (default true)
   * @returns {Promise<Array>} one result per citation, same order
   */
  async function verify(citations, o = {}) {
    const suggest = o.suggest !== false;
    const items = citations.map(c => {
      const meta = c.title ? c : { ...c, ...parseCitationText(c.text) };
      return { input: c, meta, pmid: pmidOf(c) };
    });
    await summaries(items.filter(i => i.pmid).map(i => i.pmid));
    const out = [];
    for (const it of items) {
      if (!it.pmid) { out.push({ status: 'no_pmid', title: it.meta.title || null }); continue; }
      const real = cache.get(it.pmid);
      if (!real) {
        const r = { status: 'not_found', pmid: it.pmid, cited_title: it.meta.title || null, similarity: 0, pubmed: null };
        if (suggest) r.suggestion = await locate(it.meta);
        out.push(r);
        continue;
      }
      const j = judge(it.meta.title, real, it.meta);
      const r = {
        status: j.status, pmid: it.pmid, cited_title: it.meta.title || null, similarity: round(j.ratio),
        checks: j.checks, reasons: j.reasons, pubmed: real
      };
      if (j.status === 'mismatch' && suggest) r.suggestion = await locate(it.meta);
      out.push(r);
    }
    return out;
  }

  return { verify, summaries, locate };
}

const round = x => Math.round(x * 100) / 100;

module.exports = {
  createClient, similarity, pmidOf, parseCitationText, titleWordDiff, compareMeta, judge,
  OK_RATIO, STRICT_RATIO, ACCEPT_RATIO
};
