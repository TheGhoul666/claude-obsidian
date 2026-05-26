import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import Anthropic from '@anthropic-ai/sdk';

// Allow Node.js require inside Electron/Obsidian
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

export default class ClaudeObsidianPlugin extends Plugin {
	settings: ClaudeObsidianSettings;
	client: Anthropic | null = null;

	async onload() {
		await this.loadSettings();
		this.initClient();

		// Command: Ask Claude about the current note
		this.addCommand({
			id: 'ask-claude',
			name: 'Ask Claude about this note',
			editorCallback: async (editor: Editor) => {
				const content = editor.getValue();
				await this.askClaude(content);
			}
		});

		// Command: Init Brain — scaffold a knowledge-base folder structure
		this.addCommand({
			id: 'init-brain',
			name: 'Init Brain — scaffold knowledge base',
			callback: async () => {
				await this.initBrain();
			}
		});

		// Command: Summarize current note
		this.addCommand({
			id: 'summarize-note',
			name: 'Summarize current note',
			editorCallback: async (editor: Editor) => {
				const content = editor.getValue();
				const summary = await this.summarize(content);
				if (summary) {
					editor.replaceSelection(`\n\n> **Summary:** ${summary}`);
				}
			}
		});

		// Command: Open Terminal
		this.addCommand({
			id: 'open-terminal',
			name: 'Open Terminal',
			callback: () => {
				new TerminalModal(this.app, this).open();
			}
		});

		// Ribbon icon for Terminal
		this.addRibbonIcon('terminal', 'Open Terminal', () => {
			new TerminalModal(this.app, this).open();
		});

		this.addSettingTab(new ClaudeSettingTab(this.app, this));
	}

	initClient() {
		if (this.settings.apiKey) {
			this.client = new Anthropic({ apiKey: this.settings.apiKey, dangerouslyAllowBrowser: true });
		}
	}

	async askClaude(noteContent: string) {
		if (!this.client) {
			new Notice('⚠️ Add your Anthropic API key in plugin settings.');
			return;
		}
		new AskClaudeModal(this.app, noteContent, this.client, this.settings.model).open();
	}

	async summarize(noteContent: string): Promise<string | null> {
		if (!this.client) {
			new Notice('⚠️ Add your Anthropic API key in plugin settings.');
			return null;
		}
		try {
			const response = await this.client.messages.create({
				model: this.settings.model,
				max_tokens: 300,
				messages: [{
					role: 'user',
					content: `Summarize this note in 1-2 sentences:\n\n${noteContent}`
				}]
			});
			return (response.content[0] as { type: string; text: string }).text;
		} catch (e) {
			new Notice(`Claude error: ${e.message}`);
			return null;
		}
	}

	async initBrain() {
		const folders = [
			'00 - Inbox',
			'01 - Notes',
			'02 - Projects',
			'03 - Areas',
			'04 - Resources',
			'05 - Archive',
			'Templates'
		];
		for (const folder of folders) {
			if (!this.app.vault.getAbstractFileByPath(folder)) {
				await this.app.vault.createFolder(folder);
			}
		}
		const welcome = `# 🧠 Welcome to your Claude Brain\n\nThis vault is structured using the PARA method:\n\n- **00 - Inbox** — capture everything here first\n- **01 - Notes** — processed, evergreen notes\n- **02 - Projects** — active projects with a deadline\n- **03 - Areas** — ongoing responsibilities\n- **04 - Resources** — reference material\n- **05 - Archive** — inactive items\n\nUse **Claude AI** (Cmd/Ctrl+P → "Ask Claude") to query, summarize, and extend any note.\n`;
		const welcomePath = '00 - Inbox/Welcome.md';
		if (!this.app.vault.getAbstractFileByPath(welcomePath)) {
			await this.app.vault.create(welcomePath, welcome);
		}
		new Notice('🧠 Brain initialized! Check your vault.');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.initClient();
	}
}

// ─────────────────────────────────────────────
//  TERMINAL MODAL
// ─────────────────────────────────────────────

class TerminalModal extends Modal {
	plugin: ClaudeObsidianPlugin;
	outputEl: HTMLDivElement;
	inputEl: HTMLInputElement;
	promptEl: HTMLSpanElement;
	cwd: string;
	history: string[] = [];
	historyIndex: number = -1;
	lastOutput: string = '';

