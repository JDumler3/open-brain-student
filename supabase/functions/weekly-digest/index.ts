// weekly-digest — reads the last 7 days of thoughts and writes a report on your own mind.
// Called every Sunday by pg_cron. Calls the AI only through YOUR gateway, call-llm.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SYSTEM_PROMPT = `You write a weekly digest for someone's personal knowledge base.
You are given their notes from the past 7 days, grouped by category.
Write in second person ("you"), warm but concise, in plain text (no markdown tables).
Structure:
1. WHAT YOU WERE LEARNING — a short paragraph per major thread
2. KEY THEMES — 3 to 5 bullet points
3. A QUESTION YOU SEEM TO BE EXPLORING — one question, with one sentence on why you think so
Only use what is in the notes. Do not invent details.`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async () => {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(url, serviceKey);

  // 1. Get the last 7 days of thoughts
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("thoughts")
    .select("*")
    .gte("created_at", since)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Could not read thoughts:", error.message);
    return json({ error: error.message }, 500);
  }

  const recent = (data ?? []).filter((t) => t.category !== "digest");
  if (recent.length < 5) {
    console.log(`Not enough content for a digest: only ${recent.length} thoughts this week (need 5).`);
    return json({ skipped: true, count: recent.length });
  }

  // 2. Group by category
  const groups: Record<string, string[]> = {};
  for (const t of recent) {
    const category = t.category ?? "uncategorized";
    const body = String(t.content ?? t.text ?? t.body ?? "").slice(0, 600);
    const tags = Array.isArray(t.tags) && t.tags.length ? ` [${t.tags.join(", ")}]` : "";
    (groups[category] ??= []).push(`- ${body}${tags}`);
  }

  let notes = Object.entries(groups)
    .map(([category, lines]) => `## ${category.toUpperCase()} (${lines.length})\n${lines.join("\n")}`)
    .join("\n\n");
  if (notes.length > 40000) notes = notes.slice(0, 40000) + "\n…(truncated)";

  const userId = Deno.env.get("OWNER_USER_ID") ?? recent[0].user_id;

  // 3. Ask the gateway for the digest — with the Authorization header, or it gets a silent 401.
  const res = await fetch(`${url}/functions/v1/call-llm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      systemPrompt: SYSTEM_PROMPT,
      prompt: `Here are my notes from the past 7 days (${recent.length} total):\n\n${notes}`,
      maxTokens: 1500,
      userId,
      source: "weekly-digest",
    }),
  });

  const llm = await res.json().catch(() => ({}));
  if (!res.ok || !llm.text) {
    console.error("call-llm failed:", res.status, JSON.stringify(llm));
    return json({ error: "call-llm failed", detail: llm }, 502);
  }

  // 4. Save the digest as a new thought
  const today = new Date().toISOString().slice(0, 10);
  const digestText = `WEEKLY DIGEST — week ending ${today}\n\n${llm.text.trim()}`;

  const row: Record<string, unknown> = {
    content: digestText,
    category: "digest",
    summary: `Weekly digest of ${recent.length} thoughts, week ending ${today}`,
    tags: ["weekly-digest"],
    enriched_at: new Date().toISOString(),
  };
  if (userId) row.user_id = userId;

  let { error: insertError } = await supabase.from("thoughts").insert(row);

  // If your thoughts table has no user_id column, try again without it.
  if (insertError && row.user_id && /user_id/.test(insertError.message)) {
    delete row.user_id;
    ({ error: insertError } = await supabase.from("thoughts").insert(row));
  }

  if (insertError) {
    console.error("Could not save digest:", insertError.message);
    return json({ error: insertError.message }, 500);
  }

  console.log(`Digest saved from ${recent.length} thoughts.`);
  return json({ ok: true, count: recent.length });
});