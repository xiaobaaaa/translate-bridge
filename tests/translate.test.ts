import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

type Request = { url: string; key?: string; system: string; input: string; json: boolean; body: Record<string, unknown> }

// A fake OpenAI-compatible API. Block requests get each block back as "ZH(<block>)";
// plain requests get a fixed English or Chinese line.
function fakeApi(
  on: On,
  seen: Request[],
  options: { breakBlocks?: boolean; echoBlocks?: boolean; failFirst?: number; failHosts?: string[] } = {},
) {
  let failures = options.failFirst ?? 0
  on('http.fetch', ($, e) => {
    const url = String(e.url)
    if (failures > 0 || options.failHosts?.some(host => url.includes(host))) {
      if (failures > 0) failures--
      seen.push({ url, system: 'FAILED', input: '', json: false, body: {} })
      return { value: { status: 503, ok: false, headers: {}, text: 'busy' } }
    }
    const body = JSON.parse(e.init?.body ?? '{}') as {
      messages: { content: string }[]
      response_format?: unknown
    } & Record<string, unknown>
    const system = body.messages[0]?.content ?? ''
    const input = body.messages[1]?.content ?? ''
    const key = (e.init?.headers as Record<string, string> | undefined)?.authorization
    seen.push({ url, key, system, input, json: body.response_format !== undefined, body })
    let content: string
    if (body.response_format !== undefined) {
      const blocks = JSON.parse(input) as string[]
      const out = options.breakBlocks
        ? blocks.slice(1)
        : options.echoBlocks
          ? blocks
          : blocks.map(block => `ZH(${block})`)
      content = JSON.stringify({ blocks: out })
    } else {
      content = /[一-鿿]/.test(input) ? 'Please list the files.' : '这里是文件列表。'
    }
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify({ choices: [{ message: { content } }] }),
      },
    }
  })
}

// The engine's own drawing, standing in: the text it is handed, as is.
function drawAs(on: On, component: 'AssistantMessage' | 'UserMessage') {
  if (component === 'AssistantMessage') {
    on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return h(Text, null, e.props.text) as RenderElement
    })
  } else {
    on('ui.render', { component: 'UserMessage' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return h(Text, null, e.props.text) as RenderElement
    })
  }
}

function drawLabels(on: On) {
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, String((e.props.input as { description?: string }).description)) as RenderElement
  })
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    const labels = e.props.calls.map(call => String((call.input as { description?: string }).description))
    return h(Text, null, labels.join(' | ')) as RenderElement
  })
}

const KEY = { TRANSLATE_BRIDGE_API_KEY: 'sk-test' }

async function drawnText(ui: { drawn: () => Promise<RenderElement> }): Promise<string> {
  return JSON.stringify(await ui.drawn())
}

test('a Chinese prompt reaches Claude in English', async ($, on) => {
  const seen: Request[] = []
  mock.env(on, KEY)
  mock.store(on)
  fakeApi(on, seen)
  on('prompt.submit', ($, e) => ({ text: e.text }))

  expect(await $.prompt.submit(typed('请列出文件'))).toMatchObject({ text: 'Please list the files.' })
  expect(seen[0]?.system).toContain('Simplified Chinese')
  // DeepSeek is the default: thinking off for translation
  expect(seen[0]?.body.thinking).toEqual({ type: 'disabled' })
})

test('an English prompt goes as typed, with no API call', async ($, on) => {
  const seen: Request[] = []
  mock.env(on, KEY)
  mock.store(on)
  fakeApi(on, seen)
  on('prompt.submit', ($, e) => ({ text: e.text }))

  expect(await $.prompt.submit(typed('list the files in this folder'))).toMatchObject({
    text: 'list the files in this folder',
  })
  expect(seen).toHaveLength(0)
})

test('with no API key the prompt goes as typed', async ($, on) => {
  mock.env(on, {})
  mock.store(on)
  on('prompt.submit', ($, e) => ({ text: e.text }))

  expect(await $.prompt.submit(typed('请列出文件'))).toMatchObject({ text: '请列出文件' })
})

