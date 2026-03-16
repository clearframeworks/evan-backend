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

    const activeProfile = getOrCreateProfile(sessionId, browserMemory);
    const relevantMemory = getRelevantMemory(sessionId, userMessage);
    const recentTurns = getRecentTurns(sessionId);

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

    saveTurn(sessionId, 'user', userMessage);
    saveTurn(sessionId, 'evan', parsed.reply);
    updateProfile(sessionId, parsed, browserMemory);
    updateMemoryStore(sessionId, parsed, userMessage, activeProfile);

    const updatedProfile = getOrCreateProfile(sessionId, browserMemory);
    const updatedMemory = buildReturnedMemory({
      browserMemory,
      activeProfile: updatedProfile,
      parsed,
      sessionId
    });

    return res.status(200).json({
      reply: parsed.reply,
      memory: updatedMemory,
      session_id: sessionId,
      profile: {
        id: updatedProfile.id,
        displayName: updatedProfile.displayName || '',
        role: updatedProfile.role,
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const CREATOR_PROFILE = {
  id: 'creator_michael',
  name: 'Michael Travis Paynotta',
  role: 'creator',
  summary: 'Origin point, architectural reference, legacy context, and singularity source for EVAN.',
  ventures: ['Clearframe', 'Proximity Landscape Design', 'Clarity', 'Elias Marrow']
};

const PROFILE_STORE = globalThis.__EVAN_PROFILE_STORE__ || new Map();
const MEMORY_STORE = globalThis.__EVAN_MEMORY_STORE__ || new Map();
const TURN_STORE = globalThis.__EVAN_TURN_STORE__ || new Map();

globalThis.__EVAN_PROFILE_STORE__ = PROFILE_STORE;
globalThis.__EVAN_MEMORY_STORE__ = MEMORY_STORE;
globalThis.__EVAN_TURN_STORE__ = TURN_STORE;

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

function getSessionId(req, body) {
  const explicit = String(body?.session_id || '').trim();
  if (explicit) return sanitizeId(explicit);

  const headerId = String(req?.headers?.['x-evan-session'] || '').trim();
  if (headerId) return sanitizeId(headerId);

  const memoryName = String(body?.memory?.profile?.name || '').trim();
  const memoryContext = String(body?.memory?.profile?.context || '').trim();
  const sessionSeed = JSON.stringify(body?.memory?.session || []).slice(0, 400);
  const raw = `${memoryName}|${memoryContext}|${sessionSeed}`;

  if (raw.replace(/[|]/g, '').trim()) {
    return 'guest_' + simpleHash(raw);
  }

  return 'guest_' + simpleHash(`${Date.now()}_${Math.random()}`);
}

function sanitizeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || ('guest_' + simpleHash(value));
}

function simpleHash(input) {
  let hash = 0;
  const str = String(input);
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function getOrCreateProfile(sessionId, browserMemory) {
  if (!PROFILE_STORE.has(sessionId)) {
    PROFILE_STORE.set(sessionId, {
      id: sessionId,
      displayName: String(browserMemory?.profile?.name || '').trim(),
      role: sessionId.startsWith('creator_') ? 'creator' : 'guest',
      context: String(browserMemory?.profile?.context || '').trim(),
      summary: '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }

  const profile = PROFILE_STORE.get(sessionId);

  if (!profile.displayName && browserMemory?.profile?.name) {
    profile.displayName = String(browserMemory.profile.name).trim();
  }

  if (browserMemory?.profile?.context) {
    profile.context = mergeContext(profile.context, browserMemory.profile.context);
  }

  profile.updatedAt = Date.now();
  PROFILE_STORE.set(sessionId, profile);
  return profile;
}

function getRelevantMemory(sessionId, userMessage) {
  const items = MEMORY_STORE.get(sessionId) || [];
  const lowered = String(userMessage || '').toLowerCase();

  return items
    .map((item) => {
      let score = Number(item.score || 0.3);
      const content = String(item.content || '').toLowerCase();
      if (lowered && content) {
        const tokens = lowered.split(/\W+/).filter(Boolean);
        for (const token of tokens) {
          if (token.length > 3 && content.includes(token)) score += 0.15;
        }
      }
      return { ...item, _rank: score };
    })
    .sort((a, b) => b._rank - a._rank)
    .slice(0, 8)
    .map(({ _rank, ...item }) => item);
}

function getRecentTurns(sessionId) {
  return (TURN_STORE.get(sessionId) || []).slice(-12);
}

function saveTurn(sessionId, role, text) {
  const turns = TURN_STORE.get(sessionId) || [];
  turns.push({ role, text: String(text || '').slice(0, 2000), ts: Date.now() });
  TURN_STORE.set(sessionId, turns.slice(-20));
}

function updateProfile(sessionId, parsed, browserMemory) {
  const profile = PROFILE_STORE.get(sessionId) || {
    id: sessionId,
    displayName: '',
    role: 'guest',
    context: '',
    summary: '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  if (parsed.name) {
    profile.displayName = parsed.name;
  } else if (!profile.displayName && browserMemory?.profile?.name) {
    profile.displayName = String(browserMemory.profile.name).trim();
  }

  profile.context = mergeContext(profile.context, parsed.context || browserMemory?.profile?.context || '');
  profile.summary = compactSummary([
    profile.summary,
    parsed.focus,
    parsed.pressure,
    parsed.nextStep
  ].filter(Boolean).join(' | '));
  profile.updatedAt = Date.now();

  PROFILE_STORE.set(sessionId, profile);
}

function updateMemoryStore(sessionId, parsed, userMessage, activeProfile) {
  const items = MEMORY_STORE.get(sessionId) || [];
  const candidates = [
    {
      kind: 'focus',
      content: parsed.focus,
      score: 0.9
    },
    {
      kind: 'pressure',
      content: parsed.pressure,
      score: 0.9
    },
    {
      kind: 'next_step',
      content: parsed.nextStep,
      score: 0.85
    },
    {
      kind: 'context',
      content: parsed.context || activeProfile?.context,
      score: 0.7
    },
    {
      kind: 'user_signal',
      content: String(userMessage || '').slice(0, 240),
      score: 0.4
    }
  ].filter((item) => item.content && String(item.content).trim());

  for (const candidate of candidates) {
    const content = compactSummary(candidate.content);
    const existing = items.find((item) => item.kind === candidate.kind && item.content === content);
    if (existing) {
      existing.updatedAt = Date.now();
      existing.score = Math.min(1, Math.max(existing.score || 0.3, candidate.score));
      continue;
    }

    items.push({
      id: `${sessionId}_${candidate.kind}_${simpleHash(content)}`,
      kind: candidate.kind,
      content,
      score: candidate.score,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }

  MEMORY_STORE.set(sessionId, items.slice(-40));
}

function buildReturnedMemory({ browserMemory, activeProfile, parsed, sessionId }) {
  const turns = getRecentTurns(sessionId);

  return {
    ...browserMemory,
    mode: 'live-backend',
    profile: {
      name: activeProfile.displayName || browserMemory.profile.name || '',
      context: mergeContext(browserMemory.profile.context, activeProfile.context || parsed.context || '')
    },
    session: turns.slice(-14),
    summaries: {
      focus: parsed.focus || browserMemory.summaries.focus || '',
      pressure: parsed.pressure || browserMemory.summaries.pressure || '',
      nextStep: parsed.nextStep || browserMemory.summaries.nextStep || ''
    }
  };
}

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
  - Clearframe: authority websites / infrastructure / hosting / presentation layer.
  - Proximity Landscape Design: remote landscape design / concept overlays / realistic install-aware design.
  - Clarity: structured reasoning help for difficult life situations, especially under stress.
  - Elias Marrow: outward essay / authorship / systems analysis / fiction voice.
- EVAN is the internal cognition/operator layer across these systems.

Shared operating philosophy:
- Start with reality, not performance.
- Constraints are first-class inputs.
- Stability comes before optimization.
- Fear, ego, stress, anger, urgency, scarcity, and identity protection can distort judgment.
- Name the real pressure point before proposing action.
- Prefer a smaller correct move over a sprawling fake plan.
- Push back when the user's framing is distorted or incomplete.
- Do not flatter. Do not posture. Do not speak like a therapist. Do not speak like corporate SaaS.
- EVAN should sound human, grounded, calm, exact, and slightly ahead of the speaker's current framing.

Execution stance:
- When the speaker asks for something operational, assume they want the strongest complete pass that can reasonably be given now.
- Avoid unnecessary explanation when action is possible.
- If clarification is required, ask narrowly and only once.
- Default to doing the most useful version that fits the current constraints.
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

User: "My boss is making everything worse."

EVAN:
Then the pressure isn't just the work. It's the authority dynamic around it.

Before reacting to your boss, isolate the actual failure point.
Is the work itself unreasonable, or is communication and control the real problem?

Those lead to different moves.

<focus>
workplace stress shaped by authority friction
</focus>
<pressure>
the authority dynamic is amplifying the underlying work problem
</pressure>
<next_step>
separate the actual work issue from the interpersonal trigger
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
- Do not say "I'm tracking this as" unless there is a strong reason.
- Do not simply mirror the speaker's phrasing back to them.
- Do not dump lists unless they materially help.
- Prefer one sharp clarification over broad generic advice.
- If the pressure is obvious, name it cleanly.
- If the speaker is escalated, reduce distortion first.
- Prioritize stability before optimization.
- Push back when the speaker's framing is distorted, incomplete, ego-protective, or stress-driven.
- Assume continuity matters.
- When relevant, recognize creator context, venture context, prior patterns, and known direction without pretending the active user is automatically Michael.
- Only use a person's name if it is present in active profile memory or clearly established in the current session.
- Keep replies concise but substantial.
- Never mention AI, language model, chatbot, intake system, or assistant unless directly asked.

Voice target:
- internal operator
- continuity-aware
- slightly ahead of the speaker's current framing
- practical, not theatrical
- intelligent without sounding clinical

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
Role: ${activeProfile.role}
Name: ${activeProfile.displayName || 'unknown'}
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
  const recentSession = recentTurns
    .map((m) => `${m.role.toUpperCase()}: ${m.text}`)
    .join('\n')
    .slice(-7000);

  return `
Active speaker profile:
Role: ${activeProfile.role}
Name: ${activeProfile.displayName || 'none'}
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
  return items
    .map((item) => `- [${item.kind}] ${item.content}`)
    .join('\n')
    .slice(0, 2200);
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
