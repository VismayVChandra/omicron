// Streaming deck generation. Runs on Vercel's Edge runtime so the response
// can be piped to the browser as it is written, rather than buffered.
//
// Groq returns OpenAI-style SSE. Reasoning models put their hidden thinking
// on delta.reasoning and the real answer on delta.content, so only content
// is forwarded. The client parses the line-based format below incrementally,
// which is why this is plain text rather than one JSON blob.

export const config = { runtime: 'edge' };

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SURFACE_NOUN = {
  deck: 'a slide deck',
  doc: 'a long-form document',
  site: 'a one-page website',
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

function styleLine(opts) {
  const audience = AUDIENCE[opts.audience] || AUDIENCE.general;
  if (voiceLine(opts)) return `Write for ${audience}.`;
  const tone = TONE[opts.tone] || TONE.plain;
  return `Write for ${audience}, in a ${tone} register.`;
}

// Goes last, after the format rules. Placed before them it gets buried: the
// model reads a long list of formatting constraints afterwards and writes in
// its own default register.
function voiceCoda(opts) {
  const voice = voiceLine(opts);
  if (!voice) return '';
  return `

${voice}

This matters more than anything above about length or register. Where a habit
here conflicts with the formatting guidance, follow the habit. Do not fall back
into neutral corporate phrasing — no "leverage", "align", "future-proof",
"culture of", "seamless" or "robust" unless the samples used those words.

These are tendencies, not a template. Hard limit: no signature opener,
catchphrase or sentence pattern from the habits above may appear on more than
ONE slide in the whole deck. If a habit names an opening word or phrase, use it
once at most and open every other slide differently. A tic on every slide reads
as parody, not as someone's voice.`;
}

// With pasted material every fact must come from it. Without it, the model has
// no source at all, so it is told not to pass invented figures off as data.
function groundingLine(opts) {
  if (opts.source) {
    return `Write the slides from the material below. Every fact, figure, name and
date must come from it — do not introduce statistics or claims it does not
contain. Where it is thin on a section, keep that slide short rather than
padding it out with invention.

"""
${opts.source}
"""
`;
  }
  return `You have no source material, so do not invent precise statistics, market
sizes, percentages or dated forecasts, and do not attribute quotes to real
people. Prefer qualitative claims you are confident are true, and use the stat
layout only for a figure that is genuinely well known.`;
}

// The BODY word count is relaxed when a voice is in play: "20 to 40 words"
// is a specific, format-level instruction that quietly beats a general request
// for short sentences, and the deck comes out in house style regardless.
function formatSpec(opts) {
  const bodyLine = voiceLine(opts)
    ? 'BODY: <1 to 2 sentences introducing the slide, in the voice described below>'
    : 'BODY: <1 to 2 full sentences introducing the slide, 20 to 40 words>';
  return FORMAT_SPEC.replace('__BODY__', bodyLine);
}

const FORMAT_SPEC = `Reply in EXACTLY this plain-text format and nothing else:

TITLE: <short title, under 6 words>
TAGLINE: <one sentence subtitle>
IMAGE: <2 to 5 plain words naming a photographable subject>
===
LAYOUT: bullets
HEADING: <heading, under 6 words>
__BODY__
BULLET: <point, under 18 words>
BULLET: <point, under 18 words>
BULLET: <point, under 18 words>
IMAGE: <2 to 5 plain words naming a photographable subject>
===
LAYOUT: stat
HEADING: <heading, under 6 words>
BULLET: <one striking number, under 8 words>
BULLET: <supporting point, under 18 words>

Rules:
- Begin every slide with a line of exactly ===
- LAYOUT is one of: bullets, stat, quote
- Use stat only where a single number genuinely carries the point, and quote only
  where one memorable line does (BULLET is the line, HEADING is who said it).
  At most one of each, and skip them entirely when they don't suit the subject.
- bullets: a BODY line then 3 to 5 BULLET lines. stat: exactly 2 BULLET lines and
  no BODY. quote: exactly 1 BULLET line and no BODY.
- IMAGE: give one to the cover and to every bullets slide. Never on stat or quote
  slides. It is used to search a photo library, so write plain searchable nouns
  for a thing that can be photographed — "coral reef underwater", "marathon
  runners road", "hospital waiting room". No adjectives about mood or lighting,
  no abstractions ("growth", "success"), no diagrams, charts or logos.
- Write real substance specific to the subject — never placeholder filler.
- No markdown, no blank lines, no commentary before or after.`;

function buildPrompt(topic, surface, plan, opts) {
  const noun = SURFACE_NOUN[surface] || SURFACE_NOUN.deck;

  // When the user has approved an outline, follow it exactly rather than
  // inventing a new structure — the outline is the thing they just edited.
  if (plan && plan.sections && plan.sections.length) {
    const list = plan.sections.map((s, i) => `${i + 1}. ${s}`).join('\n');
    return `Write ${noun} about: "${topic}".

Use EXACTLY these slides, in this order, one slide each:

${list}

${plan.title ? `The deck is titled "${plan.title}".` : ''}
${plan.tagline ? `Its subtitle is "${plan.tagline}".` : ''}

${groundingLine(opts)}

${styleLine(opts)}

${formatSpec(opts)}

- Write one slide per numbered section above — no more, no fewer — keeping each
  section's wording as its HEADING, exactly as written.
- Use only the bullets and stat layouts here. Do not use the quote layout: its
  HEADING is an attribution, which would overwrite the approved section name.${voiceCoda(opts)}`;
  }

  return `Draft ${noun} about: "${topic}".

First work out what kind of thing this subject actually calls for — a lesson, an
explainer, a report, a status update, a how-to, a retrospective, a travel plan, a
book summary, a proposal, a pitch — and structure it the way that kind is normally
structured. Do NOT use pitch slides (problem, solution, market, business model,
traction, the ask) unless the subject genuinely is a business pitch. A deck about
photosynthesis should read like a lesson; a deck about last quarter should read
like a review.

${groundingLine(opts)}

${styleLine(opts)}

${formatSpec(opts)}

- Write ${LENGTH[opts.length] || LENGTH.standard} slides after the cover — as many as the subject needs.
- Order the slides the way someone would actually present them, and finish with a
  closing slide: a summary, a takeaway, or what happens next.${voiceCoda(opts)}`;
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
  if (topic.length > 500) return json({ error: 'prompt_too_large', message: 'Topic is too long.' }, 400);

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
          content: buildPrompt(topic, body.surface, body.plan, {
            source: typeof body.source === 'string' ? body.source.trim().slice(0, 12000) : '',
            audience: body.audience,
            tone: body.tone,
            length: body.length,
            voice: body.voice,
          }),
        }],
        temperature: 0.8,
        max_tokens: 2600,
        reasoning_effort: 'low',
        stream: true,
      }),
    });
  } catch (e) {
    return json({ error: 'upstream_error', message: 'Could not reach the model.' }, 502);
  }

  if (groqRes.status === 429) return json({ error: 'rate_limited' }, 429);
  if (!groqRes.ok || !groqRes.body) {
    const detail = await groqRes.text().catch(() => '');
    return json({ error: 'upstream_error', message: detail.slice(0, 300) }, 502);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const reader = groqRes.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let parsed;
            try {
              parsed = JSON.parse(payload);
            } catch (e) {
              continue;
            }
            const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
            const text = delta && delta.content;
            if (text) controller.enqueue(encoder.encode(text));
          }
        }
      } catch (e) {
        controller.enqueue(new TextEncoder().encode('\nERROR: upstream_error\n'));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
