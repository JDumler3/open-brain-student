// enrich-thought — runs every time a new thought is saved.
// Asks the AI (through YOUR gateway, call-llm) for tags, a category and a one-line summary,
// then writes them back onto the thought. Never calls an AI provider directly.

import { createClient } from "jsr:@supabase/supabase-js@2";

const CATEGORIES = ["idea", "learning", "question", "reference", "plan", "reflection"];

const SYSTEM_PROMPT = `You organize notes in a personal knowledge base.
Reply with ONLY a JSON object, no other text, in exactly this shape:
{"tags": ["tag1", "tag2", "tag3"], "category": "learning", "summary": "One sentence."}
Rules:
- tags: 3 to 5 short lowercase tags (1-3 words each)
- category: exactly one of: ${CATEGORIES.join(", ")}
- summary: one sentence, max 25 words, in plain language`;

function parseEnrichment(text: string) {
  // Models sometimes wrap JSON in ``` fences or add a sentence — grab just the {...} part.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON in AI reply");
  const raw = JSON.parse(text.slice(start, end + 1));

  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t: unknown) => typeof t === "string").map((t: string) => t.trim().toLowerCase()).filter(Boolean).slice(0, 5)
    : [];
  const category = CATEGORIES.includes(String(raw.category).toLowerCase())
    ? String(raw.category).toLowerCase()
    : "reference";
  const summary = typeof raw.summary === "string" ? raw.summary.trim().slice(0, 300) : null;

  return { tags, category, summary };
}

// deno-lint-ignore no-explicit-any
async function enrich(record: any) {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const content: string = record.content ?? record.text ?? record.body ?? "";
  const thoughtId = record.id;
  const userId = record.user_id ?? Deno.env.get("OWNER_USER_ID");

  if (!thoughtId) return console.log("Skipped: no id on record");
  if (record.category === "digest") return console.log("Skipped: digest thought");
  if (record.enriched_at) return console.log("Skipped: already enriched");
  if (content.trim().length < 20) return console.log("Skipped: content under 20 characters");

  // Call YOUR gateway — with the Authorization header, or it gets a silent 401.
  const res = await fetch(`${url}/functions/v1/call-llm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      systemPrompt: SYSTEM_PROMPT,
      prompt: `Note:\n"""\n${content.slice(0, 8000)}\n"""`,
      maxTokens: 300,
      userId,
      source: "enrich-thought",
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`call-llm returned ${res.status}: ${JSON.stringify(data)}`);

  const { tags, category, summary } = parseEnrichment(data.text ?? "");

  const supabase = createClient(url, serviceKey);
  const { error } = await supabase
    .from("thoughts")
    .update({ tags, category, summary, enriched_at: new Date().toISOString() })
    .eq("id", thoughtId);

  if (error) throw new Error(`Update failed: ${error.message}`);
  console.log(`Enriched ${thoughtId}: [${category}] ${tags.join(", ")}`);
}

Deno.serve(async (req) => {
  // Webhook functions always answer 200 — a failed enrichment must never break a save.
  let payload;
  try {
    payload = await req.json();
  } catch {
    return new Response("ok", { status: 200 });
  }

  const record = payload?.record;
  if (!record) {
    console.log("Skipped: no record in payload");
    return new Response("ok", { status: 200 });
  }

  // Answer the webhook immediately; do the AI work in the background
  // so the webhook never times out waiting.
  const task = enrich(record).catch((e) => console.error("Enrichment failed:", e instanceof Error ? e.message : e));
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(task);
  else await task;

  return new Response("ok", { status: 200 });
});