	constructor(app: App, plugin: ClaudeObsidianPlugin) {
		super(app);
		this.plugin = plugin;
		// Start from user-configured dir, or home
		const os = require('os');
		this.cwd = plugin.settings.terminalCwd || os.homedir();
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		modalEl.style.width = '820px';
		modalEl.style.maxWidth = '92vw';

		// Header
		const header = contentEl.createEl('div');
		Object.assign(header.style, {
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'space-between',
			marginBottom: '10px'
		});
		header.createEl('h2', { text: '⚡ Terminal', attr: { style: 'margin:0' } });

		// Output area
		this.outputEl = contentEl.createEl('div') as HTMLDivElement;
		Object.assign(this.outputEl.style, {
			background: '#0d1117',
			color: '#c9d1d9',
			fontFamily: '"Cascadia Code", "Fira Code", "Consolas", monospace',
			fontSize: '13px',
			lineHeight: '1.5',
			padding: '14px 16px',
			height: '380px',
			overflowY: 'auto',
			borderRadius: '8px',
			marginBottom: '10px',
			whiteSpace: 'pre-wrap',
			wordBreak: 'break-all',
			border: '1px solid #30363d'
		});

		this.appendLine(`Claude Terminal  |  cwd: ${this.cwd}`, '#58a6ff');
		this.appendLine('────────────────────────────────────────', '#30363d');

		// Input row
		const inputRow = contentEl.createEl('div');
		Object.assign(inputRow.style, {
			display: 'flex',
			alignItems: 'center',
			background: '#0d1117',
			border: '1px solid #30363d',
			borderRadius: '8px',
			padding: '8px 14px',
			marginBottom: '10px'
		});

		this.promptEl = inputRow.createEl('span') as HTMLSpanElement;
		Object.assign(this.promptEl.style, {
			color: '#3fb950',
			fontFamily: 'monospace',
			fontSize: '13px',
			marginRight: '10px',
			whiteSpace: 'nowrap',
			userSelect: 'none'
		});
		this.updatePrompt();

		this.inputEl = inputRow.createEl('input') as HTMLInputElement;
		Object.assign(this.inputEl.style, {
			flex: '1',
			background: 'transparent',
			border: 'none',
			outline: 'none',
			color: '#e6edf3',
			fontFamily: 'monospace',
			fontSize: '13px'
		});
		this.inputEl.placeholder = 'type a command…';

		// Buttons row
		const btnRow = contentEl.createEl('div');
		Object.assign(btnRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap' });

		const makeBtn = (label: string, color: string, onClick: () => void) => {
			const b = btnRow.createEl('button', { text: label });
			Object.assign(b.style, {
				background: color,
				color: '#fff',
				border: 'none',
				borderRadius: '6px',
				padding: '6px 14px',
				cursor: 'pointer',
				fontSize: '13px'
			});
			b.onclick = onClick;
			return b;
		};

		makeBtn('▶ Run', '#238636', () => this.runCommand());
		makeBtn('🤖 Ask Claude', '#6e40c9', () => this.askClaudeAboutOutput());
		makeBtn('🗑 Clear', '#444', () => {
			this.outputEl.empty();
			this.lastOutput = '';
		});

		// Keyboard events
		this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.runCommand();
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				if (this.historyIndex < this.history.length - 1) {
					this.historyIndex++;
					this.inputEl.value = this.history[this.history.length - 1 - this.historyIndex];
				}
			} else if (e.key === 'ArrowDown') {
				e.preventDefault();
				if (this.historyIndex > 0) {
					this.historyIndex--;
					this.inputEl.value = this.history[this.history.length - 1 - this.historyIndex];
				} else {
					this.historyIndex = -1;
					this.inputEl.value = '';
				}
			}
		});

		setTimeout(() => this.inputEl.focus(), 50);
	}

	updatePrompt() {
		const os = require('os');
		const short = this.cwd.replace(os.homedir(), '~');
		this.promptEl.setText(`${short} $`);
	}

	appendLine(text: string, color = '#c9d1d9') {
		const span = this.outputEl.createEl('span');
		span.style.color = color;
		span.style.display = 'block';
		span.setText(text);
		this.outputEl.scrollTop = this.outputEl.scrollHeight;
	}

	appendRaw(text: string, color = '#c9d1d9') {
		const span = this.outputEl.createEl('span');
		span.style.color = color;
		span.style.whiteSpace = 'pre-wrap';
		span.setText(text);
		this.outputEl.scrollTop = this.outputEl.scrollHeight;
	}

	runCommand() {
		const cmd = this.inputEl.value.trim();
		if (!cmd) return;

		this.history.push(cmd);
		this.historyIndex = -1;
		this.inputEl.value = '';

		// Echo command
		this.appendLine(`$ ${cmd}`, '#58a6ff');

		// Handle built-in cd
		if (cmd.startsWith('cd')) {
			const path = require('path');
			const fs = require('fs');
			const os = require('os');
			const target = cmd.slice(2).trim() || os.homedir();
			const resolved = target.startsWith('~')
				? path.join(os.homedir(), target.slice(1))
				: path.resolve(this.cwd, target);

			if (fs.existsSync(resolved)) {
				this.cwd = resolved;
				this.updatePrompt();
				this.appendLine(`→ ${resolved}`, '#3fb950');
			} else {
				this.appendLine(`cd: no such directory: ${target}`, '#f85149');
			}
			return;
		}

		const { exec } = require('child_process');
		exec(
			cmd,
			{ cwd: this.cwd, shell: true, maxBuffer: 2 * 1024 * 1024 },
			(err: any, stdout: string, stderr: string) => {
				if (stdout) {
					this.lastOutput = stdout;
					this.appendRaw(stdout);
				}
				if (stderr) {
					this.appendRaw(stderr, '#f85149');
				}
				if (err && !stdout && !stderr) {
					this.appendLine(`Error: ${err.message}`, '#f85149');
				}
				if (!stdout && !stderr && !err) {
					this.appendLine('(no output)', '#8b949e');
				}
				this.outputEl.scrollTop = this.outputEl.scrollHeight;
			}
		);
	}

	async askClaudeAboutOutput() {
		if (!this.plugin.client) {
			new Notice('⚠️ Add your Anthropic API key in plugin settings.');
			return;
		}
		const output = this.lastOutput.trim();
		if (!output) {
			new Notice('Run a command first to get output.');
			return;
		}

		this.appendLine('', '#8b949e');
		this.appendLine('🤖 Claude:', '#a371f7');

		try {
			const res = await this.plugin.client.messages.create({
				model: this.plugin.settings.model,
				max_tokens: 600,
				messages: [{
					role: 'user',
					content: `You are a helpful terminal assistant. Briefly explain this terminal output or suggest what to do next:\n\n\`\`\`\n${output.slice(0, 4000)}\n\`\`\``
				}]
			});
			const text = (res.content[0] as { type: string; text: string }).text;
			this.appendRaw(text + '\n', '#a371f7');
		} catch (e) {
			this.appendLine(`Claude error: ${e.message}`, '#f85149');
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ─────────────────────────────────────────────
//  ASK CLAUDE MODAL
// ─────────────────────────────────────────────

class AskClaudeModal extends Modal {
	noteContent: string;
	client: Anthropic;
	model: string;

	constructor(app: App, noteContent: string, client: Anthropic, model: string) {
		super(app);
		this.noteContent = noteContent;
		this.client = client;
		this.model = model;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: 'Ask Claude' });

		const input = contentEl.createEl('textarea', {
			placeholder: 'What do you want to ask about this note?',
			cls: 'claude-input'
		});
		input.style.width = '100%';
		input.style.height = '80px';
		input.style.marginBottom = '10px';

		const responseEl = contentEl.createEl('div', { cls: 'claude-response' });
		responseEl.style.marginTop = '10px';
		responseEl.style.whiteSpace = 'pre-wrap';

		const btn = contentEl.createEl('button', { text: 'Ask' });
		btn.onclick = async () => {
			const question = input.value.trim();
			if (!question) return;
			responseEl.setText('Thinking…');
			try {
				const res = await this.client.messages.create({
					model: this.model,
					max_tokens: 1024,
					messages: [{
						role: 'user',
						content: `Note content:\n\n${this.noteContent}\n\n---\n\n${question}`
					}]
				});
				responseEl.setText((res.content[0] as { type: string; text: string }).text);
			} catch (e) {
				responseEl.setText(`Error: ${e.message}`);
			}
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ─────────────────────────────────────────────
//  SETTINGS TAB
// ─────────────────────────────────────────────

class ClaudeSettingTab extends PluginSettingTab {
	plugin: ClaudeObsidianPlugin;

	constructor(app: App, plugin: ClaudeObsidianPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Claude AI Settings' });

		new Setting(containerEl)
			.setName('Anthropic API Key')
			.setDesc('Get yours at console.anthropic.com')
			.addText(text => text
				.setPlaceholder('sk-ant-...')
				.setValue(this.plugin.settings.apiKey)
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Model')
			.setDesc('Claude model to use')
			.addDropdown(drop => drop
				.addOption('claude-sonnet-4-6', 'Claude Sonnet 4.6 (recommended)')
				.addOption('claude-opus-4-7', 'Claude Opus 4.7 (most capable)')
				.addOption('claude-haiku-4-5-20251001', 'Claude Haiku 4.5 (fastest)')
				.setValue(this.plugin.settings.model)
				.onChange(async (value) => {
					this.plugin.settings.model = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Terminal starting directory')
			.setDesc('Leave blank to use home directory')
			.addText(text => text
				.setPlaceholder('C:\\Users\\beni3 or /home/user')
				.setValue(this.plugin.settings.terminalCwd)
				.onChange(async (value) => {
					this.plugin.settings.terminalCwd = value;
					await this.plugin.saveSettings();
				}));
	}
}
