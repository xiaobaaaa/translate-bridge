import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Mode, Order, Translation } from '../types'

const mode = atom({ plugin: 'translate-bridge', key: 'mode' } as const, 'bilingual')
const order = atom({ plugin: 'translate-bridge', key: 'order' } as const, 'original-first')
// The provider picked with /translate provider, tried first; '' keeps the configured order.
const provider = atom({ plugin: 'translate-bridge', key: 'provider' } as const, '')
const translatedRef = { plugin: 'translate-bridge', key: 'translated' } as const
const originalRef = { plugin: 'translate-bridge', key: 'original' } as const
const englishRef = { plugin: 'translate-bridge', key: 'english' } as const

const MODES: readonly Mode[] = ['off', 'only', 'bilingual']
const ORDERS: readonly Order[] = ['original-first', 'translation-first']
const MODE_LABEL: Record<Mode, string> = {
  off: 'off',
  only: 'translation only',
  bilingual: 'bilingual',
}

// A reply grows while it streams; translate once it has stopped changing this long.
const SETTLE_MS = 1500

const DEFAULT_LANGUAGE = 'Simplified Chinese'
const DEFAULT_BASE_URL = 'https://api.deepseek.com'

// Providers known by name: where they are, a model to use when none is set, where their key
// is looked up, and fields every request to them carries.
type Preset = { baseUrl: string; model: string; keyEnv?: string; body: Record<string, unknown> }
const PRESETS: Record<string, Preset> = {
  // DeepSeek thinks by default; translation does not need it, and it costs time and money.
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    keyEnv: 'DEEPSEEK_API_KEY',
    body: { thinking: { type: 'disabled' }, temperature: 0 },
  },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', keyEnv: 'ZHIPU_API_KEY', body: { temperature: 0 } },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: '', keyEnv: 'DASHSCOPE_API_KEY', body: {} },
  openai: { baseUrl: 'https://api.openai.com/v1', model: '', keyEnv: 'OPENAI_API_KEY', body: {} },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: '', keyEnv: 'OPENROUTER_API_KEY', body: {} },
  // A local Ollama needs no key.
  ollama: { baseUrl: 'http://localhost:11434/v1', model: '', body: {} },
}
const PRESET_NAMES = Object.keys(PRESETS)
// The main provider's name when its address is none of the known ones.
const CUSTOM = 'custom'

type Settings = {
  language: string
  extraBody: Record<string, unknown>
}

type Provider = {
  name: string
  // the one set by baseUrl, model and apiKey
  main: boolean
  baseUrl: string
  model: string
  body: Record<string, unknown>
  // where to set the key, for the message when it is missing
  keyHint: string
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function hostOf(url: string): string {
  return (/^[a-z]+:\/\/([^/]+)/i.exec(url)?.[1] ?? '').toLowerCase()
}

function settingsOf(options: PluginOptions): Settings {
  let extraBody: Record<string, unknown> = {}
  const raw = text(options.extraBody)
  if (raw) {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      extraBody = parsed as Record<string, unknown>
    }
  }
  return { language: text(options.language) || DEFAULT_LANGUAGE, extraBody }
}

// "qwen=qwen-flash, ollama=qwen3:8b" → { qwen: 'qwen-flash', ollama: 'qwen3:8b' }
function modelsOf(options: PluginOptions): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of text(options.models).split(',')) {
    const at = pair.indexOf('=')
    if (at > 0) out[pair.slice(0, at).trim().toLowerCase()] = pair.slice(at + 1).trim()
  }
  return out
}

function namesOf(value: unknown): string[] {
  return text(value)
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean)
}

