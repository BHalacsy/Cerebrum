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

  # Sync extensions, themes, skills, and prompts directories
  for dir in extensions themes skills prompts; do
    if [ -d "$SCRIPT_DIR/$dir" ]; then
      mkdir -p "$TARGET_DIR/$dir"
      cp -r "$SCRIPT_DIR/$dir/"* "$TARGET_DIR/$dir/" 2>/dev/null || true
    fi
  done

  # Remove legacy/deprecated extensions if present
  rm -rf "$TARGET_DIR/extensions/context-viewer"

  # Ensure relative workflows symlink
  if [ -d "$TARGET_DIR/extensions/pi-subagents/workflows" ]; then
    (cd "$TARGET_DIR" && ln -sfn "extensions/pi-subagents/workflows" "workflows")
  fi

  # Copy config files (back up existing settings if different)
  for file in settings.json keybindings.json agent-modes.json token-saver.json tsconfig.json package.json package-lock.json; do
    if [ -f "$SCRIPT_DIR/$file" ]; then
      if [ -f "$TARGET_DIR/$file" ] && ! cmp -s "$SCRIPT_DIR/$file" "$TARGET_DIR/$file"; then
        cp "$TARGET_DIR/$file" "$TARGET_DIR/${file}.bak" 2>/dev/null || true
      fi
      cp -f "$SCRIPT_DIR/$file" "$TARGET_DIR/$file" 2>/dev/null || true
    fi
  done
fi

# 3. Install extension npm dependencies
if [ -f "$TARGET_DIR/package.json" ]; then
  echo "==> Installing extension npm dependencies in $TARGET_DIR..."
  (cd "$TARGET_DIR" && npm install --omit=dev)
fi

# Install dependencies for extensions with their own package.json (e.g. pi-subagents)
for ext_pkg in "$TARGET_DIR"/extensions/*/package.json; do
  if [ -f "$ext_pkg" ]; then
    ext_dir="$(dirname "$ext_pkg")"
    echo "==> Installing npm dependencies in $ext_dir..."
    (cd "$ext_dir" && npm install --omit=dev)
  fi
done

# Locate Pi binary
PI_BIN="${TARGET_DIR}/bin/pi"
if [ ! -x "$PI_BIN" ]; then
  PI_BIN="$(command -v pi || echo "${HOME}/.local/bin/pi")"
fi

# Reconcile Pi packages (pi-antigravity, pi-context-view, etc.)
if [ -x "$PI_BIN" ]; then
  echo "==> Reconciling Pi extension packages..."
  "$PI_BIN" update --extensions >/dev/null 2>&1 || true
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

echo "==> Cerebrum setup finished successfully!"
echo ""
echo "==> Quick Start:"
echo "    1. Reload your shell profile:"
echo "       source ~/.bashrc   # or source ~/.zshrc"
echo ""
echo "    2. Start Cerebrum:"
echo "       cerebrum   # or: pi"
echo ""
echo "    3. Authentication:"
echo "       - For Antigravity (Gemini 3.8 Flash high thinking default):"
echo "         Run '/login antigravity' inside Pi to sign in with Google OAuth."
echo "       - For OpenRouter:"
echo "         Add your API key to $TARGET_DIR/auth.json"
echo ""
