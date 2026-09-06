// Rewrites one piece of text on a slide — a bullet, a heading, a sentence, or
// just the words someone highlighted inside one.
//
// Deliberately narrow: it is handed the fragment to change and the line it sits
// in, and it returns replacement text and nothing else. It is not allowed to
// introduce facts. "Make this shorter" should not quietly acquire a statistic.

export const config = { runtime: 'edge' };

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

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

// Each move says what to change AND what to leave alone, because without the
// second half three of the four collapse into "make it shorter" — which is
// what the model does to any line it is asked to improve.
const MOVES = {
  shorter:
    'Make it shorter. Cut words, keep every fact. Noticeably fewer words than it has now.',
  longer:
    'Make it fuller: unpack what the words already imply — the consequence, the ' +
    'mechanism, who it happens to. Roughly half as long again. Add no new facts, ' +
    'figures, names or dates.',
  plainer:
    'Say it plainly. Strip the jargon, the abstraction and the noun phrases; use ' +
    'ordinary words and a plain verb. Keep it about the same length.',
  punchier:
    'Make it land harder. Stronger verbs, fewer hedges, nothing decorative, and put ' +
    'the striking part first. Keep it about the same length — this is not "shorter".',
};

// What kind of thing is being edited, so the rewrite comes back the right size
const SHAPE = {
  heading: 'a slide heading — under 6 words, no full stop',
  bullet: 'a bullet point — one line, under 18 words',
  body: 'the sentence under a heading — one or two sentences, 20 to 40 words',
  statement: 'the single line on a full-bleed slide — under 16 words',
  stat: 'a headline figure — under 8 words',
  support: 'the line under a headline figure — under 18 words',
  quote: 'a quotation — keep it sounding like speech, under 20 words',
  label: 'a column label — under 4 words',
  attribution: 'the line naming who said a quotation — under 8 words',
};

function voiceLine(voice) {
  const traits = Array.isArray(voice)
    ? voice.filter((t) => typeof t === 'string' && t.trim()).slice(0, 6)
    : [];
  if (!traits.length) return '';
  return [
    "Write in this person's own voice. These are their observed habits:",
    ...traits.map((t) => '- ' + String(t).slice(0, 140)),
    'Match these habits closely — they outrank any default style.',
  ].join('\n');
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function buildPrompt({ text, before, after, kind, move, custom, topic, title, heading, audience, tone, voice }) {
  const partial = !!(before || after);
  const style = voiceLine(voice) ||
    `Write for ${AUDIENCE[audience] || AUDIENCE.general}, in a ${TONE[tone] || TONE.plain} register.`;

  const ask = custom
    ? `What to change: ${custom}`
    : MOVES[move] || MOVES.shorter;

  // Marking the fragment inside its own line beats quoting the two separately.
  // Given the line and the fragment as separate blocks the model rewrites the
  // fragment as if it stood alone: "...are loud and costly" came back as
  // "...are blare, drain money", which is not a sentence.
  const target = partial
    ? `The line reads, with the part to rewrite marked between the brackets:

"""
${before}[[${text}]]${after}
"""

Replace only what is inside the [[ ]] markers. Your words are dropped in exactly
where the markers are, so they have to join up with the words on either side —
including the grammar of the words immediately before and after.`
    : `Rewrite this:\n"""\n${text}\n"""`;

  return `You are editing ${SHAPE[kind] || SHAPE.bullet} in a slide deck.

Deck: "${title}" — about ${topic}.${heading ? `\nSlide: "${heading}".` : ''}

${target}

${ask}

${style}

Rules:
- Reply with the replacement text and nothing else.
- No quotation marks around it, no preamble, no explanation, no alternatives.
- Do not add facts, figures, names or dates that are not already there.
- Keep it the same kind of thing it is now.${partial ? '\n- Do not repeat the words outside the markers.' : ''}`;
}

// The model is told to answer with bare text; this is what to do when it does
// not quite. Strip a label, unwrap quotation marks, and for anything that is
// meant to be one line, keep the first one.
function clean(raw, kind) {
  let out = String(raw || '').trim();
  out = out.replace(/^(?:rewrite|replacement|revised|result|answer)\s*[:\-—]\s*/i, '');
  out = out.replace(/^["“”'']+|["“”'']+$/g, '').trim();
  if (kind !== 'body') {
    const first = out.split('\n').map((l) => l.trim()).filter(Boolean)[0];
    if (first) out = first;
  } else {
    out = out.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
  }
  // a bulleted answer to "rewrite this bullet" still arrives with its marker
  out = out.replace(/^[-*•]\s+/, '').trim();
  // and a marked fragment sometimes comes back still wearing the brackets
  out = out.replace(/^\[\[/, '').replace(/\]\]$/, '').trim();
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

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return json({ error: 'invalid_request', message: 'Nothing to rewrite.' }, 400);
  if (text.length > 1200) return json({ error: 'prompt_too_large', message: 'Selection is too long.' }, 400);

  const custom = typeof body.custom === 'string' ? body.custom.trim().slice(0, 200) : '';
  const move = typeof body.move === 'string' ? body.move : 'shorter';
  if (!custom && !MOVES[move]) {
    return json({ error: 'invalid_request', message: 'Unknown rewrite.' }, 400);
  }

  if (!process.env.GROQ_API_KEY) {
    return json({ error: 'upstream_error', message: 'GROQ_API_KEY is not configured.' }, 500);
  }

  const kind = typeof body.kind === 'string' && SHAPE[body.kind] ? body.kind : 'bullet';
  const prompt = buildPrompt({
    text,
    before: typeof body.before === 'string' ? body.before.slice(-600) : '',
    after: typeof body.after === 'string' ? body.after.slice(0, 600) : '',
    kind,
    move,
    custom,
    topic: typeof body.topic === 'string' ? body.topic.slice(0, 300) : 'this deck',
    title: typeof body.title === 'string' ? body.title.slice(0, 120) : 'Untitled',
    heading: typeof body.heading === 'string' ? body.heading.slice(0, 120) : '',
    audience: body.audience,
    tone: body.tone,
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
        temperature: 0.7,
        max_tokens: 400,
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

  const out = clean(content, kind);
  if (!out) return json({ error: 'empty_completion' }, 502);

  return json({ text: out.slice(0, 1200) }, 200);
}
