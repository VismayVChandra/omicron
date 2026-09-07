// Generates a slide photograph, rather than finding one.
//
// This answers with image bytes, not JSON, and that is the whole design. A
// generated picture has no URL of its own, and putting a megabyte of base64
// into the deck would break localStorage, blow up share links and choke the
// jsonb column. Instead a slide stores the prompt and the seed — about sixty
// bytes — and points its <img> at this endpoint. The image is deterministic
// for a given prompt and seed, so the same slide always draws the same
// picture, and the edge cache means the second viewer of a shared deck costs
// nothing at all.
//
// Three providers, picked by whichever key is configured. Cloudflare first
// because it is the only one of the three with a real free tier: 10,000
// neurons a day, and FLUX-1-schnell costs 4.8 of them per tile. Google's
// pricing page lists "not available" under Free Tier for every one of its
// image models, Nano Banana included, whatever the blog posts say.

export const config = { runtime: 'edge' };

const CF_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const TOGETHER_MODEL = 'black-forest-labs/FLUX.1-schnell-Free';
const GEMINI_MODEL = 'gemini-2.5-flash-image';

// A deck should not look like ten pictures from ten different stock libraries,
// so the theme it is wearing decides how its pictures are lit and coloured.
const STYLES = {
  tide: 'documentary photograph, soft natural light, cool blue-green palette, calm',
  press: 'black and white documentary photograph, high contrast, grainy 35mm',
  azure: 'clean corporate photograph, cool blue tones, even soft light, uncluttered',
  amber: 'dramatic low-key photograph, warm amber light, deep shadows, dark background',
  dune: 'warm minimal photograph, sand and clay tones, generous negative space',
  orchard: 'natural daylight photograph, muted greens and cream, unhurried',
  plum: 'soft luxe photograph, muted plum and rose, shallow depth of field',
  mist: 'high-key photograph, pale and airy, soft grey, lots of light',
  graphite: 'precise technical photograph, cool neutral greys, engineered surfaces',
  noir: 'cinematic photograph, deep shadows, monochrome, single hard light source',
};

function env(name) {
  // a pasted key picks up whitespace and a trailing newline more often than
  // anyone expects, and the provider answers "authentication error" for it
  return String(process.env[name] || '').trim();
}

function pickProvider() {
  if (env('CF_ACCOUNT_ID') && env('CF_API_TOKEN')) return 'cloudflare';
  if (env('TOGETHER_API_KEY')) return 'together';
  if (env('GEMINI_API_KEY')) return 'gemini';
  return null;
}

// Providers say "authentication error" for a wrong key, a key scoped to the
// wrong account, and a key that is fine but lacks the permission — three
// different fixes behind one message. Worth separating from "the model could
// not draw that", which is what the editor says otherwise.
function looksLikeAuth(status, detail) {
  if (status === 401 || status === 403) return true;
  return /authentication|unauthor|invalid api|forbidden|permission|"code":\s*10000/i.test(String(detail));
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function base64ToBytes(b64) {
  const clean = String(b64).replace(/^data:[^,]+,/, '').replace(/\s/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Declare what the bytes actually are rather than what the model was asked for.
// A JPEG served as image/png is the kind of thing PowerPoint refuses to open.
function sniffType(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'image/webp';
  return 'application/octet-stream';
}

async function viaCloudflare(prompt, seed) {
  // Cloudflare prefixes its credentials, and two of them are easy to confuse on
  // a dashboard: cfut_ is a scoped User API Token, which is what the Workers AI
  // template makes and what this wants; cfk_ is the Global API Key, which has
  // full access to the whole account and authenticates with X-Auth-Email and
  // X-Auth-Key rather than a bearer token. Sent as a bearer it just returns
  // "Authentication error", which sends you looking at scopes and account ids
  // for an hour. Say what it actually is.
  const token = env('CF_API_TOKEN');
  if (token.indexOf('cfk_') === 0) {
    throw {
      code: 'bad_credentials',
      detail: 'CF_API_TOKEN is a Global API Key (cfk_), not an API token. ' +
        'Create a scoped token instead — it starts cfut_. Do not use the ' +
        'Global API Key here: it grants full access to the whole account.',
    };
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${env('CF_ACCOUNT_ID')}/ai/run/${CF_MODEL}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt, seed, steps: 4 }),
  });
  if (res.status === 429) throw { code: 'rate_limited' };

  const raw = await res.text();
  if (!res.ok) {
    if (looksLikeAuth(res.status, raw)) throw { code: 'bad_credentials', detail: raw.slice(0, 300) };
    throw { code: 'upstream_error', detail: raw.slice(0, 300) };
  }
  // Cloudflare answers 200 with success:false for an authentication failure,
  // so the status line alone does not tell you whether this worked
  let data;
  try { data = JSON.parse(raw); } catch (e) { throw { code: 'upstream_error', detail: raw.slice(0, 300) }; }
  if (data && data.success === false) {
    const detail = JSON.stringify(data.errors || []).slice(0, 300);
    if (looksLikeAuth(200, detail)) throw { code: 'bad_credentials', detail };
    throw { code: 'upstream_error', detail };
  }
  const b64 = data && data.result && data.result.image;
  if (!b64) throw { code: 'empty_completion' };
  return base64ToBytes(b64);
}

