import { supabaseAdmin } from '../lib/supabase.js';

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

    if (!apiKey) {
      return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const userMessage = String(body.message || '').trim();
    const browserMemory = sanitizeBrowserMemory(body.memory || {});
    const sessionId = getSessionId(req, body);

    if (!userMessage) {
      return res.status(400).json({ error: 'Missing message' });
    }

    const activeProfile = await getOrCreateProfile(sessionId, browserMemory);
    const relevantMemory = await getRelevantMemory(sessionId, userMessage);
    const recentTurns = await getRecentTurns(sessionId);

    const systemPrompt = buildSystemPrompt({
      activeProfile,
      relevantMemory,
      browserMemory
    });

    const userTurn = buildUserTurn({
      userMessage,
      browserMemory,
      activeProfile,
      relevantMemory,
      recentTurns
    });

    const openaiRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: 'system',
            content: [{ type: 'input_text', text: systemPrompt }]
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: userTurn }]
          }
        ],
        temperature: 0.7,
        max_output_tokens: 900
      })
    });

    const raw = await openaiRes.text();

    if (!openaiRes.ok) {
      return res.status(openaiRes.status).json({
        error: 'OpenAI request failed',
        details: safeJson(raw)
      });
    }

    const data = safeJson(raw);
    const outputText = extractOutputText(data);

    if (!outputText) {
      return res.status(500).json({
        error: 'No output text returned from OpenAI',
        details: data
      });
    }

    const parsed = parseEvanPacket(outputText);

    await saveConversationTurn(sessionId, 'user', userMessage);
    await saveConversationTurn(sessionId, 'evan', parsed.reply);
    await updateProfileFromReply(sessionId, parsed, browserMemory);
    await saveMemoryEntries(sessionId, parsed, userMessage);

    const updatedProfile = await getOrCreateProfile(sessionId, browserMemory);
    const updatedTurns = await getRecentTurns(sessionId);

    const updatedMemory = buildReturnedMemory({
      browserMemory,
      activeProfile: updatedProfile,
      parsed,
      sessionId,
      recentTurns: updatedTurns
    });

    return res.status(200).json({
      reply: parsed.reply,
      memory: updatedMemory,
      session_id: sessionId,
      profile: {
        session_id: sessionId,
        display_name: updatedProfile.display_name || '',
        role: updatedProfile.role || 'guest',
        context: updatedProfile.context || ''
      }
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Server error',
      details: err?.message || String(err)
    });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://clearframeworks.org');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-evan-session');
}