// The main provider, from the baseUrl, model and apiKey options.
function mainProvider(options: PluginOptions): Provider {
  const baseUrl = (text(options.baseUrl) || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const name = PRESET_NAMES.find(one => hostOf(PRESETS[one]!.baseUrl) === hostOf(baseUrl)) ?? CUSTOM
  const preset = PRESETS[name]
  return {
    name,
    main: true,
    baseUrl,
    model: text(options.model) || modelsOf(options)[name] || preset?.model || '',
    body: { ...preset?.body, ...settingsOf(options).extraBody },
    keyHint: 'the plugin option apiKey or the TRANSLATE_BRIDGE_API_KEY environment variable',
  }
}

function presetProvider(options: PluginOptions, name: string): Provider {
  const preset = PRESETS[name]!
  return {
    name,
    main: false,
    baseUrl: preset.baseUrl,
    model: modelsOf(options)[name] || preset.model,
    body: { ...preset.body, ...settingsOf(options).extraBody },
    keyHint: `the plugin option ${name}ApiKey${preset.keyEnv ? ` or the ${preset.keyEnv} environment variable` : ''}`,
  }
}

// The providers in the order they are tried: the main one, then the fallback list, with the
// one picked by /translate provider moved to the front.
function providersOf(options: PluginOptions, preferred: string): Provider[] {
  const all = [mainProvider(options)]
  for (const name of namesOf(options.fallback)) {
    if (PRESETS[name] && !all.some(one => one.name === name)) all.push(presetProvider(options, name))
  }
  if (preferred) {
    const at = all.findIndex(one => one.name === preferred)
    if (at > 0) all.unshift(...all.splice(at, 1))
    else if (at < 0 && PRESETS[preferred]) all.unshift(presetProvider(options, preferred))
  }
  return all
}

function toEnglishPrompt(language: string): string {
  return [
    'You translate a message that a user wrote to an AI coding assistant into English.',
    `The message is most likely in ${language}.`,
    'Keep code, inline code, file paths, shell commands, URLs, identifiers, numbers and markdown exactly as written.',
    'Translate faithfully; do not answer, explain or add anything.',
    'If the message is already in English, return it unchanged. Output only the translation.',
  ].join(' ')
}

function blocksPrompt(target: string): string {
  return [
    `You translate markdown blocks from an AI coding assistant's reply into ${target}.`,
    'The user message is a JSON array of strings, one markdown block each.',
    'Reply with a JSON object {"blocks": [...]} holding exactly as many strings, in the same order,',
    'each the translation of the block at the same index.',
    "Keep each block's markdown structure. Leave inline code, file paths, shell commands, URLs, identifiers and numbers unchanged.",
    'Use standard technical terms.',
  ].join(' ')
}

function wholePrompt(target: string): string {
  return [
    `You translate a reply from an AI coding assistant into ${target}.`,
    'Keep the markdown structure. Leave fenced code blocks, inline code, file paths, shell commands, URLs, identifiers and numbers unchanged.',
    'Use standard technical terms. Output only the translation.',
  ].join(' ')
}

function labelPrompt(target: string): string {
  return [
    `You translate a short status label from an AI coding tool into ${target}.`,
    'Keep file names, commands, identifiers and URLs unchanged. Output one line, only the translation.',
  ].join(' ')
}

// cyrb53: a stable short id for a text
function hash(value: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

const LATIN_WORDS = /\p{Script=Latin}{2,}/gu
const NON_LATIN_LETTERS = /(?!\p{Script=Latin})\p{L}/gu
const ENGLISH_WORDS = new Set(
  (
    'the a an and or of to in on for with is are was were be been it its this that these those you your we our ' +
    'i my me as at by from not no can will would should do does did has have had if so but then than there here ' +
    'which what when where how all any some into about out up now just also only more most each both'
  ).split(' '),
)

function stripCode(value: string): string {
  return value.replace(/```[\s\S]*?(```|$)/g, '').replace(/`[^`]*`/g, '')
}

// Is the prose (code left out) English? undefined when there is no prose at all.
// A few non-English names inside English prose still count as English; short Latin
// texts (a label) are taken as English, which is what Claude writes them in.
function isMostlyEnglish(value: string): boolean | undefined {
  const prose = stripCode(value)
  const words = prose.match(LATIN_WORDS) ?? []
  const nonLatin = prose.match(NON_LATIN_LETTERS)?.length ?? 0
  if (words.length === 0 && nonLatin === 0) return undefined
  if (nonLatin >= words.length) return false
  if (words.length < 6) return true
  const common = words.filter(word => ENGLISH_WORDS.has(word.toLowerCase())).length
  return common / words.length >= 0.15
}

type Block = { text: string; isCode: boolean }

// Paragraphs, lists, tables and headings split on blank lines; a fenced code block stays whole.
function splitBlocks(value: string): Block[] {
  const blocks: Block[] = []
  let lines: string[] = []
  let inFence = false
  const flush = (isCode: boolean) => {
    if (lines.length > 0) blocks.push({ text: lines.join('\n'), isCode })
    lines = []
  }
  for (const line of value.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (!inFence) flush(false)
      lines.push(line)
      if (inFence) flush(true)
      inFence = !inFence
    } else if (inFence) {
      lines.push(line)
    } else if (line.trim() === '') {
      flush(false)
    } else {
      lines.push(line)
    }
  }
  flush(inFence)
  return blocks
}

function needsTranslation(block: Block): boolean {
  return !block.isCode && /\p{L}/u.test(stripCode(block.text))
}

function quote(value: string): string {
  return value
    .split('\n')
    .map(line => (line ? `> ${line}` : '>'))
    .join('\n')
}

// The original (what was written) and its translation, in the chosen order, put together by
// `join`; in 'only' mode just the one in the user's language.
function pair(
  original: string,
  translation: string,
  current: Mode,
  chosen: Order,
  originalIsEnglish: boolean,
  join: (first: string, second: string) => string,
): string {
  if (current === 'only') return originalIsEnglish ? translation : original
  return chosen === 'original-first' ? join(original, translation) : join(translation, original)
}

// A reply, paragraph by paragraph: the first version as written, the second as a quote under it.
function layout(source: string, translation: Translation, current: Mode, chosen: Order, sourceIsEnglish: boolean): string {
  if (translation.whole !== undefined) {
    return pair(source, translation.whole, current, chosen, sourceIsEnglish, (a, b) => `${a}\n\n---\n\n${b}`)
  }
  const translated = translation.blocks ?? []
  let index = 0
  return splitBlocks(source)
    .map(block => {
      if (!needsTranslation(block)) return block.text
      const other = translated[index++] ?? block.text
      return pair(block.text, other, current, chosen, sourceIsEnglish, (a, b) => `${a}\n\n${quote(b)}`)
    })
    .join('\n\n')
}

const pending = new Map<string, { text: string; cancel: () => void }>()
const inflight = new Set<string>()

// Each name is spelled out, so the variables and options the mod reads can be listed.
async function namedKey($: EngineInterface, options: PluginOptions, name: string): Promise<string> {
  switch (name) {
    case 'deepseek':
      return text(options.deepseekApiKey) || text(await $.env.get('DEEPSEEK_API_KEY'))
    case 'zhipu':
      return text(options.zhipuApiKey) || text(await $.env.get('ZHIPU_API_KEY'))
    case 'qwen':
      return text(options.qwenApiKey) || text(await $.env.get('DASHSCOPE_API_KEY'))
    case 'openai':
      return text(options.openaiApiKey) || text(await $.env.get('OPENAI_API_KEY'))
    case 'openrouter':
      return text(options.openrouterApiKey) || text(await $.env.get('OPENROUTER_API_KEY'))
    case 'ollama':
      // a local Ollama takes any key
      return 'ollama'
    default:
      return ''
  }
}

async function keyOf($: EngineInterface, options: PluginOptions, provider: Provider): Promise<string | undefined> {
  if (provider.main) {
    const own = text(options.apiKey) || text(await $.env.get('TRANSLATE_BRIDGE_API_KEY'))
    if (own) return own
  }
  return (await namedKey($, options, provider.name)) || undefined
}

async function providers($: EngineInterface, options: PluginOptions): Promise<Provider[]> {
  return providersOf(options, await read($, provider))
}

async function ask(
  $: EngineInterface,
  one: Provider,
  key: string,
  system: string,
  input: string,
  asJson: boolean,
): Promise<string> {
  const res = await $.http.fetch(`${one.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: one.model,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: input },
      ],
      ...(asJson ? { response_format: { type: 'json_object' } } : {}),
      ...one.body,
    }),
  })
  if (!res.ok) {
    throw new Error(`the translation API answered HTTP ${res.status}`)
  }
  const out = (JSON.parse(res.text) as { choices?: { message?: { content?: string } }[] })
    .choices?.[0]?.message?.content?.trim()
  if (!out) {
    throw new Error('the translation API returned an empty answer')
  }
  return out
}

