#!/bin/bash
#
# Annex Encoder Update Script
#
# Downloads and installs the latest encoder from the Annex server
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
ANNEX_HOME="${ANNEX_HOME:-/opt/annex-encoder}"
ANNEX_SERVER="${ANNEX_SERVER:-}"
BACKUP_DIR="${ANNEX_HOME}/backups"
FORCE_UPDATE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --server)
      ANNEX_SERVER="$2"
      shift 2
      ;;
    --home)
      ANNEX_HOME="$2"
      shift 2
      ;;
    --force|-f)
      FORCE_UPDATE=true
      shift
      ;;
    --help)
      echo "Annex Encoder Update Script"
      echo ""
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --server URL    Annex server URL (e.g., http://192.168.1.50:3000)"
      echo "  --home PATH     Encoder installation directory (default: /opt/annex-encoder)"
      echo "  --force, -f     Force update even if version matches"
      echo ""
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      exit 1
      ;;
  esac
done

# Get server from env file if not provided
if [[ -z "$ANNEX_SERVER" ]] && [[ -f /etc/annex-encoder.env ]]; then
  source /etc/annex-encoder.env
  # Extract HTTP URL from WebSocket URL
  if [[ -n "$ANNEX_SERVER_URL" ]]; then
    ANNEX_SERVER=$(echo "$ANNEX_SERVER_URL" | sed 's|^ws://|http://|' | sed 's|^wss://|https://|' | sed 's|/encoder$||')
  fi
fi

if [[ -z "$ANNEX_SERVER" ]]; then
  echo -e "${RED}Error: Server URL required. Use --server or set ANNEX_SERVER_URL in /etc/annex-encoder.env${NC}"
  exit 1
fi

echo -e "${BLUE}"
echo "================================="
echo "  Annex Encoder Update"
echo "================================="
echo -e "${NC}"
echo "Server: $ANNEX_SERVER"
echo "Install: $ANNEX_HOME"
echo ""

# Check if running as root or annex user
if [[ $EUID -ne 0 ]] && [[ "$(whoami)" != "annex" ]]; then
  echo -e "${RED}This script should be run as root or the annex user${NC}"
  exit 1
fi

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Download package info
echo -e "${BLUE}[1/5] Checking for updates...${NC}"
CURRENT_VERSION="unknown"
if [[ -f "$ANNEX_HOME/package.json" ]]; then
  CURRENT_VERSION=$(grep '"version"' "$ANNEX_HOME/package.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
fi

REMOTE_INFO=$(curl -sf "$ANNEX_SERVER/api/encoder/package/info" 2>/dev/null || echo '{}')
REMOTE_VERSION=$(echo "$REMOTE_INFO" | grep -o '"version":"[^"]*"' | head -1 | sed 's/"version":"\([^"]*\)"/\1/')

if [[ -z "$REMOTE_VERSION" ]]; then
  echo -e "${RED}Failed to fetch package info from server${NC}"
  exit 1
fi

echo "Current version: $CURRENT_VERSION"
echo "Available version: $REMOTE_VERSION"

if [[ "$CURRENT_VERSION" == "$REMOTE_VERSION" ]] && [[ "$FORCE_UPDATE" != "true" ]]; then
  echo -e "${GREEN}Already up to date!${NC}"
  echo "Use --force to reinstall anyway"
  exit 0
fi

if [[ "$FORCE_UPDATE" == "true" ]]; then
  echo -e "${YELLOW}Force update requested${NC}"
fi

# Stop service
echo -e "${BLUE}[2/5] Stopping encoder service...${NC}"
if systemctl is-active --quiet annex-encoder 2>/dev/null; then
  sudo systemctl stop annex-encoder
  echo "Service stopped"
else
  echo "Service not running"
fi

# Backup current installation
echo -e "${BLUE}[3/5] Backing up current installation...${NC}"
BACKUP_NAME="encoder-$CURRENT_VERSION-$(date +%Y%m%d-%H%M%S).tar.gz"
if [[ -f "$ANNEX_HOME/encoder.js" ]]; then
  tar -czf "$BACKUP_DIR/$BACKUP_NAME" -C "$ANNEX_HOME" encoder.js package.json 2>/dev/null || true
  echo "Backup saved: $BACKUP_DIR/$BACKUP_NAME"
else
  echo "No existing installation to backup"
fi

# Download and extract new version
echo -e "${BLUE}[4/5] Downloading version $REMOTE_VERSION...${NC}"
TEMP_DIR=$(mktemp -d)
curl -sf "$ANNEX_SERVER/api/encoder/package/download" -o "$TEMP_DIR/encoder.tar.gz"

if [[ ! -f "$TEMP_DIR/encoder.tar.gz" ]]; then
  echo -e "${RED}Download failed${NC}"
  rm -rf "$TEMP_DIR"
  exit 1
fi

# Extract
tar -xzf "$TEMP_DIR/encoder.tar.gz" -C "$TEMP_DIR"
cp "$TEMP_DIR/encoder.js" "$ANNEX_HOME/"
cp "$TEMP_DIR/encoder.js.map" "$ANNEX_HOME/" 2>/dev/null || true
cp "$TEMP_DIR/package.json" "$ANNEX_HOME/"
cp "$TEMP_DIR/update.sh" "$ANNEX_HOME/" 2>/dev/null || true
chmod +x "$ANNEX_HOME/encoder.js"
chmod +x "$ANNEX_HOME/update.sh" 2>/dev/null || true

# Cleanup
rm -rf "$TEMP_DIR"
echo "Installed version $REMOTE_VERSION"

# Restart service
echo -e "${BLUE}[5/5] Starting encoder service...${NC}"
sudo systemctl start annex-encoder
sleep 2

if systemctl is-active --quiet annex-encoder; then
  echo -e "${GREEN}Service started successfully${NC}"
else
  echo -e "${RED}Service failed to start. Check logs: journalctl -u annex-encoder -n 50${NC}"
  exit 1
fi

echo ""
echo -e "${GREEN}================================="
echo "  Update Complete!"
echo "================================="
echo -e "${NC}"
echo "Updated from $CURRENT_VERSION to $REMOTE_VERSION"
echo ""
