import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import Anthropic from '@anthropic-ai/sdk';

interface ClaudeObsidianSettings {
	apiKey: string;
	model: string;
}

const DEFAULT_SETTINGS: ClaudeObsidianSettings = {
	apiKey: '',
	model: 'claude-sonnet-4-6'
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
		// Create a welcome note
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
	}
}
