// Minimal Ollama chat client (native /api/chat with tool support).
export function createOllama({ url, model }) {
  async function chat({ messages, tools = [] }) {
    const body = { model, messages, stream: false };
    if (tools.length) body.tools = tools;
    const r = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()).message; // { role, content, tool_calls? }
  }

  async function healthy() {
    try {
      const r = await fetch(`${url}/api/tags`);
      if (!r.ok) return false;
      const tags = await r.json();
      return (tags.models ?? []).some(m => m.name === model || m.name.startsWith(model + ':'));
    } catch { return false; }
  }

  return { chat, healthy, url, model };
}
