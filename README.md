# translate-bridge

**Write to Claude Code in your own language. Claude works in English. You read everything in both.**

translate-bridge is a Claude Code mod. It hooks into Claude Code's prompt and transcript, so you don't run a separate app:

- **Your prompt** is translated into English before Claude sees it. The transcript still shows what you typed, with the English that was sent under it (`↳ …`).
- **Claude's replies** are shown paragraph by paragraph: each paragraph as Claude wrote it, then its translation as a quote under it. Code blocks are shown once and never translated.
- **The grey step labels** (for example "List files in current directory") are shown as `English / your language`.
- Prefer the translation on top? `/translate translation-first` swaps the order everywhere.

The translation is done by any **OpenAI-compatible API** you choose, with **your own API key**. DeepSeek is the default, and the target language is set in the plugin options.

> Unofficial community project. It is not made or endorsed by Anthropic.

## Install

**Desktop app:** click **+** next to the prompt box, then **Plugins** → **Add marketplace** → enter `xiaobaaaa/translate-bridge` → **Add plugin**.

**Terminal session (at the Claude Code prompt):**

```
/plugin install translate-bridge --marketplace xiaobaaaa/translate-bridge
```

Answer `y` to add the marketplace, then pick a scope. *User* makes it work in every project.

**From a shell:**

```bash
claude plugin install translate-bridge --marketplace xiaobaaaa/translate-bridge
```

Options can be set in the same line, for example `--config language=Japanese`.

### Or let Claude install it for you

Copy this into a Claude Code session:

```text
Install the Claude Code mod "translate-bridge" from https://github.com/xiaobaaaa/translate-bridge.
First ask me which language I write in and which translation provider I use (DeepSeek, Qwen,
Zhipu GLM, OpenAI, OpenRouter or a local Ollama). Then install it with the matching options, e.g.:
claude plugin install translate-bridge --marketplace xiaobaaaa/translate-bridge --config language="Simplified Chinese" --config baseUrl=https://api.deepseek.com
(add --config model=<model> for any provider other than DeepSeek). Do not ask me to paste my API key into the chat:
tell me how to add it myself, either in the plugin's settings or as TRANSLATE_BRIDGE_API_KEY
in the "env" block of ~/.claude/settings.json. Then tell me to start a new session and run
/translate status to check it.
```

## Configure

Set these at install time (the install screen, or `--config KEY=VALUE`), or change them later with `/plugin configure translate-bridge@translate-bridge` in a terminal session or in the plugin's settings.

| Option | Default | What it is |
|---|---|---|
| `language` | `Simplified Chinese` | The language you write in and want replies shown in, named in English: `Japanese`, `Korean`, `Spanish`, `German`, … |
| `apiKey` | *(empty)* | Your key for the translation API. It is stored in the system's secure storage. If you leave it empty, the `TRANSLATE_BRIDGE_API_KEY` environment variable is used instead. |
| `baseUrl` | `https://api.deepseek.com` | Base URL of any OpenAI-compatible API. `/chat/completions` is appended to it. |
| `model` | *(empty → `deepseek-flash` on DeepSeek)* | The model that translates. Required for any provider other than DeepSeek. |
| `extraBody` | *(empty)* | Optional JSON object merged into every request, for example `{"temperature": 0}`. |
| `fallback` | *(empty)* | Providers to try, in order, when the one before fails, comma-separated: `deepseek`, `zhipu`, `qwen`, `openai`, `openrouter`, `ollama`. |
| `models` | *(empty)* | A model for each named provider, such as `qwen=qwen-flash, ollama=qwen3:8b`. DeepSeek and Zhipu have defaults; the others need one. |
| `deepseekApiKey`, `zhipuApiKey`, `qwenApiKey`, `openaiApiKey`, `openrouterApiKey` | *(empty)* | The key for that provider when it is a fallback or picked with `/translate provider`. Each is kept in secure storage. Left empty, the environment variable in the table below is used. |

If you'd rather use an environment variable for the key, add it to `~/.claude/settings.json` and start a new session:

```json
{ "env": { "TRANSLATE_BRIDGE_API_KEY": "sk-..." } }
```

### Providers

Any API that speaks OpenAI's `/chat/completions` works. Pick a small, fast model, because translation doesn't need a large one. The providers below are also known by name, for `fallback` and `/translate provider`. When `baseUrl` is one of their addresses, the main provider takes that name, its default model, and (if `apiKey` is empty) its key.

