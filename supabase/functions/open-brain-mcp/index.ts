// =============================================================================
// Open Brain MCP Server (Supabase Edge Function: open-brain-mcp)
//
// What this does, in plain language:
// An AI (like Claude Desktop) sends this function a request such as
// "search thoughts for 'marketing'". This function checks the password,
// asks your Supabase database for the answer, and sends the results back
// in the format MCP expects. The AI never touches your database directly.
//
// Deploy with:
//   npx supabase functions deploy open-brain-mcp --no-verify-jwt
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

// -----------------------------------------------------------------------------
// 1. SETTINGS
// Supabase gives every edge function SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY automatically. MCP_ACCESS_KEY is the password
// you created yourself in Edge Functions -> Secrets.
// -----------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY");

// The database connection. This key stays here on the server and is never
// sent to the AI.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// -----------------------------------------------------------------------------
// 2. CORS HEADERS
// These let the server be called from other places (like a browser-based
// tool). They don't weaken security; the password check still applies.
// -----------------------------------------------------------------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, accept, mcp-session-id, mcp-protocol-version",
};

// -----------------------------------------------------------------------------
// 3. THE TOOL LIST
// This is the "menu" the AI reads to learn what it can ask for.
// The descriptions matter: the AI reads them to decide when to use each tool.
// -----------------------------------------------------------------------------
const TOOLS = [
  {
    name: "search_thoughts",
    description:
      "Search the user's personal knowledge base (their 'Open Brain') for saved thoughts, notes, YouTube transcripts, articles and PDFs containing a word or phrase. Use short keywords for best results. Returns up to 10 matches, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Word or short phrase to search for, e.g. 'marketing'",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_recent",
    description:
      "List the most recently saved thoughts in the user's Open Brain, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "How many thoughts to return (1-50). Default 10.",
        },
      },
    },
  },
  {
    name: "add_thought",
    description:
      "Save a new thought to the user's Open Brain. Only use this when the user asks you to save or remember something.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The text of the thought to save",
        },
      },
      required: ["content"],
    },
  },
];

// -----------------------------------------------------------------------------
// 4. SMALL HELPERS
// -----------------------------------------------------------------------------

// Send a JSON reply with the CORS headers attached.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Build a JSON-RPC 2.0 error message (the standard "something went wrong"
// format MCP uses).
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

// Check the password in the Authorization header: "Bearer <your key>".
function isAuthorized(req: Request): boolean {
  if (!MCP_ACCESS_KEY) return false; // No key configured = nobody gets in.
  const header = req.headers.get("authorization") ?? "";
  const supplied = header.replace(/^Bearer\s+/i, "").trim();
  if (supplied.length !== MCP_ACCESS_KEY.length) return false;
  // Compare every character so the check takes the same time whether the
  // guess is close or not (makes password guessing harder).
  let diff = 0;
  for (let i = 0; i < supplied.length; i++) {
    diff |= supplied.charCodeAt(i) ^ MCP_ACCESS_KEY.charCodeAt(i);
  }
  return diff === 0;
}

// Turn database rows into readable text for the AI.
type Thought = { id: unknown; content: string; created_at: string };
function formatThoughts(rows: Thought[]): string {
  if (rows.length === 0) return "No thoughts found.";
  return rows
    .map((t) => `[${t.created_at}] (id: ${t.id})\n${t.content}`)
    .join("\n\n---\n\n");
}

// Wrap text in the shape MCP expects for a tool result.
function toolText(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

// -----------------------------------------------------------------------------
// 5. THE TOOLS THEMSELVES
// Each one runs a database query and returns the result as text.
// -----------------------------------------------------------------------------
async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "search_thoughts": {
      const query = String(args.query ?? "").trim();
      if (!query) return toolText("Please provide a search query.", true);
      // Escape % and _ so they're treated as normal characters, then
      // search for the phrase anywhere in the content (case-insensitive).
      const safe = query.replace(/[\\%_]/g, (c) => "\\" + c);
      const { data, error } = await supabase
        .from("thoughts")
        .select("id, content, created_at")
        .ilike("content", `%${safe}%`)
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) return toolText(`Search failed: ${error.message}`, true);
      return toolText(formatThoughts(data as Thought[]));
    }

    case "list_recent": {
      const requested = Number(args.limit ?? 10);
      const limit = Number.isFinite(requested)
        ? Math.min(Math.max(Math.floor(requested), 1), 50)
        : 10;
      const { data, error } = await supabase
        .from("thoughts")
        .select("id, content, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) return toolText(`Listing failed: ${error.message}`, true);
      return toolText(formatThoughts(data as Thought[]));
    }

    case "add_thought": {
      const content = String(args.content ?? "").trim();
      if (!content) return toolText("Cannot save an empty thought.", true);
      const { data, error } = await supabase
        .from("thoughts")
        .insert({ content })
        .select("id, content, created_at")
        .single();
      if (error) return toolText(`Save failed: ${error.message}`, true);
      return toolText(`Saved.\n\n${formatThoughts([data as Thought])}`);
    }

    default:
      return toolText(`Unknown tool: ${name}`, true);
  }
}

// -----------------------------------------------------------------------------
// 6. HANDLING ONE MCP MESSAGE
// MCP messages follow JSON-RPC 2.0: each has a "method" (what to do) and,
// unless it's a one-way notification, an "id" so the reply can be matched up.
// -----------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function handleMessage(msg: any) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id, -32600, "Invalid Request");
  }

  // Notifications have no id and expect no reply.
  const isNotification = !("id" in msg);
  const id = msg.id;

  try {
    let result: unknown;
    switch (msg.method) {
      // The AI's first "hello": we say who we are and that we offer tools.
      case "initialize":
        result = {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "open-brain", version: "1.0.0" },
        };
        break;

      // A simple "are you there?" check.
      case "ping":
        result = {};
        break;

      // The AI asks for the menu of tools.
      case "tools/list":
        result = { tools: TOOLS };
        break;

      // The AI uses one of the tools.
      case "tools/call":
        result = await callTool(
          String(msg.params?.name ?? ""),
          msg.params?.arguments ?? {},
        );
        break;

      default:
        if (isNotification) return null; // e.g. "notifications/initialized"
        return rpcError(id, -32601, `Method not found: ${msg.method}`);
    }
    return isNotification ? null : { jsonrpc: "2.0", id, result };
  } catch (err) {
    if (isNotification) return null;
    return rpcError(id, -32603, `Internal error: ${(err as Error).message}`);
  }
}

// -----------------------------------------------------------------------------
// 7. THE FRONT DOOR
// Every request to the function arrives here first.
// -----------------------------------------------------------------------------
Deno.serve(async (req) => {
  // Browsers send a "pre-flight" OPTIONS check; just say yes.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Password check before anything else.
  if (!isAuthorized(req)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // This server only answers POST requests. (Some MCP clients try a GET
  // first to open a live stream; 405 politely tells them we don't do that.)
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" },
    });
  }

  // Read the request body as JSON.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(rpcError(null, -32700, "Parse error"), 400);
  }

  // A request can be one message or a list of messages.
  const messages = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const msg of messages) {
    const reply = await handleMessage(msg);
    if (reply) replies.push(reply);
  }

  // Only notifications? Acknowledge with no body.
  if (replies.length === 0) {
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }

  return jsonResponse(Array.isArray(body) ? replies : replies[0]);
});