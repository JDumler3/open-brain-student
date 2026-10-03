// ============================================================
// Open Brain — capture-youtube (Supabase Edge Function)
//
// Your app sends this function a YouTube link. It gets what was
// actually SAID in the video (the transcript) and saves it.
//
// WHY THIS FILE LOOKS COMPLICATED — worth reading:
//
// YouTube serves a stripped-down page with no captions when the
// request comes from a data centre, which is exactly what a
// Supabase function runs in. Code that works on your laptop fails
// once deployed. That is not a bug in your code; it is YouTube
// treating servers differently from people.
//
// So we try several routes and take the first that works:
//   1. SUPADATA    — a service built for this. It fetches from home
//                    internet connections, so it gets real
//                    transcripts. Needs SUPADATA_API_KEY (optional:
//                    without it we skip straight to route 2).
//   2. INNERTUBE   — YouTube's own internal app system. We identify
//                    as the iPhone app, then the Android app, which
//                    YouTube often serves properly even to servers.
//   3. DESCRIPTION — if no captions can be had, save the title and
//                    description instead, clearly labelled as such.
//
// No AI summary yet: that needs an AI key (Level 5). For now the
// transcript itself is saved; Level 5's enrichment agent summarises it.
//
// Secrets: SUPADATA_API_KEY (optional, you add it). SUPABASE_URL,
// SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY come automatically.
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const SUPADATA_KEY = (Deno.env.get('SUPADATA_API_KEY') ?? '').trim()

const MAX_CONTENT_CHARS = 8_000   // the thought itself; the full transcript goes in thought_sources

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

interface VideoContent {
  content: string
  hasTranscript: boolean
  source: 'supadata' | 'innertube' | 'description'
}

// Turn "&#39;" "&amp;" "&quot;" etc. back into real characters.
const ENTITIES: Record<string, string> = {
  nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…',
}
function decodeEntities(s: string): string {
  return s
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name === 'amp' ? m : ENTITIES[name] ?? m))
    .replace(/&#(?!0*38;)(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x(?!0*26;)([0-9a-fA-F]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;|&#0*38;|&#x0*26;/gi, '&')
}

// Pull the 11-character video id out of any YouTube link shape
function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ]
  for (const p of patterns) {
    const m = url.trim().match(p)
    if (m) return m[1]
  }
  return null
}

