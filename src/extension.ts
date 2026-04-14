import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';

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
    branchName?: string; // If set, only appears on this branch
}

let _activeBranchWatcher: BranchWatcher | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('[GitGuard] Extension activated.');
    const memoManager = new MemoManager(context);
    const branchWatcher = new BranchWatcher(context);
    const memoTreeProvider = new MemoTreeProvider(memoManager);

    _activeBranchWatcher = branchWatcher;

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
        vscode.commands.registerCommand('gitguard.addToMemo', async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                if (editor.document.isUntitled) {
                    vscode.window.showErrorMessage('Cannot add memos from unsaved/untitled files. Please save the file first.');
                    return;
                }
                const selection = editor.selection;
                const text = editor.document.getText(selection);
                if (text) {
                    // Robust branch detection with retry logic (total 1.5s wait)
                    let currentBranch: string | undefined;
                    for (let i = 0; i < 5; i++) {
                        const activeRepo = branchWatcher.getActiveRepository();
                        currentBranch = activeRepo?.state.HEAD?.name;
                        if (currentBranch) break;
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }

                    const entry: MemoEntry = {
                        id: Date.now().toString() + Math.random().toString(36).substring(2, 9),
                        text,
                        filePath: editor.document.uri.fsPath,
                        fileName: path.basename(editor.document.fileName),
                        timestamp: Date.now(),
                        branchName: currentBranch // Auto-pin to detected branch
                    };
                    memoManager.addToMemo(entry);
                    
                    if (!currentBranch) {
                        vscode.window.setStatusBarMessage(`🛡️ GitGuard: No branch detected. Saved as Global memo.`, 5000);
                    }
                    
                    // Automatically switch to SCM view and focus the memos
                    vscode.commands.executeCommand('workbench.view.scm');
                    vscode.commands.executeCommand('gitguard.memoView.focus');
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

                // Only auto-delete if the user has enabled the setting
                const autoDelete = vscode.workspace.getConfiguration('gitguard').get<boolean>('autoDeleteMemosAfterCommit', false);
                if (autoDelete) {
                    // Auto-delete on success to keep workspace clean
                    memoManager.deleteItemById(item.entry.id);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Auto-commit failed: ${err.message}`);
            }
        }),
        vscode.commands.registerCommand('gitguard.repairGit', async () => {
            const activeRepo = branchWatcher.getActiveRepository();
            if (!activeRepo) {
                vscode.window.showErrorMessage('No Git repository found to repair.');
                return;
            }
            await branchWatcher.repairGitWorkflow(activeRepo.rootUri.fsPath);
        }),
        branchWatcher.onDidBranchChange(() => {
            memoTreeProvider.refresh();
        }),
        vscode.commands.registerCommand('gitguard.editMemoItem', async (item: MemoItem) => {
            const newText = await vscode.window.showInputBox({
                prompt: 'Edit your memo message',
                value: item.entry.text,
                ignoreFocusOut: true
            });
            if (newText !== undefined && newText.trim().length > 0) {
                memoManager.editItem(item.entry.id, newText);
                memoTreeProvider.refresh();
            }
        }),
        vscode.commands.registerCommand('gitguard.moveMemoUp', (item: MemoItem) => {
            memoManager.moveItem(item.entry.id, 'up');
            memoTreeProvider.refresh();
        }),
        vscode.commands.registerCommand('gitguard.moveMemoDown', (item: MemoItem) => {
            memoManager.moveItem(item.entry.id, 'down');
            memoTreeProvider.refresh();
        }),
        vscode.commands.registerCommand('gitguard.toggleMemoPin', (item: MemoItem) => {
            const activeRepo = branchWatcher.getActiveRepository();
            const currentBranch = activeRepo?.state.HEAD?.name;
            memoManager.togglePin(item.entry.id, currentBranch);
            // Unified refresh handles the rest
        }),
        vscode.commands.registerCommand('gitguard.refreshMemos', () => {
            refreshAllUI();
            vscode.window.showInformationMessage('Commit Memos refreshed.');
        })
    );

    // Wire up branchWatcher as a disposable
    context.subscriptions.push(branchWatcher);

    const refreshAllUI = () => {
        const activeRepo = branchWatcher.getActiveRepository();
        const currentBranch = activeRepo?.state.HEAD?.name;
        
        const text = memoManager.getFormattedMemo(currentBranch);
        branchWatcher.updateGitInput(text);
        branchWatcher.updateStatusBarTooltip(text);
        memoTreeProvider.refresh();
    };

    // Update everything whenever the branch changes or memos change
    branchWatcher.onDidBranchChange(refreshAllUI);
    memoManager.onDidUpdateMemo(refreshAllUI);

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
    private _onDidBranchChange = new vscode.EventEmitter<string>();
    public readonly onDidBranchChange = this._onDidBranchChange.event;

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

    public getActiveRepository(): Repository | undefined {
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

        const mode = vscode.workspace.getConfiguration('gitguard').get<string>('storageMode') || 'global';
        const target = (mode === 'workspace' && vscode.workspace.workspaceFolders) ?
            vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;

        if (selection === 'Change Current Branch Color') {
            const activeRepo = this.getActiveRepository();
            if (activeRepo?.state.HEAD?.name) {
                const branchName = activeRepo.state.HEAD.name;
                if (this.isCritical(branchName)) {
                    vscode.window.showInformationMessage(`🛡️ Branch "${branchName}" is registered as a Critical Branch and is locked to Crimson Red.`);
                    return;
                }
                this.declinedBranches.delete(branchName);
                await this.promptForColor(branchName);
            }
        } else if (selection === 'Remove All Rules') {
            await vscode.workspace.getConfiguration('gitguard').update('branchRules', [], target);
            this.updateColors();
        } else if (selection === 'Reset to Defaults') {
            await vscode.workspace.getConfiguration('gitguard').update('branchRules', undefined, target);
            this.updateColors();
        }
    }

    private isCritical(branch: string): boolean {
        return /^(main|master|prod)$/i.test(branch);
    }

    private async promptForColor(branchName: string) {
        if (this.isCritical(branchName)) return;

        this.isPrompting = true;

        try {
            const config = vscode.workspace.getConfiguration('gitguard');
            const rules = config.get<BranchRule[]>('branchRules') || [];

            // Check all used colors except the one for this specific pattern
            const usedColors = new Set(
                rules.filter(r => r.pattern !== `^${branchName}$`).map(r => r.backgroundColor.toLowerCase())
            );

            // Filter out used colors and explicitly exclude ANY red shades for non-critical branches
            let options = PALETTE.filter(p => !usedColors.has(p.hex.toLowerCase()) && !this.isRed(p.hex));

            if (options.length === 0) {
                vscode.window.showInformationMessage('All unique colors for this branch type are already taken! Clearing oldest rule might help.');
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
                        hex = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
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

                const mode = vscode.workspace.getConfiguration('gitguard').get<string>('storageMode') || 'global';
                const target = (mode === 'workspace' && vscode.workspace.workspaceFolders) ?
                    vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;

                await config.update('branchRules', rules, target);
                this.declinedBranches.delete(branchName); // Successfully colored
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
        this.gitAPI.repositories.forEach(repo => {
            this.watchRepository(repo);
            this.ensureInvisibility(repo.rootUri.fsPath); // PROACTIVE
        });
        this.gitAPI.onDidOpenRepository(repo => {
            this.watchRepository(repo);
            this.ensureInvisibility(repo.rootUri.fsPath); // PROACTIVE
        }, null, this.disposables);

        // Initial update
        this.updateColors();

        // Robustness: Retry update after a short delay to catch late-loading Git repositories
        setTimeout(() => this.updateColors(), 2000);
    }

    private async ensureInvisibility(root: string) {
        await this.ensureLocalExclude(root);
        await this.ensureGitIgnore(root);
        await this.skipWorktree(root);
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

        const repoPath = activeRepo.rootUri.fsPath;
        if (this.isRepositoryIgnored(repoPath)) {
            this.resetColors();
            this.statusBarItem.text = `$(shield) Ignored Repo`;
            return;
        }

        const branchName = activeRepo.state.HEAD.name;
        const config = vscode.workspace.getConfiguration('gitguard');
        const rules = config.get<BranchRule[]>('branchRules') || [];

        // 1. Priority Enforcement: Critical branches are ALWAYS Crimson Red
        if (this.isCritical(branchName)) {
            const hex = CRITICAL_RED.hex;
            const fg = this.isLight(hex) ? '#000000' : '#ffffff';

            await this.applyColors(hex, fg);
            this.statusBarItem.text = `$(shield) ${branchName}`;
            this.statusBarItem.color = hex;

            // Auto-heal configuration if it's missing or incorrect
            const existingIdx = rules.findIndex(r => r.pattern === `^${branchName}$`);
            const ruleMatches = existingIdx !== -1 && rules[existingIdx].backgroundColor.toLowerCase() === hex.toLowerCase();

            if (!ruleMatches) {
                const newRule: BranchRule = { pattern: `^${branchName}$`, backgroundColor: hex, foregroundColor: fg };
                const updatedRules = [...rules];
                if (existingIdx !== -1) updatedRules[existingIdx] = newRule;
                else updatedRules.push(newRule);

                const mode = config.get<string>('storageMode') || 'global';
                const target = (mode === 'workspace' && vscode.workspace.workspaceFolders) ?
                    vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
                await config.update('branchRules', updatedRules, target);
            }
            this._onDidBranchChange.fire(branchName);
            return; // Exit early for critical branches
        }

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
        this._onDidBranchChange.fire(branchName);
    }

    private isRepositoryIgnored(repoPath: string): boolean {
        const ignored = vscode.workspace.getConfiguration('gitguard').get<string[]>('ignoredRepositories') || [];
        const normalizedPath = repoPath.replace(/\\/g, '/').toLowerCase();

        // Always ignore the extension source if identifiable
        if (normalizedPath.endsWith('gitguard-memo') || normalizedPath.endsWith('git-color')) {
            return true;
        }

        return ignored.some(i => {
            const normI = i.replace(/\\/g, '/').toLowerCase();
            return normalizedPath === normI || normalizedPath.startsWith(normI + '/');
        });
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
        const config = vscode.workspace.getConfiguration('workbench');

        // WINDOW ISOLATION: Always use Workspace target if a folder is open.
        // This prevents colors from changing in other windows.
        const target = vscode.workspace.workspaceFolders ?
            vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;

        // Read only the current target's value to avoid duplicating global settings into workspace
        const inspect = config.inspect<any>('colorCustomizations');
        const currentCustoms = { ...(target === vscode.ConfigurationTarget.Workspace ? inspect?.workspaceValue : inspect?.globalValue) || {} };

        const colorMap = this.getColorMap(bg, fg);
        const targets = vscode.workspace.getConfiguration('gitguard').get<string[]>('colorTargets') ||
            ['statusBar', 'titleBar', 'activityBar', 'tabBar', 'breadcrumb'];

        // 1. Clear ALL possible GitGuard keys first to handle 'colorTargets' changes or target swaps
        const allKeys = Object.values(this.getColorMap('#000', '#fff')).flatMap(zone => Object.keys(zone));
        for (const key of allKeys) {
            delete currentCustoms[key];
        }

        // 2. Apply current targets
        for (const t of targets) {
            if (colorMap[t]) {
                Object.assign(currentCustoms, colorMap[t]);
            }
        }

        // 3. Proactive invisibility to avoid Git IRRRRRITATION (Zero-File intent)
        const activeRepo = this.getActiveRepository();
        if (activeRepo) {
            await this.ensureInvisibility(activeRepo.rootUri.fsPath);
        }

        // 4. Update the target
        await config.update('colorCustomizations', currentCustoms, target);

        // 5. Clean up orphans from previous buggy versions that might have set Global when they shouldn't
        if (target === vscode.ConfigurationTarget.Workspace) {
            await this.clearGlobalOrphans(allKeys);
        }
    }

    private async clearGlobalOrphans(allKeys: string[]) {
        const config = vscode.workspace.getConfiguration('workbench');
        const inspect = config.inspect<any>('colorCustomizations');
        if (inspect?.globalValue) {
            const gCustoms = { ...inspect.globalValue };
            let changed = false;
            for (const key of allKeys) {
                if (key in gCustoms) {
                    delete gCustoms[key];
                    changed = true;
                }
            }
            if (changed) {
                await config.update('colorCustomizations', gCustoms, vscode.ConfigurationTarget.Global);
            }
        }
    }


    public async repairGitWorkflow(repoRoot: string) {
        const confirm = await vscode.window.showInformationMessage(
            'Repairing Git Workflow will untrack .vscode folder and ignore local settings. This fixes "Checkout Overwritten" errors. Proceed?',
            { modal: true }, 'Yes', 'No'
        );

        if (confirm !== 'Yes') return;

        // 1. Untrack from index
        exec('git rm -r --cached --sparse .vscode', { cwd: repoRoot }, (err: any) => {
            if (err) {
                // Ignore errors if already untracked
                console.log('[GitGuard] rm --cached failed (might already be untracked).');
            }

            // 2. Skip worktree
            exec('git update-index --skip-worktree .vscode/settings.json', { cwd: repoRoot }, (innerErr: any) => {
                // 3. Update .gitignore
                this.ensureGitIgnore(repoRoot);

                vscode.window.showInformationMessage('GitGuard: Repair command sent. Please COMMIT your changes now to finish unblocking your branches!');
            });
        });
    }

    private async ensureGitIgnore(repoRoot: string) {
        try {
            const ignorePath = path.join(repoRoot, '.gitignore');
            const entry = '.vscode/';
            let content = '';
            if (fs.existsSync(ignorePath)) {
                content = fs.readFileSync(ignorePath, 'utf8');
            }

            if (!content.includes(entry)) {
                const divider = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
                fs.appendFileSync(ignorePath, `${divider}# Ignored by GitGuard\n${entry}\n`);
                vscode.window.showInformationMessage(`GitGuard: Added ${entry} to .gitignore to prevent accidental commits.`);
            }
        } catch (err) {
            console.error('[GitGuard] Failed to update .gitignore:', err);
        }
    }

    private async skipWorktree(repoRoot: string) {
        // Execute 'git update-index --skip-worktree .vscode/settings.json'
        // This stops git from tracking changes even if the file is indexed.
        const settingsPath = '.vscode/settings.json';
        exec(`git update-index --skip-worktree ${settingsPath}`, { cwd: repoRoot }, (err: any) => {
            if (!err) {
                console.log(`[GitGuard] Skipped worktree for ${settingsPath}`);
            } else {
                console.error(`[GitGuard] skip-worktree failed: ${err.message}`);
            }
        });
    }

    private async ensureLocalExclude(repoRoot: string) {
        try {
            const excludePath = path.join(repoRoot, '.git', 'info', 'exclude');
            if (!fs.existsSync(path.dirname(excludePath))) return; // Not a standard Git repo or no info dir

            const entry = '.vscode/settings.json';
            let content = '';
            if (fs.existsSync(excludePath)) {
                content = fs.readFileSync(excludePath, 'utf8');
            }

            if (!content.includes(entry)) {
                const divider = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
                fs.appendFileSync(excludePath, `${divider}${entry}\n`);
                console.log(`[GitGuard] Added ${entry} to local git exclude.`);
            }
        } catch (err) {
            console.error('[GitGuard] Failed to update git exclude:', err);
        }
    }

    private async resetColors() {
        const config = vscode.workspace.getConfiguration('workbench');
        const allKeys = Object.values(this.getColorMap('#000', '#fff')).flatMap(zone => Object.keys(zone));
        const inspect = config.inspect<any>('colorCustomizations');

        // Clean Workspace
        if (inspect?.workspaceValue) {
            const wsCustoms = { ...inspect.workspaceValue };
            let changed = false;
            for (const key of allKeys) {
                if (key in wsCustoms) { delete wsCustoms[key]; changed = true; }
            }
            if (changed) await config.update('colorCustomizations', wsCustoms, vscode.ConfigurationTarget.Workspace);
        }

        // Clean Global
        if (inspect?.globalValue) {
            const gCustoms = { ...inspect.globalValue };
            let changed = false;
            for (const key of allKeys) {
                if (key in gCustoms) { delete gCustoms[key]; changed = true; }
            }
            if (changed) await config.update('colorCustomizations', gCustoms, vscode.ConfigurationTarget.Global);
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
        if (!this.gitAPI) return;
        const autoPopulate = vscode.workspace.getConfiguration('gitguard').get<boolean>('autoPopulateCommit');
        if (!autoPopulate) return;

        const markerHead = '--- GitGuard Commit Memos ---';
        const marker = `\n\n${markerHead}\n`;

        this.gitAPI.repositories.forEach(repo => {
            if (repo.inputBox) {
                const currentVal = repo.inputBox.value;
                const markerIndex = currentVal.indexOf(markerHead);

                let baseValue = currentVal;
                if (markerIndex !== -1) {
                    // Find the start of the marker block (including potential leading newlines)
                    const beforeMarker = currentVal.substring(0, markerIndex);
                    baseValue = beforeMarker.trim();
                }

                if (text) {
                    const newVal = baseValue ? `${baseValue}${marker}${text}` : text;
                    if (currentVal !== newVal) {
                        repo.inputBox.value = newVal;
                    }
                } else if (markerIndex !== -1) {
                    // If no text but marker exists, remove marker and everything after
                    repo.inputBox.value = baseValue;
                }
            }
        });
    }

    public async dispose() {
        await this.resetColors();
        this.disposables.forEach(d => d.dispose());
    }
}

