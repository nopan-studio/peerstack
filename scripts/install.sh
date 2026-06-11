#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_DIR="${HOME}/.local/share/peerstack"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/peerstack"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/peerstack"
BIN_DIR="${HOME}/.local/bin"

echo "Installing peerstack..."
echo "  repo:    $REPO_ROOT"
echo "  app:     $INSTALL_DIR"
echo "  config:  $CONFIG_DIR"
echo "  cache:   $CACHE_DIR"
echo "  bin:     $BIN_DIR/peerstack"

# Remove old install and copy fresh
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -R "$REPO_ROOT"/* "$INSTALL_DIR/"

# Create wrapper script that knows where peerstack lives
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/peerstack" <<EOF
#!/usr/bin/env bash
export PEERSTACK_ROOT="$INSTALL_DIR"
export PEERSTACK_CONFIG="$CONFIG_DIR"
export PEERSTACK_CACHE="$CACHE_DIR"
exec "\$PEERSTACK_ROOT/peerstack" "\$@"
EOF
chmod +x "$BIN_DIR/peerstack"

# Create XDG dirs
mkdir -p "$CONFIG_DIR"
mkdir -p "$CACHE_DIR"

echo ""
echo "peerstack installed. Make sure $BIN_DIR is in your PATH."
echo "  export PATH=\"$BIN_DIR:\$PATH\""
echo ""
echo "Usage:"
echo "  peerstack hub                       Start the hub"
echo "  peerstack spawn <agent> [dir]       Spawn an agent"
echo "  peerstack team [dir]                Spawn team in tmux panes"
echo "  peerstack list                      List agents"