// Ask each provider in turn until one answers; when none does, say what each one said.
async function complete(
  $: EngineInterface,
  options: PluginOptions,
  system: string,
  input: string,
  asJson: boolean,
): Promise<string> {
  const all = await providers($, options)
  const errors: string[] = []
  for (const one of all) {
    const key = await keyOf($, options, one)
    const problem = !key
      ? `no API key: set ${one.keyHint}`
      : !one.model
        ? `no model: set the plugin option ${one.main ? 'model' : `models (${one.name}=<model>)`}`
        : ''
    if (problem) {
      errors.push(all.length > 1 ? `${one.name}: ${problem}` : problem)
      continue
    }
    try {
      return await ask($, one, key!, system, input, asJson)
    } catch (error) {
      errors.push(all.length > 1 ? `${one.name}: ${describe(error)}` : describe(error))
    }
  }
  throw new Error(errors.join('; '))
}

async function translateBlocks(
  $: EngineInterface,
  options: PluginOptions,
  blocks: readonly string[],
  target: string,
): Promise<string[] | undefined> {
  try {
    const answer = await complete($, options, blocksPrompt(target), JSON.stringify(blocks), true)
    const parsed = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, '')) as { blocks?: unknown }
    const out = parsed.blocks
    if (Array.isArray(out) && out.length === blocks.length && out.every(one => typeof one === 'string')) {
      return out as string[]
    }
  } catch {
    // fall through to translating the whole text
  }
  return undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// At most this many translation requests run at once; the rest wait their turn.
