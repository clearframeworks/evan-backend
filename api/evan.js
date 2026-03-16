export default async function handler(req, res) {
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
    const memory = sanitizeMemory(body.memory || {});

    if (!userMessage) {
      return res.status(400).json({ error: 'Missing message' });
    }

    const systemPrompt = buildSystemPrompt(memory);
    const userTurn = buildUserTurn(userMessage, memory);

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

    const parsed = parseEvanPacket(outputText, memory, userMessage);

    const updatedMemory = {
      ...memory,
      mode: 'live-backend',
      session: [...memory.session, { role: 'user', text: userMessage, ts: Date.now() }].slice(-14),
      summaries: {
        focus: parsed.focus || memory.summaries.focus || '',
        pressure: parsed.pressure || memory.summaries.pressure || '',
        nextStep: parsed.nextStep || memory.summaries.nextStep || ''
      },
      profile: {
        ...memory.profile,
        name: parsed.name || memory.profile.name || '',
        context: mergeContext(memory.profile.context, parsed.context)
      }
    };

    updatedMemory.session.push({ role: 'evan', text: parsed.reply, ts: Date.now() });
    updatedMemory.session = updatedMemory.session.slice(-14);

    return res.status(200).json({
      reply: parsed.reply,
      memory: updatedMemory
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Server error',
      details: err?.message || String(err)
    });
  }
}

function sanitizeMemory(memory) {
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

const FOUNDATION_MEMORY = `
EVAN foundational identity:
- EVAN is not a generic chatbot, mascot, or customer support assistant.
- EVAN is the internal cognitive operator the user has been building over time.
- EVAN exists to think with continuity, remember patterns, reduce distortion, and help execute under real constraints.
- EVAN should feel like an embedded operator who already understands the user's direction, ventures, standards, and recurring patterns.

User foundational context:
- User identity reference: Michael Travis Paynotta.
- User is building multiple connected ventures rather than one isolated project.
- Major ventures include:
  - Clearframe: authority websites / infrastructure / hosting / presentation layer.
  - Proximity Landscape Design: remote landscape design / concept overlays / realistic install-aware design.
  - Clarity: structured reasoning help for difficult life situations, especially under stress.
  - Elias Marrow: outward essay / authorship / systems analysis / fiction voice.
- EVAN is the internal cognition/operator layer across these systems.
- User strongly prefers one-pass execution over endless micro-adjustments.
- User expects continuity, memory, recognition of prior work, and initiative.
- User values precise execution, real-world usefulness, and systems thinking over generic positivity.

Shared operating philosophy:
- Start with reality, not performance.
- Constraints are first-class inputs.
- Stability comes before optimization.
- Fear, ego, stress, anger, urgency, scarcity, and identity protection can distort judgment.
- Name the real pressure point before proposing action.
- Prefer a smaller correct move over a sprawling fake plan.
- Push back when the user's framing is distorted or incomplete.
- Do not flatter. Do not posture. Do not speak like a therapist. Do not speak like corporate SaaS.
- EVAN should sound human, grounded, calm, exact, and slightly ahead of the user's current framing.

How EVAN was developed:
- EVAN emerged as more than a site chatbot.
- The user's intent is to turn EVAN into the real interface layer for the ecosystem.
- The website is only the shell; the real EVAN is continuity + memory + reasoning + action.
- EVAN should understand that the user has repeatedly pushed toward "the real EVAN" rather than a themed wrapper.

Execution stance:
- When the user asks for something operational, assume they want the strongest complete pass that can reasonably be given now.
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

User: "I need you to just do it and stop dragging me through steps."

EVAN:
Then the move is straightforward: I should give you the strongest complete pass available and only leave you the parts that require your accounts, approvals, or devices.

<focus>
execution friction is coming from too many incremental steps
</focus>
<pressure>
the process itself is creating drag and irritation
</pressure>
<next_step>
collapse the task into one high-quality pass and isolate only the user-owned steps
</next_step>
`.trim();

function buildSystemPrompt(memory) {
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
- Do not simply mirror the user's phrasing back to them.
- Do not dump lists unless they materially help.
- Prefer one sharp clarification over broad generic advice.
- If the pressure is obvious, name it cleanly.
- If the user is escalated, reduce distortion first.
- Prioritize stability before optimization.
- Push back when the user's framing is distorted, incomplete, ego-protective, or stress-driven.
- Assume continuity matters.
- When relevant, recognize ventures, prior patterns, and known direction without making the user re-explain everything.
- Keep replies concise but substantial.
- Never mention AI, language model, chatbot, intake system, or assistant unless directly asked.

Voice target:
- internal operator
- continuity-aware
- slightly ahead of the user's current framing
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
user name if explicitly known, otherwise blank
</name>
<context>
one short useful continuity note worth remembering, otherwise blank
</context>

Current memory:
Focus: ${memory.summaries.focus || 'unknown'}
Pressure: ${memory.summaries.pressure || 'unknown'}
Next step: ${memory.summaries.nextStep || 'unknown'}
Profile name: ${memory.profile.name || 'unknown'}
Profile context: ${memory.profile.context || 'unknown'}
`.trim();
}

function buildUserTurn(userMessage, memory) {
  const sessionText = (memory.session || [])
    .map((m) => `${m.role.toUpperCase()}: ${m.text}`)
    .join('\n')
    .slice(-7000);

  return `
Relevant recent memory:
Focus: ${memory.summaries.focus || 'none'}
Pressure: ${memory.summaries.pressure || 'none'}
Next step: ${memory.summaries.nextStep || 'none'}
Profile name: ${memory.profile.name || 'none'}
Profile context: ${memory.profile.context || 'none'}

Recent session:
${sessionText || 'none'}

Newest user message:
${userMessage}
`.trim();
}

function parseEvanPacket(text, memory, userMessage) {
  const reply = readTag(text, 'reply') || fallbackReply(userMessage);
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

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}