#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.pi/agent"

echo "==> Setting up Pi configuration..."

# 1. Install official Pi if not installed
if ! command -v pi >/dev/null 2>&1; then
  echo "==> Pi binary not found. Installing Pi..."
  curl -fsSL https://pi.dev/install.sh | sh
  # Add default pi node/bin to current PATH for remainder of script
  export PATH="${HOME}/.local/bin:${HOME}/.pi/agent/bin:${PATH}"
else
  echo "==> Pi is already installed."
fi

# 2. If running from outside ~/.pi/agent, link/copy files into target
if [ "$SCRIPT_DIR" != "$TARGET_DIR" ]; then
  echo "==> Syncing files to $TARGET_DIR..."
  mkdir -p "$TARGET_DIR"

  # Link extensions, themes, skills, prompts, and missions directories
  for dir in extensions themes skills prompts missions; do
    if [ -d "$SCRIPT_DIR/$dir" ]; then
      mkdir -p "$TARGET_DIR/$dir"
      cp -rn "$SCRIPT_DIR/$dir/"* "$TARGET_DIR/$dir/" 2>/dev/null || true
    fi
  done

  # Preserve workflows symlink if present
  if [ -e "$SCRIPT_DIR/workflows" ] && [ ! -e "$TARGET_DIR/workflows" ]; then
    cp -dn "$SCRIPT_DIR/workflows" "$TARGET_DIR/workflows" 2>/dev/null || true
  fi

  # Copy config files if missing or link
  for file in settings.json keybindings.json agent-modes.json open-tui.json token-saver.json tsconfig.json package.json package-lock.json; do
    if [ -f "$SCRIPT_DIR/$file" ]; then
      cp -n "$SCRIPT_DIR/$file" "$TARGET_DIR/$file" 2>/dev/null || true
    fi
  done
fi

# 3. Install extension npm dependencies
if [ -f "$TARGET_DIR/package.json" ]; then
  echo "==> Installing extension npm dependencies in $TARGET_DIR..."
  (cd "$TARGET_DIR" && npm install --omit=dev)
fi

# 4. Check auth.json
if [ ! -f "$TARGET_DIR/auth.json" ]; then
  if [ -f "$SCRIPT_DIR/auth.json.example" ]; then
    echo "==> Note: No auth.json found. Creating template at $TARGET_DIR/auth.json"
    cp "$SCRIPT_DIR/auth.json.example" "$TARGET_DIR/auth.json"
    chmod 600 "$TARGET_DIR/auth.json"
    echo "==> Remember to update $TARGET_DIR/auth.json with your API keys!"
  fi
fi

# 5. Create 'cerebrum' executable link and shell alias
echo "==> Setting up 'cerebrum' command..."
PI_BIN="${TARGET_DIR}/bin/pi"
if [ ! -x "$PI_BIN" ]; then
  PI_BIN="$(command -v pi || echo "${HOME}/.local/bin/pi")"
fi

CEREBRUM_LINK="${HOME}/.local/bin/cerebrum"
mkdir -p "$(dirname "$CEREBRUM_LINK")"
ln -sf "$PI_BIN" "$CEREBRUM_LINK"

# Ensure ~/.local/bin is in PATH and add alias to shell configs
SHELL_CONFIGS=()
[ -f "${HOME}/.bashrc" ] && SHELL_CONFIGS+=("${HOME}/.bashrc")
[ -f "${HOME}/.zshrc" ] && SHELL_CONFIGS+=("${HOME}/.zshrc")

for cfg in "${SHELL_CONFIGS[@]}"; do
  if ! grep -q 'PATH=.*\.local/bin' "$cfg" 2>/dev/null; then
    echo 'export PATH="${HOME}/.local/bin:${PATH}"' >> "$cfg"
  fi
  if ! grep -q 'alias cerebrum=' "$cfg" 2>/dev/null; then
    echo "alias cerebrum='pi'" >> "$cfg"
  fi
done

echo "==> Pi setup finished successfully!"
echo "==> If 'cerebrum' is not recognized in your current shell, reload your profile:"
echo "    source ~/.bashrc   # or source ~/.zshrc"