class MemoManager {
    private _onDidUpdateMemo = new vscode.EventEmitter<void>();
    public readonly onDidUpdateMemo = this._onDidUpdateMemo.event;

    constructor(private context: vscode.ExtensionContext) { }

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
        const memoBuffer = this.getAllItems();
        const index = memoBuffer.findIndex(i => i.id === id);
        if (index !== -1) {
            memoBuffer.splice(index, 1);
            this.context.workspaceState.update('memoBuffer', memoBuffer);
            this._onDidUpdateMemo.fire();
        }
    }

    public editItem(id: string, newText: string) {
        const memoBuffer = this.getAllItems();
        const item = memoBuffer.find(i => i.id === id);
        if (item) {
            item.text = newText;
            this.context.workspaceState.update('memoBuffer', memoBuffer);
            this._onDidUpdateMemo.fire();
        }
    }

    public moveItem(id: string, direction: 'up' | 'down') {
        const memoBuffer = this.getAllItems();
        const index = memoBuffer.findIndex(i => i.id === id);
        if (index === -1) return;

        if (direction === 'up' && index > 0) {
            [memoBuffer[index], memoBuffer[index - 1]] = [memoBuffer[index - 1], memoBuffer[index]];
        } else if (direction === 'down' && index < memoBuffer.length - 1) {
            [memoBuffer[index], memoBuffer[index + 1]] = [memoBuffer[index + 1], memoBuffer[index]];
        } else {
            return;
        }

        this.context.workspaceState.update('memoBuffer', memoBuffer);
        this._onDidUpdateMemo.fire();
    }

    public togglePin(id: string, currentBranchName?: string) {
        const memoBuffer = this.getAllItems();
        const item = memoBuffer.find(i => i.id === id);
        if (item) {
            if (item.branchName) {
                delete item.branchName; // Make global
            } else if (currentBranchName) {
                item.branchName = currentBranchName; // Pin to current
            }
            this.context.workspaceState.update('memoBuffer', memoBuffer);
            this._onDidUpdateMemo.fire();
        }
    }

    /**
     * Get items filtered by the current branch.
     * Shows: (Global items) OR (Items pinned to this branch)
     */
    public getItems(currentBranch?: string): MemoEntry[] {
        const all = this.getAllItems();
        if (!currentBranch) return all;

        return all.filter(item => !item.branchName || item.branchName === currentBranch);
    }

    public getAllItems(): MemoEntry[] {
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

    public getFormattedMemo(currentBranch?: string): string {
        const memoBuffer = this.getItems(currentBranch);
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

    constructor(private memoManager: MemoManager) { }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: MemoItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: MemoItem): vscode.ProviderResult<MemoItem[]> {
        if (element) return [];

        // Direct lookup from the watcher to ensure fresh branch state
        const activeRepo = _activeBranchWatcher?.getActiveRepository();
        const currentBranch = activeRepo?.state.HEAD?.name;

        const items = this.memoManager.getItems(currentBranch);
        
        // SORT: Pinned items at the top
        const sortedItems = items.sort((a, b) => {
            if (a.branchName && !b.branchName) return -1;
            if (!a.branchName && b.branchName) return 1;
            return 0;
        });

        return sortedItems.map((entry, index) => new MemoItem(entry, index, currentBranch));
    }
}