| Name | `baseUrl` | Default model | Key variable | Notes |
|---|---|---|---|---|
| `deepseek` | `https://api.deepseek.com` | `deepseek-flash` | `DEEPSEEK_API_KEY` | Default. Tested. Thinking mode is switched off automatically for translation. |
| `zhipu` | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | `ZHIPU_API_KEY` | `glm-4-flash` is free. Blocks it hands back untranslated are sent again one by one. |
| `qwen` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | *(set in `models`)* | `DASHSCOPE_API_KEY` | Untested; use a Qwen chat model. |
| `openai` | `https://api.openai.com/v1` | *(set in `models`)* | `OPENAI_API_KEY` | Untested. |
| `openrouter` | `https://openrouter.ai/api/v1` | *(set in `models`)* | `OPENROUTER_API_KEY` | Untested. |
| `ollama` | `http://localhost:11434/v1` | *(set in `models`)* | *(none needed)* | Untested. Runs on your machine, so no text leaves it. |

### Fallback providers

Set `fallback` to have other providers take over when one fails (no key, a network error, an HTTP error, an empty answer). Each request tries them in order, and a notice appears only when all of them failed, saying what each one answered. For example, Zhipu first and DeepSeek when Zhipu fails:

```bash
claude plugin install translate-bridge --marketplace xiaobaaaa/translate-bridge --config baseUrl=https://open.bigmodel.cn/api/paas/v4 --config fallback=deepseek
```

Then give each provider its key: the main one in `apiKey` (or `TRANSLATE_BRIDGE_API_KEY`), DeepSeek in `deepseekApiKey` (or `DEEPSEEK_API_KEY`).

Translation is cheap. On DeepSeek's October 2026 price list, translating a medium-length reply (about 700 tokens in and 700 out) costs well under one US cent.

## Use

| Command | What it does |
|---|---|
| `/translate on` | Bilingual (the default). |
| `/translate original-first` | In bilingual mode, show what was written first and its translation second (the default). |
| `/translate translation-first` | In bilingual mode, show the translation first and the original second. |
| `/translate only` | Show only the version in your language. |
| `/translate off` | Turn translation off. Prompts go to Claude as typed. |
| `/translate provider` | List the providers in the order they are tried, with each one's model and whether its key is set. |
| `/translate provider <name>` | Try that provider first, such as `/translate provider deepseek`. It can be any named provider with a key, even one not in `fallback`. |
| `/translate provider default` | Go back to the configured order. |
| `/translate status` | Show the mode, language, providers and whether each has a key. |

Your choices are remembered across sessions.

### In a session that is already open

A new session always loads the mod. For a session that is already running:

- **The mod loaded when the session started** (an older version, or before you changed its options): run `/reload-plugins`, then `/translate status` to check. `/reload-plugins` reloads only mods that loaded at the start.
- **The mod was not loaded at all** (the session started before you installed it): ask Claude in that session to copy the mod's folder into the session's own mods folder. Claude Code then asks whether to turn on mod hot-reloading for the session. Say yes, and the mod loads right away, without a restart, and reloads by itself when its files change. If you say no, it loads the next time that session starts.

Use the second way only where the mod isn't loaded already, or it runs twice and everything is translated twice. The copy belongs to that session and doesn't follow later updates; remove it before you restart the session, since a restarted session loads the installed mod as well.

### What happens, and when

- Prompts that are already English are sent unchanged, with no API call. Slash commands are never translated.
- Each block of a reply, and each step label, is translated as soon as Claude has written it, whether or not the session is on screen. Coming back to a session that worked in the background, you find its replies already translated. A block still streaming on screen is translated about 1.5 s after it stops changing. At most 4 translation requests run at once.
- Translations are saved, so they survive a restart of the app: a session you reopen shows them again with no new requests. About 1 million characters of them are kept, the oldest dropped first.
- If a prompt can't be translated (no key, network error, provider error), it is sent as typed and a notice says why. The mod also tries again as the prompt is written into the conversation, which catches a prompt sent before the mod had loaded (the first prompt of a new session can be). One that still goes as typed gets a line in the transcript saying so and why, which Claude does not read. A reply or label that fails is retried twice, 5 s apart, before a notice is shown. Nothing is ever dropped.
- Only what you **see** changes. Claude's stored conversation stays in English, so Claude's context is never mixed with translations.

### What isn't translated

- Count lines such as "Ran a command" or "Read 3 files" are written by Claude Code itself, and the mod has no text to change there. Instead, a folded group that contains a step with a description is shown unfolded, so each of those steps shows its own bilingual label. Groups of steps without descriptions (such as file reads) stay folded.
- Steps that only show a file name or a path.
- The details inside a tool call (command output, file contents).

## Privacy

Your prompts, Claude's replies and the step labels are sent to the translation provider you configure. If that matters for your work, use a provider you trust, or a local model through Ollama.

## Why translate at all?

Claude already understands many languages well, so this mod is about comfort, not rescue. The evidence is mixed:

- **Anthropic's own numbers show a small gap for major languages.** Measured on professionally translated MMLU, relative to English (100%), Claude Sonnet 4.5 scores 96.9% in Simplified Chinese, 96.8% in Japanese, 96.7% in Korean and 98.2% in Spanish. Claude Haiku 4.5 scores 94.2%, 93.5%, 93.3% and 96.4% respectively. The gap is much larger for low-resource languages: Yoruba is 79.7% and 52.7%. Anthropic itself describes the performance as consistent across languages. ([Claude docs: Multilingual support](https://platform.claude.com/docs/en/build-with-claude/multilingual-support); the table covers those two models only.)
- **Several studies find models do better when the input is in English.** Etxaniz et al. found that "language models are unable to leverage their full multilingual potential when prompted in non-English languages", and that translating the input into English first helps. ([NAACL 2024](https://aclanthology.org/2024.naacl-short.46/))
- **English isn't always better.** Liu et al. found that translating into English "can boost the performance of English-centric LLMs on NLP tasks, it is not universally optimal". Prompting in the native language worked better for culture-related tasks. ([NAACL 2025](https://arxiv.org/abs/2403.10258))
- **Part of the measured gap is benchmark noise.** Peter et al. found translation errors in the multilingual MGSM benchmark, and once these were fixed "the aforementioned language gap mostly disappears". ([arXiv 2511.05162](https://arxiv.org/abs/2511.05162))

In practice, the case for this mod is that coding work is English-heavy. Code, error messages, documentation and search results are mostly in English, so keeping Claude's whole conversation in English avoids constant language switching. You still read and write in your own language. Translation can add its own errors, so the English original always stays on screen.

## Develop

The mod is one hooks module, [`hooks/register.tsx`](hooks/register.tsx), with tests in [`tests/`](tests/).

```bash
claude plugin validate .
claude plugin test .
```

To run your working copy instead of the installed version, start Claude Code with `claude --plugin-dir /path/to/translate-bridge`, or list the folder in `CLAUDE_CODE_PLUGIN_DIRS`. Don't load both at once, or every text gets translated twice.

## License

[MIT](LICENSE)

---

## 简体中文

**用中文给 Claude Code 写提示，Claude 在英文里工作，回复按段落中英对照显示。**

- **你的提示**：先译成英文再交给 Claude；对话里照样显示你写的中文，下面附上发出去的英文。
- **Claude 的回复**：每段先显示英文原文，下面用引用块附上中文译文；代码块只显示一次，不翻译。
- **灰色步骤标签**：显示成「English / 中文」。
- 想让译文在上？`/translate translation-first` 会把所有地方的顺序换过来，`/translate original-first` 换回原文在上。

翻译用你自己的 API key，接任何 OpenAI 兼容接口，默认 DeepSeek。

**安装**：在桌面 App 里点输入框旁的 **+** → **Plugins** → **Add marketplace**，填 `xiaobaaaa/translate-bridge` → **Add plugin**。在终端会话里，也可以用上面英文部分的 `/plugin install` 命令。安装时填 API key，也可以在 `~/.claude/settings.json` 的 `env` 里设 `TRANSLATE_BRIDGE_API_KEY`。然后新开会话，运行 `/translate status` 检查。

**命令**：`/translate on`（中英对照，默认）、`/translate original-first`（原文在上，默认）、`/translate translation-first`（译文在上）、`/translate only`（只显示中文）、`/translate off`、`/translate provider [名称 | default]`（列出或切换翻译服务商，当前会话立即生效）、`/translate status`。

**已经开着的会话**：新开的会话总会加载本 mod。会话启动时已加载过本 mod（比如旧版本，或改设置之前）：运行 `/reload-plugins`，再用 `/translate status` 检查。会话启动时没加载本 mod（安装之前就开着）：在那个会话里让 Claude 把本 mod 的文件夹复制进该会话自己的 mods 文件夹，Claude Code 会问是否为这个会话打开 mod 热加载，同意后立即加载、不用重启，文件改动后会自动重载。只在没加载本 mod 的会话里这样做，否则会加载两份、每段都翻译两次；这份副本只属于那个会话、不跟随后续更新，重启那个会话前请先删掉它。

**何时翻译**：Claude 每写完一段回复或一个步骤标签就立即翻译，会话不在屏幕上也照样翻，回到会话时已经译好。译文会保存，重启 App 后重新打开会话不必再译（最多保留约 100 万字符，旧的先删）。提示若没能翻译就照原文发出并提示原因；mod 还会在提示写入对话时再试一次，能补上新会话里 mod 尚未加载时发出的第一条提示；仍未翻译的，会在对话记录里留一行说明原因（Claude 不读这一行）。

**注意**：你的提示和 Claude 的回复会发给你配置的翻译服务商。代码块不翻译。"Ran a command" 这类计数行是 Claude Code 自己生成的，没法翻译；所以凡是含有带说明步骤的折叠组，都会自动展开，让每一步显示自己的中英对照标签。
