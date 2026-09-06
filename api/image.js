// Finds a photograph for a slide from Wikimedia Commons.
//
// Why proxied rather than called from the browser: Wikimedia's API policy
// requires a descriptive User-Agent, which a browser cannot set, and routing
// through here lets the edge cache repeat queries so a popular topic hits
// Wikimedia once rather than once per visitor.
//
// Pollinations (AI-generated images) was tried first and rejected: it returns
// 429 for concurrent requests and 40s+ when serialized, which cannot fill a
// seven-slide deck.

export const config = { runtime: 'edge' };

const ENDPOINT = 'https://commons.wikimedia.org/w/api.php';
const UA = 'Swell/1.0 (https://omicron-beta.vercel.app; deck drafting demo)';

// Commons carries plenty of diagrams, logos and scans; skip the obvious ones
const REJECT = /\.svg$|logo|coat of arms|flag of|map of|diagram|chart|graph|seal of|icon|screenshot|font|\.pdf/i;

function json(obj, status, cacheSeconds) {
  const headers = { 'Content-Type': 'application/json' };
  if (cacheSeconds) {
    headers['Cache-Control'] = `public, s-maxage=${cacheSeconds}, stale-while-revalidate=86400`;
  }
  return new Response(JSON.stringify(obj), { status, headers });
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

async function search(query) {
  const api =
    `${ENDPOINT}?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}` +
    '&gsrnamespace=6&gsrlimit=10&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1200' +
    '&format=json&origin=*';

  const res = await fetch(api, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error('upstream');
  const data = await res.json();

  const pages = data && data.query && data.query.pages ? Object.values(data.query.pages) : [];
  const candidates = [];

  for (const page of pages) {
    const info = page.imageinfo && page.imageinfo[0];
    if (!info || !info.thumburl) continue;
    if (REJECT.test(page.title || '')) continue;

    const meta = info.extmetadata || {};
    const license = stripTags(meta.LicenseShortName && meta.LicenseShortName.value) || 'See Commons';
    // no-derivatives and non-commercial images don't belong in someone's deck
    if (/\bND\b|NonCommercial|\bNC\b|Fair use/i.test(license)) continue;

    const w = info.thumbwidth || 0;
    const h = info.thumbheight || 0;
    if (w < 500) continue;

    candidates.push({
      url: info.thumburl,
      credit: stripTags(meta.Artist && meta.Artist.value).slice(0, 80),
      license,
      // prefer landscape: these sit in a wide slot on the slide
      score: h > 0 && w / h >= 1.2 ? 0 : 1,
      order: candidates.length,
    });
  }

  candidates.sort((a, b) => a.score - b.score || a.order - b.order);
  return candidates;
}

// Commons serves rendered thumbnails at .../thumb/a/ab/File.jpg/1200px-File.jpg,
// so a grid of eight can ask for small ones instead of eight full-size images.
// If the pattern is not there the file was served at its own size; the caller
// falls back to the full URL when the small one fails to load.
function smallerThumb(url, width) {
  return String(url).replace(/\/(\d+)px-/, (match, w) =>
    Number(w) > width ? `/${width}px-` : match
  );
}

export default async function handler(request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get('q') || '').trim().slice(0, 120);
  if (!query) return json({ error: 'invalid_request', message: 'Missing q.' }, 400);

  // Specific three-word queries often return nothing once diagrams and
  // screenshots are filtered out, so widen the search a step at a time
  // rather than dropping straight to the placeholder gradient.
  const words = query.split(/\s+/).filter(Boolean);
  const attempts = [query];
  if (words.length > 2) attempts.push(words.slice(0, 2).join(' '));
  if (words.length > 1) attempts.push(words[0]);

  // ?n=8 asks for a choice rather than a verdict — the picker in the editor
  // shows these so a slide's photograph can be someone's decision, not the
  // first thing the search happened to rank.
  const wanted = Math.min(12, Math.max(0, parseInt(url.searchParams.get('n') || '0', 10) || 0));

  for (const attempt of attempts) {
    let found;
    try {
      found = await search(attempt);
    } catch (e) {
      return json({ error: 'upstream_error' }, 502);
    }
    if (!found.length) continue;

    if (wanted) {
      return json({
        results: found.slice(0, wanted).map((c) => ({
          url: c.url,
          thumb: smallerThumb(c.url, 320),
          credit: c.credit,
          license: c.license,
        })),
      }, 200, 604800);
    }

    const pick = found[0];
    return json({ url: pick.url, credit: pick.credit, license: pick.license }, 200, 604800);
  }

  return json(wanted ? { results: [] } : { error: 'no_image' }, wanted ? 200 : 404, 3600);
}
