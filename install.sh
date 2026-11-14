#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${HOME}/.pi/agent"
REPO_URL="https://github.com/BHalacsy/Cerebrum.git"
CLEANUP_TMP_DIR=""

cleanup() {
  if [ -n "$CLEANUP_TMP_DIR" ] && [ -d "$CLEANUP_TMP_DIR" ]; then
    rm -rf "$CLEANUP_TMP_DIR"
  fi
}
trap cleanup EXIT

echo "==> Setting up Pi configuration..."

# 0. Detect source directory or download repo if run standalone/via curl
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  CANDIDATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -d "$CANDIDATE_DIR/extensions" ] && [ -f "$CANDIDATE_DIR/package.json" ]; then
    SCRIPT_DIR="$CANDIDATE_DIR"
  fi
fi

if [ -z "$SCRIPT_DIR" ]; then
  echo "==> Standalone installer run detected. Fetching latest Cerebrum repository..."
  TMP_REPO="$(mktemp -d)"
  CLEANUP_TMP_DIR="$TMP_REPO"
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 "$REPO_URL" "$TMP_REPO" >/dev/null 2>&1
  else
    curl -fsSL "https://github.com/BHalacsy/Cerebrum/archive/refs/heads/main.tar.gz" | tar -xz -C "$TMP_REPO" --strip-components=1
  fi
  SCRIPT_DIR="$TMP_REPO"
fi

# Ensure ~/.local/bin and ~/.pi/agent/bin are in PATH for this session
export PATH="${HOME}/.local/bin:${TARGET_DIR}/bin:${PATH}"

# 1. Install official Pi if not installed, or update it if already installed
if ! command -v pi >/dev/null 2>&1; then
  echo "==> Pi binary not found. Installing Pi..."
  curl -fsSL https://pi.dev/install.sh | sh
  export PATH="${HOME}/.local/bin:${TARGET_DIR}/bin:${PATH}"
else
  echo "==> Pi is already installed. Updating Pi to latest version..."
  pi update || true
fi

# Locate Pi binary
PI_BIN="${TARGET_DIR}/bin/pi"
if [ ! -x "$PI_BIN" ]; then
  PI_BIN="$(command -v pi || echo "${HOME}/.local/bin/pi")"
fi

# 2. Fresh install of custom agent into ~/.pi/agent
if [ "$SCRIPT_DIR" != "$TARGET_DIR" ]; then
  echo "==> Removing old custom agent files in $TARGET_DIR..."
  mkdir -p "$TARGET_DIR"

  # Remove old custom agent directories and obsolete files for a clean install
  rm -rf "$TARGET_DIR/extensions"
  rm -rf "$TARGET_DIR/themes"
  rm -rf "$TARGET_DIR/skills"
  rm -rf "$TARGET_DIR/prompts"
  rm -rf "$TARGET_DIR/node_modules"
  rm -rf "$TARGET_DIR/workflows"
  rm -f "$TARGET_DIR/agent-modes.json" "$TARGET_DIR/open-tui.json"

  echo "==> Installing fresh custom agent files into $TARGET_DIR..."
  for dir in extensions themes skills prompts; do
    if [ -d "$SCRIPT_DIR/$dir" ]; then
      cp -r "$SCRIPT_DIR/$dir" "$TARGET_DIR/"
    else
      mkdir -p "$TARGET_DIR/$dir"
    fi
  done

  # Copy config files (back up existing settings if different)
  for file in settings.json keybindings.json token-saver.json tsconfig.json package.json package-lock.json; do
    if [ -f "$SCRIPT_DIR/$file" ]; then
      if [ -f "$TARGET_DIR/$file" ] && ! cmp -s "$SCRIPT_DIR/$file" "$TARGET_DIR/$file"; then
        cp "$TARGET_DIR/$file" "$TARGET_DIR/${file}.bak" 2>/dev/null || true
      fi
      cp -f "$SCRIPT_DIR/$file" "$TARGET_DIR/$file"
    fi
  done
else
  echo "==> Running inside $TARGET_DIR; cleaning old custom agent artifacts..."
  # Clean known deprecated files
  rm -rf "$TARGET_DIR/extensions/context-viewer" "$TARGET_DIR/extensions/pi-subagents" "$TARGET_DIR/workflows"
  rm -f "$TARGET_DIR/agent-modes.json" "$TARGET_DIR/open-tui.json"
  rm -rf "$TARGET_DIR/skills/pi-subagents"
  rm -f "$TARGET_DIR/prompts/parallel-research.md" "$TARGET_DIR/prompts/parallel-review.md" "$TARGET_DIR/prompts/review-loop.md"

  # Clean untracked files in custom agent directories if git repo
  if [ -d "$TARGET_DIR/.git" ]; then
    git -C "$TARGET_DIR" clean -fd extensions themes skills prompts 2>/dev/null || true
  fi

  # Clean stale node_modules for a fresh install
  rm -rf "$TARGET_DIR/node_modules"
  mkdir -p "$TARGET_DIR/skills" "$TARGET_DIR/prompts"
fi

# 3. Install extension npm dependencies freshly
if [ -f "$TARGET_DIR/package.json" ]; then
  echo "==> Installing extension npm dependencies in $TARGET_DIR..."
  (cd "$TARGET_DIR" && npm install --omit=dev)
fi

# Install dependencies for extensions with their own package.json
for ext_pkg in "$TARGET_DIR"/extensions/*/package.json; do
  if [ -f "$ext_pkg" ]; then
    ext_dir="$(dirname "$ext_pkg")"
    echo "==> Installing npm dependencies in $ext_dir..."
    (cd "$ext_dir" && rm -rf node_modules && npm install --omit=dev)
  fi
done

# Synchronize tsconfig.json paths with current Pi release if available
if [ -f "$TARGET_DIR/install/current-version" ] && [ -f "$TARGET_DIR/tsconfig.json" ]; then
  CURRENT_PI_VER="$(tr -d '[:space:]' < "$TARGET_DIR/install/current-version")"
  if [ -n "$CURRENT_PI_VER" ] && [ -d "$TARGET_DIR/install/releases/$CURRENT_PI_VER" ]; then
    sed -i "s|\./install/releases/[^/]*/|./install/releases/${CURRENT_PI_VER}/|g" "$TARGET_DIR/tsconfig.json"
  fi
fi

# Reconcile Pi packages (pi-antigravity, pi-context-view, etc.)
if [ -x "$PI_BIN" ]; then
  echo "==> Reconciling Pi extension packages..."
  "$PI_BIN" update --extensions || true
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
CEREBRUM_LINK="${HOME}/.local/bin/cerebrum"
mkdir -p "$(dirname "$CEREBRUM_LINK")"
if [ -x "$PI_BIN" ]; then
  ln -sf "$PI_BIN" "$CEREBRUM_LINK"
fi

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
