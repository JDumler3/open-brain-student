// call-llm — your LLM gateway.
// To switch providers, change LLM_PROVIDER in Supabase secrets. Add the new provider's API key. No other code changes needed.
//
// Secrets this function reads:
//   LLM_PROVIDER   'anthropic' (default) | 'openai' | 'google'
//   LLM_MODEL      the model name for that provider
//   ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY  (only the one you use)
//   LLM_PRICE_INPUT_PER_MTOK / LLM_PRICE_OUTPUT_PER_MTOK  (optional: dollars per million tokens, for your receipts)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  (provided automatically by Supabase)

import { createClient } from "jsr:@supabase/supabase-js@2";

type LlmResult = { text: string; promptTokens: number; completionTokens: number };
type LlmCall = (prompt: string, systemPrompt: string | undefined, model: string, maxTokens: number) => Promise<LlmResult>;

function requireKey(name: string): string {
  const key = Deno.env.get(name);
  if (!key) throw new Error(`${name} is not set in Supabase secrets`);
  return key;
}

// ── Provider adapters: each one speaks one company's API and returns the same shape ──

const callAnthropic: LlmCall = async (prompt, systemPrompt, model, maxTokens) => {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": requireKey("ANTHROPIC_API_KEY"),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${JSON.stringify(data)}`);
  const text = (data.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");
  return { text, promptTokens: data.usage?.input_tokens ?? 0, completionTokens: data.usage?.output_tokens ?? 0 };
};

const callOpenAI: LlmCall = async (prompt, systemPrompt, model, maxTokens) => {
  const messages = [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    { role: "user", content: prompt },
  ];
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireKey("OPENAI_API_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, messages, max_completion_tokens: maxTokens }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${JSON.stringify(data)}`);
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
};

const callGoogle: LlmCall = async (prompt, systemPrompt, model, maxTokens) => {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": requireKey("GOOGLE_API_KEY"), "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Google error ${res.status}: ${JSON.stringify(data)}`);
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p: { text?: string }) => p.text ?? "")
    .join("");
  return {
    text,
    promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
    completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
};

const providers: Record<string, LlmCall> = {
  anthropic: callAnthropic,
  openai: callOpenAI,
  google: callGoogle,
};

// ── Receipts: a failed log must NEVER fail the call. The AI already answered. ──

function logUsage(userId: string | undefined, source: string | undefined, model: string, r: LlmResult) {
  const task = (async () => {
    try {
      const url = Deno.env.get("SUPABASE_URL");
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!url || !serviceKey || !userId) return;
      const inPrice = Number(Deno.env.get("LLM_PRICE_INPUT_PER_MTOK") ?? 0) || 0;
      const outPrice = Number(Deno.env.get("LLM_PRICE_OUTPUT_PER_MTOK") ?? 0) || 0;
      const cost = (r.promptTokens * inPrice + r.completionTokens * outPrice) / 1_000_000;
      const supabase = createClient(url, serviceKey);
      const { error } = await supabase.from("llm_usage").insert({
        user_id: userId,
        kind: "chat",
        model,
        source: source ?? null,
        prompt_tokens: r.promptTokens,
        completion_tokens: r.completionTokens,
        cost_usd: cost,
      });
      if (error) console.warn("Usage log failed (ignored):", error.message);
    } catch (e) {
      console.warn("Usage log failed (ignored):", e);
    }
  })();
  // Send the answer back right away; let the receipt finish in the background.
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(task);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ── The gateway itself ──

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  let body: {
    prompt?: string;
    systemPrompt?: string;
    model?: string;
    maxTokens?: number;
    userId?: string;
    source?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Request body must be JSON" }, 400);
  }

  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    return json({ error: "Missing 'prompt'" }, 400);
  }

  const provider = (Deno.env.get("LLM_PROVIDER") ?? "anthropic").toLowerCase();
  const call = providers[provider];
  if (!call) return json({ error: `Unknown LLM_PROVIDER '${provider}'` }, 500);

  const model = body.model ?? Deno.env.get("LLM_MODEL");
  if (!model) return json({ error: "LLM_MODEL is not set in Supabase secrets" }, 500);

  const maxTokens = Number(body.maxTokens) || 1024;

  try {
    const result = await call(body.prompt, body.systemPrompt, model, maxTokens);
    logUsage(body.userId, body.source, model, result);
    return json({ text: result.text });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("call-llm failed:", message);
    return json({ error: message }, 502);
  }
});