const MAX_REQUESTS = 4
// A failed translation is tried this many times in all, this long apart.
const ATTEMPTS = 3
const RETRY_MS = 5000

let running = 0
const waiting: (() => void)[] = []

async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_REQUESTS) {
    await new Promise<void>(resolve => waiting.push(resolve))
  }
  running++
  try {
    return await work()
  } finally {
    running--
    waiting.shift()?.()
  }
}

// Translate and store under `id`; on failure try again later, and say so only at the last try.
async function runTranslation(
  $: EngineInterface,
  id: string,
  work: () => Promise<Translation>,
  attempt = 1,
): Promise<void> {
  if (inflight.has(id)) return
  inflight.add(id)
  let failed = false
  try {
    await $.state.set({ ...translatedRef, id }, await limited(work))
  } catch (error) {
    failed = true
    if (attempt >= ATTEMPTS) $.ui.toast(`translate-bridge: ${describe(error)}`)
  } finally {
    inflight.delete(id)
  }
  if (failed && attempt < ATTEMPTS) {
    $.clock.after(RETRY_MS, () => void runTranslation($, id, work, attempt + 1))
  }
}

// A block that came back exactly as it was sent, though it has prose to translate.
function untranslated(source: string, out: string): boolean {
  return out.trim() === source.trim() && isMostlyEnglish(source) !== undefined
}

function translateReply($: EngineInterface, options: PluginOptions, id: string, source: string, target: string) {
  return runTranslation($, id, async () => {
    const blocks = splitBlocks(source).filter(needsTranslation).map(block => block.text)
    const translated = await translateBlocks($, options, blocks, target)
    if (!translated) return { whole: await complete($, options, wholePrompt(target), source, false) }
    // Some models (glm-4-flash) hand blocks back as they were in JSON mode; those go again, one by one.
    const fixed = await Promise.all(
      translated.map((out, i) =>
        untranslated(blocks[i] ?? '', out)
          ? complete($, options, wholePrompt(target), blocks[i] ?? '', false).catch(() => out)
          : out,
      ),
    )
    return { blocks: fixed }
  })
}

function translateLabel($: EngineInterface, options: PluginOptions, id: string, label: string, target: string) {
  return runTranslation($, id, async () => {
    const whole = await complete($, options, labelPrompt(target), label, false)
    return { whole: whole.split('\n')[0] ?? whole }
  })
}