// Title via oEmbed — lightweight, no key, nearly always works
async function fetchTitle(videoUrl: string, videoId: string): Promise<string> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`,
      { signal: AbortSignal.timeout(8_000) },
    )
    if (res.ok) {
      const data = await res.json()
      if (data?.title) return String(data.title)
    }
  } catch { /* use the placeholder */ }
  return `Video ${videoId}`
}

// ---- ROUTE 1: Supadata ----
async function fromSupadata(videoUrl: string): Promise<VideoContent | null> {
  if (!SUPADATA_KEY) return null
  try {
    const res = await fetch(
      `https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(videoUrl)}&text=true`,
      { headers: { 'x-api-key': SUPADATA_KEY }, signal: AbortSignal.timeout(25_000) },
    )
    if (!res.ok) {
      // 401 = wrong key, 402/429 = free monthly quota used up
      console.log(`[youtube] Supadata HTTP ${res.status} — trying next route`)
      return null
    }
    const data = await res.json()
    // With text=true, content is one string. Handle the segment-list shape too.
    const raw = data?.content
    const transcript = (typeof raw === 'string'
      ? raw
      : Array.isArray(raw) ? raw.map((s: { text?: string }) => s.text ?? '').join(' ') : '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!transcript) return null
    console.log(`[youtube] Supadata OK — ${transcript.length} chars`)
    return { content: transcript, hasTranscript: true, source: 'supadata' }
  } catch (err) {
    console.error('[youtube] Supadata error:', String(err))
    return null
  }
}

// ---- ROUTES 2 and 3: Innertube, then the description ----
async function fromInnertube(videoId: string): Promise<VideoContent | null> {
  const clients = [
    {
      name: 'IOS',
      userAgent: 'com.google.ios.youtube/19.29.1 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      context: {
        clientName: 'IOS', clientVersion: '19.29.1',
        deviceMake: 'Apple', deviceModel: 'iPhone17,2',
        osName: 'iPhone', osVersion: '18.1.0.22B83', hl: 'en', gl: 'US',
      },
    },
    {
      name: 'ANDROID',
      userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
      context: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34, hl: 'en', gl: 'US' },
    },
  ]

  // deno-lint-ignore no-explicit-any
  let best: any = null
  for (const client of clients) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': client.userAgent },
        body: JSON.stringify({ context: { client: client.context }, videoId }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        console.log(`[youtube] Innertube ${client.name} HTTP ${res.status}`)
        continue
      }
      const result = await res.json()
      const tracks = result?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      if (Array.isArray(tracks) && tracks.length > 0) {
        console.log(`[youtube] Innertube ${client.name}: ${tracks.length} caption tracks`)
        best = result
        break
      }
      // Keep the first answer anyway: even without captions it has the description.
      if (!best) best = result
      console.log(`[youtube] Innertube ${client.name}: no caption tracks`)
    } catch (err) {
      console.error(`[youtube] Innertube ${client.name} error:`, String(err))
    }
  }
  if (!best) return null

  try {
    const tracks = best?.captions?.playerCaptionsTracklistRenderer?.captionTracks
    if (Array.isArray(tracks) && tracks.length > 0) {
      // Prefer human-written English, then auto-generated English, then anything
      // deno-lint-ignore no-explicit-any
      const t = tracks as any[]
      const track =
        t.find((x) => x.languageCode === 'en' && x.kind !== 'asr') ??
        t.find((x) => x.languageCode === 'en') ??
        t.find((x) => String(x.languageCode ?? '').startsWith('en')) ??
        t[0]

      const capRes = await fetch(track.baseUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        signal: AbortSignal.timeout(12_000),
      })
      if (capRes.ok) {
        const xml = await capRes.text()
        // Two caption formats exist: <text ...>words</text> and <p ...>words</p>
        const pieces = [...xml.matchAll(/<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/g)]
          .map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, '')))
        const transcript = pieces.join(' ').replace(/\s+/g, ' ').trim()
        if (transcript) {
          console.log(`[youtube] Innertube transcript OK — ${transcript.length} chars`)
          return { content: transcript, hasTranscript: true, source: 'innertube' }
        }
      }
    }

    // ROUTE 3 — no captions anywhere. Use the description.
    const details = best?.videoDetails
    const description: string = details?.shortDescription ?? ''
    const keywords: string = Array.isArray(details?.keywords) ? details.keywords.join(', ') : ''
    if (description || keywords) {
      const content = [description, keywords ? `Keywords: ${keywords}` : ''].filter(Boolean).join('\n\n')
      console.log(`[youtube] Falling back to description — ${description.length} chars`)
      return { content, hasTranscript: false, source: 'description' }
    }
    return null
  } catch (err) {
    console.error('[youtube] Innertube parse error:', String(err))
    return null
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // Who is asking? Read from their login token — never from the request body.
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return jsonResponse({ ok: false, error: 'Not signed in' }, 401)

    const { url } = await req.json().catch(() => ({ url: null }))
    if (!url || typeof url !== 'string') {
      return jsonResponse({ ok: false, error: 'A YouTube url is required' }, 400)
    }
    const videoId = extractVideoId(url)
    if (!videoId) {
      return jsonResponse({
        ok: false,
        error: 'That does not look like a YouTube link. Expected something like https://www.youtube.com/watch?v=...',
      }, 400)
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
    const title = await fetchTitle(videoUrl, videoId)

    // Try each route in order; the first success wins
    const result = (await fromSupadata(videoUrl)) ?? (await fromInnertube(videoId))
    if (!result) {
      return jsonResponse({
        ok: false,
        error: 'Could not read anything from that video. It may be private, age-restricted, or region-locked. Try a different one.',
      }, 422)
    }

    const label = result.hasTranscript
      ? 'Transcript'
      : 'No transcript was available — this is the video DESCRIPTION'
    const header = `📹 ${title}\n${videoUrl}\n\n${label}:\n`
    const content = result.content.length > MAX_CONTENT_CHARS
      ? header + result.content.slice(0, MAX_CONTENT_CHARS) + '…'
      : header + result.content

    // Save with the master key (it skips the security rule), so set the owner by hand.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const { data: thought, error: saveError } = await admin
      .from('thoughts')
      .insert({
        user_id: user.id,
        content,
        source: 'youtube',
        metadata: {
          title,
          video_id: videoId,
          video_url: videoUrl,
          has_transcript: result.hasTranscript,
          fetched_via: result.source,
        },
      })
      .select('id')
      .single()
    if (saveError || !thought) {
      console.error('[youtube] Save failed:', saveError)
      return jsonResponse({ ok: false, error: `Could not save: ${saveError?.message ?? 'unknown error'}` }, 500)
    }

    // Keep the FULL transcript too. Non-fatal: the thought is already saved.
    let sourceSaved = true
    const { error: sourceError } = await admin.from('thought_sources').insert({
      thought_id: thought.id,
      user_id: user.id,
      source_text: result.content,
      source_kind: result.hasTranscript ? 'youtube_transcript' : 'youtube_description',
      char_count: result.content.length,
      truncated: false,
    })
    if (sourceError) {
      sourceSaved = false
      console.warn('[youtube] thought_sources insert skipped:', sourceError.message)
    }

    return jsonResponse({
      ok: true,
      id: thought.id,
      title,
      has_transcript: result.hasTranscript,
      fetched_via: result.source,
      chars: result.content.length,
      full_text_saved: sourceSaved,
      preview: content.slice(0, 240) + '…',
    })
  } catch (err) {
    console.error('[youtube] Failed:', String(err))
    return jsonResponse({ ok: false, error: String(err) }, 500)
  }
})