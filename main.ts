import { App, Editor, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from 'obsidian';
import Anthropic from '@anthropic-ai/sdk';

declare const require: (module: string) => any;

interface ClaudeObsidianSettings {
	apiKey: string;
	model: string;
	terminalCwd: string;
}

const DEFAULT_SETTINGS: ClaudeObsidianSettings = {
	apiKey: '',
	model: 'claude-sonnet-4-6',
	terminalCwd: ''
};

// ─── Tool definitions for the agent ───────────────────────────────────────────
const AGENT_TOOLS: Anthropic.Tool[] = [
	{
		name: 'create_note',
		description: 'Create a new note in the Obsidian vault',
		input_schema: {
			type: 'object' as const,
			properties: {
				path: { type: 'string', description: 'Path relative to vault root, e.g. "01 - Notes/My Note.md"' },
				content: { type: 'string', description: 'Markdown content of the note' }
			},
			required: ['path', 'content']
		}
	},
	{
		name: 'read_note',
		description: 'Read the content of a note from the vault',
		input_schema: {
			type: 'object' as const,
			properties: {
				path: { type: 'string', description: 'Path to the note relative to vault root' }
			},
			required: ['path']
		}
	},
	{
		name: 'update_note',
		description: 'Update or append to an existing note in the vault',
		input_schema: {
			type: 'object' as const,
			properties: {
				path: { type: 'string', description: 'Path to the note' },
				content: { type: 'string', description: 'New full markdown content' },
				append: { type: 'boolean', description: 'If true, append to existing content instead of replacing' }
			},
			required: ['path', 'content']
		}
	},
	{
		name: 'list_notes',
		description: 'List notes in the vault or in a specific folder',
		input_schema: {
			type: 'object' as const,
			properties: {
				folder: { type: 'string', description: 'Folder path to list. Leave empty for all notes.' }
			},
			required: []
		}
	},
	{
		name: 'search_notes',
		description: 'Search for notes by filename or content keyword',
		input_schema: {
			type: 'object' as const,
			properties: {
				query: { type: 'string', description: 'Search term' }
			},
			required: ['query']
		}
	},
	{
		name: 'run_command',
		description: 'Run a shell command on the operating system',
		input_schema: {
			type: 'object' as const,
			properties: {
				command: { type: 'string', description: 'The shell command to run' },
				cwd: { type: 'string', description: 'Working directory (optional)' }
			},
			required: ['command']
		}
	}
];

// ─── Plugin ────────────────────────────────────────────────────────────────────
export default class ClaudeObsidianPlugin extends Plugin {
	settings: ClaudeObsidianSettings;
	client: Anthropic | null = null;

	async onload() {
		await this.loadSettings();
		this.initClient();

		this.addCommand({
			id: 'open-agent',
			name: 'Open Agent',
			callback: () => new AgentModal(this.app, this).open()
		});

		this.addCommand({
			id: 'ask-claude',
			name: 'Ask Claude about this note',
			editorCallback: async (editor: Editor) => {
				new AskClaudeModal(this.app, editor.getValue(), this.client!, this.settings.model).open();
			}
		});

		this.addCommand({
			id: 'summarize-note',
			name: 'Summarize current note',
			editorCallback: async (editor: Editor) => {
				const summary = await this.summarize(editor.getValue());
				if (summary) editor.replaceSelection(`\n\n> **Summary:** ${summary}`);
			}
		});

		this.addCommand({
			id: 'init-brain',
			name: 'Init Brain — scaffold knowledge base',
			callback: async () => this.initBrain()
		});

		this.addCommand({
			id: 'open-terminal',
			name: 'Open Terminal',
			callback: () => new TerminalModal(this.app, this).open()
		});

		this.addRibbonIcon('bot', 'Open Claude Agent', () => new AgentModal(this.app, this).open());
		this.addRibbonIcon('terminal', 'Open Terminal', () => new TerminalModal(this.app, this).open());

		this.addSettingTab(new ClaudeSettingTab(this.app, this));
	}

	initClient() {
		if (this.settings.apiKey) {
			this.client = new Anthropic({ apiKey: this.settings.apiKey, dangerouslyAllowBrowser: true });
		}
	}

	async summarize(content: string): Promise<string | null> {
		if (!this.client) { new Notice('⚠️ Set API key in settings'); return null; }
		try {
			const r = await this.client.messages.create({
				model: this.settings.model, max_tokens: 300,
				messages: [{ role: 'user', content: `Summarize in 1-2 sentences:\n\n${content}` }]
			});
			return (r.content[0] as any).text;
		} catch (e) { new Notice(`Error: ${e.message}`); return null; }
	}

	async initBrain() {
		const folders = ['00 - Inbox','01 - Notes','02 - Projects','03 - Areas','04 - Resources','05 - Archive','Templates'];
		for (const f of folders) {
			if (!this.app.vault.getAbstractFileByPath(f)) await this.app.vault.createFolder(f);
		}
		const wp = '00 - Inbox/Welcome.md';
		if (!this.app.vault.getAbstractFileByPath(wp)) {
			await this.app.vault.create(wp, `# 🧠 Welcome to your Claude Brain\n\nPARA structure initialized. Use Ctrl+P → "Open Agent" to chat with your AI agent.\n`);
		}
		new Notice('🧠 Brain initialized!');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}
	async saveSettings() {
		await this.saveData(this.settings);
		this.initClient();
	}
}

// ─── AGENT MODAL ──────────────────────────────────────────────────────────────
class AgentModal extends Modal {
	plugin: ClaudeObsidianPlugin;
	logEl: HTMLDivElement;
	inputEl: HTMLTextAreaElement;
	messages: Anthropic.MessageParam[] = [];
	running = false;

	constructor(app: App, plugin: ClaudeObsidianPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		modalEl.style.width = '860px';
		modalEl.style.maxWidth = '94vw';
		modalEl.style.maxHeight = '90vh';

		contentEl.createEl('h2', { text: '🤖 Claude Agent', attr: { style: 'margin:0 0 12px' } });

		// Log area
		this.logEl = contentEl.createEl('div') as HTMLDivElement;
		Object.assign(this.logEl.style, {
			background: '#0d1117', color: '#e6edf3',
			fontFamily: 'system-ui, sans-serif', fontSize: '14px',
			lineHeight: '1.6', padding: '16px', height: '420px',
			overflowY: 'auto', borderRadius: '10px',
			marginBottom: '12px', border: '1px solid #21262d'
		});
		this.logEntry('system', '🤖 Agent ready. I can write notes, search your vault, and run commands. What shall I do?');

		// Input area
		this.inputEl = contentEl.createEl('textarea') as HTMLTextAreaElement;
		Object.assign(this.inputEl.style, {
			width: '100%', height: '72px', background: '#161b22',
			border: '1px solid #30363d', borderRadius: '8px',
			color: '#e6edf3', fontFamily: 'system-ui', fontSize: '14px',
			padding: '10px', resize: 'none', marginBottom: '10px', boxSizing: 'border-box'
		});
		this.inputEl.placeholder = 'Tell the agent what to do… (Shift+Enter for new line, Enter to send)';

		// Buttons
		const btnRow = contentEl.createEl('div');
		Object.assign(btnRow.style, { display: 'flex', gap: '8px' });

		const sendBtn = this.makeBtn(btnRow, '▶ Run', '#238636');
		const clearBtn = this.makeBtn(btnRow, '🗑 Clear', '#444');

		sendBtn.onclick = () => this.run();
		clearBtn.onclick = () => {
			this.messages = [];
			this.logEl.empty();
			this.logEntry('system', '🤖 Conversation cleared.');
		};

		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.run(); }
		});

		setTimeout(() => this.inputEl.focus(), 50);
	}

	makeBtn(parent: HTMLElement, text: string, bg: string) {
		const b = parent.createEl('button', { text });
		Object.assign(b.style, { background: bg, color: '#fff', border: 'none', borderRadius: '6px', padding: '8px 18px', cursor: 'pointer', fontSize: '14px' });
		return b;
	}

	logEntry(type: 'user' | 'agent' | 'tool' | 'result' | 'system' | 'error', text: string) {
		const colors: Record<string, string> = {
			user: '#58a6ff', agent: '#3fb950', tool: '#e3b341',
			result: '#8b949e', system: '#a371f7', error: '#f85149'
		};
		const labels: Record<string, string> = {
			user: 'You', agent: 'Claude', tool: '🔧 Tool', result: '↳ Result', system: '', error: '✗ Error'
		};
		const entry = this.logEl.createEl('div');
		Object.assign(entry.style, { marginBottom: '10px', borderLeft: `3px solid ${colors[type]}`, paddingLeft: '10px' });
		if (labels[type]) {
			const label = entry.createEl('span', { text: labels[type] });
			Object.assign(label.style, { color: colors[type], fontWeight: 'bold', fontSize: '12px', display: 'block', marginBottom: '2px' });
		}
		const body = entry.createEl('span');
		body.style.whiteSpace = 'pre-wrap';
		body.style.wordBreak = 'break-word';
		body.setText(text);
		this.logEl.scrollTop = this.logEl.scrollHeight;
		return body;
	}

	async run() {
		if (this.running || !this.inputEl.value.trim()) return;
		if (!this.plugin.client) { new Notice('⚠️ Set API key in settings'); return; }

		const userMsg = this.inputEl.value.trim();
		this.inputEl.value = '';
		this.running = true;

		this.logEntry('user', userMsg);
		this.messages.push({ role: 'user', content: userMsg });

		const thinking = this.logEntry('system', '⏳ Thinking…');

		try {
			await this.agentLoop(thinking);
		} catch (e) {
			this.logEntry('error', e.message);
		}

		this.running = false;
	}

	async agentLoop(thinkingEl: HTMLSpanElement) {
		let removed = false;
		const removeThinking = () => {
			if (!removed) { thinkingEl.parentElement?.remove(); removed = true; }
		};

		// agentic loop — keep running until no more tool calls
		while (true) {
			const response = await this.plugin.client!.messages.create({
				model: this.plugin.settings.model,
				max_tokens: 4096,
				tools: AGENT_TOOLS,
				messages: this.messages,
				system: `You are a powerful Obsidian AI agent. You have access to tools to read/write/search notes in the vault and run shell commands. Be proactive — use tools when needed without asking for confirmation. Current vault path: ${(this.app.vault.adapter as any).basePath || 'unknown'}`
			});

			removeThinking();

			// Collect tool uses
			const toolUses = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[];
			const textBlocks = response.content.filter(b => b.type === 'text') as Anthropic.TextBlock[];

			// Show text
			for (const t of textBlocks) {
				if (t.text.trim()) this.logEntry('agent', t.text);
			}

			// Push assistant message
			this.messages.push({ role: 'assistant', content: response.content });

			if (response.stop_reason === 'end_turn' || toolUses.length === 0) break;

			// Execute tools
			const toolResults: Anthropic.ToolResultBlockParam[] = [];
			for (const tu of toolUses) {
				this.logEntry('tool', `${tu.name}(${JSON.stringify(tu.input, null, 2)})`);
				const result = await this.executeTool(tu.name, tu.input as Record<string, any>);
				const preview = result.length > 500 ? result.slice(0, 500) + '…' : result;
				this.logEntry('result', preview);
				toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
			}

			this.messages.push({ role: 'user', content: toolResults });
		}
	}

	async executeTool(name: string, input: Record<string, any>): Promise<string> {
		const vault = this.app.vault;

		switch (name) {
			case 'create_note': {
				const { path, content } = input;
				try {
					// Create parent folder if needed
					const parts = path.split('/');
					if (parts.length > 1) {
						const folder = parts.slice(0, -1).join('/');
						if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
					}
					await vault.create(path, content);
					return `✅ Note created: ${path}`;
				} catch (e) { return `Error: ${e.message}`; }
			}

			case 'read_note': {
				const file = vault.getAbstractFileByPath(input.path);
				if (!file || !(file instanceof TFile)) return `Error: Note not found: ${input.path}`;
				return await vault.read(file);
			}

			case 'update_note': {
				const file = vault.getAbstractFileByPath(input.path);
				if (!file || !(file instanceof TFile)) return `Error: Note not found: ${input.path}`;
				if (input.append) {
					const existing = await vault.read(file);
					await vault.modify(file, existing + '\n' + input.content);
				} else {
					await vault.modify(file, input.content);
				}
				return `✅ Note updated: ${input.path}`;
			}

			case 'list_notes': {
				const folder = input.folder || '';
				const files = vault.getFiles().filter(f =>
					folder ? f.path.startsWith(folder) : true
				);
				return files.map(f => f.path).join('\n') || '(no notes found)';
			}

			case 'search_notes': {
				const q = input.query.toLowerCase();
				const results: string[] = [];
				for (const file of vault.getFiles()) {
					if (file.path.toLowerCase().includes(q)) {
						results.push(`[filename] ${file.path}`);
						continue;
					}
					try {
						const content = await vault.read(file);
						if (content.toLowerCase().includes(q)) {
							const lines = content.split('\n').filter(l => l.toLowerCase().includes(q));
							results.push(`[content] ${file.path}\n  ${lines.slice(0, 2).join('\n  ')}`);
						}
					} catch {}
				}
				return results.length ? results.join('\n\n') : '(no results found)';
			}

			case 'run_command': {
				return new Promise((resolve) => {
					const { exec } = require('child_process');
					const cwd = input.cwd || this.plugin.settings.terminalCwd || require('os').homedir();
					exec(input.command, { cwd, shell: true, maxBuffer: 1024 * 1024 },
						(err: any, stdout: string, stderr: string) => {
							const out = [stdout, stderr].filter(Boolean).join('\n');
							resolve(out || (err ? `Error: ${err.message}` : '(no output)'));
						}
					);
				});
			}

			default:
				return `Unknown tool: ${name}`;
		}
	}

	onClose() { this.contentEl.empty(); }
}

