import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Simplified Git API interfaces for the internal 'vscode.git' extension.
 */

interface GitExtension {
    getAPI(version: number): GitAPI;
}

interface GitAPI {
    repositories: Repository[];
    onDidOpenRepository: vscode.Event<Repository>;
    onDidCloseRepository: vscode.Event<Repository>;
}

interface Repository {
    state: {
        HEAD: {
            name?: string;
        };
        mergeChanges: any[];
    };
    rootUri: vscode.Uri;
    inputBox: {
        value: string;
    };
    ui: {
        onDidChange: vscode.Event<void>;
    };
    add(resources: string[]): Promise<void>;
    commit(message: string): Promise<void>;
}

interface BranchRule {
    pattern: string;
    backgroundColor: string;
    foregroundColor: string;
}

interface MemoEntry {
    id: string;
    text: string;
    filePath: string;
    fileName: string;
    timestamp: number;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('[GitGuard] Extension activated.');
    const memoManager = new MemoManager(context);
    const branchWatcher = new BranchWatcher(context);
    const memoTreeProvider = new MemoTreeProvider(memoManager);

    // Register Source Control Memo View
    vscode.window.registerTreeDataProvider('gitguard.memoView', memoTreeProvider);

    // Create and show the Status Bar "Button"
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = "$(shield) GitGuard";
    statusBarItem.tooltip = "Click to configure GitGuard branch colors";
    statusBarItem.command = 'gitguard.configure';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Register Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('gitguard.addToMemo', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                if (editor.document.isUntitled) {
                    vscode.window.showErrorMessage('Cannot add memos from unsaved/untitled files. Please save the file first.');
                    return;
                }
                const selection = editor.selection;
                const text = editor.document.getText(selection);
                if (text) {
                    const entry: MemoEntry = {
                        id: Date.now().toString() + Math.random().toString(36).substring(2, 9),
                        text,
                        filePath: editor.document.uri.fsPath,
                        fileName: path.basename(editor.document.fileName),
                        timestamp: Date.now()
                    };
                    memoManager.addToMemo(entry);
                }
            }
        }),
        vscode.commands.registerCommand('gitguard.clearMemo', async () => {
            const confirm = await vscode.window.showWarningMessage('Are you sure you want to clear ALL items from the Commit Memo?', { modal: true }, 'Clear All');
            if (confirm === 'Clear All') {
                memoManager.clearMemo();
            }
        }),
        vscode.commands.registerCommand('gitguard.configure', () => {
            branchWatcher.configure(context);
        }),
        vscode.commands.registerCommand('gitguard.viewMemo', () => {
            const memo = memoManager.getFormattedMemo();
            if (memo) {
                vscode.window.showInformationMessage('Current Commit Memo:\n' + memo);
            } else {
                vscode.window.showInformationMessage('Commit Memo is empty.');
            }
        }),
        vscode.commands.registerCommand('gitguard.deleteMemoItem', (item: MemoItem) => {
            memoManager.deleteItemById(item.entry.id);
        }),
        vscode.commands.registerCommand('gitguard.previewMemoItem', (item: MemoItem) => {
            vscode.window.showInformationMessage(item.entry.text, { modal: true });
        }),
        vscode.commands.registerCommand('gitguard.insertAndCommit', async (item: MemoItem) => {
            if (!item.entry.filePath) {
                vscode.window.showErrorMessage('Cannot insert legacy memo (No original file tracked).');
                return;
            }

            let document: vscode.TextDocument;
            try {
                document = await vscode.workspace.openTextDocument(vscode.Uri.file(item.entry.filePath));
            } catch (err: any) {
                vscode.window.showErrorMessage(`Could not open file: ${item.entry.filePath}`);
                return;
            }

            const editor = await vscode.window.showTextDocument(document);

            const lineInput = await vscode.window.showInputBox({
                prompt: `Enter the line number to insert the memo into ${item.entry.fileName} (1 - ${document.lineCount + 1})`,
                validateInput: (value) => {
                    const num = parseInt(value, 10);
                    if (isNaN(num) || num < 1 || num > document.lineCount + 1) {
                        return `Please enter a valid line number between 1 and ${document.lineCount + 1}`;
                    }
                    return null;
                }
            });

            if (!lineInput) return;

            const lineNumber = parseInt(lineInput, 10);
            const position = new vscode.Position(lineNumber - 1, 0);

            const textToInsert = (lineNumber <= document.lineCount) ? item.entry.text + '\n' : '\n' + item.entry.text;

            await editor.edit(editBuilder => {
                editBuilder.insert(position, textToInsert);
            });

            await document.save();

            const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
            const gitAPI = gitExtension?.exports.getAPI(1);
            if (!gitAPI) return;

            const activeRepo = branchWatcher.findRepositoryForUri(gitAPI, document.uri);

            if (!activeRepo) {
                vscode.window.showErrorMessage('No Git repository found for this file.');
                return;
            }

            if (activeRepo.state.mergeChanges && activeRepo.state.mergeChanges.length > 0) {
                vscode.window.showErrorMessage('Conflict! Cannot stage while there are merge conflicts.');
                return;
            }

            try {
                await activeRepo.add([document.uri.fsPath]);
                await activeRepo.commit(item.entry.text);
                vscode.window.showInformationMessage('Memo auto-committed successfully!');
                
                // Auto-delete on success to keep workspace clean
                memoManager.deleteItemById(item.entry.id);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Auto-commit failed: ${err.message}`);
            }
        })
    );

    // Wire up branchWatcher as a disposable so it's cleaned up on deactivation
    context.subscriptions.push({ dispose: () => branchWatcher.dispose() });

    // Update git commit input and status bar tooltip whenever the memo buffer changes
    memoManager.onDidUpdateMemo(() => {
        const text = memoManager.getFormattedMemo();
        branchWatcher.updateGitInput(text);
        branchWatcher.updateStatusBarTooltip(text);
        memoTreeProvider.refresh();
    });

    branchWatcher.start();
}

const PALETTE = [
    // Blues & Cyans
    { label: 'Dodger Blue', hex: '#1e90ff' },
    { label: 'Steel Blue', hex: '#4682b4' },
    { label: 'Turquoise', hex: '#40e0d0' },
    { label: 'Teal', hex: '#008080' },
    { label: 'Royal Blue', hex: '#4169e1' },
    { label: 'Deep Sky Blue', hex: '#00bfff' },
    // Greens
    { label: 'Forest Green', hex: '#228b22' },
    { label: 'Sea Green', hex: '#2e8b57' },
    { label: 'Lime Green', hex: '#32cd32' },
    { label: 'Olive Drab', hex: '#6b8e23' },
    // Purples & Pinks
    { label: 'Dark Orchid', hex: '#9932cc' },
    { label: 'Medium Slate Blue', hex: '#7b68ee' },
    { label: 'Deep Pink', hex: '#ff1493' },
    { label: 'Hot Pink', hex: '#ff69b4' },
    { label: 'Blue Violet', hex: '#8a2be2' },
    { label: 'Rebecca Purple', hex: '#663399' },
    // Yellows, Oranges & Browns
    { label: 'Gold', hex: '#ffd700' },
    { label: 'Dark Orange', hex: '#ff8c00' },
    { label: 'Chocolate', hex: '#d2691e' },
    { label: 'Coral', hex: '#ff7f50' },
    { label: 'Tomato', hex: '#ff6347' },
    { label: 'Saddle Brown', hex: '#8b4513' },
    // Greys
    { label: 'Dim Gray', hex: '#696969' },
    { label: 'Slate Gray', hex: '#708090' }
];

const CRITICAL_RED = { label: 'Crimson (Critical)', hex: '#8b0000' };

class BranchWatcher {
    private gitAPI?: GitAPI;
    private disposables: vscode.Disposable[] = [];
    private statusBarItem: vscode.StatusBarItem;
    private isPrompting: boolean = false;
    private declinedBranches: Set<string> = new Set();

    constructor(private context: vscode.ExtensionContext) {
        const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (gitExtension) {
            this.gitAPI = gitExtension.exports.getAPI(1);
        }
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.text = "$(shield) GitGuard";
        this.statusBarItem.command = 'gitguard.configure';
        this.statusBarItem.show();
        this.context.subscriptions.push(this.statusBarItem);
    }

    public findRepositoryForUri(api: GitAPI, uri: vscode.Uri): Repository | undefined {
        const docPath = uri.fsPath.replace(/\\/g, '/').toLowerCase();
        
        const matches = api.repositories.map(repo => ({
            repo,
            repoPath: repo.rootUri.fsPath.replace(/\\/g, '/').toLowerCase()
        })).filter(m => docPath === m.repoPath || docPath.startsWith(m.repoPath + '/'));

        // Sort by longest path to find the deepest matching repository (correct for nested repos)
        matches.sort((a, b) => b.repoPath.length - a.repoPath.length);
        return matches.length > 0 ? matches[0].repo : undefined;
    }

    private getActiveRepository(): Repository | undefined {
        if (!this.gitAPI) return undefined;
        
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const repo = this.findRepositoryForUri(this.gitAPI, editor.document.uri);
            if (repo) return repo;
        }

        return this.gitAPI.repositories[0];
    }

    public async configure(context: vscode.ExtensionContext) {
        const options = ['Change Current Branch Color', 'Remove All Rules', 'Reset to Defaults'];
        const selection = await vscode.window.showQuickPick(options, { placeHolder: 'GitGuard: Configuration' });

        if (selection === 'Change Current Branch Color') {
            const activeRepo = this.getActiveRepository();
            if (activeRepo?.state.HEAD?.name) {
                await this.promptForColor(activeRepo.state.HEAD.name);
            }
        } else if (selection === 'Remove All Rules') {
            await vscode.workspace.getConfiguration('gitguard').update('branchRules', [], vscode.ConfigurationTarget.Global);
            this.updateColors();
        } else if (selection === 'Reset to Defaults') {
            await vscode.workspace.getConfiguration('gitguard').update('branchRules', undefined, vscode.ConfigurationTarget.Global);
            this.updateColors();
        }
    }

    private isCritical(branch: string): boolean {
        return /^(main|master|prod)$/i.test(branch);
    }

    private async promptForColor(branchName: string) {
        if (this.isPrompting) return;
        this.isPrompting = true;

        try {
            const config = vscode.workspace.getConfiguration('gitguard');
            const rules = config.get<BranchRule[]>('branchRules') || [];
            
            // Check all used colors except the one for this specific pattern
            const usedColors = new Set(
                rules.filter(r => r.pattern !== `^${branchName}$`).map(r => r.backgroundColor.toLowerCase())
            );

            let options = [];
            
            if (this.isCritical(branchName)) {
                options.push(CRITICAL_RED);
                const redOptions = PALETTE.filter(p => this.isRed(p.hex) && !usedColors.has(p.hex.toLowerCase()));
                options.push(...redOptions);
            } else {
                // Filter out used colors and explicitly exclude ANY red shades for non-critical branches
                options = PALETTE.filter(p => !usedColors.has(p.hex.toLowerCase()) && !this.isRed(p.hex));
            }

            if (options.length === 0) {
                vscode.window.showInformationMessage('All unique colors are already taken! Clearing oldest rule might help.');
                return;
            }

            const quickPickOptions = options.map(o => ({ label: o.label, description: o.hex }));
            quickPickOptions.unshift({ label: '🎨 Custom Hex Color...', description: 'Provide your own hex code' });

            const selection = await vscode.window.showQuickPick(
                quickPickOptions,
                { 
                    placeHolder: `🛡️ Pick a unique color for branch "${branchName}"`,
                    ignoreFocusOut: true
                }
            );

            if (selection) {
                let hex = selection.description!;

                if (selection.label === '🎨 Custom Hex Color...') {
                    const customInput = await new Promise<string | undefined>(resolve => {
                        const panel = vscode.window.createWebviewPanel(
                            'colorPicker',
                            `Pick Color for ${branchName}`,
                            vscode.ViewColumn.Beside,
                            { enableScripts: true }
                        );

                        panel.webview.html = `
                            <!DOCTYPE html>
                            <html lang="en">
                            <head>
                                <meta charset="UTF-8">
                                <style>
                                    body { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-family: sans-serif; }
                                    input[type="color"] { width: 150px; height: 150px; border: none; padding: 0; cursor: pointer; border-radius: 8px; }
                                    button { margin-top: 20px; padding: 10px 24px; background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; border-radius: 4px; font-size: 14px;}
                                    button:hover { background-color: var(--vscode-button-hoverBackground); }
                                </style>
                            </head>
                            <body>
                                <h2>Pick a color for "${branchName}"</h2>
                                <input type="color" id="picker" value="#1e90ff">
                                <button id="save">Save Branch Color</button>
                                <script>
                                    const vscode = acquireVsCodeApi();
                                    document.getElementById('save').addEventListener('click', () => {
                                        vscode.postMessage({ type: 'color', value: document.getElementById('picker').value });
                                    });
                                </script>
                            </body>
                            </html>
                        `;

                        panel.webview.onDidReceiveMessage(message => {
                            if (message.type === 'color') {
                                resolve(message.value);
                                panel.dispose();
                            }
                        });

                        panel.onDidDispose(() => resolve(undefined));
                    });

                    if (!customInput) return; // cancelled
                    hex = customInput.toLowerCase();

                    if (hex.length === 4) {
                        hex = '#' + hex[1]+hex[1] + hex[2]+hex[2] + hex[3]+hex[3];
                    }

                    if (usedColors.has(hex)) {
                        vscode.window.showErrorMessage(`The color ${hex} is already in use by another branch! Please pick a unique color.`);
                        return;
                    }

                    if (!this.isCritical(branchName) && this.isRed(hex)) {
                        vscode.window.showErrorMessage(`Red shades (${hex}) are strictly reserved for critical branches like main/master/prod!`);
                        return; // Prevent user from manually grabbing red from the color wheel.
                    }
                }

                const newRule: BranchRule = {
                    pattern: `^${branchName}$`,
                    backgroundColor: hex,
                    foregroundColor: this.isLight(hex) ? '#000000' : '#ffffff'
                };
                
                // Add or update
                const existingIdx = rules.findIndex(r => r.pattern === `^${branchName}$`);
                if (existingIdx !== -1) {
                    rules[existingIdx] = newRule;
                } else {
                    rules.push(newRule);
                }

                await config.update('branchRules', rules, vscode.ConfigurationTarget.Global);
                this.declinedBranches.delete(branchName); // Succesfully colored
                this.updateColors();
            } else {
                // User cancelled or dismissed the picker
                this.declinedBranches.add(branchName);
            }
        } finally {
            this.isPrompting = false;
        }
    }

    private isLight(hex: string): boolean {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (!result) return false;
        const r = parseInt(result[1], 16);
        const g = parseInt(result[2], 16);
        const b = parseInt(result[3], 16);
        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
        return brightness > 155;
    }

    private isRed(hex: string): boolean {
        let normalized = hex.startsWith('#') ? hex.slice(1) : hex;
        // Expand 3-char hex to 6-char
        if (normalized.length === 3) {
            normalized = normalized.split('').map(c => c + c).join('');
        }
        const result = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(normalized);
        if (!result) return false;

        const r = parseInt(result[1], 16);
        const g = parseInt(result[2], 16);
        const b = parseInt(result[3], 16);

        // A color is "Red" if:
        // 1. Red is the dominant component.
        // 2. Red is significantly higher than Green and Blue (the "Danger" look).
        // 3. It's not too dark (blackish) or too light (pinkish), though dark red is still dangerous.
        
        const isDominantRed = r > g * 1.4 && r > b * 1.4;
        const reflectsDanger = r > 100; // Deep maroons start around 128,0,0

        return isDominantRed && reflectsDanger;
    }

    public start() {
        if (!this.gitAPI) return;
        this.gitAPI.repositories.forEach(repo => this.watchRepository(repo));
        this.gitAPI.onDidOpenRepository(repo => this.watchRepository(repo), null, this.disposables);
        this.updateColors();
    }

    private watchRepository(repo: any) {
        if (repo.state && typeof repo.state.onDidChange === 'function') {
            repo.state.onDidChange(() => this.updateColors(), null, this.disposables);
        } else if (repo.ui && repo.ui.onDidChange) {
             repo.ui.onDidChange(() => this.updateColors(), null, this.disposables);
        }
    }

    private async updateColors() {
        if (!this.gitAPI) return;

        const activeRepo = this.getActiveRepository(); 
        if (!activeRepo || !activeRepo.state.HEAD?.name) {
            this.resetColors();
            this.statusBarItem.text = "$(shield) GitGuard: No Repo";
            return;
        }

        const branchName = activeRepo.state.HEAD.name;
        const config = vscode.workspace.getConfiguration('gitguard');
        const rules = config.get<BranchRule[]>('branchRules') || [];

        let matched = false;
        for (const rule of rules) {
            const regex = new RegExp(rule.pattern);
            if (regex.test(branchName)) {
                await this.applyColors(rule.backgroundColor, rule.foregroundColor);
                this.statusBarItem.text = `$(shield) ${branchName}`;
                this.statusBarItem.color = rule.backgroundColor;
                matched = true;
                
                // Extra check: ensure no other non-matching rule is using the same color (UI warning)
                const otherRulesWithSameColor = rules.filter(r => r.pattern !== rule.pattern && r.backgroundColor.toLowerCase() === rule.backgroundColor.toLowerCase());
                if (otherRulesWithSameColor.length > 0) {
                    vscode.window.showWarningMessage(`Color Collision! Branch "${branchName}" shares a color with another rule ("${otherRulesWithSameColor[0].pattern}").`, 'Configure').then(val => {
                        if (val === 'Configure') vscode.commands.executeCommand('gitguard.configure');
                    });
                }

                break;
            }
        }

        if (!matched) {
            this.resetColors();
            this.statusBarItem.text = `$(shield) ${branchName} (Pick Color)`;
            this.statusBarItem.color = undefined;
            
            // Only prompt if we haven't been rejected in this session
            if (!this.declinedBranches.has(branchName)) {
                this.promptForColor(branchName);
            }
        }
    }

    private getColorMap(bg: string, fg: string): Record<string, Record<string, string>> {
        return {
            statusBar: { "statusBar.background": bg, "statusBar.foreground": fg },
            titleBar: { "titleBar.activeBackground": bg, "titleBar.activeForeground": fg },
            activityBar: { "activityBar.background": bg, "activityBar.foreground": fg },
            tabBar: {
                "editorGroupHeader.tabsBackground": bg,
                "tab.activeBackground": bg,
                "tab.activeForeground": fg,
                "tab.border": bg,
            },
            breadcrumb: { "breadcrumb.background": bg, "breadcrumb.foreground": fg },
        };
    }

    private async applyColors(bg: string, fg: string) {
        const customizations = { ...(vscode.workspace.getConfiguration('workbench').get<any>('colorCustomizations') || {}) };
        const colorMap = this.getColorMap(bg, fg);
        const targets = vscode.workspace.getConfiguration('gitguard').get<string[]>('colorTargets') || 
                       ['statusBar', 'titleBar', 'activityBar', 'tabBar', 'breadcrumb'];

        for (const target of targets) {
            if (colorMap[target]) {
                Object.assign(customizations, colorMap[target]);
            }
        }

        const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        await vscode.workspace.getConfiguration('workbench').update('colorCustomizations', customizations, target);
    }

    private async resetColors() {
        const customizations = { ...(vscode.workspace.getConfiguration('workbench').get<any>('colorCustomizations') || {}) };
        const allKeys = Object.values(this.getColorMap('#000', '#fff')).flatMap(zone => Object.keys(zone));

        let changed = false;
        for (const key of allKeys) {
            if (key in customizations) {
                delete customizations[key];
                changed = true;
            }
        }

        if (changed) {
            const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
            await vscode.workspace.getConfiguration('workbench').update('colorCustomizations', customizations, target);
        }
    }

    public updateStatusBarTooltip(text: string) {
        const count = text.split('\n').filter(l => l.trim().length > 0).length;
        if (count > 0) {
            this.statusBarItem.tooltip = `Total Snippets: ${count}\n---\n${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`;
        } else {
            this.statusBarItem.tooltip = "Click to configure GitGuard branch colors";
        }
    }

    public updateGitInput(text: string) {
        if (!this.gitAPI || !text) return;
        const autoPopulate = vscode.workspace.getConfiguration('gitguard').get<boolean>('autoPopulateCommit');
        if (!autoPopulate) return;

        this.gitAPI.repositories.forEach(repo => {
            if (repo.inputBox) {
                const currentVal = repo.inputBox.value;
                // Only append if the text isn't already there to avoid duplicates
                if (!currentVal.includes(text)) {
                    repo.inputBox.value = currentVal ? `${currentVal}\n\n${text}` : text;
                }
            }
        });
    }

    public dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}

class MemoManager {
    private _onDidUpdateMemo = new vscode.EventEmitter<void>();
    public readonly onDidUpdateMemo = this._onDidUpdateMemo.event;

    constructor(private context: vscode.ExtensionContext) {}

    public addToMemo(entry: MemoEntry) {
        const memoBuffer = this.getItems();
        memoBuffer.push(entry);
        this.context.workspaceState.update('memoBuffer', memoBuffer);
        
        vscode.window.showInformationMessage(`Added to Commit Memo: "${this.truncate(entry.text, 30)}"`);
        this._onDidUpdateMemo.fire();
    }

    public clearMemo() {
        this.context.workspaceState.update('memoBuffer', []);
        vscode.window.showInformationMessage('Commit Memo cleared.');
        this._onDidUpdateMemo.fire();
    }

    public deleteItemById(id: string) {
        const memoBuffer = this.getItems();
        const index = memoBuffer.findIndex(i => i.id === id);
        if (index !== -1) {
            memoBuffer.splice(index, 1);
            this.context.workspaceState.update('memoBuffer', memoBuffer);
            this._onDidUpdateMemo.fire();
        }
    }

    public getItems(): MemoEntry[] {
        const raw = this.context.workspaceState.get<any[]>('memoBuffer', []);
        return raw.map(item => {
            if (typeof item === 'string') {
                return { id: Math.random().toString(), text: item, filePath: '', fileName: 'Legacy', timestamp: Date.now() };
            }
            if (!item.id) {
                item.id = item.timestamp?.toString() || Math.random().toString();
            }
            return item;
        });
    }

    public getFormattedMemo(): string {
        const memoBuffer = this.getItems();
        if (memoBuffer.length === 0) return '';
        
        return memoBuffer.map(item => `- ${item.text}`).join('\n');
    }

    private truncate(str: string, length: number): string {
        return str.length > length ? str.substring(0, length) + '...' : str;
    }
}

class MemoTreeProvider implements vscode.TreeDataProvider<MemoItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<MemoItem | undefined | void> = new vscode.EventEmitter<MemoItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<MemoItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(private memoManager: MemoManager) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: MemoItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: MemoItem): vscode.ProviderResult<MemoItem[]> {
        if (element) return [];
        
        return this.memoManager.getItems().map((entry, index) => new MemoItem(entry, index));
    }
}

class MemoItem extends vscode.TreeItem {
    constructor(
        public readonly entry: MemoEntry,
        public readonly index: number
    ) {
        const fullText = entry.text;
        const snippet = fullText.length > 50 ? fullText.substring(0, 50) + '...' : fullText;
        const label = `${snippet}    #${index + 1} (${entry.fileName})`;
        super(label, vscode.TreeItemCollapsibleState.None);
        
        const dateStr = new Date(entry.timestamp).toLocaleString();
        this.tooltip = `File: ${entry.fileName}\nTime: ${dateStr}\n\n${fullText}`;
        this.contextValue = 'memoItem';
        this.iconPath = new vscode.ThemeIcon('bookmark');
        
        this.command = {
            command: 'gitguard.previewMemoItem',
            title: 'Preview Memo Item',
            arguments: [this]
        };
    }
}

export function deactivate() {}