test('the old DEEPSEEK_API_KEY still works with the DeepSeek API', async ($, on) => {
  const seen: Request[] = []
  mock.env(on, { DEEPSEEK_API_KEY: 'sk-old' })
  mock.store(on)
  fakeApi(on, seen)
  on('prompt.submit', ($, e) => ({ text: e.text }))

  expect(await $.prompt.submit(typed('请列出文件'))).toMatchObject({ text: 'Please list the files.' })
})

for (const shown of ['Please list the files.', '请列出文件']) {
  test(`your message shows both languages when the row is handed "${shown}"`, async ($, on) => {
    mock.env(on, KEY)
    mock.store(on)
    fakeApi(on, [])
    on('prompt.submit', ($, e) => ({ text: e.text }))
    drawAs(on, 'UserMessage')

    await $.prompt.submit(typed('请列出文件'))
    const ui = await $.ui.mount({
      plugin: 'translate-bridge',
      surface: 'desktop',
      component: 'UserMessage',
      props: { text: shown, origin: { kind: 'composer' }, isExpanded: false },
    })
    const drawn = await drawnText(ui)
    expect(drawn).toContain('请列出文件')
    expect(drawn).toContain('↳ Please list the files.')
  })
}

const REPLY = [
  'I checked the two endpoints and both of them answered.',
  '- **Free:** big-pickle, beam-free',
  '```bash\ncurl https://example.com/models\n\necho done\n```',
  'This is the public list, so it does not prove that your account can call each model.',
].join('\n\n')

test('a reply is shown paragraph by paragraph: the English as written, then the translation as a quote; code once', async ($, on) => {
  const seen: Request[] = []
  const clock = mock.clock(on)
  mock.env(on, KEY)
  mock.store(on)
  fakeApi(on, seen)
  drawAs(on, 'AssistantMessage')

  const ui = await $.ui.mount({
    plugin: 'translate-bridge',
    surface: 'desktop',
    component: 'AssistantMessage',
    props: { text: REPLY, isFirstOfReply: true },
  })
  await clock.advance(2000)
  expect(seen).toHaveLength(1)
  expect(seen[0]?.json).toBe(true)
  // three prose blocks are sent; the code block is not
  expect(JSON.parse(seen[0]?.input ?? '[]')).toHaveLength(3)

  const drawn = JSON.parse(await drawnText(ui)) as { children: string[] }
  const shown = drawn.children.join('')
  expect(shown).toContain('I checked the two endpoints and both of them answered.\n\n> ZH(I checked the two endpoints')
  expect(shown).toContain('- **Free:** big-pickle, beam-free\n\n> ZH(- **Free:** big-pickle, beam-free)')
  expect(shown.split('curl https://example.com/models')).toHaveLength(2)
})

test('when the provider loses the blocks, the whole reply is translated instead', async ($, on) => {
  const seen: Request[] = []
  const clock = mock.clock(on)
  mock.env(on, KEY)
  mock.store(on)
  fakeApi(on, seen, { breakBlocks: true })
  drawAs(on, 'AssistantMessage')

  const ui = await $.ui.mount({
    plugin: 'translate-bridge',
    surface: 'desktop',
    component: 'AssistantMessage',
    props: { text: REPLY, isFirstOfReply: true },
  })
  await clock.advance(2000)
  expect(seen).toHaveLength(2)
  const shown = await drawnText(ui)
  expect(shown).toContain('这里是文件列表。')
  expect(shown).toContain('---')
})

test('blocks the provider hands back untranslated are translated again one by one', async ($, on) => {
  const seen: Request[] = []
  const clock = mock.clock(on)
  mock.env(on, KEY)
  mock.store(on)
  fakeApi(on, seen, { echoBlocks: true })
  drawAs(on, 'AssistantMessage')

  const ui = await $.ui.mount({
    plugin: 'translate-bridge',
    surface: 'desktop',
    component: 'AssistantMessage',
    props: { text: REPLY, isFirstOfReply: true },
  })
  await clock.advance(2000)
  // one block request, then one plain request for each of the three prose blocks
  expect(seen).toHaveLength(4)
  expect(seen.slice(1).every(request => !request.json)).toBe(true)
  const shown = await drawnText(ui)
  expect(shown).toContain('> 这里是文件列表。')
  expect(shown).not.toContain('---')
})