// ─── TERMINAL MODAL ───────────────────────────────────────────────────────────
class TerminalModal extends Modal {
	plugin: ClaudeObsidianPlugin;
	outputEl: HTMLDivElement;
	inputEl: HTMLInputElement;
	promptEl: HTMLSpanElement;
	cwd: string;
	history: string[] = [];
	historyIndex = -1;
	lastOutput = '';

	constructor(app: App, plugin: ClaudeObsidianPlugin) {
		super(app);
		this.plugin = plugin;
		this.cwd = plugin.settings.terminalCwd || require('os').homedir();
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		modalEl.style.width = '820px';
		modalEl.style.maxWidth = '92vw';

		contentEl.createEl('h2', { text: '⚡ Terminal', attr: { style: 'margin:0 0 10px' } });

		this.outputEl = contentEl.createEl('div') as HTMLDivElement;
		Object.assign(this.outputEl.style, {
			background: '#0d1117', color: '#c9d1d9',
			fontFamily: '"Cascadia Code","Fira Code",Consolas,monospace',
			fontSize: '13px', lineHeight: '1.5', padding: '14px 16px',
			height: '380px', overflowY: 'auto', borderRadius: '8px',
			marginBottom: '10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
			border: '1px solid #30363d'
		});
		this.appendLine(`Claude Terminal  |  cwd: ${this.cwd}`, '#58a6ff');
		this.appendLine('────────────────────────────────────────', '#30363d');

		const inputRow = contentEl.createEl('div');
		Object.assign(inputRow.style, {
			display: 'flex', alignItems: 'center', background: '#0d1117',
			border: '1px solid #30363d', borderRadius: '8px', padding: '8px 14px', marginBottom: '10px'
		});

		this.promptEl = inputRow.createEl('span') as HTMLSpanElement;
		Object.assign(this.promptEl.style, { color: '#3fb950', fontFamily: 'monospace', fontSize: '13px', marginRight: '10px', whiteSpace: 'nowrap' });
		this.updatePrompt();

		this.inputEl = inputRow.createEl('input') as HTMLInputElement;
		Object.assign(this.inputEl.style, { flex: '1', background: 'transparent', border: 'none', outline: 'none', color: '#e6edf3', fontFamily: 'monospace', fontSize: '13px' });

		const btnRow = contentEl.createEl('div');
		Object.assign(btnRow.style, { display: 'flex', gap: '8px' });
		const mk = (t: string, c: string, fn: () => void) => {
			const b = btnRow.createEl('button', { text: t });
			Object.assign(b.style, { background: c, color: '#fff', border: 'none', borderRadius: '6px', padding: '6px 14px', cursor: 'pointer', fontSize: '13px' });
			b.onclick = fn; return b;
		};
		mk('▶ Run', '#238636', () => this.runCommand());
		mk('🤖 Ask Claude', '#6e40c9', () => this.askClaude());
		mk('🗑 Clear', '#444', () => { this.outputEl.empty(); this.lastOutput = ''; });

		this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') { e.preventDefault(); this.runCommand(); }
			else if (e.key === 'ArrowUp') { e.preventDefault(); if (this.historyIndex < this.history.length - 1) { this.historyIndex++; this.inputEl.value = this.history[this.history.length - 1 - this.historyIndex]; } }
			else if (e.key === 'ArrowDown') { e.preventDefault(); if (this.historyIndex > 0) { this.historyIndex--; this.inputEl.value = this.history[this.history.length - 1 - this.historyIndex]; } else { this.historyIndex = -1; this.inputEl.value = ''; } }
		});
		setTimeout(() => this.inputEl.focus(), 50);
	}

	updatePrompt() {
		const short = this.cwd.replace(require('os').homedir(), '~');
		this.promptEl.setText(`${short} $`);
	}
	appendLine(text: string, color = '#c9d1d9') {
		const s = this.outputEl.createEl('span');
		s.style.color = color; s.style.display = 'block'; s.setText(text);
		this.outputEl.scrollTop = this.outputEl.scrollHeight;
	}
	appendRaw(text: string, color = '#c9d1d9') {
		const s = this.outputEl.createEl('span');
		s.style.color = color; s.style.whiteSpace = 'pre-wrap'; s.setText(text);
		this.outputEl.scrollTop = this.outputEl.scrollHeight;
	}

	runCommand() {
		const cmd = this.inputEl.value.trim();
		if (!cmd) return;
		this.history.push(cmd); this.historyIndex = -1; this.inputEl.value = '';
		this.appendLine(`$ ${cmd}`, '#58a6ff');
		if (cmd.startsWith('cd')) {
			const path = require('path'), fs = require('fs'), os = require('os');
			const target = cmd.slice(2).trim() || os.homedir();
			const resolved = target.startsWith('~') ? require('path').join(os.homedir(), target.slice(1)) : path.resolve(this.cwd, target);
			if (fs.existsSync(resolved)) { this.cwd = resolved; this.updatePrompt(); this.appendLine(`→ ${resolved}`, '#3fb950'); }
			else this.appendLine(`cd: not found: ${target}`, '#f85149');
			return;
		}
		const { exec } = require('child_process');
		exec(cmd, { cwd: this.cwd, shell: true, maxBuffer: 2 * 1024 * 1024 }, (err: any, stdout: string, stderr: string) => {
			if (stdout) { this.lastOutput = stdout; this.appendRaw(stdout); }
			if (stderr) this.appendRaw(stderr, '#f85149');
			if (err && !stdout && !stderr) this.appendLine(`Error: ${err.message}`, '#f85149');
			if (!stdout && !stderr && !err) this.appendLine('(no output)', '#8b949e');
			this.outputEl.scrollTop = this.outputEl.scrollHeight;
		});
	}

	async askClaude() {
		if (!this.plugin.client) { new Notice('⚠️ Set API key in settings'); return; }
		if (!this.lastOutput.trim()) { new Notice('Run a command first'); return; }
		this.appendLine('\n🤖 Claude:', '#a371f7');
		try {
			const r = await this.plugin.client.messages.create({
				model: this.plugin.settings.model, max_tokens: 512,
				messages: [{ role: 'user', content: `Explain this terminal output briefly:\n\`\`\`\n${this.lastOutput.slice(0, 4000)}\n\`\`\`` }]
			});
			this.appendRaw((r.content[0] as any).text + '\n', '#a371f7');
		} catch (e) { this.appendLine(`Error: ${e.message}`, '#f85149'); }
	}

	onClose() { this.contentEl.empty(); }
}

