// Checks a deck's factual claims against Wikipedia and reports what is backed
// by a source, what a source contradicts, and what could not be found.
//
// Scope is deliberately narrow and the UI says so: this checks claims about the
// world against an encyclopedia. It cannot confirm your own metrics, your
// plans, or anything published in the last few days, and "not found" means
// exactly that — not "false".
//
// Wikipedia is used because it needs no API key. The pipeline is: one model
// call to pull out checkable claims, one lookup each, then one model call to
// judge them all together (cheaper and more consistent than judging one by one).

export const config = { runtime: 'edge' };

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const WIKI = 'https://en.wikipedia.org/w/api.php';
const UA = 'Swell/1.0 (https://omicron-beta.vercel.app; deck drafting demo)';
const MAX_CLAIMS = 6;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deckToText(slides) {
  return slides
    .map((s, i) => {
      if (i === 0 || s.type === 'cover') return `1. COVER: ${s.title || ''}`;
      const lines = [`${i + 1}. ${s.heading || ''}`];
      if (s.body) lines.push(`   ${s.body}`);
      (s.bullets || []).forEach((b) => lines.push(`   - ${b}`));
      return lines.join('\n');
    })
    .join('\n');
}

async function askModel(prompt, maxTokens) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: maxTokens,
      reasoning_effort: 'low',
    }),
  });
  if (res.status === 429) throw { code: 'rate_limited' };
  if (!res.ok) throw { code: 'upstream_error' };
  const data = await res.json();
  const content =
    data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
  if (!content) throw { code: 'empty_completion' };
  return content;
}

// Blocks of KEY: value lines, normally separated by ===. The separator is not
// always emitted, so `startKey` also opens a new block: without that, a run of
// items collapses into one and every verdict but the last is lost.
function parseBlocks(text, startKey) {
  const blocks = [];
  let current = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line === '===') { current = null; continue; }
    const match = line.match(/^([A-Z]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (!current || (startKey && key === startKey)) {
      current = {};
      blocks.push(current);
    }
    current[key.toLowerCase()] = match[2].trim();
  }
  return blocks;
}

// Full-text search alone lands on odd pages — a claim about the Great Barrier
// Reef came back matched against the Mesoamerican one — so the exact article
// title is tried first and search is the fallback.
async function findTitle(query) {
  const exactUrl =
    `${WIKI}?action=query&redirects=1&titles=${encodeURIComponent(query)}&format=json&origin=*`;
  try {
    const res = await fetch(exactUrl, { headers: { 'User-Agent': UA } });
    if (res.ok) {
      const data = await res.json();
      const pages = data && data.query && data.query.pages;
      const page = pages ? Object.values(pages)[0] : null;
      if (page && page.pageid && !page.missing) return page.title;
    }
  } catch (e) { /* fall through to search */ }

  const searchUrl =
    `${WIKI}?action=query&list=search&srsearch=${encodeURIComponent(query)}` +
    '&srlimit=1&format=json&origin=*';
  const searchRes = await fetch(searchUrl, { headers: { 'User-Agent': UA } });
  if (!searchRes.ok) return null;
  const searchData = await searchRes.json();
  const hit = searchData && searchData.query && searchData.query.search && searchData.query.search[0];
  return hit ? hit.title : null;
}

async function lookup(query) {
  const title = await findTitle(query);
  if (!title) return null;

  // more than the intro: the deciding sentence is often further down
  const extractUrl =
    `${WIKI}?action=query&prop=extracts&explaintext=1&exchars=4000` +
    `&titles=${encodeURIComponent(title)}&format=json&origin=*`;
  const extractRes = await fetch(extractUrl, { headers: { 'User-Agent': UA } });
  if (!extractRes.ok) return null;
  const extractData = await extractRes.json();
  const pages = extractData && extractData.query && extractData.query.pages;
  const page = pages ? Object.values(pages)[0] : null;
  if (!page || !page.extract) return null;

  return {
    title: title,
    url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')),
    extract: String(page.extract).slice(0, 4000),
  };
}

