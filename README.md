# Custom Pi Agent Configuration

Personal setup for [Pi](https://pi.dev) with custom extensions, themes, modes, and keybindings.

## Included Extensions
- **agent-modes**: Switch agent modes and security constraints.
- **ask-user**: Interactive user prompts during tool execution.
- **context-viewer**: View and inspect context and tokens.
- **open-tui**: Custom full-screen TUI layout and widgets.
- **pi-natives**: Native utilities integration.
- **token-saver**: Headroom and token optimization tool.
- **tool-manager**: Enable and disable agent tools dynamically.
- **websearch**: Custom web search integration.

## Installation

### Method A: Direct Clone (Recommended for new machine)
```bash
git clone <your-repo-url> ~/.pi/agent
cd ~/.pi/agent
./install.sh
```

### Method B: Separate Directory Clone
```bash
git clone <your-repo-url> ~/pi-config
cd ~/pi-config
./install.sh
```

## Configure API Keys
Edit `~/.pi/agent/auth.json`:
```bash
chmod 600 ~/.pi/agent/auth.json
```
Fill in your provider API keys.
