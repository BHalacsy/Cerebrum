# Custom Pi Agent Configuration

Personal setup for [Pi](https://pi.dev) with custom extensions, themes, and keybindings.

## Included Extensions
- **ask-user**: Context gathering tool. Prompts user for input to questions during execution.
- **open-tui**: Custom full-screen TUI layout and widgets (Copied from open-tui extension on pi marketplace).
- **pi-natives**: Native utilities integration.
- **token-saver**: Headroom and caveman token optimization tool.
- **tool-manager**: Enable and disable agent tools dynamically.
- **websearch**: Custom web search integration (Searxng).

## Installation

### Quick Install (Recommended)
One-line fresh install (installs/updates Pi, cleans out any old custom agent files, and configures Cerebrum):
```bash
curl -fsSL https://raw.githubusercontent.com/BHalacsy/Cerebrum/main/install.sh | bash
```

### Method A: Direct Clone
```bash
git clone https://github.com/BHalacsy/Cerebrum.git ~/.pi/agent
cd ~/.pi/agent
./install.sh
```

### Method B: Separate Directory Clone
```bash
git clone https://github.com/BHalacsy/Cerebrum.git ~/pi-config
cd ~/pi-config
./install.sh
```

## Configure API Keys
Edit `~/.pi/agent/auth.json`:
```bash
chmod 600 ~/.pi/agent/auth.json
```
Fill in your provider API keys.