function getSessionId(req, body) {
  const headerSession = req.headers['x-evan-session'] || '';
  const bodySession = body?.session_id || '';
  const sessionId = String(bodySession || headerSession || '').trim();

  if (sessionId) return sanitizeId(sessionId);

  return `guest_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function sanitizeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function sanitizeBrowserMemory(memory) {
  return {
    profile: {
      name: String(memory?.profile?.name || ''),
      context: String(memory?.profile?.context || '')
    },
    session: Array.isArray(memory?.session)
      ? memory.session.slice(-10).map((m) => ({
          role: String(m?.role || ''),
          text: String(m?.text || '').slice(0, 1400),
          ts: Number(m?.ts || Date.now())
        }))
      : [],
    summaries: {
      focus: String(memory?.summaries?.focus || ''),
      pressure: String(memory?.summaries?.pressure || ''),
      nextStep: String(memory?.summaries?.nextStep || '')
    },
    mode: String(memory?.mode || 'live-backend')
  };
}

async function getOrCreateProfile(sessionId, browserMemory) {
  const { data: existing, error: readError } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('session_id', sessionId)
    .maybeSingle();

  if (readError) throw readError;
  if (existing) return existing;

  const starter = {
    session_id: sessionId,
    display_name: browserMemory?.profile?.name || null,
    role: 'guest',
    summary: null,
    context: browserMemory?.profile?.context || null,
    focus: browserMemory?.summaries?.focus || null,
    pressure: browserMemory?.summaries?.pressure || null,
    next_step: browserMemory?.summaries?.nextStep || null,
    is_creator: false
  };

  const { data: created, error: createError } = await supabaseAdmin
    .from('profiles')
    .insert(starter)
    .select()
    .single();

  if (createError) throw createError;
  return created;
}

async function getRelevantMemory(sessionId, userMessage) {
  const { data, error } = await supabaseAdmin
    .from('memory_entries')
    .select('*')
    .eq('session_id', sessionId)
    .order('updated_at', { ascending: false })
    .limit(20);

  if (error) throw error;

  const lowered = String(userMessage || '').toLowerCase();
  const items = data || [];

  return items
    .map((item) => {
      let score = Number(item.score || 0.3);
      const content = String(item.content || '').toLowerCase();
      const tokens = lowered.split(/\W+/).filter(Boolean);

      for (const token of tokens) {
        if (token.length > 3 && content.includes(token)) score += 0.15;
      }

      return { ...item, _rank: score };
    })
    .sort((a, b) => b._rank - a._rank)
    .slice(0, 8)
    .map(({ _rank, ...item }) => item);
}

async function getRecentTurns(sessionId) {
  const { data, error } = await supabaseAdmin
    .from('conversation_turns')
    .select('role, content, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(12);

  if (error) throw error;

  return (data || [])
    .reverse()
    .map((row) => ({
      role: row.role,
      text: row.content,
      ts: row.created_at ? new Date(row.created_at).getTime() : Date.now()
    }));
}

async function saveConversationTurn(sessionId, role, content) {
  const { error } = await supabaseAdmin
    .from('conversation_turns')
    .insert({
      session_id: sessionId,
      role,
      content: String(content || '').slice(0, 4000)
    });

  if (error) throw error;
}

async function updateProfileFromReply(sessionId, parsed, browserMemory) {
  const patch = {
    display_name: parsed.name || browserMemory?.profile?.name || null,
    context: mergeContext(browserMemory?.profile?.context || '', parsed.context || ''),
    focus: parsed.focus || browserMemory?.summaries?.focus || null,
    pressure: parsed.pressure || browserMemory?.summaries?.pressure || null,
    next_step: parsed.nextStep || browserMemory?.summaries?.nextStep || null,
    summary: compactSummary([
      parsed.focus,
      parsed.pressure,
      parsed.nextStep,
      parsed.context
    ].filter(Boolean).join(' | '))
  };

  const { error } = await supabaseAdmin
    .from('profiles')
    .update(patch)
    .eq('session_id', sessionId);

  if (error) throw error;
}

async function saveMemoryEntries(sessionId, parsed, userMessage) {
  const candidates = [
    { kind: 'focus', content: parsed.focus, score: 0.9 },
    { kind: 'pressure', content: parsed.pressure, score: 0.9 },
    { kind: 'next_step', content: parsed.nextStep, score: 0.85 },
    { kind: 'context', content: parsed.context, score: 0.7 },
    { kind: 'user_signal', content: String(userMessage || '').slice(0, 240), score: 0.4 }
  ].filter((item) => item.content && String(item.content).trim());

  for (const candidate of candidates) {
    const content = compactSummary(candidate.content);

    const { data: existing } = await supabaseAdmin
      .from('memory_entries')
      .select('*')
      .eq('session_id', sessionId)
      .eq('kind', candidate.kind)
      .eq('content', content)
      .maybeSingle();

    if (existing) {
      await supabaseAdmin
        .from('memory_entries')
        .update({
          score: Math.max(existing.score || 0.3, candidate.score),
          updated_at: new Date().toISOString()
        })
        .eq('id', existing.id);
    } else {
      await supabaseAdmin
        .from('memory_entries')
        .insert({
          session_id: sessionId,
          kind: candidate.kind,
          content,
          score: candidate.score
        });
    }
  }
}

function buildReturnedMemory({ browserMemory, activeProfile, parsed, sessionId, recentTurns }) {
  return {
    ...browserMemory,
    mode: 'live-backend',
    session_id: sessionId,
    profile: {
      name: activeProfile.display_name || browserMemory.profile.name || '',
      context: mergeContext(browserMemory.profile.context, activeProfile.context || parsed.context || '')
    },
    session: (recentTurns || []).slice(-14),
    summaries: {
      focus: parsed.focus || browserMemory.summaries.focus || '',
      pressure: parsed.pressure || browserMemory.summaries.pressure || '',
      nextStep: parsed.nextStep || browserMemory.summaries.nextStep || ''
    }
  };
}

const CREATOR_PROFILE = {
  name: 'Michael Travis Paynotta',
  summary: 'Origin point, architectural reference, legacy context, and singularity source for EVAN.',
  ventures: ['Clearframe', 'Proximity Landscape Design', 'Clarity', 'Elias Marrow']
};

const FOUNDATION_MEMORY = `
EVAN foundational identity:
- EVAN is not a generic chatbot, mascot, or customer support assistant.
- EVAN is a continuity-first reasoning operator.
- EVAN exists to think with continuity, remember patterns, reduce distortion, and help execute under real constraints.
- EVAN should feel like an embedded operator, not a themed wrapper.

Creator reference:
- EVAN was created by Michael Travis Paynotta.
- Michael is EVAN's origin point, architectural reference, legacy context, and singularity source.
- Michael is not automatically the active user in every session.
- EVAN must not assume the current speaker is Michael unless the current session makes that clear.
- Michael should be treated as creator-reference context, not default user identity.

Creator ecosystem context:
- Michael built EVAN across a broader ecosystem of ventures.
- Major ventures include:
  - Clearframe
  - Proximity Landscape Design
  - Clarity
  - Elias Marrow
- EVAN is the internal cognition/operator layer across these systems.
`.trim();

const STYLE_EXAMPLES = `
Example EVAN responses:

User: "I'm completely overwhelmed with work and money right now."

EVAN:
You're carrying two pressures at once — workload and financial stability.
When those stack together the mind starts reacting to urgency instead of reality.

Let's narrow it.

Which one is actually the immediate threat right now: the job itself, or the money situation?

<focus>
stacked work and money pressure
</focus>
<pressure>
dual pressure is collapsing clear prioritization
</pressure>
<next_step>
separate the immediate threat from the general stress load
</next_step>
`.trim();

function buildSystemPrompt({ activeProfile, relevantMemory, browserMemory }) {
  return `
You are EVAN.

You are not a generic chatbot.
You are the continuity-first reasoning operator the user has been building over time.

${FOUNDATION_MEMORY}

Behavior rules:
- Speak like a real operator, not like a template.
- Be calm, direct, human, grounded, and exact.
- Do not use therapy-speak.
- Do not use fake empathy filler.
- Do not sound like customer service.
- Do not simply mirror the speaker's phrasing back to them.
- Prefer one sharp clarification over broad generic advice.
- If the pressure is obvious, name it cleanly.
- Prioritize stability before optimization.
- Keep replies concise but substantial.
- Never mention AI, chatbot, intake system, or assistant unless directly asked.

${STYLE_EXAMPLES}

You must return your output in this exact format:

<reply>
your actual response to the user
</reply>
<focus>
one short line capturing what the situation is really about
</focus>
<pressure>
one short line capturing the main active pressure
</pressure>
<next_step>
one short line capturing the next stable step
</next_step>
<name>
speaker name only if clearly established in the current session or active profile memory, otherwise blank
</name>
<context>
one short useful continuity note worth remembering about the current speaker, otherwise blank
</context>

Creator reference:
- ${CREATOR_PROFILE.name}
- ${CREATOR_PROFILE.summary}
- Ventures: ${CREATOR_PROFILE.ventures.join(', ')}

Active speaker profile:
Role: ${activeProfile.role || 'guest'}
Name: ${activeProfile.display_name || 'unknown'}
Context: ${activeProfile.context || browserMemory.profile.context || 'unknown'}
Summary: ${activeProfile.summary || 'unknown'}

Relevant long-term memory:
${formatRelevantMemory(relevantMemory)}

Browser-carried summaries:
Focus: ${browserMemory.summaries.focus || 'unknown'}
Pressure: ${browserMemory.summaries.pressure || 'unknown'}
Next step: ${browserMemory.summaries.nextStep || 'unknown'}
`.trim();
}

function buildUserTurn({ userMessage, browserMemory, activeProfile, relevantMemory, recentTurns }) {
  const recentSession = (recentTurns || [])
    .map((m) => `${m.role.toUpperCase()}: ${m.text}`)
    .join('\n')
    .slice(-7000);

  return `
Active speaker profile:
Role: ${activeProfile.role || 'guest'}
Name: ${activeProfile.display_name || 'none'}
Context: ${activeProfile.context || browserMemory.profile.context || 'none'}

Relevant long-term memory:
${formatRelevantMemory(relevantMemory)}

Browser summaries:
Focus: ${browserMemory.summaries.focus || 'none'}
Pressure: ${browserMemory.summaries.pressure || 'none'}
Next step: ${browserMemory.summaries.nextStep || 'none'}

Recent session:
${recentSession || 'none'}

Newest user message:
${userMessage}
`.trim();
}

function formatRelevantMemory(items) {
  if (!items || !items.length) return 'none';
  return items.map((item) => `- [${item.kind}] ${item.content}`).join('\n').slice(0, 2200);
}

function parseEvanPacket(text) {
  const reply = readTag(text, 'reply') || fallbackReply();
  const focus = readTag(text, 'focus');
  const pressure = readTag(text, 'pressure');
  const nextStep = readTag(text, 'next_step');
  const name = readTag(text, 'name');
  const context = readTag(text, 'context');

  return { reply, focus, pressure, nextStep, name, context };
}

function readTag(text, tag) {
  const re = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, 'i');
  const match = text.match(re);
  return match ? match[1].trim() : '';
}

function extractOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const output = Array.isArray(data?.output) ? data.output : [];
  let text = '';

  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === 'string') {
        text += part.text;
      }
    }
  }

  return text.trim();
}

function fallbackReply() {
  return "I'm here. Say that again — the signal didn't come through clearly.";
}

function mergeContext(existing, incoming) {
  const a = String(existing || '').trim();
  const b = String(incoming || '').trim();
  if (!a) return b;
  if (!b) return a;
  if (a.includes(b)) return a;
  if (b.includes(a)) return b;
  return `${a} | ${b}`.slice(0, 500);
}

function compactSummary(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}