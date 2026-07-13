'use strict'

const API_URL = 'https://api.deepseek.com/v1/chat/completions'
const MODEL   = 'deepseek-v4-flash'
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'sk-48ab7db1fa034df5bf80efc'

async function callDeepSeek(systemPrompt, userPrompt, opts) {
  opts = opts || {}
  const apiKey = DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('missing DEEPSEEK_API_KEY')

  const body = {
    model:       opts.model       || MODEL,
    temperature: opts.temperature != null ? opts.temperature : 0.2,
    max_tokens:  opts.maxTokens   || 131072,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120000)

  let res
  try {
    res = await fetch(API_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const err = await res.text()
    throw new Error('DeepSeek API error ' + res.status + ': ' + err)
  }

  const data   = await res.json()
  const choice = data.choices[0]
  const text   = choice.message.content || ''
  console.log('[DeepSeek] finish=' + choice.finish_reason + '  len=' + text.length)

  if (choice.finish_reason === 'length') {
    console.warn('[DeepSeek] WARNING: response hit max_tokens limit, output may be truncated!')
  }

  return text
}

module.exports = { callDeepSeek }
