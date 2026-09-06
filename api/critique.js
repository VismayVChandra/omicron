// Red-teams a finished deck: what will actually get challenged in the room.
//
// Deliberately not "presentation tips" — the value is in findings specific to
// this deck's claims, so the prompt forbids generic advice and asks for the
// question the audience will really ask, in their words.

export const config = { runtime: 'edge' };

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const AUDIENCE = {
  general: 'a general audience',
  executives: 'senior executives',
  students: 'students',
  engineers: 'a technical audience',
  customers: 'prospective customers',
};

const KINDS = ['unsupported', 'gap', 'weak-number', 'logic', 'missing-answer'];

function deckToText(slides) {
  return slides
    .map((s, i) => {
      if (i === 0 || s.type === 'cover') {
        return `1. COVER: ${s.title || ''}${s.tagline ? ' — ' + s.tagline : ''}`;
      }
      const lines = [`${i + 1}. ${s.heading || ''}`];
      if (s.body) lines.push(`   ${s.body}`);
      (s.bullets || []).forEach((b) => lines.push(`   - ${b}`));
      if (s.chart && Array.isArray(s.chart.values)) {
        lines.push('   data: ' + s.chart.labels.map((l, n) => `${l} ${s.chart.values[n]}`).join(', '));
      }
      return lines.join('\n');
    })
    .join('\n');
}

function buildPrompt(topic, audience, deckText, hasSource) {
  return `This deck is about "${topic}" and will be presented to ${
    AUDIENCE[audience] || AUDIENCE.general
  }.

${deckText}

You are the sharpest, least forgiving person in that room. Find the 3 to 5
things that will actually get challenged: a claim with nothing behind it, a
number that invites an immediate follow-up, a missing counterargument, a step
where the logic jumps, or an obvious question the deck never answers.${
    hasSource
      ? ''
      : '\n\nThe writer had no source material, so treat confident figures with particular suspicion.'
  }

Output exactly these lines per finding and nothing else:

SLIDE: <slide number this is about, or 0 for the deck as a whole>
KIND: <one of: unsupported, gap, weak-number, logic, missing-answer>
ISSUE: <what is weak, one sentence, under 25 words>
ASK: <the question they will actually ask, in their own words, under 20 words>
===

Be specific to this deck and quote its actual wording where it helps. Never give
generic presentation advice about fonts, pacing, eye contact or slide counts.`;
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

  const slides = Array.isArray(body.slides) ? body.slides.slice(0, 14) : [];
  const topic = typeof body.topic === 'string' ? body.topic.trim().slice(0, 300) : '';
  if (slides.length < 2) {
    return json({ error: 'invalid_request', message: 'Need a deck to test.' }, 400);
  }
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
        messages: [{
          role: 'user',
          content: buildPrompt(topic, body.audience, deckToText(slides), !!body.hasSource),
        }],
        temperature: 0.7,
        max_tokens: 1400,
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

  const findings = [];
  let current = null;
  for (const raw of String(content).split('\n')) {
    const line = raw.trim();
    if (line === '===') { current = null; continue; }
    const match = line.match(/^([A-Z]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (key === 'SLIDE') {
      current = { slide: Math.max(0, parseInt(value, 10) || 0), kind: 'gap', issue: '', ask: '' };
      findings.push(current);
    } else if (current) {
      if (key === 'KIND') current.kind = KINDS.includes(value) ? value : 'gap';
      else if (key === 'ISSUE') current.issue = value;
      else if (key === 'ASK') current.ask = value;
    }
  }

  const usable = findings.filter((f) => f.issue).slice(0, 5);
  if (!usable.length) return json({ error: 'invalid_json', message: 'No usable findings.' }, 502);
  return json({ findings: usable }, 200);
}
