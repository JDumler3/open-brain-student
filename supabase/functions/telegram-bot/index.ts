// ============================================================
// Open Brain — Telegram bot (Supabase Edge Function)
//
// Telegram delivers every message sent to your bot here (the
// "webhook"). This function then:
//   /search <words>  or  ?<words>  → searches your thoughts
//   /recent                        → shows your last 5 thoughts
//   /start or /help                → shows how to use the bot
//   anything else                  → saves it as a new thought
//
// Secrets it reads (set in Supabase → Edge Functions → Secrets):
//   TELEGRAM_BOT_TOKEN  – from BotFather
//   OWNER_USER_ID       – your UID from Authentication → Users
//   ALLOWED_CHAT_ID     – your Telegram chat ID (the bot tells
//                         you this the first time you message it)
// Provided automatically by Supabase (do NOT add these yourself):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const ALLOWED_CHAT_ID = (Deno.env.get('ALLOWED_CHAT_ID') ?? '').trim()
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// The service role key is a master key: it skips the security rule from
// Level 2. That is why every query below filters by OWNER_USER_ID by hand.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

interface ThoughtRow {
  content: string
  created_at: string
}

const HELP_TEXT = [
  'Your Open Brain is listening.',
  '',
  '• Send any message → saved to your brain',
  '• /search <words>  or  ?<words> → search your brain',
  '• /recent → your last 5 thoughts',
].join('\n')

// Always answer Telegram with 200 OK. If we returned an error, Telegram
// would keep re-sending the same message and you would get duplicates.
function ok(): Response {
  return new Response('ok', { status: 200, headers: corsHeaders })
}

async function sendMessage(chatId: number, text: string): Promise<void> {
  // Telegram refuses messages longer than 4096 characters.
  const safeText = text.length > 4000 ? text.slice(0, 4000) + '…' : text
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: safeText }),
    })
    if (!res.ok) console.error('Telegram sendMessage failed:', res.status, await res.text())
  } catch (err) {
    console.error('Telegram sendMessage error:', err)
  }
}

function preview(content: string, max = 300): string {
  const oneLine = (content ?? '').replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine
}

function formatThoughts(rows: ThoughtRow[]): string {
  return rows
    .map((row, i) => {
      const date = new Date(row.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
      return `${i + 1}. ${preview(row.content)}\n   — ${date}`
    })
    .join('\n\n')
}

async function searchThoughts(chatId: number, term: string): Promise<void> {
  if (!term) {
    await sendMessage(chatId, 'What should I search for? Try: /search coffee')
    return
  }
  // Escape characters that have special meaning inside an ILIKE pattern.
  const escaped = term.replace(/[\\%_]/g, (c) => '\\' + c)
  const { data, error } = await supabase
    .from('thoughts')
    .select('content, created_at')
    .eq('user_id', OWNER_USER_ID)
    .ilike('content', `%${escaped}%`)
    .order('created_at', { ascending: false })
    .limit(5)

  if (error) {
    console.error('Search failed:', error)
    await sendMessage(chatId, `Search failed: ${error.message}`)
    return
  }
  if (!data || data.length === 0) {
    await sendMessage(chatId, `Nothing in your brain matches "${term}" yet.`)
    return
  }
  await sendMessage(chatId, `🔎 Top matches for "${term}":\n\n${formatThoughts(data as ThoughtRow[])}`)
}

async function recentThoughts(chatId: number): Promise<void> {
  const { data, error } = await supabase
    .from('thoughts')
    .select('content, created_at')
    .eq('user_id', OWNER_USER_ID)
    .order('created_at', { ascending: false })
    .limit(5)

  if (error) {
    console.error('Recent failed:', error)
    await sendMessage(chatId, `Could not load recent thoughts: ${error.message}`)
    return
  }
  if (!data || data.length === 0) {
    await sendMessage(chatId, 'Your brain is empty so far. Send me a thought!')
    return
  }
  await sendMessage(chatId, `🕑 Your 5 most recent thoughts:\n\n${formatThoughts(data as ThoughtRow[])}`)
}

async function saveThought(chatId: number, text: string, message: Record<string, any>): Promise<void> {
  const { error } = await supabase.from('thoughts').insert({
    user_id: OWNER_USER_ID,
    content: text,
    source: 'telegram',
    metadata: {
      telegram_chat_id: chatId,
      telegram_message_id: message.message_id,
      telegram_username: message.from?.username ?? null,
    },
  })

  if (error) {
    console.error('Save failed:', error)
    await sendMessage(chatId, `❌ Could not save: ${error.message}`)
    return
  }
  await sendMessage(chatId, '✅ Saved to your brain')
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return ok()

  let update: Record<string, any>
  try {
    update = await req.json()
  } catch {
    return ok() // not valid JSON — ignore it
  }

  // Telegram also sends other kinds of updates (edits, etc.). We only handle new messages.
  const message = update?.message
  const chatId: number | undefined = message?.chat?.id
  if (!chatId) return ok()

  if (!TELEGRAM_BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN secret is missing')
    return ok()
  }

  try {
    // ---- Lock the bot to YOUR chat only ----
    // The function is open to the internet (--no-verify-jwt), so it
    // has to check who is knocking by itself.
    if (!ALLOWED_CHAT_ID) {
      await sendMessage(
        chatId,
        `Almost ready! Your chat ID is:\n\n${chatId}\n\n` +
          'Add it in Supabase → Edge Functions → Secrets as ALLOWED_CHAT_ID, ' +
          'then message me again. Until then I will not save anything.',
      )
      return ok()
    }
    if (String(chatId) !== ALLOWED_CHAT_ID) {
      console.warn('Ignored message from unknown chat:', chatId)
      return ok() // a stranger — stay silent
    }

    if (!OWNER_USER_ID) {
      await sendMessage(chatId, 'Setup problem: the OWNER_USER_ID secret is missing in Supabase.')
      return ok()
    }

    const text: string | undefined = message.text
    if (!text || !text.trim()) {
      await sendMessage(chatId, 'I can only read text messages for now. Try typing your thought.')
      return ok()
    }

    const trimmed = text.trim()
    const [firstWord, ...rest] = trimmed.split(/\s+/)
    // "/search@mybot hello" → "/search"
    const command = firstWord.startsWith('/') ? firstWord.split('@')[0].toLowerCase() : ''

    if (command === '/start' || command === '/help') {
      await sendMessage(chatId, HELP_TEXT)
    } else if (command === '/search') {
      await searchThoughts(chatId, rest.join(' ').trim())
    } else if (!command && trimmed.startsWith('?')) {
      await searchThoughts(chatId, trimmed.slice(1).trim())
    } else if (command === '/recent') {
      await recentThoughts(chatId)
    } else if (command) {
      await sendMessage(chatId, `I don't know the command ${command}.\n\n${HELP_TEXT}`)
    } else {
      await saveThought(chatId, trimmed, message)
    }
  } catch (err) {
    console.error('Unexpected error:', err)
    await sendMessage(chatId, 'Something went wrong on my side. Please try again.')
  }

  return ok()
})