# claude-obsidian

An Obsidian plugin that integrates Claude AI into your vault — summarize notes, generate ideas, and build a second brain powered by AI.

## Features

- 💬 Chat with Claude about your notes
- 🧠 `/init-brain` — scaffold a knowledge-base structure in any folder
- ✍️ Generate summaries, outlines, and follow-up questions
- 🔗 Auto-link related notes using Claude's understanding

## Installation

1. Clone this repo into your vault's `.obsidian/plugins/claude-obsidian/` folder
2. Run `npm install` then `npm run build`
3. Enable the plugin in **Settings → Community Plugins**
4. Add your Anthropic API key in the plugin settings

## Development

```bash
npm install
npm run dev     # watch mode
npm run build   # production build
```

## Configuration

| Setting | Description |
|---|---|
| `apiKey` | Your Anthropic API key |
| `model` | Claude model to use (default: `claude-sonnet-4-6`) |
| `vaultPath` | Root folder for `/init-brain` scaffolding |

## License

MIT