// ─── ASK CLAUDE MODAL ─────────────────────────────────────────────────────────
class AskClaudeModal extends Modal {
	noteContent: string; client: Anthropic; model: string;
	constructor(app: App, noteContent: string, client: Anthropic, model: string) {
		super(app); this.noteContent = noteContent; this.client = client; this.model = model;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: 'Ask Claude' });
		const input = contentEl.createEl('textarea');
		Object.assign(input.style, { width: '100%', height: '80px', marginBottom: '10px' });
		input.placeholder = 'What do you want to ask about this note?';
		const responseEl = contentEl.createEl('div');
		Object.assign(responseEl.style, { marginTop: '10px', whiteSpace: 'pre-wrap' });
		const btn = contentEl.createEl('button', { text: 'Ask' });
		btn.onclick = async () => {
			const q = input.value.trim(); if (!q) return;
			responseEl.setText('Thinking…');
			try {
				const r = await this.client.messages.create({
					model: this.model, max_tokens: 1024,
					messages: [{ role: 'user', content: `Note:\n\n${this.noteContent}\n\n---\n\n${q}` }]
				});
				responseEl.setText((r.content[0] as any).text);
			} catch (e) { responseEl.setText(`Error: ${e.message}`); }
		};
	}
	onClose() { this.contentEl.empty(); }
}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
class ClaudeSettingTab extends PluginSettingTab {
	plugin: ClaudeObsidianPlugin;
	constructor(app: App, plugin: ClaudeObsidianPlugin) { super(app, plugin); this.plugin = plugin; }
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Claude AI Settings' });
		new Setting(containerEl).setName('Anthropic API Key').setDesc('Get yours at console.anthropic.com')
			.addText(t => t.setPlaceholder('sk-ant-...').setValue(this.plugin.settings.apiKey)
				.onChange(async v => { this.plugin.settings.apiKey = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Model').setDesc('Claude model to use')
			.addDropdown(d => d
				.addOption('claude-sonnet-4-6', 'Claude Sonnet 4.6 (recommended)')
				.addOption('claude-opus-4-7', 'Claude Opus 4.7 (most capable)')
				.addOption('claude-haiku-4-5-20251001', 'Claude Haiku 4.5 (fastest)')
				.setValue(this.plugin.settings.model)
				.onChange(async v => { this.plugin.settings.model = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Terminal starting directory').setDesc('Leave blank to use home directory')
			.addText(t => t.setPlaceholder('C:\\Users\\...').setValue(this.plugin.settings.terminalCwd)
				.onChange(async v => { this.plugin.settings.terminalCwd = v; await this.plugin.saveSettings(); }));
	}
}
