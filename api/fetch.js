// Pulls the readable text out of a web page, so a deck can be built from a URL.
//
// This is a server that fetches a URL somebody typed, which is the classic
// shape of a server-side request forgery: point it at 169.254.169.254 or
// localhost and it will happily read a cloud metadata endpoint or something
// behind the firewall and hand the contents back. The guards below matter more
// than the extraction does.
//
// They are not complete. Hostnames are checked, not resolved addresses, so a
// name that resolves to a private address gets through — DNS resolution is not
// available in the edge runtime, and following redirects makes it worse, so
// redirects are refused rather than followed.

export const config = { runtime: 'edge' };

const MAX_BYTES = 2_000_000;
const MAX_TEXT = 200_000;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Everything that should never be reachable from a public form.
const BLOCKED_HOST = [
  /^localhost$/i,
  /\.localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,            // link-local, and AWS/GCP metadata lives at .169.254
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /^\[?fc00:/i,
  /^\[?fd/i,
  /^\[?fe80:/i,
  /\.internal$/i,
  /\.local$/i,
  /^metadata\./i,
];

function refuseHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return 'no host';
  if (BLOCKED_HOST.some((re) => re.test(host))) return 'that address is not reachable from here';
  return null;
}

// A page is mostly furniture. Strip what is never prose, then unwrap the rest.
function pageToText(html) {
  let s = String(html);

  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';

  // an article body if the page marks one, otherwise the whole thing
  const main =
    (s.match(/<article[^>]*>([\s\S]*?)<\/article>/i) || [])[1] ||
    (s.match(/<main[^>]*>([\s\S]*?)<\/main>/i) || [])[1] ||
    s;
  s = main;

  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<nav[\s\S]*?<\/nav>/gi, ' ');
  s = s.replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  s = s.replace(/<header[\s\S]*?<\/header>/gi, ' ');
  s = s.replace(/<aside[\s\S]*?<\/aside>/gi, ' ');
  s = s.replace(/<form[\s\S]*?<\/form>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');

  // keep the shape: headings and paragraphs become their own lines
  s = s.replace(/<\/(p|div|section|li|tr|h[1-6]|blockquote)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '- ');
  s = s.replace(/<[^>]+>/g, ' ');

  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => line.length > 1)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  return { title: title.replace(/\s+/g, ' ').trim().slice(0, 200), text: s.slice(0, MAX_TEXT) };
}

export default async function handler(request) {
  const here = new URL(request.url);
  const raw = (here.searchParams.get('url') || '').trim();
  if (!raw) return json({ error: 'invalid_request', message: 'Missing url.' }, 400);

  let target;
  try {
    target = new URL(raw.indexOf('://') === -1 ? 'https://' + raw : raw);
  } catch (e) {
    return json({ error: 'invalid_request', message: 'That is not a URL.' }, 400);
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return json({ error: 'invalid_request', message: 'Only http and https.' }, 400);
  }
  const refusal = refuseHost(target.hostname);
  if (refusal) return json({ error: 'invalid_request', message: refusal }, 400);

  let res;
  try {
    res = await fetch(target.toString(), {
      // a redirect could land on an address the checks above just refused, and
      // the redirect target is not checked, so do not go
      redirect: 'manual',
      headers: {
        'User-Agent': 'Swell/1.0 (+https://omicron-beta.vercel.app; deck drafting)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
      },
    });
  } catch (e) {
    return json({ error: 'upstream_error', message: 'Could not reach that page.' }, 502);
  }

  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get('location') || '';
    return json({
      error: 'redirected',
      message: 'That URL redirects. Try the address it points at.',
      location: to.slice(0, 300),
    }, 409);
  }
  if (!res.ok) {
    return json({ error: 'upstream_error', message: 'That page answered ' + res.status + '.' }, 502);
  }

  const type = (res.headers.get('content-type') || '').toLowerCase();
  const isText = type.indexOf('text/html') === 0 || type.indexOf('text/plain') === 0 ||
    type.indexOf('application/xhtml') === 0;
  if (!isText) {
    return json({
      error: 'unsupported',
      message: 'That is not a web page. PDFs and documents can be dropped in directly instead.',
    }, 415);
  }

  const size = Number(res.headers.get('content-length') || 0);
  if (size && size > MAX_BYTES) {
    return json({ error: 'too_large', message: 'That page is too big to read.' }, 413);
  }

  let body;
  try {
    body = await res.text();
  } catch (e) {
    return json({ error: 'upstream_error', message: 'Could not read that page.' }, 502);
  }
  if (body.length > MAX_BYTES) body = body.slice(0, MAX_BYTES);

  const out = pageToText(body);
  if (!out.text || out.text.length < 40) {
    return json({
      error: 'empty_completion',
      message: 'Nothing readable on that page — it may need JavaScript to render.',
    }, 422);
  }

  return json({ title: out.title, text: out.text, chars: out.text.length }, 200);
}
