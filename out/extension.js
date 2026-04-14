"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
function activate(context) {
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
    context.subscriptions.push(vscode.commands.registerCommand('gitguard.addToMemo', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            if (editor.document.isUntitled) {
                vscode.window.showErrorMessage('Cannot add memos from unsaved/untitled files. Please save the file first.');
                return;
            }
            const selection = editor.selection;
            const text = editor.document.getText(selection);
            if (text) {
                const entry = {
                    id: Date.now().toString() + Math.random().toString(36).substring(2, 9),
                    text,
                    filePath: editor.document.uri.fsPath,
                    fileName: path.basename(editor.document.fileName),
                    timestamp: Date.now()
                };
                memoManager.addToMemo(entry);
            }
        }
    }), vscode.commands.registerCommand('gitguard.clearMemo', async () => {
        const confirm = await vscode.window.showWarningMessage('Are you sure you want to clear ALL items from the Commit Memo?', { modal: true }, 'Clear All');
        if (confirm === 'Clear All') {
            memoManager.clearMemo();
        }
    }), vscode.commands.registerCommand('gitguard.configure', () => {
        branchWatcher.configure(context);
    }), vscode.commands.registerCommand('gitguard.viewMemo', () => {
        const memo = memoManager.getFormattedMemo();
        if (memo) {
            vscode.window.showInformationMessage('Current Commit Memo:\n' + memo);
        }
        else {
            vscode.window.showInformationMessage('Commit Memo is empty.');
        }
    }), vscode.commands.registerCommand('gitguard.deleteMemoItem', (item) => {
        memoManager.deleteItemById(item.entry.id);
    }), vscode.commands.registerCommand('gitguard.previewMemoItem', (item) => {
        vscode.window.showInformationMessage(item.entry.text, { modal: true });
    }), vscode.commands.registerCommand('gitguard.insertAndCommit', async (item) => {
        if (!item.entry.filePath) {
            vscode.window.showErrorMessage('Cannot insert legacy memo (No original file tracked).');
            return;
        }
        let document;
        try {
            document = await vscode.workspace.openTextDocument(vscode.Uri.file(item.entry.filePath));
        }
        catch (err) {
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
        if (!lineInput)
            return;
        const lineNumber = parseInt(lineInput, 10);
        const position = new vscode.Position(lineNumber - 1, 0);
        const textToInsert = (lineNumber <= document.lineCount) ? item.entry.text + '\n' : '\n' + item.entry.text;
        await editor.edit(editBuilder => {
            editBuilder.insert(position, textToInsert);
        });
        await document.save();
        const gitExtension = vscode.extensions.getExtension('vscode.git');
        const gitAPI = gitExtension?.exports.getAPI(1);
        if (!gitAPI)
            return;
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
        }
        catch (err) {
            vscode.window.showErrorMessage(`Auto-commit failed: ${err.message}`);
        }
    }));
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
exports.activate = activate;
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
    constructor(context) {
        this.context = context;
        this.disposables = [];
        this.isPrompting = false;
        this.declinedBranches = new Set();
        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (gitExtension) {
            this.gitAPI = gitExtension.exports.getAPI(1);
        }
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.text = "$(shield) GitGuard";
        this.statusBarItem.command = 'gitguard.configure';
        this.statusBarItem.show();
        this.context.subscriptions.push(this.statusBarItem);
    }
    findRepositoryForUri(api, uri) {
        const docPath = uri.fsPath.replace(/\\/g, '/').toLowerCase();
        const matches = api.repositories.map(repo => ({
            repo,
            repoPath: repo.rootUri.fsPath.replace(/\\/g, '/').toLowerCase()
        })).filter(m => docPath === m.repoPath || docPath.startsWith(m.repoPath + '/'));
        // Sort by longest path to find the deepest matching repository (correct for nested repos)
        matches.sort((a, b) => b.repoPath.length - a.repoPath.length);
        return matches.length > 0 ? matches[0].repo : undefined;
    }
    getActiveRepository() {
        if (!this.gitAPI)
            return undefined;
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const repo = this.findRepositoryForUri(this.gitAPI, editor.document.uri);
            if (repo)
                return repo;
        }
        return this.gitAPI.repositories[0];
    }
    async configure(context) {
        const options = ['Change Current Branch Color', 'Remove All Rules', 'Reset to Defaults'];
        const selection = await vscode.window.showQuickPick(options, { placeHolder: 'GitGuard: Configuration' });
        if (selection === 'Change Current Branch Color') {
            const activeRepo = this.getActiveRepository();
            if (activeRepo?.state.HEAD?.name) {
                await this.promptForColor(activeRepo.state.HEAD.name);
            }
        }
        else if (selection === 'Remove All Rules') {
            await vscode.workspace.getConfiguration('gitguard').update('branchRules', [], vscode.ConfigurationTarget.Global);
            this.updateColors();
        }
        else if (selection === 'Reset to Defaults') {
            await vscode.workspace.getConfiguration('gitguard').update('branchRules', undefined, vscode.ConfigurationTarget.Global);
            this.updateColors();
        }
    }
    isCritical(branch) {
        return /^(main|master|prod)$/i.test(branch);
    }
    async promptForColor(branchName) {
        if (this.isPrompting)
            return;
        this.isPrompting = true;
        try {
            const config = vscode.workspace.getConfiguration('gitguard');
            const rules = config.get('branchRules') || [];
            // Check all used colors except the one for this specific pattern
            const usedColors = new Set(rules.filter(r => r.pattern !== `^${branchName}$`).map(r => r.backgroundColor.toLowerCase()));
            let options = [];
            if (this.isCritical(branchName)) {
                options.push(CRITICAL_RED);
                const redOptions = PALETTE.filter(p => this.isRed(p.hex) && !usedColors.has(p.hex.toLowerCase()));
                options.push(...redOptions);
            }
            else {
                // Filter out used colors and explicitly exclude ANY red shades for non-critical branches
                options = PALETTE.filter(p => !usedColors.has(p.hex.toLowerCase()) && !this.isRed(p.hex));
            }
            if (options.length === 0) {
                vscode.window.showInformationMessage('All unique colors are already taken! Clearing oldest rule might help.');
                return;
            }
            const quickPickOptions = options.map(o => ({ label: o.label, description: o.hex }));
            quickPickOptions.unshift({ label: '🎨 Custom Hex Color...', description: 'Provide your own hex code' });
            const selection = await vscode.window.showQuickPick(quickPickOptions, {
                placeHolder: `🛡️ Pick a unique color for branch "${branchName}"`,
                ignoreFocusOut: true
            });
            if (selection) {
                let hex = selection.description;
                if (selection.label === '🎨 Custom Hex Color...') {
                    const customInput = await new Promise(resolve => {
                        const panel = vscode.window.createWebviewPanel('colorPicker', `Pick Color for ${branchName}`, vscode.ViewColumn.Beside, { enableScripts: true });
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
                    if (!customInput)
                        return; // cancelled
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
                const newRule = {
                    pattern: `^${branchName}$`,
                    backgroundColor: hex,
                    foregroundColor: this.isLight(hex) ? '#000000' : '#ffffff'
                };
                // Add or update
                const existingIdx = rules.findIndex(r => r.pattern === `^${branchName}$`);
                if (existingIdx !== -1) {
                    rules[existingIdx] = newRule;
                }
                else {
                    rules.push(newRule);
                }
                await config.update('branchRules', rules, vscode.ConfigurationTarget.Global);
                this.declinedBranches.delete(branchName); // Succesfully colored
                this.updateColors();
            }
            else {
                // User cancelled or dismissed the picker
                this.declinedBranches.add(branchName);
            }
        }
        finally {
            this.isPrompting = false;
        }
    }
    isLight(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (!result)
            return false;
        const r = parseInt(result[1], 16);
        const g = parseInt(result[2], 16);
        const b = parseInt(result[3], 16);
        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
        return brightness > 155;
    }
    isRed(hex) {
        let normalized = hex.startsWith('#') ? hex.slice(1) : hex;
        // Expand 3-char hex to 6-char
        if (normalized.length === 3) {
            normalized = normalized.split('').map(c => c + c).join('');
        }
        const result = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(normalized);
        if (!result)
            return false;
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
    start() {
        if (!this.gitAPI)
            return;
        this.gitAPI.repositories.forEach(repo => this.watchRepository(repo));
        this.gitAPI.onDidOpenRepository(repo => this.watchRepository(repo), null, this.disposables);
        this.updateColors();
    }
    watchRepository(repo) {
        if (repo.state && typeof repo.state.onDidChange === 'function') {
            repo.state.onDidChange(() => this.updateColors(), null, this.disposables);
        }
        else if (repo.ui && repo.ui.onDidChange) {
            repo.ui.onDidChange(() => this.updateColors(), null, this.disposables);
        }
    }
    async updateColors() {
        if (!this.gitAPI)
            return;
        const activeRepo = this.getActiveRepository();
        if (!activeRepo || !activeRepo.state.HEAD?.name) {
            this.resetColors();
            this.statusBarItem.text = "$(shield) GitGuard: No Repo";
            return;
        }
        const branchName = activeRepo.state.HEAD.name;
        const config = vscode.workspace.getConfiguration('gitguard');
        const rules = config.get('branchRules') || [];
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
                        if (val === 'Configure')
                            vscode.commands.executeCommand('gitguard.configure');
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
    getColorMap(bg, fg) {
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
    async applyColors(bg, fg) {
        const customizations = { ...(vscode.workspace.getConfiguration('workbench').get('colorCustomizations') || {}) };
        const colorMap = this.getColorMap(bg, fg);
        const targets = vscode.workspace.getConfiguration('gitguard').get('colorTargets') ||
            ['statusBar', 'titleBar', 'activityBar', 'tabBar', 'breadcrumb'];
        for (const target of targets) {
            if (colorMap[target]) {
                Object.assign(customizations, colorMap[target]);
            }
        }
        const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        await vscode.workspace.getConfiguration('workbench').update('colorCustomizations', customizations, target);
    }
    async resetColors() {
        const customizations = { ...(vscode.workspace.getConfiguration('workbench').get('colorCustomizations') || {}) };
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
    updateStatusBarTooltip(text) {
        const count = text.split('\n').filter(l => l.trim().length > 0).length;
        if (count > 0) {
            this.statusBarItem.tooltip = `Total Snippets: ${count}\n---\n${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`;
        }
        else {
            this.statusBarItem.tooltip = "Click to configure GitGuard branch colors";
        }
    }
    updateGitInput(text) {
        if (!this.gitAPI || !text)
            return;
        const autoPopulate = vscode.workspace.getConfiguration('gitguard').get('autoPopulateCommit');
        if (!autoPopulate)
            return;
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
    dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}
class MemoManager {
    constructor(context) {
        this.context = context;
        this._onDidUpdateMemo = new vscode.EventEmitter();
        this.onDidUpdateMemo = this._onDidUpdateMemo.event;
    }
    addToMemo(entry) {
        const memoBuffer = this.getItems();
        memoBuffer.push(entry);
        this.context.workspaceState.update('memoBuffer', memoBuffer);
        vscode.window.showInformationMessage(`Added to Commit Memo: "${this.truncate(entry.text, 30)}"`);
        this._onDidUpdateMemo.fire();
    }
    clearMemo() {
        this.context.workspaceState.update('memoBuffer', []);
        vscode.window.showInformationMessage('Commit Memo cleared.');
        this._onDidUpdateMemo.fire();
    }
    deleteItemById(id) {
        const memoBuffer = this.getItems();
        const index = memoBuffer.findIndex(i => i.id === id);
        if (index !== -1) {
            memoBuffer.splice(index, 1);
            this.context.workspaceState.update('memoBuffer', memoBuffer);
            this._onDidUpdateMemo.fire();
        }
    }
    getItems() {
        const raw = this.context.workspaceState.get('memoBuffer', []);
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
    getFormattedMemo() {
        const memoBuffer = this.getItems();
        if (memoBuffer.length === 0)
            return '';
        return memoBuffer.map(item => `- ${item.text}`).join('\n');
    }
    truncate(str, length) {
        return str.length > length ? str.substring(0, length) + '...' : str;
    }
}
class MemoTreeProvider {
    constructor(memoManager) {
        this.memoManager = memoManager;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (element)
            return [];
        return this.memoManager.getItems().map((entry, index) => new MemoItem(entry, index));
    }
}
class MemoItem extends vscode.TreeItem {
    constructor(entry, index) {
        const fullText = entry.text;
        const snippet = fullText.length > 50 ? fullText.substring(0, 50) + '...' : fullText;
        const label = `${snippet}    #${index + 1} (${entry.fileName})`;
        super(label, vscode.TreeItemCollapsibleState.None);
        this.entry = entry;
        this.index = index;
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
function deactivate() { }
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map