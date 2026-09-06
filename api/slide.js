// Regenerates one slide in place. Small and fast, so unlike /api/generate
// this returns a single JSON object rather than streaming.

export const config = { runtime: 'edge' };

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const LAYOUTS = ['bullets', 'stat', 'quote'];

// Kept deliberately short and layout-specific: a longer, rule-heavy prompt
// makes this model reason for hundreds of tokens before writing anything.
const AUDIENCE = {
  general: 'a general audience',
  executives: 'senior executives who want the decision and the numbers',
  students: 'students meeting this topic for the first time',
  engineers: 'a technical audience who want mechanism and detail',
  customers: 'prospective customers weighing whether to buy',
};

const TONE = {
  plain: 'plain, direct',
  persuasive: 'persuasive',
  technical: 'precise and technical',
  warm: 'warm and conversational',
};

// A learned voice replaces the generic tone: concrete habits beat an adjective.
function voiceLine(opts) {
  const traits = Array.isArray(opts.voice) ? opts.voice.filter(function(t){ return typeof t === 'string' && t.trim(); }).slice(0, 6) : [];
  if (!traits.length) return '';
  const lines = traits.map((t) => '- ' + String(t).slice(0, 140));
  return [
    "Write in this person's own voice. These are their observed habits:",
    ...lines,
    'Match these habits closely — they outrank any default style.',
  ].join('\n');
}

function buildPrompt({ topic, title, heading, layout, audience, tone, source, voice }) {
  const shape = {
    stat:
      'LAYOUT: stat\nHEADING: <heading, under 6 words>\n' +
      'BULLET: <one striking number, under 8 words>\n' +
      'BULLET: <supporting point, under 18 words>',
    quote:
      'LAYOUT: quote\nHEADING: <who said it, under 8 words>\n' +
      'BULLET: <the quoted line, under 20 words>',
    bullets:
      'LAYOUT: bullets\nHEADING: <heading, under 6 words>\n' +
      'BODY: <1 to 2 sentences, 20 to 40 words>\n' +
      'BULLET: <point, under 18 words>\nBULLET: <point, under 18 words>\n' +
      'BULLET: <point, under 18 words>\n' +
      'IMAGE: <2 to 5 plain searchable words naming a photographable subject>',
  }[LAYOUTS.includes(layout) ? layout : 'bullets'];

  const grounding = source
    ? `Take the facts from this material and nothing else:\n\n"""\n${source}\n"""\n\n`
    : 'Do not invent precise statistics, market sizes or dated forecasts.\n\n';

  return `Deck: "${title}" — about ${topic}.

Rewrite the "${heading}" slide. Same subject, fresh wording.

${grounding}${voiceLine({ voice: voice }) || `Write for ${AUDIENCE[audience] || AUDIENCE.general}, in a ${TONE[tone] || TONE.plain} register.`}

Output exactly these lines and nothing else:

${shape}`;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const MAX_BULLETS = { bullets: 5, stat: 2, quote: 1 };

function parseSlide(text) {
  const out = { layout: 'bullets', heading: '', body: '', image: '', bullets: [] };
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
    } else if (key === 'BODY') {
      if (!out.body) out.body = value;
    } else if (key === 'IMAGE') {
      if (!out.image) out.image = value;
    } else if (key === 'BULLET' && value) {
      out.bullets.push(value);
    }
  }
  out.bullets = out.bullets.slice(0, MAX_BULLETS[out.layout] || 5);
  if (out.layout !== 'bullets') { out.body = ''; out.image = ''; }
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
    audience: body.audience,
    tone: body.tone,
    source: typeof body.source === 'string' ? body.source.trim().slice(0, 6000) : '',
    voice: body.voice,
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
