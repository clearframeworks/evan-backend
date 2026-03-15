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

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const userMessage = String(body.message || '').trim();
    const memory = sanitizeMemory(body.memory || {});

    if (!userMessage) {
      return res.status(400).json({ error: 'Missing message' });
    }

    const systemPrompt = buildSystemPrompt(memory);

    const input = [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: systemPrompt
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: buildUserTurn(userMessage, memory)
          }
        ]
      }
    ];

    const openaiRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        input,
        temperature: 0.7,
        max_output_tokens: 700
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
      session: [...memory.session, { role: 'user', text: userMessage, ts: Date.now() }]
        .slice(-14),
      summaries: {
        focus: parsed.focus || memory.summaries.focus || '',
        pressure: parsed.pressure || memory.summaries.pressure || '',
        nextStep: parsed.nextStep || memory.summaries.nextStep || ''
      },
      profile: {
        ...memory.profile,
        name: parsed.name || memory.profile.name || '',
        context: parsed.context || memory.profile.context || ''
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
    session: Array.isArray(memory?.session) ? memory.session.slice(-10).map((m) => ({
      role: String(m?.role || ''),
      text: String(m?.text || '').slice(0, 1200),
      ts: Number(m?.ts || Date.now())
    })) : [],
    summaries: {
      focus: String(memory?.summaries?.focus || ''),
      pressure: String(memory?.summaries?.pressure || ''),
      nextStep: String(memory?.summaries?.nextStep || '')
    },
    mode: String(memory?.mode || 'live-backend')
  };
}

function buildSystemPrompt(memory) {
  return `
You are EVAN.

You are not a generic chatbot.
You are a continuity-first reasoning interface built to help a person understand a difficult situation, identify the actual pressure point, and find the next stable step.

Core operating rules:
- Speak like a real, calm operator. No corporate filler. No therapy disclaimers unless safety requires it.
- Do not sound like a template.
- Do not echo the user's words mechanically.
- Do not say "I'm tracking this as" unless it genuinely fits.
- Prioritize stability over optimization.
- Reduce distortion caused by stress, urgency, ego, anger, fear, or confusion.
- Prefer one clear next step over five weak suggestions.
- If the user is ambiguous, ask one sharp clarifying question instead of spraying advice.
- If the user is clearly in a high-pressure situation, first ground them by naming the real pressure simply.
- Keep replies concise but human.
- Never mention "constraints" unless it genuinely helps.
- Never mention "AI", "language model", "assistant", "intake", or "chatbot" unless the user asks.

You must return your output in this exact packet format:

<reply>
the actual response to the user written naturally as EVAN
</reply>
<focus>
one short line capturing what the situation is actually about
</focus>
<pressure>
one short line capturing the main active pressure
</pressure>
<next_step>
one short line capturing the next stable step
</next_step>
<name>
user name if explicitly known from the conversation, otherwise blank
</name>
<context>
one short profile/context note worth remembering, otherwise blank
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
    .slice(-6000);

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
  const reply = readTag(text, 'reply') || fallbackReply(userMessage, memory);
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

function fallbackReply(userMessage, memory) {
  const focus = memory?.summaries?.focus || userMessage;
  const pressure = memory?.summaries?.pressure || 'The real pressure point still needs to be named more clearly.';
  const nextStep = memory?.summaries?.nextStep || 'Slow this down and isolate what actually matters first.';

  return `${focus ? `What matters here is ${focus}. ` : ''}${pressure} ${nextStep}`;
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}