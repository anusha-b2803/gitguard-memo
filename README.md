# GitGuard & Memo

**GitGuard & Memo** is a developer experience (DX) extension for VS Code designed to keep your workspace safe from accidental commits to protected branches and to keep your commit history organized using an integrated code snippet tracker.

## Features

### 🛡️ GitGuard: Visual Branch Protection
Never accidentally push experimental code to production again. GitGuard dynamically colorizes your entire VS Code workspace (Status Bar, Title Bar, Tabs, and Breadcrumbs) based on your active Git branch. 
* **Critical Alerts**: Automatically paints the IDE Red when working on restricted branches like `main`, `master`, or `prod`.
* **Custom Palettes**: Choose from a rich curated palette of 24 unique aesthetic Web colors to identify your `feature`, `hotfix`, or `release` branches.
* **Auto-Discovery**: Automatically links and reads the specific Git repository connected to your active file, working flawlessly across Multi-Root Workspaces.

### 📝 Commit Memos: Context-Aware Snippet Buffers
Say goodbye to forgetting what you changed hours ago. The "Commit Memos" feature acts as a persistent clipboard seamlessly integrated alongside your Git changes.
* **Capture Anywhere**: Highlight any span of code across the workspace, right-click, and "Add to Commit Memo." 
* **Rich Metadata**: The extension remembers exactly which file the snippet came from and logs the exact timestamp for reference. No more lost context. 
* **Smart Insert & Stage**: When you're ready to commit, click the `+` action button over the memo item. GitGuard will:
  1. Jump directly back to the exact source file you grabbed it from.
  2. Ask for the precise line number to insert the memo.
  3. Seamlessly inject your code, save the file, and gracefully **auto-stage** the changes into Git.

## Requirements
* `vscode.git` (Built-in Git Extension): GitGuard connects to VS Code's internal Git API automatically. You must have Git initialized on your workspace.

## Configuration
Configure GitGuard directly through the User Interface by clicking the **GitGuard** logo locally in the Status Bar or configuring it in your `settings.json`:
* `gitguard.branchRules`: Regex rules detailing which color mapping belongs to which string regex namespace.
* `gitguard.colorTargets`: Restrict where the colors display (status bar, tabs, titlebar).
