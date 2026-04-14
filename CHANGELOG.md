# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-04-14

### Added
- **Branch Pinning**: Memos can now be pinned to specific branches or set as Global items.
- **Unified UI Sync**: Instant synchronization between sidebar, commit input box, and status bar upon branch checkout.
- **Advanced Sidebar Controls**: Inline actions for Editing, Reordering (Up/Down), Pinning, and Deleting memos.
- **Git Repair Utility**: Command to untrack configuration files and fix branch checkout conflicts.
- **Auto-Delete Setting**: Customizable configuration to purge memos after a successful auto-commit.
- **Security Logic**: Strict Crimson Red color enforcement for critical branches (`main`, `master`, `prod`).

### Changed
- **Robust Branch Detection**: Implemented retry logic for capturing branch state during high-speed workflows.
- **Professional Branding**: Standardized iconography and removed all emoji indicators for a high-end feel.
- **UI Consolidation**: Grouped all management actions into a single inline hover area in the sidebar.

### Fixed
- **Sync Lag**: Resolved issues where the sidebar didn't update immediately after git checkout.
- **Global Settings Leakage**: Enforced workspace-level isolation to prevent color changes from affecting other VS Code windows.
- **Race conditions**: Fixed branch detection failures during rapid memo creation.

## [0.0.1] - 2026-04-14
### Added
- Initial release of GitGuard & Memo.
- Visual branch protection with dynamic workspace colorization.
- Persistent Commit Memos for snippet tracking and auto-staging.