test('English prose naming a few Chinese things is still English; a Chinese reply gets English under it', async ($, on) => {
  const seen: Request[] = []
  const clock = mock.clock(on)
  mock.env(on, KEY)
  mock.store(on)
  fakeApi(on, seen)
  drawAs(on, 'AssistantMessage')

  await $.ui.mount({
    plugin: 'translate-bridge',
    surface: 'desktop',
    component: 'AssistantMessage',
    props: { text: 'For your mod I recommend Zhipu (智谱) GLM-4-Flash, which is free and connects directly.', isFirstOfReply: true },
  })
  const chinese = await $.ui.mount({
    plugin: 'translate-bridge',
    surface: 'desktop',
    component: 'AssistantMessage',
    props: { text: '推荐用智谱的 GLM-4-Flash，它免费而且可以直连。', isFirstOfReply: true },
  })
  await clock.advance(2000)
  expect(seen).toHaveLength(2)
  expect(seen.some(one => one.system.includes('into Simplified Chinese'))).toBe(true)
  expect(seen.some(one => one.system.includes('into English'))).toBe(true)
  const shown = await drawnText(chinese)
  expect(shown).toContain('推荐用智谱')
  expect(shown).toContain('> ZH(推荐用智谱')
})

test('the language option sets the target', { options: { language: 'Japanese' } }, async ($, on) => {
  const seen: Request[] = []
  const clock = mock.clock(on)
  mock.env(on, KEY)
  mock.store(on)
  fakeApi(on, seen)
  drawAs(on, 'AssistantMessage')

  await $.ui.mount({
    plugin: 'translate-bridge',
    surface: 'desktop',
    component: 'AssistantMessage',
    props: { text: 'Here are the files in the folder you asked about.', isFirstOfReply: true },
  })
  await clock.advance(2000)
  expect(seen[0]?.system).toContain('into Japanese')
})

const bash = (id: string, description: string) => ({
  tool_use_id: id,
  tool: 'Bash',
  input: { command: 'ls', description },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
})

test('a step label is shown bilingually', async ($, on) => {
  const seen: Request[] = []
  const clock = mock.clock(on)
  mock.env(on, KEY)
  mock.store(on)
  fakeApi(on, seen)
  drawLabels(on)

  const ui = await $.ui.mount({
    plugin: 'translate-bridge',
    surface: 'desktop',
    component: 'ToolUse',
    props: bash('t1', 'List files in current directory'),
  })
  await clock.advance(2000)
  expect(seen).toHaveLength(1)
  expect(await drawnText(ui)).toContain('List files in current directory / 这里是文件列表。')
})

test('a folded group with labelled steps is unfolded, so each step shows its own label', async ($, on) => {
  const seen: Request[] = []
  mock.env(on, KEY)
  mock.store(on)
  fakeApi(on, seen)
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, e.props.isExpanded ? 'unfolded' : 'Ran 2 commands') as RenderElement
  })

  const ui = await $.ui.mount({
    plugin: 'translate-bridge',
    surface: 'desktop',
    component: 'ToolGroup',
    props: {
      calls: [bash('u1', 'Show working tree status'), bash('u2', 'Install package dependencies')],
      isActive: false,
      isExpanded: false,
    },
  })
  expect(await drawnText(ui)).toContain('unfolded')
})

test('a folded group of steps with no label stays folded', async ($, on) => {
  mock.env(on, KEY)
  mock.store(on)
  fakeApi(on, [])
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, e.props.isExpanded ? 'unfolded' : 'Read 2 files') as RenderElement
  })
  const read = (id: string) => ({ ...bash(id, ''), tool: 'Read', input: { file_path: '/tmp/a' } })

  const ui = await $.ui.mount({
    plugin: 'translate-bridge',
    surface: 'desktop',
    component: 'ToolGroup',
    props: { calls: [read('r1'), read('r2')], isActive: false, isExpanded: false },
  })
  expect(await drawnText(ui)).toContain('Read 2 files')
})