class MemoItem extends vscode.TreeItem {
    constructor(
        public readonly entry: MemoEntry,
        public readonly index: number,
        public readonly currentBranchName?: string
    ) {
        const fullText = entry.text;
        const snippet = fullText.length > 50 ? fullText.substring(0, 50) + '...' : fullText;
        
        // Label shows the snippet and index. Prefix pinned items with 📌
        const label = entry.branchName ? `📌 ${snippet}` : snippet;
        super(label, vscode.TreeItemCollapsibleState.None);

        // Description shows the origin file and pin status
        const pinStatus = entry.branchName ? `(Pinned: ${entry.branchName})` : '(Global)';
        this.description = `#${index + 1} ${pinStatus}`;

        const dateStr = new Date(entry.timestamp).toLocaleString();
        this.tooltip = `File: ${entry.fileName}\nBranch: ${entry.branchName || 'Global'}\nTime: ${dateStr}\n\n${fullText}`;
        
        // Context value allows menu icons to be shown/hidden
        this.contextValue = entry.branchName ? 'memoItemPinned' : 'memoItemGlobal';
        
        if (entry.branchName) {
            this.iconPath = new vscode.ThemeIcon('pin', new vscode.ThemeColor('charts.blue'));
        } else {
            this.iconPath = new vscode.ThemeIcon('bookmark');
        }

        this.command = {
            command: 'gitguard.previewMemoItem',
            title: 'Preview Memo Item',
            arguments: [this]
        };
    }
}

export async function deactivate() {
    console.log('[GitGuard] Extension deactivated. Cleaning up...');
    if (_activeBranchWatcher) {
        await _activeBranchWatcher.dispose();
    }
}
