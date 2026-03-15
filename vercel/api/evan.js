export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { message, memory, system } = req.body || {};
    if (!message) return res.status(400).json({ error: 'Missing message' });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });

    const history = Array.isArray(memory?.session) ? memory.session.slice(-10) : [];

    const instructions = `${system || ''}

Use the provided memory when relevant. Respond as EVAN in plain human language. Be specific, calm, continuity-aware, and constraint-first. Avoid filler. Keep replies concise but substantive.`;

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-5-mini',
        instructions,
        input: [
          ...history.map(item => ({
            role: item.role === 'evan' ? 'assistant' : 'user',
            content: [{ type: 'input_text', text: item.text }]
          })),
          { role: 'user', content: [{ type: 'input_text', text: message }] }
        ]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data?.error?.message || 'OpenAI request failed' });
    }

    const reply = data.output_text || data.output?.map(o => o?.content?.map(c => c?.text).join(' ')).join(' ').trim() || 'I hit a formatting issue, but I am still here.';

    const nextMemory = memory || { session: [], summaries: {}, mode: 'live-backend' };
    nextMemory.mode = 'live-backend';
    nextMemory.session = [...(nextMemory.session || []), { role: 'user', text: message, ts: Date.now() }, { role: 'evan', text: reply, ts: Date.now() }].slice(-14);

    return res.status(200).json({ reply, memory: nextMemory });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error' });
  }
}
