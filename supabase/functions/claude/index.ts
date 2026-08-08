// ═══════════════════════════════════════════════════════════════════════════
// Edge Function: claude
// Server-side proxy to the Anthropic Messages API. Holds ANTHROPIC_API_KEY as a
// Supabase secret so the browser never sees it. The frontend posts the same
// body it would send to Anthropic ({ model, max_tokens, messages }); this
// forwards it and returns Anthropic's response verbatim (the frontend already
// parses { content: [...] } / { error }).
//
// Deploy:
//   supabase functions deploy claude
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   [CLAUDE_MODEL=...]
// Then set the frontend's VITE_CLAUDE_PROXY_URL to this function's URL.
// ═══════════════════════════════════════════════════════════════════════════

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const DEFAULT_MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-4-5";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: { message: "POST only" } }, 405);
  if (!ANTHROPIC_API_KEY) return json({ error: { message: "ANTHROPIC_API_KEY not set on the function" } }, 500);

  let body: {
    model?: string; max_tokens?: number; messages?: unknown;
    system?: unknown; tools?: unknown; tool_choice?: unknown; temperature?: number;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: { message: "invalid JSON body" } }, 400);
  }
  if (!body?.messages) return json({ error: { message: "messages[] required" } }, 400);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: body.model ?? DEFAULT_MODEL,
        max_tokens: body.max_tokens ?? 1000,
        messages: body.messages,
        // Forward the rest instead of dropping it. Rebuilding the body from a
        // fixed list of fields is what silently disabled web search: the tools
        // array never left this function.
        ...(body.system !== undefined ? { system: body.system } : {}),
        ...(body.tools !== undefined ? { tools: body.tools } : {}),
        ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      }),
    });
    const data = await res.json();
    return json(data, res.status);
  } catch (e) {
    return json({ error: { message: `proxy error: ${String(e)}` } }, 502);
  }
});