test('each step in an unfolded group is shown bilingually', async ($, on) => {
  const seen: Request[] = []
  const clock = mock.clock(on)
  mock.env(on, KEY)
  mock.store(on)
  fakeApi(on, seen)
  drawLabels(on)

  const ui = await $.ui.mount({
    plugin: 'translate-bridge',
    surface: 'desktop',
    component: 'ToolGroup',
    props: {
      calls: [bash('g1', 'Show working tree status'), bash('g2', 'Install package dependencies')],
      isActive: false,
      isExpanded: true,
    },
  })
  await clock.advance(2000)
  expect(seen).toHaveLength(2)
  const drawn = await drawnText(ui)
  expect(drawn).toContain('Show working tree status / 这里是文件列表。')
  expect(drawn).toContain('Install package dependencies / 这里是文件列表。')
})

test('a reply the app reports as off screen is still translated', async ($, on) => {
  const seen: Request[] = []
  const clock = mock.clock(on)
  mock.env(on, KEY)
  mock.store(on)
  fakeApi(on, seen)
  drawAs(on, 'AssistantMessage')

  const ui = await $.ui.mount({
    plugin: 'translate-bridge',
    surface: 'desktop',
    component: 'AssistantMessage',
    props: { text: 'Confirmed: every message reached me in English.', isFirstOfReply: true, onScreen: null },
  })
  await clock.advance(2000)
  expect(await drawnText(ui)).toContain('ZH(Confirmed: every message reached me in English.)')
})

test('a failed translation is tried again, and is not reported while a retry is left', async ($, on) => {
  const seen: Request[] = []
  const toasts: string[] = []
  const clock = mock.clock(on)
  mock.env(on, KEY)
  mock.store(on)
  fakeApi(on, seen, { failFirst: 2 })
  drawAs(on, 'AssistantMessage')
  on('ui.toast', ($, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })

  const ui = await $.ui.mount({
    plugin: 'translate-bridge',
    surface: 'desktop',
    component: 'AssistantMessage',
    props: { text: 'Here are the files in the folder you asked about.', isFirstOfReply: true },
  })
  await clock.advance(2000)
  // first try: the block request fails, and so does the whole-text fallback
  await clock.advance(6000)
  expect(await drawnText(ui)).toContain('ZH(Here are the files in the folder you asked about.)')
  expect(toasts).toHaveLength(0)
})

