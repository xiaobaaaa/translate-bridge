import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Mode, Translation } from '../types'

const mode = atom({ plugin: 'translate-bridge', key: 'mode' } as const, 'bilingual')
const translatedRef = { plugin: 'translate-bridge', key: 'translated' } as const
const originalRef = { plugin: 'translate-bridge', key: 'original' } as const
const englishRef = { plugin: 'translate-bridge', key: 'english' } as const

const MODES: readonly Mode[] = ['off', 'only', 'bilingual']
const MODE_LABEL: Record<Mode, string> = {
  off: 'off',
  only: 'translation only',
  bilingual: 'bilingual',
}

// A reply grows while it streams; translate once it has stopped changing this long.
const SETTLE_MS = 1500

const DEFAULT_LANGUAGE = 'Simplified Chinese'
const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash'

type Settings = {
  language: string
  baseUrl: string
  model: string
  extraBody: Record<string, unknown>
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isDeepSeek(baseUrl: string): boolean {
  return /(^|\.|\/\/)deepseek\.com/.test(baseUrl)
}

function settingsOf(options: PluginOptions): Settings {
  const baseUrl = (text(options.baseUrl) || DEFAULT_BASE_URL).replace(/\/+$/, '')
  let extraBody: Record<string, unknown> = {}
  const raw = text(options.extraBody)
  if (raw) {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      extraBody = parsed as Record<string, unknown>
    }
  }
  return {
    language: text(options.language) || DEFAULT_LANGUAGE,
    baseUrl,
    model: text(options.model) || (isDeepSeek(baseUrl) ? DEFAULT_DEEPSEEK_MODEL : ''),
    extraBody,
  }
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

// Native text first, the English under it as a quote, paragraph by paragraph.
function layout(source: string, translation: Translation, current: Mode, sourceIsEnglish: boolean): string {
  if (translation.whole !== undefined) {
    const [native, english] = sourceIsEnglish ? [translation.whole, source] : [source, translation.whole]
    return current === 'only' ? native : `${native}\n\n---\n\n${english}`
  }
  const translated = translation.blocks ?? []
  let index = 0
  return splitBlocks(source)
    .map(block => {
      if (!needsTranslation(block)) return block.text
      const other = translated[index++] ?? block.text
      const [native, english] = sourceIsEnglish ? [other, block.text] : [block.text, other]
      return current === 'only' ? native : `${native}\n\n${quote(english)}`
    })
    .join('\n\n')
}

const pending = new Map<string, { text: string; cancel: () => void }>()
const inflight = new Set<string>()

async function apiKey($: EngineInterface, options: PluginOptions): Promise<string | undefined> {
  const own = text(options.apiKey)
  if (own) return own
  const shared = text(await $.env.get('TRANSLATE_BRIDGE_API_KEY'))
  if (shared) return shared
  return isDeepSeek(settingsOf(options).baseUrl) ? text(await $.env.get('DEEPSEEK_API_KEY')) || undefined : undefined
}

async function complete(
  $: EngineInterface,
  options: PluginOptions,
  system: string,
  input: string,
  asJson: boolean,
): Promise<string> {
  const settings = settingsOf(options)
  const key = await apiKey($, options)
  if (!key) {
    throw new Error('no API key: set the plugin option apiKey or the TRANSLATE_BRIDGE_API_KEY environment variable')
  }
  if (!settings.model) {
    throw new Error('no model: set the plugin option model')
  }
  const res = await $.http.fetch(`${settings.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: settings.model,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: input },
      ],
      ...(asJson ? { response_format: { type: 'json_object' } } : {}),
      // DeepSeek thinks by default; translation does not need it, and it costs time and money.
      ...(isDeepSeek(settings.baseUrl) ? { thinking: { type: 'disabled' }, temperature: 0 } : {}),
      ...settings.extraBody,
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

async function translateReply($: EngineInterface, options: PluginOptions, id: string, source: string, target: string) {
  if (inflight.has(id)) return
  inflight.add(id)
  try {
    const blocks = splitBlocks(source).filter(needsTranslation).map(block => block.text)
    const translated = await translateBlocks($, options, blocks, target)
    const value: Translation = translated
      ? { blocks: translated }
      : { whole: await complete($, options, wholePrompt(target), source, false) }
    await $.state.set({ ...translatedRef, id }, value)
  } catch (error) {
    $.ui.toast(`translate-bridge: ${describe(error)}`)
  } finally {
    inflight.delete(id)
  }
}

async function translateLabel($: EngineInterface, options: PluginOptions, id: string, label: string, target: string) {
  if (inflight.has(id)) return
  inflight.add(id)
  try {
    const whole = await complete($, options, labelPrompt(target), label, false)
    await $.state.set({ ...translatedRef, id }, { whole: whole.split('\n')[0] ?? whole })
  } catch (error) {
    $.ui.toast(`translate-bridge: ${describe(error)}`)
  } finally {
    inflight.delete(id)
  }
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
  canSchedule: boolean,
): Promise<string | undefined> {
  const english = isMostlyEnglish(label)
  if (english === undefined || (current === 'only' && !english)) return undefined
  const target = english ? settingsOf(options).language : 'English'
  const id = hash(`label:${target}:${label}`)
  const { value } = await $.state.get({ ...translatedRef, id })
  if (value?.whole !== undefined) {
    const [native, en] = english ? [value.whole, label] : [label, value.whole]
    return current === 'only' ? native : `${native} / ${en}`
  }
  if (canSchedule) schedule($, slot, label, () => translateLabel($, options, id, label, target))
  return undefined
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('mode')
    if (MODES.includes(saved as Mode)) {
      await update($, mode, () => saved as Mode)
    }
    await $.command.register({
      name: 'translate',
      description: 'Translation: /translate on (bilingual) | only | off | status',
      argumentHint: 'on | only | off | status',
    })
    return next(e)
  })

  on('command.run', { command: 'translate' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const wanted: Mode | undefined =
      arg === 'only' ? 'only' : arg === 'off' ? 'off' : arg === 'on' || arg === 'bilingual' ? 'bilingual' : undefined
    if (wanted) {
      await update($, mode, () => wanted)
      await $.store.set('mode', wanted)
    } else if (arg && arg !== 'status') {
      return { text: 'Usage: /translate on (bilingual) | only (translation only) | off | status' }
    }
    const now = await read($, mode)
    const settings = settingsOf(options)
    const key = (await apiKey($, options)) ? 'API key set' : 'no API key'
    return {
      text: `translate-bridge: ${MODE_LABEL[now]}; ${settings.language} ⇄ English via ${settings.model || '(no model)'} at ${settings.baseUrl}; ${key}`,
    }
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
    const native = original ?? (english ? e.props.text : undefined)
    const en = original ? e.props.text : english
    if (!native || !en) return next(e)
    const shown = current === 'only' ? native : `${native}\n\n↳ ${en}`
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
      return next({ ...e, props: { ...e.props, text: layout(source, value, current, english) } })
    }

    // Leave messages scrolled out of view for when they come back into view.
    if (e.props.onScreen === null) return next(e)

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
    const shown = await shownLabel($, options, current, slot, label, e.props.onScreen !== null)
    if (!shown) return next(e)
    const input = { ...(e.props.input as Record<string, unknown>), [labelField(e.props.tool)]: shown }
    return next({ ...e, props: { ...e.props, input } })
  })

  // Steps folded into a group get the same; the count line ("Ran 5 commands") is the app's own.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const current = await read($, mode)
    if (current === 'off') return next(e)
    let changed = false
    const calls = await Promise.all(
      e.props.calls.map(async (call, index) => {
        const label = labelOf(call.tool, call.input)
        if (!label) return call
        const slot = `label:${call.tool_use_id ?? `${e.requestId}:${index}`}`
        const shown = await shownLabel($, options, current, slot, label, e.props.onScreen !== null)
        if (!shown) return call
        changed = true
        return { ...call, input: { ...(call.input as Record<string, unknown>), [labelField(call.tool)]: shown } }
      }),
    )
    return changed ? next({ ...e, props: { ...e.props, calls } }) : next(e)
  })
}
