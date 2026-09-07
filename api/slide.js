// Regenerates one slide in place. Small and fast, so unlike /api/generate
// this returns a single JSON object rather than streaming.
//
// Two ways in. With no instruction it redraws the slide from its heading —
// same subject, fresh wording. With one, it revises the slide it is given:
// "cut this to three points", "make the second one concrete". Revising has to
// see the current slide, or "make the second one concrete" has nothing to act
// on and the model quietly writes a new slide instead.

export const config = { runtime: 'edge' };

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const LAYOUTS = ['bullets', 'stat', 'quote', 'steps', 'compare', 'section', 'statement'];

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

// The shape template spells out three BULLET lines and the model counts them:
// "cut this to two points" came back with three, every time, whatever the
// instruction said. When revising, a run of repeated lines collapses into one
// that says the count belongs to the instruction.
function flexibleShape(shape) {
  const note = '   <- one line per point, as many as the instruction asks for';
  const out = [];
  let run = 0;
  for (const line of String(shape).split('\n')) {
    if (line.startsWith('BULLET:')) {
      run += 1;
      if (run === 1) out.push(line);
      continue;
    }
    if (run > 1) out[out.length - 1] += note;
    run = 0;
    out.push(line);
  }
  if (run > 1) out[out.length - 1] += note;
  return out.join('\n');
}

// The existing slide, in the same line format the model is asked to answer in,
// so revising is an edit of something it can see rather than a fresh draft.
function slideToLines(slide) {
  if (!slide || typeof slide !== 'object') return '';
  const out = [];
  if (slide.type === 'cover') {
    out.push('LAYOUT: cover');
    if (slide.title) out.push(`TITLE: ${String(slide.title).slice(0, 200)}`);
    if (slide.tagline) out.push(`TAGLINE: ${String(slide.tagline).slice(0, 400)}`);
    if (slide.image) out.push(`IMAGE: ${String(slide.image).slice(0, 80)}`);
    return out.join('\n');
  }
  if (slide.layout) out.push(`LAYOUT: ${String(slide.layout).slice(0, 20)}`);
  if (slide.heading) out.push(`HEADING: ${String(slide.heading).slice(0, 200)}`);
  if (slide.body) out.push(`BODY: ${String(slide.body).slice(0, 600)}`);
  for (const side of ['left', 'right']) {
    const col = slide[side];
    if (!col) continue;
    out.push(`${side.toUpperCase()}: ${String(col.label || '').slice(0, 80)}`);
    for (const p of (Array.isArray(col.points) ? col.points : []).slice(0, 6)) {
      if (p) out.push(`BULLET: ${String(p).slice(0, 250)}`);
    }
  }
  if (!slide.left && !slide.right) {
    for (const b of (Array.isArray(slide.bullets) ? slide.bullets : []).slice(0, 8)) {
      if (b) out.push(`BULLET: ${String(b).slice(0, 250)}`);
    }
  }
  if (slide.image) out.push(`IMAGE: ${String(slide.image).slice(0, 80)}`);
  return out.join('\n');
}