test('/translate translation-first puts the translation first everywhere', async ($, on) => {
  const seen: Request[] = []
  const clock = mock.clock(on)
  mock.env(on, KEY)
  mock.store(on)
  fakeApi(on, seen)
  drawAs(on, 'AssistantMessage')
  drawLabels(on)

  const answer = await $.command.run({
    command: 'translate',
    args: 'translation-first',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(JSON.stringify(answer)).toContain('translation-first')

  const reply = await $.ui.mount({
    plugin: 'translate-bridge',
    surface: 'desktop',
    component: 'AssistantMessage',
    props: { text: 'Here are the files in the folder you asked about.', isFirstOfReply: true },
  })
  const label = await $.ui.mount({
    plugin: 'translate-bridge',
    surface: 'desktop',
    component: 'ToolUse',
    props: bash('o1', 'List files in current directory'),
  })
  await clock.advance(2000)
  expect(await drawnText(reply)).toContain('ZH(Here are the files in the folder you asked about.)\\n\\n> Here are the files')
  expect(await drawnText(label)).toContain('这里是文件列表。 / List files in current directory')
})

const ZHIPU = { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', fallback: 'deepseek' }
const BOTH_KEYS = { TRANSLATE_BRIDGE_API_KEY: 'sk-zhipu', DEEPSEEK_API_KEY: 'sk-deepseek' }

function run(command: { run: (input: never) => Promise<unknown> }, args: string) {
  return command.run({
    command: 'translate',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  } as never)
}

test('when the main provider fails, the fallback answers', { options: ZHIPU }, async ($, on) => {
  const seen: Request[] = []
  mock.env(on, BOTH_KEYS)
  mock.store(on)
  fakeApi(on, seen, { failHosts: ['bigmodel.cn'] })
  on('prompt.submit', ($, e) => ({ text: e.text }))

  expect(await $.prompt.submit(typed('请列出文件'))).toMatchObject({ text: 'Please list the files.' })
  expect(seen.map(request => request.url)).toEqual([
    'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    'https://api.deepseek.com/chat/completions',
  ])
  // Zhipu has its own defaults; DeepSeek still gets thinking off and its own key
  expect(seen[1]?.body.model).toBe('deepseek-flash')
  expect(seen[1]?.body.thinking).toEqual({ type: 'disabled' })
})

test('the main provider uses its own key and default model', { options: ZHIPU }, async ($, on) => {
  const seen: Request[] = []
  mock.env(on, BOTH_KEYS)
  mock.store(on)
  fakeApi(on, seen)
  on('prompt.submit', ($, e) => ({ text: e.text }))

  await $.prompt.submit(typed('请列出文件'))
  expect(seen).toHaveLength(1)
  expect(seen[0]?.body.model).toBe('glm-4-flash')
  expect(seen[0]?.key).toBe('Bearer sk-zhipu')
})

test('when every provider fails, the notice names each one', { options: ZHIPU }, async ($, on) => {
  const toasts: string[] = []
  mock.env(on, BOTH_KEYS)
  mock.store(on)
  fakeApi(on, [], { failHosts: ['bigmodel.cn', 'deepseek.com'] })
  on('ui.toast', ($, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))

  expect(await $.prompt.submit(typed('请列出文件'))).toMatchObject({ text: '请列出文件' })
  expect(toasts.join(' ')).toContain('zhipu: the translation API answered HTTP 503')
  expect(toasts.join(' ')).toContain('deepseek: the translation API answered HTTP 503')
})

test('a fallback with no key is skipped, and the notice says where to set it', { options: { ...ZHIPU, fallback: 'qwen' } }, async ($, on) => {
  const toasts: string[] = []
  mock.env(on, { TRANSLATE_BRIDGE_API_KEY: 'sk-zhipu' })
  mock.store(on)
  fakeApi(on, [], { failHosts: ['bigmodel.cn'] })
  on('ui.toast', ($, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))

  await $.prompt.submit(typed('请列出文件'))
  expect(toasts.join(' ')).toContain('qwen: no API key: set the plugin option qwenApiKey or the DASHSCOPE_API_KEY environment variable')
})

test('/translate provider deepseek puts DeepSeek first; default puts the order back', { options: ZHIPU }, async ($, on) => {
  const seen: Request[] = []
  mock.env(on, BOTH_KEYS)
  mock.store(on)
  fakeApi(on, seen)
  on('prompt.submit', ($, e) => ({ text: e.text }))

  const answer = JSON.stringify(await run($.command, 'provider deepseek'))
  expect(answer).toContain('1. deepseek: deepseek-flash at https://api.deepseek.com (API key set)')
  expect(answer).toContain('2. zhipu: glm-4-flash at https://open.bigmodel.cn/api/paas/v4 (API key set)')
  await $.prompt.submit(typed('请列出文件'))
  expect(seen[0]?.url).toBe('https://api.deepseek.com/chat/completions')

  expect(JSON.stringify(await run($.command, 'provider default'))).toContain('1. zhipu')
})

test('/translate provider with an unknown name lists the choices', { options: ZHIPU }, async ($, on) => {
  mock.env(on, BOTH_KEYS)
  mock.store(on)
  const answer = JSON.stringify(await run($.command, 'provider nope'))
  expect(answer).toContain('no provider \\"nope\\"')
  expect(answer).toContain('zhipu, deepseek, qwen')
})

test('/translate status with one provider keeps to one line', async ($, on) => {
  mock.env(on, KEY)
  mock.store(on)
  const answer = JSON.stringify(await run($.command, 'status'))
  expect(answer).toContain('via deepseek: deepseek-flash at https://api.deepseek.com (API key set)')
})

// The mod's id for a text (cyrb53), to lay out what a store holds after a restart.
function idOf(value: string): string {
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

const WRITTEN = 'Here are the files in the folder you asked about.'

function response(text: string) {
  return {
    message: { type: 'assistant' as const, role: 'assistant' as const, content: [{ type: 'text', text }] },
    door: 'response' as const,
    origin: { kind: 'model' as const, model: 'test' },
    uuid: 'r1',
  }
}

function promptRow(text: string) {
  return {
    message: { type: 'user' as const, role: 'user' as const, content: [{ type: 'text', text }] },
    door: 'prompt' as const,
    origin: { kind: 'composer' as const },
    uuid: 'p1',
  }
}

test('a reply is translated as it is written, so it is ready when drawn, and is not translated again', async ($, on) => {
  const seen: Request[] = []
  const clock = mock.clock(on)
  mock.env(on, KEY)
  mock.store(on)
  fakeApi(on, seen)
  drawAs(on, 'AssistantMessage')

  await $.session.append(response(WRITTEN))
  await clock.advance(10)
  // translated with nothing on screen
  expect(seen).toHaveLength(1)

  const ui = await $.ui.mount({
    plugin: 'translate-bridge',
    surface: 'desktop',
    component: 'AssistantMessage',
    props: { text: WRITTEN, isFirstOfReply: true },
  })
  expect(await drawnText(ui)).toContain(`ZH(${WRITTEN})`)
  await clock.advance(2000)
  expect(seen).toHaveLength(1)
})

test('a translation is saved in the store', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, KEY)
  // the store in memory, kept here so the test can read it
  const written: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: written[e.key] }))
  on('store.set', ($, e) => {
    written[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete written[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(written) }))
  fakeApi(on, [])

  await $.session.append(response(WRITTEN))
  await clock.advance(10)
  const key = `t:${idOf(`reply:Simplified Chinese:${WRITTEN}`)}`
  expect(written[key]).toEqual({ blocks: [`ZH(${WRITTEN})`] })
  expect(JSON.stringify(written.saved)).toContain(key)
})