export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ error: 'invalid_request', message: 'Use POST.' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'invalid_request', message: 'Body must be JSON.' }, 400);
  }

  const slides = Array.isArray(body.slides) ? body.slides.slice(0, 14) : [];
  if (slides.length < 2) return json({ error: 'invalid_request', message: 'Need a deck.' }, 400);
  if (!process.env.GROQ_API_KEY) {
    return json({ error: 'upstream_error', message: 'GROQ_API_KEY is not configured.' }, 500);
  }

  // 1. what in this deck can be checked against an encyclopedia at all
  let claimText;
  try {
    claimText = await askModel(
      `${deckToText(slides)}

List the statements above that could be checked against a public encyclopedia:
facts about the world, science, history, geography, well-known organisations or
public figures.

Ignore everything that cannot be checked that way — the writer's own metrics and
results, internal plans, recommendations, opinions, and predictions about the
future. It is fine to return fewer than ${MAX_CLAIMS}.

Output up to ${MAX_CLAIMS} items, exactly these lines each, and nothing else:

SLIDE: <slide number the claim is on>
CLAIM: <the claim, closely paraphrased, under 25 words>
QUERY: <the proper name of the thing the claim is about, if it has one
       (e.g. "Great Barrier Reef", not "largest reef system"), else 2 to 5 words>
===

If nothing in the deck can be checked this way, output the single word NONE.`,
      900
    );
  } catch (e) {
    return json({ error: e.code || 'upstream_error' }, e.code === 'rate_limited' ? 429 : 502);
  }

  if (/^\s*NONE\s*$/i.test(claimText)) return json({ claims: [] }, 200);

  const claims = parseBlocks(claimText, 'SLIDE')
    .filter((c) => c.claim && c.query)
    .slice(0, MAX_CLAIMS);
  if (!claims.length) return json({ claims: [] }, 200);

  // 2. one encyclopedia lookup per claim
  const sources = await Promise.all(
    claims.map((c) => lookup(c.query).catch(() => null))
  );

  const results = claims.map((c, i) => ({
    slide: Math.max(0, parseInt(c.slide, 10) || 0),
    claim: c.claim,
    status: sources[i] ? 'unclear' : 'not-found',
    source: sources[i] ? { title: sources[i].title, url: sources[i].url } : null,
    quote: '',
  }));

  const withSource = results
    .map((r, i) => ({ r, i }))
    .filter((x) => x.r.source);

  // 3. judge them together
  if (withSource.length) {
    const listing = withSource
      .map((x, n) => `${n + 1}. CLAIM: ${x.r.claim}\n   SOURCE (${sources[x.i].title}): ${sources[x.i].extract}`)
      .join('\n\n');
    try {
      const verdictText = await askModel(
        `For each item, decide whether the source text backs up the claim.

${listing}

Output exactly these lines per item and nothing else:

ITEM: <the item number>
VERDICT: <one of: supported, contradicted, unclear>
QUOTE: <the sentence from the source that decides it, under 30 words, or - if none>
===

Say "supported" only where the source plainly backs the claim. Where the source
is about the right subject but does not address the claim, say "unclear". Say
"contradicted" only where the source states something incompatible with it.`,
        1100
      );
      const verdicts = parseBlocks(verdictText, 'ITEM');
      verdicts.forEach((v) => {
        const n = parseInt(v.item, 10);
        const target = withSource[n - 1];
        if (!target) return;
        const verdict = String(v.verdict || '').toLowerCase();
        target.r.status = ['supported', 'contradicted', 'unclear'].includes(verdict) ? verdict : 'unclear';
        target.r.quote = v.quote && v.quote !== '-' ? v.quote : '';
      });
    } catch (e) {
      // lookups succeeded but judging failed: report them as unjudged rather
      // than pretending they were checked
      withSource.forEach((x) => { x.r.status = 'unclear'; });
    }
  }

  return json({ claims: results }, 200);
}