function buildPrompt({ topic, title, heading, layout, audience, tone, source, voice, instruction, current }) {
  const shape = {
    cover:
      'LAYOUT: cover\nTITLE: <short title, under 6 words>\n' +
      'TAGLINE: <one sentence subtitle>\n' +
      'IMAGE: <2 to 5 plain searchable words naming a photographable subject>',
    stat:
      'LAYOUT: stat\nHEADING: <heading, under 6 words>\n' +
      'BULLET: <one striking number, under 8 words>\n' +
      'BULLET: <supporting point, under 18 words>',
    quote:
      'LAYOUT: quote\nHEADING: <who said it, under 8 words>\n' +
      'BULLET: <the quoted line, under 20 words>',
    steps:
      'LAYOUT: steps\nHEADING: <heading, under 6 words>\n' +
      'BODY: <one sentence saying what the sequence achieves>\n' +
      'BULLET: <step, under 12 words>\nBULLET: <step, under 12 words>\n' +
      'BULLET: <step, under 12 words>',
    compare:
      'LAYOUT: compare\nHEADING: <heading, under 6 words>\n' +
      'LEFT: <label, under 4 words>\n' +
      'BULLET: <point, under 12 words>\nBULLET: <point, under 12 words>\n' +
      'RIGHT: <label, under 4 words>\n' +
      'BULLET: <point, under 12 words>\nBULLET: <point, under 12 words>',
    section:
      'LAYOUT: section\nHEADING: <the name of this part, under 5 words>\n' +
      'IMAGE: <2 to 5 plain searchable words naming a photographable subject>',
    statement:
      'LAYOUT: statement\n' +
      'BULLET: <one line worth putting on a wall, under 16 words>\n' +
      'IMAGE: <2 to 5 plain searchable words naming a photographable subject>',
    bullets:
      'LAYOUT: bullets\nHEADING: <heading, under 6 words>\n' +
      'BODY: <1 to 2 sentences, 20 to 40 words>\n' +
      'BULLET: <point, under 18 words>\nBULLET: <point, under 18 words>\n' +
      'BULLET: <point, under 18 words>\n' +
      'IMAGE: <2 to 5 plain searchable words naming a photographable subject>',
  }[layout === 'cover' ? 'cover' : (LAYOUTS.includes(layout) ? layout : 'bullets')];

  const grounding = source
    ? `Take the facts from this material and nothing else:\n\n"""\n${source}\n"""\n\n`
    : 'Do not invent precise statistics, market sizes or dated forecasts.\n\n';

  const style = voiceLine({ voice: voice }) ||
    `Write for ${AUDIENCE[audience] || AUDIENCE.general}, in a ${TONE[tone] || TONE.plain} register.`;

  if (instruction && current) {
    return `Deck: "${title}" — about ${topic}.

The "${heading}" slide currently reads:

${current}

Revise it: ${instruction}

${grounding}${style}

Change what the instruction asks for and leave the rest of the slide alone.
Do not invent facts, figures or names that are not there already.

Output these lines and nothing else:

${flexibleShape(shape)}`;
  }

  return `Deck: "${title}" — about ${topic}.

Rewrite the "${heading}" slide. Same subject, fresh wording.

${grounding}${style}

Output exactly these lines and nothing else:

${shape}`;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const MAX_BULLETS = { bullets: 5, stat: 2, quote: 1, steps: 5, compare: 6, section: 0, statement: 1 };

// Which layouts legitimately carry which fields — a section slide has no
// bullets and a statement has no heading, so a blanket "strip everything that
// isn't bullets" throws away valid output.
const KEEPS_BODY = ['bullets', 'steps'];
const KEEPS_IMAGE = ['bullets', 'section', 'statement'];

function parseSlide(text, wantCover) {
  const out = { layout: 'bullets', heading: '', body: '', image: '', bullets: [] };
  if (wantCover) { out.title = ''; out.tagline = ''; }
  let seenLayout = false;
  let side = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    const match = line.match(/^([A-Z]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (key === 'LAYOUT') {
      if (seenLayout) break; // a second block: the slide ended at the first
      seenLayout = true;
      if (value === 'cover') out.layout = 'cover';
      else if (LAYOUTS.includes(value)) out.layout = value;
    } else if (key === 'TITLE') {
      if (wantCover && !out.title) out.title = value;
    } else if (key === 'TAGLINE') {
      if (wantCover && !out.tagline) out.tagline = value;
    } else if (key === 'HEADING') {
      if (!out.heading) out.heading = value;
    } else if (key === 'BODY') {
      if (!out.body) out.body = value;
    } else if (key === 'IMAGE') {
      if (!out.image) out.image = value;
    } else if (key === 'LEFT' || key === 'RIGHT') {
      side = key === 'LEFT' ? 'left' : 'right';
      out[side] = { label: value, points: [] };
    } else if (key === 'BULLET' && value) {
      if (side && out[side]) out[side].points.push(value);
      else out.bullets.push(value);
    }
  }
  if (wantCover) {
    // a cover carries a title, a line under it and a picture; nothing else
    return { layout: 'cover', title: out.title, tagline: out.tagline, image: out.image };
  }
  out.bullets = out.bullets.slice(0, MAX_BULLETS[out.layout] || 5);
  if (!KEEPS_BODY.includes(out.layout)) out.body = '';
  if (!KEEPS_IMAGE.includes(out.layout)) out.image = '';
  return out;
}

// A regenerated slide is usable if it carries whatever its own layout needs.
function slideIsUsable(slide) {
  if (slide.layout === 'cover') return !!slide.title;
  if (slide.layout === 'section') return !!slide.heading;
  if (slide.layout === 'statement') return slide.bullets.length > 0;
  if (slide.layout === 'compare') {
    return !!slide.heading && !!slide.left && !!slide.right &&
      slide.left.points.length > 0 && slide.right.points.length > 0;
  }
  return !!slide.heading && slide.bullets.length > 0;
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
  const wantCover = body.layout === 'cover';
  let heading = typeof body.heading === 'string' ? body.heading.trim() : '';

  // A statement slide has no heading — that is the whole point of the layout —
  // so requiring one meant those slides could not be reworked at all, and the
  // 400 came back as a message the person could not see. Name the slide by
  // what is on it instead.
  if (!heading && body.current && typeof body.current === 'object') {
    const first = wantCover
      ? body.current.title
      : (Array.isArray(body.current.bullets) ? body.current.bullets[0] : '');
    heading = String(first || '').trim().slice(0, 60);
  }
  if (!heading && wantCover) heading = topic;
  if (!topic) {
    return json({ error: 'invalid_request', message: 'Missing topic.' }, 400);
  }
  if (!heading) {
    return json({ error: 'invalid_request', message: 'Missing heading.' }, 400);
  }
  if (topic.length > 500 || heading.length > 200) {
    return json({ error: 'prompt_too_large', message: 'Input is too long.' }, 400);
  }

  if (!process.env.GROQ_API_KEY) {
    return json({ error: 'upstream_error', message: 'GROQ_API_KEY is not configured.' }, 500);
  }

  const instruction = typeof body.instruction === 'string' ? body.instruction.trim().slice(0, 300) : '';

  const prompt = buildPrompt({
    topic,
    title: typeof body.title === 'string' ? body.title.slice(0, 120) : topic,
    heading,
    layout: body.layout,
    audience: body.audience,
    tone: body.tone,
    source: typeof body.source === 'string' ? body.source.trim().slice(0, 6000) : '',
    voice: body.voice,
    instruction,
    current: instruction ? slideToLines(body.current) : '',
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
        temperature: instruction ? 0.5 : 0.9,
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

  const slide = parseSlide(content, wantCover);
  if (!slideIsUsable(slide)) {
    return json({ error: 'invalid_json', message: 'Model returned an unusable slide.' }, 502);
  }

  return json(slide, 200);
}