test('after a restart, a saved translation is drawn with no API call', async ($, on) => {
  const seen: Request[] = []
  const clock = mock.clock(on)
  mock.env(on, KEY)
  mock.store(on, { [`t:${idOf(`reply:Simplified Chinese:${WRITTEN}`)}`]: { blocks: ['已保存的译文。'] } })
  fakeApi(on, seen)
  drawAs(on, 'AssistantMessage')

  const ui = await $.ui.mount({
    plugin: 'translate-bridge',
    surface: 'desktop',
    component: 'AssistantMessage',
    props: { text: WRITTEN, isFirstOfReply: true },
  })
  expect(await drawnText(ui)).toContain('> 已保存的译文。')
  await clock.advance(2000)
  expect(seen).toHaveLength(0)
})

test('a prompt that reaches the conversation untranslated is translated there', async ($, on) => {
  const seen: Request[] = []
  mock.env(on, KEY)
  mock.store(on)
  fakeApi(on, seen)
  const session = mock.session(on)

  await $.session.append(promptRow('请列出文件'))
  const row = session.appended().find(one => one.door === 'prompt')
  expect(JSON.stringify(row?.message.content)).toContain('Please list the files.')
  expect(JSON.stringify(row?.message.content)).not.toContain('请列出文件')
  expect(seen).toHaveLength(1)
})

test('a prompt that goes as typed leaves a notice in the transcript saying why', async ($, on) => {
  mock.env(on, {})
  mock.store(on)
  const session = mock.session(on)

  await $.session.append(promptRow('请列出文件'))
  const rows = session.appended()
  expect(JSON.stringify(rows.find(one => one.door === 'prompt')?.message.content)).toContain('请列出文件')
  const notice = rows.find(one => one.door === 'note')
  expect(notice?.message.type).toBe('system')
  expect(JSON.stringify(notice?.message.content)).toContain('reached Claude as typed')
  expect(JSON.stringify(notice?.message.content)).toContain('no API key')
})

test('a prompt translated when submitted is not translated again as its row is kept', async ($, on) => {
  const seen: Request[] = []
  mock.env(on, KEY)
  mock.store(on)
  fakeApi(on, seen)
  on('prompt.submit', ($, e) => ({ text: e.text }))

  const sent = await $.prompt.submit(typed('请列出文件'))
  await $.session.append(promptRow((sent as { text: string }).text))
  expect(seen).toHaveLength(1)
})
