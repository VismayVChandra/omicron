// Step one of the two-step flow: plan the deck before writing it, so the
// section list can be edited before any slide content is generated.
// Deliberately terse — a rule-heavy prompt makes this model spend its whole
// token budget reasoning and return nothing.

export const config = { runtime: 'edge' };

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SURFACE_NOUN = {
  deck: 'slide deck',
  doc: 'document',
  site: 'one-page website',
};

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

const LENGTH = { brief: '4 to 5', standard: '5 to 8', detailed: '9 to 12' };

export function styleLine(opts) {
  const audience = AUDIENCE[opts.audience] || AUDIENCE.general;
  const tone = TONE[opts.tone] || TONE.plain;
  return `Write it for ${audience}, in a ${tone} register.`;
}

function buildPrompt(topic, surface, opts) {
  const noun = SURFACE_NOUN[surface] || SURFACE_NOUN.deck;
  const count = LENGTH[opts.length] || LENGTH.standard;

  // With pasted material the outline follows the material; without it the
  // model plans from the topic alone, as before.
  const grounding = opts.source
    ? `Base the outline on the material below and derive the sections from what
it actually contains — its own structure, emphasis and terms. Do not add
sections it says nothing about.

"""
${opts.source}
"""

`
    : '';

  return `Plan a ${noun} about: "${topic}".

${grounding}Work out what kind it should be — lesson, report, how-to, retrospective,
proposal, pitch — and outline it that way. Do not use pitch sections
(problem, market, the ask) unless it really is a pitch. End with a closing
section. ${styleLine(opts)}

Output exactly these lines and nothing else:

TITLE: <short title, under 6 words>
TAGLINE: <one sentence>
SECTION: <section heading, under 6 words>
SECTION: <section heading, under 6 words>

Give ${count} SECTION lines.`;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
  if (!topic) return json({ error: 'invalid_request', message: 'Missing topic.' }, 400);
  if (topic.length > 500) return json({ error: 'prompt_too_large' }, 400);

  const opts = {
    source: typeof body.source === 'string' ? body.source.trim().slice(0, 12000) : '',
    audience: body.audience,
    tone: body.tone,
    length: body.length,
  };
  if (!process.env.GROQ_API_KEY) {
    return json({ error: 'upstream_error', message: 'GROQ_API_KEY is not configured.' }, 500);
  }

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
        messages: [{ role: 'user', content: buildPrompt(topic, body.surface, opts) }],
        temperature: 0.8,
        max_tokens: 1100,
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

  const out = { title: '', tagline: '', sections: [] };
  for (const raw of String(content).split('\n')) {
    const match = raw.trim().match(/^([A-Z]+):\s*(.*)$/);
    if (!match) continue;
    const value = match[2].trim();
    if (match[1] === 'TITLE' && !out.title) out.title = value;
    else if (match[1] === 'TAGLINE' && !out.tagline) out.tagline = value;
    else if (match[1] === 'SECTION' && value) out.sections.push(value);
  }
  out.sections = out.sections.slice(0, 8);

  if (!out.title || out.sections.length < 2) {
    return json({ error: 'invalid_json', message: 'Model returned an unusable outline.' }, 502);
  }
  return json(out, 200);
}