// Translate once the text at `slot` has stopped changing for SETTLE_MS.
function schedule($: EngineInterface, slot: string, source: string, run: () => Promise<void>) {
  const waiting = pending.get(slot)
  if (waiting?.text === source) return
  waiting?.cancel()
  const timer = $.clock.after(SETTLE_MS, () => {
    pending.delete(slot)
    void run()
  })
  pending.set(slot, { text: source, cancel: timer.cancel })
}

// A step's grey label comes from this field of the call's input.
function labelField(tool: string): string {
  return tool === 'WebSearch' ? 'query' : 'description'
}

function labelOf(tool: string, input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const value = (input as Record<string, unknown>)[labelField(tool)]
  return typeof value === 'string' && value.trim() ? value : undefined
}

// The label as it should be drawn, or undefined while there is no translation yet.
async function shownLabel(
  $: EngineInterface,
  options: PluginOptions,
  current: Mode,
  slot: string,
  label: string,
): Promise<string | undefined> {
  const english = isMostlyEnglish(label)
  if (english === undefined || (current === 'only' && !english)) return undefined
  const target = english ? settingsOf(options).language : 'English'
  const id = hash(`label:${target}:${label}`)
  const { value } = await $.state.get({ ...translatedRef, id })
  if (value?.whole !== undefined) {
    return pair(label, value.whole, current, await read($, order), english, (a, b) => `${a} / ${b}`)
  }
  schedule($, slot, label, () => translateLabel($, options, id, label, target))
  return undefined
}

const USAGE =
  'Usage: /translate on (bilingual) | only (translation only) | off | ' +
  'original-first | translation-first | provider [name | default] | status'

// "zhipu: glm-4-flash at https://… (API key set)"
async function describeProvider($: EngineInterface, options: PluginOptions, one: Provider): Promise<string> {
  const key = (await keyOf($, options, one)) ? 'API key set' : 'no API key'
  return `${one.name}: ${one.model || '(no model)'} at ${one.baseUrl} (${key})`
}

// Switch which provider goes first; '' or "default" goes back to the configured order.
async function pickProvider($: EngineInterface, options: PluginOptions, name: string): Promise<string | undefined> {
  if (name === 'default') name = ''
  const known = providersOf(options, '').map(one => one.name)
  if (name && !known.includes(name) && !PRESETS[name]) {
    return `translate-bridge: no provider "${name}". Choose from ${[...new Set([...known, ...PRESET_NAMES])].join(', ')}, or default.`
  }
  await update($, provider, () => name)
  await $.store.set('provider', name)
  return undefined
}

