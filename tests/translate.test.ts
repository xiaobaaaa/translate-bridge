import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

type Request = { system: string; input: string; json: boolean; body: Record<string, unknown> }

// A fake OpenAI-compatible API. Block requests get each block back as "ZH(<block>)";
// plain requests get a fixed English or Chinese line.
function fakeApi(on: On, seen: Request[], options: { breakBlocks?: boolean } = {}) {
  on('http.fetch', ($, e) => {
    const body = JSON.parse(e.init?.body ?? '{}') as {
      messages: { content: string }[]
      response_format?: unknown
    } & Record<string, unknown>
    const system = body.messages[0]?.content ?? ''
    const input = body.messages[1]?.content ?? ''
    seen.push({ system, input, json: body.response_format !== undefined, body })
    let content: string
    if (body.response_format !== undefined) {
      const blocks = JSON.parse(input) as string[]
      const out = options.breakBlocks ? blocks.slice(1) : blocks.map(block => `ZH(${block})`)
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
  fakeApi(on, seen)
  on('prompt.submit', ($, e) => ({ text: e.text }))

  expect(await $.prompt.submit(typed('list the files in this folder'))).toMatchObject({
    text: 'list the files in this folder',
  })
  expect(seen).toHaveLength(0)
})

test('with no API key the prompt goes as typed', async ($, on) => {
  mock.env(on, {})
  on('prompt.submit', ($, e) => ({ text: e.text }))

  expect(await $.prompt.submit(typed('请列出文件'))).toMatchObject({ text: '请列出文件' })
})

test('the old DEEPSEEK_API_KEY still works with the DeepSeek API', async ($, on) => {
  const seen: Request[] = []
  mock.env(on, { DEEPSEEK_API_KEY: 'sk-old' })
  fakeApi(on, seen)
  on('prompt.submit', ($, e) => ({ text: e.text }))

  expect(await $.prompt.submit(typed('请列出文件'))).toMatchObject({ text: 'Please list the files.' })
})

for (const shown of ['Please list the files.', '请列出文件']) {
  test(`your message shows both languages when the row is handed "${shown}"`, async ($, on) => {
    mock.env(on, KEY)
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

test('a reply is shown paragraph by paragraph: translation, then the English as a quote; code once', async ($, on) => {
  const seen: Request[] = []
  const clock = mock.clock(on)
  mock.env(on, KEY)
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
  expect(shown).toContain('ZH(I checked the two endpoints and both of them answered.)\n\n> I checked the two endpoints')
  expect(shown).toContain('ZH(- **Free:** big-pickle, beam-free)\n\n> - **Free:** big-pickle, beam-free')
  expect(shown.split('curl https://example.com/models')).toHaveLength(2)
})

test('when the provider loses the blocks, the whole reply is translated instead', async ($, on) => {
  const seen: Request[] = []
  const clock = mock.clock(on)
  mock.env(on, KEY)
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

test('English prose naming a few Chinese things is still English; a Chinese reply gets English under it', async ($, on) => {
  const seen: Request[] = []
  const clock = mock.clock(on)
  mock.env(on, KEY)
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
  expect(await drawnText(ui)).toContain('这里是文件列表。 / List files in current directory')
})

test('a folded group with labelled steps is unfolded, so each step shows its own label', async ($, on) => {
  const seen: Request[] = []
  mock.env(on, KEY)
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
  expect(drawn).toContain('这里是文件列表。 / Show working tree status')
  expect(drawn).toContain('这里是文件列表。 / Install package dependencies')
})
