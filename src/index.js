/**
 * Checks that each cited PMID really belongs to the cited article.
 *
 * A PMID can exist and still point to another paper. A link check (HTTP 200)
 * cannot see that. This module reads the real title of each PMID from the
 * PubMed E-utilities API, compares it with the cited title and, when they
 * differ, searches PubMed for the article the citation describes.
 */
'use strict';

const API = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const OK_RATIO = 0.55;     // cited title vs real title: below this the PMID is wrong
const ACCEPT_RATIO = 0.8;  // a search candidate must match this well on its title alone

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
          year: (x.pubdate || '').slice(0, 4),
          author: x.sortfirstauthor || ''
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

    const venue = j => new Set(norm(j).replace(/\b(the|of|and|journal|in|for)\b/g, ' ').split(' ').filter(w => w.length > 2));
    const citedVenue = venue(c.journal);
    const accept = cand => {
      if (cand.ratio >= ACCEPT_RATIO) return true;
      if (cand.ratio < 0.6) return false;
      const real = new Set(norm(cand.real.title).split(' '));
      const coverage = words.length ? words.filter(w => real.has(w)).length / words.length : 0;
      if (coverage < 0.7) return false;
      const authorOk = byAuthor && norm(cand.real.author).startsWith(norm(firstAuthor));
      const yearOk = year && cand.real.year && Math.abs(year - parseInt(cand.real.year, 10)) <= 1;
      const rv = venue(cand.real.journal);
      const shared = [...citedVenue].filter(w => [...rv].some(r => r.startsWith(w) || w.startsWith(r))).length;
      const venueOk = citedVenue.size > 0 && shared >= Math.max(1, Math.ceil(Math.min(citedVenue.size, rv.size) / 2));
      return authorOk && (yearOk || venueOk);
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
    return best && best.accepted ? { pmid: best.pmid, title: best.real.title, similarity: round(best.ratio) } : null;
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
      const ratio = real ? similarity(it.meta.title, real.title) : 0;
      const status = !real ? 'not_found' : ratio >= OK_RATIO ? 'ok' : 'mismatch';
      const r = { status, pmid: it.pmid, cited_title: it.meta.title || null, similarity: round(ratio), pubmed: real };
      if (status !== 'ok' && suggest) r.suggestion = await locate(it.meta);
      out.push(r);
    }
    return out;
  }

  return { verify, summaries, locate };
}

const round = x => Math.round(x * 100) / 100;

module.exports = { createClient, similarity, pmidOf, parseCitationText, OK_RATIO, ACCEPT_RATIO };
