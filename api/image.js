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

export default async function handler(request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get('q') || '').trim().slice(0, 120);
  if (!query) return json({ error: 'invalid_request', message: 'Missing q.' }, 400);

  const api =
    `${ENDPOINT}?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}` +
    '&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1200' +
    '&format=json&origin=*';

  let data;
  try {
    const res = await fetch(api, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) return json({ error: 'upstream_error' }, 502);
    data = await res.json();
  } catch (e) {
    return json({ error: 'upstream_error' }, 502);
  }

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

  if (!candidates.length) return json({ error: 'no_image' }, 404, 3600);

  candidates.sort((a, b) => a.score - b.score || a.order - b.order);
  const pick = candidates[0];

  return json({ url: pick.url, credit: pick.credit, license: pick.license }, 200, 604800);
}
