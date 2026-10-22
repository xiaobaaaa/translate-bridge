# translate-bridge

**Write to Claude Code in your own language. Claude works in English. You read the replies in both.**

translate-bridge is a Claude Code mod. It hooks into Claude Code's prompt and transcript, so you don't run a separate app:

- **Your prompt** is translated into English before Claude sees it. The transcript still shows what you typed, with the English that was sent under it (`↳ …`).
- **Claude's replies** are shown paragraph by paragraph: first your language, then Claude's original English as a quote under it. Code blocks are shown once and never translated.
- **The grey step labels** (for example "List files in current directory") are shown as `your language / English`.

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

If you'd rather use an environment variable for the key, add it to `~/.claude/settings.json` and start a new session:

```json
{ "env": { "TRANSLATE_BRIDGE_API_KEY": "sk-..." } }
```

### Providers

Any API that speaks OpenAI's `/chat/completions` works. Pick a small, fast model, because translation doesn't need a large one.

| Provider | `baseUrl` | Notes |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | Default. Tested. Thinking mode is switched off automatically for translation. |
| Alibaba Cloud Model Studio (Qwen) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Untested; use a Qwen chat model. |
| Zhipu (GLM) | `https://open.bigmodel.cn/api/paas/v4` | Untested; use a GLM chat model. |
| OpenAI | `https://api.openai.com/v1` | Untested. |
| OpenRouter | `https://openrouter.ai/api/v1` | Untested. |
| Ollama (local, free) | `http://localhost:11434/v1` | Untested. Runs on your machine, so no text leaves it. |

Translation is cheap. On DeepSeek's October 2026 price list, translating a medium-length reply (about 700 tokens in and 700 out) costs well under one US cent.

## Use

| Command | What it does |
|---|---|
| `/translate on` | Bilingual (the default): your language first, English under it. |
| `/translate only` | Show the translation only. |
| `/translate off` | Turn translation off. Prompts go to Claude as typed. |
| `/translate status` | Show the mode, language, provider and whether a key is set. |

Your choice is remembered across sessions.

### What happens, and when

- Prompts that are already English are sent unchanged, with no API call. Slash commands are never translated.
- A reply is translated about 1.5 s after it stops streaming, so you'll briefly see the English first. Replies that are scrolled out of view are translated when you scroll back to them.
- If translation fails (no key, network error, provider error), your prompt is sent as typed and a notice says why. Nothing is ever dropped.
- Only what you **see** changes. Claude's stored conversation stays in English, so Claude's context is never mixed with translations.

### What isn't translated

- The count lines such as "Ran 5 commands" are drawn by Claude Code itself and contain no text the mod can change.
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
- **Claude 的回复**：每段先显示中文，下面用引用块附上英文原文；代码块只显示一次，不翻译。
- **灰色步骤标签**：显示成「中文 / English」。

翻译用你自己的 API key，接任何 OpenAI 兼容接口，默认 DeepSeek。

**安装**：在桌面 App 里点输入框旁的 **+** → **Plugins** → **Add marketplace**，填 `xiaobaaaa/translate-bridge` → **Add plugin**。在终端会话里，也可以用上面英文部分的 `/plugin install` 命令。安装时填 API key，也可以在 `~/.claude/settings.json` 的 `env` 里设 `TRANSLATE_BRIDGE_API_KEY`。然后新开会话，运行 `/translate status` 检查。

**命令**：`/translate on`（中英对照，默认）、`/translate only`（只显示中文）、`/translate off`、`/translate status`。

**注意**：你的提示和 Claude 的回复会发给你配置的翻译服务商。代码块和 "Ran 5 commands" 这类计数行不翻译。