async function status($: EngineInterface, options: PluginOptions): Promise<string> {
  const now = await read($, mode)
  const all = await providers($, options)
  const lines = await Promise.all(all.map(one => describeProvider($, options, one)))
  const head = `translate-bridge: ${MODE_LABEL[now]}${now === 'bilingual' ? ` (${await read($, order)})` : ''}; ${settingsOf(options).language} ⇄ English via`
  return all.length === 1 ? `${head} ${lines[0]}` : `${head}, in this order:\n${lines.map((line, i) => `${i + 1}. ${line}`).join('\n')}`
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('mode')
    if (MODES.includes(saved as Mode)) {
      await update($, mode, () => saved as Mode)
    }
    const savedOrder = await $.store.get('order')
    if (ORDERS.includes(savedOrder as Order)) {
      await update($, order, () => savedOrder as Order)
    }
    const savedProvider = await $.store.get('provider')
    if (typeof savedProvider === 'string') {
      await update($, provider, () => savedProvider)
    }
    await $.command.register({
      name: 'translate',
      description: 'Translation: /translate on | only | off | original-first | translation-first | provider | status',
      argumentHint: 'on | only | off | original-first | translation-first | provider [name] | status',
    })
    return next(e)
  })

  on('command.run', { command: 'translate' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const [word = '', ...rest] = arg.split(/\s+/)
    const wanted: Mode | undefined =
      arg === 'only' ? 'only' : arg === 'off' ? 'off' : arg === 'on' || arg === 'bilingual' ? 'bilingual' : undefined
    const wantedOrder: Order | undefined = ORDERS.find(one => one === arg)
    if (wanted) {
      await update($, mode, () => wanted)
      await $.store.set('mode', wanted)
    } else if (wantedOrder) {
      await update($, order, () => wantedOrder)
      await $.store.set('order', wantedOrder)
    } else if (word === 'provider' || word === 'providers') {
      const name = rest.join(' ')
      if (name) {
        const problem = await pickProvider($, options, name)
        if (problem) return { text: problem }
      }
    } else if (arg && arg !== 'status') {
      return { text: USAGE }
    }
    return { text: await status($, options) }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || isMostlyEnglish(e.text) !== false || (await read($, mode)) === 'off') {
      return next(e)
    }
    $.ui.status('Translating the prompt into English…')
    let english: string
    try {
      english = await complete($, options, toEnglishPrompt(settingsOf(options).language), e.text, false)
    } catch (error) {
      $.ui.toast(`translate-bridge: sent as typed (${describe(error)})`)
      return next(e)
    } finally {
      $.ui.status(undefined)
    }
    // Record the pair both ways: a surface may hand the row the English sent or the text typed.
    await $.state.set({ ...originalRef, id: hash(english.trim()) }, e.text)
    await $.state.set({ ...englishRef, id: hash(e.text.trim()) }, english)
    return next({ ...e, text: english })
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const current = await read($, mode)
    if (current === 'off') return next(e)
    const id = hash(e.props.text.trim())
    const [{ value: original }, { value: english }] = await Promise.all([
      $.state.get({ ...originalRef, id }),
      $.state.get({ ...englishRef, id }),
    ])
    const typedText = original ?? (english ? e.props.text : undefined)
    const sent = original ? e.props.text : english
    if (!typedText || !sent) return next(e)
    const shown = pair(typedText, sent, current, await read($, order), false, (a, b) => `${a}\n\n↳ ${b}`)
    return next({ ...e, props: { ...e.props, text: shown } })
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const current = await read($, mode)
    const source = e.props.text
    const english = isMostlyEnglish(source)
    if (current === 'off' || english === undefined || (current === 'only' && !english)) return next(e)

    const target = english ? settingsOf(options).language : 'English'
    const id = hash(`reply:${target}:${source}`)
    const { value } = await $.state.get({ ...translatedRef, id })
    if (value) {
      return next({ ...e, props: { ...e.props, text: layout(source, value, current, await read($, order), english) } })
    }

    // While a block streams its start stays the same: that and the message id find it again.
    const slot = `${e.requestId ?? ''}:${source.slice(0, 40)}`
    schedule($, slot, source, () => translateReply($, options, id, source, target))
    return next(e)
  })

  // The grey step labels: only the row's drawing changes, never the call that runs.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const current = await read($, mode)
    const label = labelOf(e.props.tool, e.props.input)
    if (current === 'off' || !label) return next(e)
    const slot = `label:${e.props.tool_use_id}`
    const shown = await shownLabel($, options, current, slot, label)
    if (!shown) return next(e)
    const input = { ...(e.props.input as Record<string, unknown>), [labelField(e.props.tool)]: shown }
    return next({ ...e, props: { ...e.props, input } })
  })

  // A folded group shows the app's own count line ("Ran a command"), which has no text to
  // translate. So a group with a labelled step is unfolded: each step then draws as a ToolUse
  // row with its own label, which the hook above translates.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const current = await read($, mode)
    if (current === 'off') return next(e)
    if (!e.props.isExpanded && e.props.calls.some(call => labelOf(call.tool, call.input))) {
      return next({ ...e, props: { ...e.props, isExpanded: true } })
    }
    let changed = false
    const calls = await Promise.all(
      e.props.calls.map(async (call, index) => {
        const label = labelOf(call.tool, call.input)
        if (!label) return call
        const slot = `label:${call.tool_use_id ?? `${e.requestId}:${index}`}`
        const shown = await shownLabel($, options, current, slot, label)
        if (!shown) return call
        changed = true
        return { ...call, input: { ...(call.input as Record<string, unknown>), [labelField(call.tool)]: shown } }
      }),
    )
    return changed ? next({ ...e, props: { ...e.props, calls } }) : next(e)
  })
}
