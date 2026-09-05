// Regenerates one slide in place. Small and fast, so unlike /api/generate
// this returns a single JSON object rather than streaming.

export const config = { runtime: 'edge' };

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const LAYOUTS = ['bullets', 'stat', 'quote'];

// Kept deliberately short and layout-specific: a longer, rule-heavy prompt
// makes this model reason for hundreds of tokens before writing anything.
function buildPrompt({ topic, title, heading, layout }) {
  const shape = {
    stat:
      'LAYOUT: stat\nHEADING: <heading, under 6 words>\n' +
      'BULLET: <one striking number, under 8 words>\n' +
      'BULLET: <supporting point, under 14 words>',
    quote:
      'LAYOUT: quote\nHEADING: <who said it, under 8 words>\n' +
      'BULLET: <the quoted line, under 20 words>',
    bullets:
      'LAYOUT: bullets\nHEADING: <heading, under 6 words>\n' +
      'BULLET: <point, under 14 words>\nBULLET: <point, under 14 words>\n' +
      'BULLET: <point, under 14 words>',
  }[LAYOUTS.includes(layout) ? layout : 'bullets'];

  return `Deck: "${title}" — about ${topic}.

Rewrite the "${heading}" slide. Same subject, fresh wording.

Output exactly these lines and nothing else:

${shape}`;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const MAX_BULLETS = { bullets: 4, stat: 2, quote: 1 };

function parseSlide(text) {
  const out = { layout: 'bullets', heading: '', bullets: [] };
  let seenLayout = false;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    const match = line.match(/^([A-Z]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (key === 'LAYOUT') {
      if (seenLayout) break; // a second block: the slide ended at the first
      seenLayout = true;
      if (LAYOUTS.includes(value)) out.layout = value;
    } else if (key === 'HEADING') {
      if (!out.heading) out.heading = value;
    } else if (key === 'BULLET' && value) {
      out.bullets.push(value);
    }
  }
  out.bullets = out.bullets.slice(0, MAX_BULLETS[out.layout] || 4);
  return out;
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

  const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
  const heading = typeof body.heading === 'string' ? body.heading.trim() : '';
  if (!topic || !heading) {
    return json({ error: 'invalid_request', message: 'Missing topic or heading.' }, 400);
  }
  if (topic.length > 500 || heading.length > 200) {
    return json({ error: 'prompt_too_large', message: 'Input is too long.' }, 400);
  }

  if (!process.env.GROQ_API_KEY) {
    return json({ error: 'upstream_error', message: 'GROQ_API_KEY is not configured.' }, 500);
  }

  const prompt = buildPrompt({
    topic,
    title: typeof body.title === 'string' ? body.title.slice(0, 120) : topic,
    heading,
    layout: body.layout,
  });

  let groqRes;
  try {
    groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.9,
        max_tokens: 900,
        reasoning_effort: 'low',
      }),
    });
  } catch (e) {
    return json({ error: 'upstream_error', message: 'Could not reach the model.' }, 502);
  }

  if (groqRes.status === 429) return json({ error: 'rate_limited' }, 429);
  if (!groqRes.ok) {
    const detail = await groqRes.text().catch(() => '');
    return json({ error: 'upstream_error', message: detail.slice(0, 300) }, 502);
  }

  const completion = await groqRes.json();
  const content =
    completion.choices && completion.choices[0] && completion.choices[0].message
      ? completion.choices[0].message.content
      : '';
  if (!content) return json({ error: 'empty_completion' }, 502);

  const slide = parseSlide(content);
  if (!slide.heading || slide.bullets.length === 0) {
    return json({ error: 'invalid_json', message: 'Model returned an unusable slide.' }, 502);
  }

  return json(slide, 200);
}
