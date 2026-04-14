# GitGuard & Memo

[![Version](https://img.shields.io/visual-studio-marketplace/v/AnushaB.gitguard-memo?label=version&color=blue)](https://marketplace.visualstudio.com/items?itemName=AnushaB.gitguard-memo)
[![License](https://img.shields.io/github/license/anushab2803/git-color?color=green)](LICENSE.md)
[![Platform](https://img.shields.io/badge/platform-vscode-blue)](https://code.visualstudio.com/)

GitGuard is a professional-grade DevOps utility designed to eliminate branch-based deployment errors and streamline commit message management. By combining visual safety triggers with a branch-aware memo buffer, GitGuard ensures developers maintain perfect situational awareness.

Check out the product : [GitGuard & Memo](https://marketplace.visualstudio.com/items?itemName=AnushaB.gitguard-memo)

## Core Technical Architecture

### 1. Visual Context Enforcement
GitGuard dynamically manages the VS Code interface theme based on the active Git branch, providing an immediate visual safeguard against accidental commits to protected environments.
- **Protected Branch Hardening**: Critical branches (`main`, `master`, `prod`) are hard-coded to a Crimson Red profile. Users are prevented from modifying these enforcement rules.
- **Unique Branch Mapping**: Automatically assigns unique, high-contrast colors to feature, development, and hotfix branches to prevent context confusion.
- **Workspace Isolation**: Multi-window support ensures that branch colors remain isolated to the specific workspace where the branch is checked out.

### 2. Context-Aware Commit Memos
The Commit Memo system provides a persistent, branch-aware buffer that captures technical snippets and context during the development lifecycle.
- **Automated Pining**: Memos created on a branch are automatically pinned to that branch. They reappear programmatically upon branch checkout and are hidden in all other contexts.
- **Unified Interface Synchronization**: The Extension Sidebar, Git Commit Input Box, and Status Bar tooltips are synchronized via a central event bus to update instantly across Git state changes.
- **Structural Management**: Supports in-place text editing, logical reordering for cohesive commit messages, and global/local pinning toggles.

### 3. Engineering Utilities
- **Git Workflow Repair**: A dedicated tool to untrack local workspace configurations and prevent checkout conflicts caused by environment settings.
- **Automated Staging**: Direct insertion of memos into source code with built-in Git staging and commit execution.
- **Proactive Leak Prevention**: Automatically updates local Git excludes to ensure extension metadata does not pollute the repository index.

## Installation

1. Install via the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=AnushaB.gitguard-memo).
2. Ensure the built-in VS Code Git extension is enabled.
3. Once a Git repository is detected, GitGuard will automatically activate its monitoring services.

## Configuration

GitGuard offers granular control through JSON-based settings or the Status Bar configuration menu:

| Setting Key | Type | Description |
| :--- | :--- | :--- |
| `gitguard.branchRules` | `Array` | Mapping of branch regex patterns to HEX color codes. |
| `gitguard.storageMode` | `String` | Determines if configuration is stored globally or per-workspace. |
| `gitguard.autoPopulateCommit` | `Boolean` | Toggles automatic insertion into the Source Control input box. |
| `gitguard.autoDeleteMemosAfterCommit` | `Boolean` | Enables automatic cleanup of memos after a successful commit. |
| `gitguard.colorTargets` | `Array` | Defines which UI elements (Status Bar, Tab Bar, etc.) are colorized. |

## Professional Integrity
This extension is built for high-security environments. It prefers non-intrusive metadata storage and implements strict "Zero-File" intent to ensure no extension data is ever accidentally committed to your project repo.

## License
Licensed under the [MIT License](LICENSE.md).
