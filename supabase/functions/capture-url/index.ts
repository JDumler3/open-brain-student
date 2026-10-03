// ============================================================
// Open Brain — capture-url (Supabase Edge Function)
//
// Your app sends this function a web link. It fetches the page,
// strips it down to the readable text, and saves it to your brain.
//
// WHY THIS RUNS ON A SERVER: a web page in your browser is not
// allowed to fetch pages from other websites (that rule is called
// CORS). A server has no such limit, so the browser hands the link
// here and this function does the fetching.
//
// No AI summary yet: that needs an AI key, which you get in Level 5.
// For now the readable text itself is saved, and Level 5's
// enrichment agent summarises it later.
//
// Secrets it reads: SUPABASE_URL, SUPABASE_ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY — all provided automatically by Supabase.
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const MAX_BYTES = 3_000_000       // don't try to swallow a giant page
const MAX_CONTENT_CHARS = 8_000   // the thought itself; the full text goes in thought_sources

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// Turn "&rsquo;" "&amp;" "&#39;" etc. back into real characters.
const ENTITIES: Record<string, string> = {
  nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—',
  hellip: '…', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ',
  uuml: 'ü', Uuml: 'Ü', iexcl: '¡', iquest: '¿',
}
function decodeEntities(s: string): string {
  return s
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name === 'amp' ? m : ENTITIES[name] ?? m))
    .replace(/&#(?!0*38;)(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x(?!0*26;)([0-9a-fA-F]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;|&#0*38;|&#x0*26;/gi, '&') // & goes last, so "&amp;lt;" stays "&lt;"
}

// Simple HTML → readable text. No library: remove the machinery
// (scripts, menus, footers), then remove the remaining tags.
function htmlToText(html: string): { title: string; text: string } {
  const titleMatch =
    html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : 'Untitled page'

  // If the page marks up its article properly, use just that part
  const articleMatch =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  const body = articleMatch ? articleMatch[1] : html

  const text = body
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  const cleaned = decodeEntities(text)
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  return { title: title || 'Untitled page', text: cleaned }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // Who is asking? Read from their login token — never from the request
    // body, or anyone could write into anyone else's brain.
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return jsonResponse({ ok: false, error: 'Not signed in' }, 401)

    const { url } = await req.json().catch(() => ({ url: null }))
    if (!url || typeof url !== 'string') {
      return jsonResponse({ ok: false, error: 'A url is required' }, 400)
    }

    // Only http(s) links
    let parsed: URL
    try {
      parsed = new URL(url.trim())
    } catch {
      return jsonResponse({ ok: false, error: 'That is not a valid web address' }, 400)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return jsonResponse({ ok: false, error: 'Only http and https links are supported' }, 400)
    }

    // Fetch the page, identifying as a normal browser — some sites
    // refuse anything that looks automated.
    const pageRes = await fetch(parsed.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })
    if (!pageRes.ok) {
      return jsonResponse({
        ok: false,
        error: `That page returned an error (HTTP ${pageRes.status}). It may require a login or block automated readers.`,
      }, 422)
    }

    const contentType = pageRes.headers.get('content-type') ?? ''
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return jsonResponse({
        ok: false,
        error: `That link is a ${contentType.split(';')[0] || 'file'}, not a web page. For PDFs, use the PDF tab instead.`,
      }, 415)
    }

    const raw = await pageRes.text()
    if (raw.length > MAX_BYTES) {
      return jsonResponse({ ok: false, error: 'That page is too large to process' }, 413)
    }

    const { title, text } = htmlToText(raw)
    if (text.length < 200) {
      return jsonResponse({
        ok: false,
        error:
          'Almost no readable text was found. The page probably builds itself with ' +
          'JavaScript after loading, which a server cannot see. Copy the text in by hand instead.',
      }, 422)
    }

    const header = `🔗 ${title}\n${parsed.hostname}\n${parsed.toString()}\n\n`
    const content = text.length > MAX_CONTENT_CHARS
      ? header + text.slice(0, MAX_CONTENT_CHARS) + '…'
      : header + text

    // Save with the master key (it skips the security rule), so set the owner by hand.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const { data: thought, error: saveError } = await admin
      .from('thoughts')
      .insert({
        user_id: user.id,
        content,
        source: 'url',
        metadata: { title, url: parsed.toString(), hostname: parsed.hostname },
      })
      .select('id')
      .single()
    if (saveError || !thought) {
      console.error('[url] Save failed:', saveError)
      return jsonResponse({ ok: false, error: `Could not save: ${saveError?.message ?? 'unknown error'}` }, 500)
    }

    // Keep the FULL article text too. Non-fatal: the thought is already saved.
    let sourceSaved = true
    const { error: sourceError } = await admin.from('thought_sources').insert({
      thought_id: thought.id,
      user_id: user.id,
      source_text: text,
      source_kind: 'web',
      char_count: text.length,
      truncated: false,
    })
    if (sourceError) {
      sourceSaved = false
      console.warn('[url] thought_sources insert skipped:', sourceError.message)
    }

    return jsonResponse({
      ok: true,
      id: thought.id,
      title,
      hostname: parsed.hostname,
      chars: text.length,
      full_text_saved: sourceSaved,
      preview: content.slice(0, 240) + '…',
    })
  } catch (err) {
    console.error('[url] Failed:', String(err))
    const msg = String(err).toLowerCase().includes('timeout')
      ? 'That page took too long to respond.'
      : String(err)
    return jsonResponse({ ok: false, error: msg }, 500)
  }
})