async function viaTogether(prompt, seed) {
  const res = await fetch('https://api.together.xyz/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env('TOGETHER_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TOGETHER_MODEL,
      prompt,
      seed,
      width: 1024,
      height: 768,
      steps: 4,
      n: 1,
      response_format: 'b64_json',
    }),
  });
  if (res.status === 429) throw { code: 'rate_limited' };
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (looksLikeAuth(res.status, detail)) throw { code: 'bad_credentials', detail: detail.slice(0, 300) };
    throw { code: 'upstream_error', detail: detail.slice(0, 300) };
  }
  const data = await res.json();
  const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
  if (!b64) throw { code: 'empty_completion' };
  return base64ToBytes(b64);
}

async function viaGemini(prompt) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent` +
    `?key=${env('GEMINI_API_KEY')}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (res.status === 429) throw { code: 'rate_limited' };
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (looksLikeAuth(res.status, detail)) throw { code: 'bad_credentials', detail: detail.slice(0, 300) };
    throw { code: 'upstream_error', detail: detail.slice(0, 300) };
  }
  const data = await res.json();
  const parts =
    (data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts) || [];
  const inline = parts.find((p) => p.inlineData && p.inlineData.data);
  if (!inline) throw { code: 'empty_completion' };
  return base64ToBytes(inline.inlineData.data);
}

export default async function handler(request) {
  const url = new URL(request.url);
  const provider = pickProvider();
  if (!provider) {
    return json({ error: 'not_configured', message: 'No image generation key is set.' }, 501);
  }

  // A public GET that costs quota is worth a token gesture at least: only serve
  // requests that came from a page on this deployment. It stops a crawler
  // finding the endpoint and spending the day's free allocation, and share
  // links still work because their readers are on this origin too.
  const from = request.headers.get('referer') || request.headers.get('origin') || '';
  if (from && url.origin && from.indexOf(url.origin) !== 0) {
    return json({ error: 'invalid_request', message: 'Not from this site.' }, 403);
  }

  const subject = (url.searchParams.get('q') || '').trim().slice(0, 200);
  if (!subject) return json({ error: 'invalid_request', message: 'Missing q.' }, 400);

  const seed = Math.abs(parseInt(url.searchParams.get('s') || '1', 10) || 1) % 4294967295;
  const theme = url.searchParams.get('t') || 'tide';
  const style = STYLES[theme] || STYLES.tide;

  // No text: every one of these models writes gibberish letters into a picture
  // when it thinks a sign or a label belongs there, and a slide has real words
  // on it already.
  const prompt =
    `${subject}. ${style}. Photographic, no text, no words, no letters, ` +
    'no watermark, no logo, no charts or diagrams.';

  let bytes;
  try {
    if (provider === 'cloudflare') bytes = await viaCloudflare(prompt, seed);
    else if (provider === 'together') bytes = await viaTogether(prompt, seed);
    else bytes = await viaGemini(prompt);
  } catch (e) {
    const code = (e && e.code) || 'upstream_error';
    const status = code === 'rate_limited' ? 429 : (code === 'bad_credentials' ? 401 : 502);
    return json({ error: code, provider: provider, message: (e && e.detail) || '' }, status);
  }

  const type = sniffType(bytes);
  if (type === 'application/octet-stream') {
    return json({ error: 'upstream_error', message: 'Unrecognised image bytes.' }, 502);
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': type,
      // deterministic for a prompt and seed, so it can be cached hard: the
      // second person to open a shared deck costs no quota at all
      'Cache-Control': 'public, s-maxage=31536000, max-age=86400, immutable',
    },
  });
}
