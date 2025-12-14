#!/bin/bash
#
# Annex Remote Encoder Setup Script
#
# Sets up a fresh Ubuntu 24.04 installation to run as a remote encoder.
# Downloads the encoder package from the Annex server for easy updates.
#
# Usage:
#   curl -fsSL http://annex-server:3000/deploy-encoder | sudo bash -s -- \
#     --server ws://annex-server:3000/encoder \
#     --encoder-id encoder-vm-1 \
#     --nfs-server 192.168.1.100:/mnt/downloads
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Default values
ANNEX_USER="annex"
ANNEX_HOME="/opt/annex-encoder"
ANNEX_SERVER_URL=""
ANNEX_ENCODER_ID=""
ANNEX_NFS_SERVER=""
ANNEX_NFS_MOUNT="/mnt/downloads"
ANNEX_GPU_DEVICE="/dev/dri/renderD128"
ANNEX_MAX_CONCURRENT=1
ANNEX_YES=false
ANNEX_SKIP_GPU_DRIVERS=false
NODE_VERSION="20"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --server)
      ANNEX_SERVER_URL="$2"
      shift 2
      ;;
    --encoder-id)
      ANNEX_ENCODER_ID="$2"
      shift 2
      ;;
    --nfs-server)
      ANNEX_NFS_SERVER="$2"
      shift 2
      ;;
    --nfs-mount)
      ANNEX_NFS_MOUNT="$2"
      shift 2
      ;;
    --gpu-device)
      ANNEX_GPU_DEVICE="$2"
      shift 2
      ;;
    --max-concurrent)
      ANNEX_MAX_CONCURRENT="$2"
      shift 2
      ;;
    --user)
      ANNEX_USER="$2"
      shift 2
      ;;
    --yes|-y)
      ANNEX_YES=true
      shift
      ;;
    --skip-gpu-drivers)
      ANNEX_SKIP_GPU_DRIVERS=true
      shift
      ;;
    --help)
      echo "Annex Remote Encoder Setup Script"
      echo ""
      echo "Usage: $0 [options]"
      echo ""
      echo "Required options:"
      echo "  --server URL         Annex server WebSocket URL (e.g., ws://192.168.1.50:3000/encoder)"
      echo "  --encoder-id ID      Unique identifier for this encoder (e.g., encoder-vm-1)"
      echo ""
      echo "Optional:"
      echo "  --nfs-server HOST:PATH   NFS server and export path for media files"
      echo "  --nfs-mount PATH         Local mount point for NFS (default: /mnt/downloads)"
      echo "  --gpu-device PATH        GPU device path (default: /dev/dri/renderD128)"
      echo "  --max-concurrent N       Max concurrent encoding jobs (default: 1)"
      echo "  --user USERNAME          System user to create (default: annex)"
      echo "  --yes, -y                Skip confirmation prompts"
      echo "  --skip-gpu-drivers       Skip Intel GPU driver installation"
      echo ""
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      exit 1
      ;;
  esac
done

# Validate required arguments
if [[ -z "$ANNEX_SERVER_URL" ]]; then
  echo -e "${RED}Error: --server is required${NC}"
  exit 1
fi

if [[ -z "$ANNEX_ENCODER_ID" ]]; then
  echo -e "${RED}Error: --encoder-id is required${NC}"
  exit 1
fi

# Check root
if [[ $EUID -ne 0 ]]; then
  echo -e "${RED}This script must be run as root (use sudo)${NC}"
  exit 1
fi

# Extract HTTP URL from WebSocket URL for package downloads
ANNEX_HTTP_URL=$(echo "$ANNEX_SERVER_URL" | sed 's|^ws://|http://|' | sed 's|^wss://|https://|' | sed 's|/encoder$||')

echo -e "${BLUE}"
echo "=============================================="
echo "     Annex Remote Encoder Setup"
echo "=============================================="
echo -e "${NC}"
echo ""
echo "Configuration:"
echo "  Server URL:      $ANNEX_SERVER_URL"
echo "  HTTP URL:        $ANNEX_HTTP_URL"
echo "  Encoder ID:      $ANNEX_ENCODER_ID"
echo "  GPU Device:      $ANNEX_GPU_DEVICE"
echo "  Max Concurrent:  $ANNEX_MAX_CONCURRENT"
echo "  NFS Server:      ${ANNEX_NFS_SERVER:-"(not configured)"}"
echo "  NFS Mount:       $ANNEX_NFS_MOUNT"
echo ""

# Confirm
if [[ "$ANNEX_YES" != "true" ]] && [[ -t 0 ]]; then
  read -p "Continue with installation? [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Installation cancelled."
    exit 0
  fi
fi

# =============================================================================
# Step 1: System Updates
# =============================================================================

echo ""
echo -e "${BLUE}[1/7] Updating system packages...${NC}"
apt-get update
apt-get upgrade -y

# =============================================================================
# Step 2: Install Intel GPU Drivers
# =============================================================================

echo ""
if [[ "$ANNEX_SKIP_GPU_DRIVERS" == "true" ]]; then
  echo -e "${YELLOW}[2/7] Skipping Intel GPU drivers (--skip-gpu-drivers)${NC}"
else
  echo -e "${BLUE}[2/7] Installing Intel GPU drivers...${NC}"

  # Add Intel graphics repository
  wget -qO - https://repositories.intel.com/gpu/intel-graphics.key | \
    gpg --yes --dearmor --output /usr/share/keyrings/intel-graphics.gpg

  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/intel-graphics.gpg] https://repositories.intel.com/gpu/ubuntu noble unified" | \
    tee /etc/apt/sources.list.d/intel-gpu-noble.list

  apt-get update

  apt-get install -y \
    intel-opencl-icd \
    intel-level-zero-gpu \
    level-zero \
    intel-media-va-driver-non-free \
    libmfx1 \
    libmfxgen1 \
    libvpl2 \
    libegl-mesa0 \
    libegl1-mesa \
    libegl1-mesa-dev \
    libgbm1 \
    libgl1-mesa-dev \
    libgl1-mesa-dri \
    libglapi-mesa \
    libgles2-mesa-dev \
    libglx-mesa0 \
    libigdgmm12 \
    libxatracker2 \
    mesa-va-drivers \
    mesa-vdpau-drivers \
    mesa-vulkan-drivers \
    va-driver-all \
    vainfo \
    hwinfo
fi

# =============================================================================
# Step 3: Install FFmpeg
# =============================================================================

echo ""
echo -e "${BLUE}[3/7] Installing FFmpeg with VAAPI support...${NC}"

apt-get install -y \
  ffmpeg \
  libavcodec-extra \
  libva-dev \
  libva-drm2 \
  libva-x11-2

# =============================================================================
# Step 4: Install Node.js
# =============================================================================

echo ""
echo -e "${BLUE}[4/7] Installing Node.js ${NODE_VERSION}...${NC}"

curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
apt-get install -y nodejs

echo "Node.js version: $(node --version)"

# =============================================================================
# Step 5: Create User and Directories
# =============================================================================

echo ""
echo -e "${BLUE}[5/7] Creating user and directories...${NC}"

# Create user
if ! id "$ANNEX_USER" &>/dev/null; then
  useradd -r -m -d "/home/$ANNEX_USER" -s /bin/bash "$ANNEX_USER"
  echo "Created user: $ANNEX_USER"
else
  echo "User $ANNEX_USER already exists"
fi

# Add to video and render groups
usermod -aG video "$ANNEX_USER"
usermod -aG render "$ANNEX_USER"

# Create directories
mkdir -p "$ANNEX_HOME"
mkdir -p "$ANNEX_HOME/backups"
mkdir -p "$ANNEX_NFS_MOUNT"
chown -R "$ANNEX_USER:$ANNEX_USER" "$ANNEX_HOME"

# =============================================================================
# Step 6: Configure NFS
# =============================================================================

echo ""
echo -e "${BLUE}[6/7] Configuring NFS mount...${NC}"

if [[ -n "$ANNEX_NFS_SERVER" ]]; then
  apt-get install -y nfs-common

  if ! grep -q "$ANNEX_NFS_SERVER" /etc/fstab; then
    echo "$ANNEX_NFS_SERVER $ANNEX_NFS_MOUNT nfs defaults,_netdev,nofail 0 0" >> /etc/fstab
    echo "Added NFS mount to /etc/fstab"
  fi

  mount -a || echo -e "${YELLOW}Warning: Could not mount NFS share.${NC}"
else
  echo "NFS not configured - skipping"
fi

# =============================================================================
# Step 7: Download and Install Encoder Package
# =============================================================================

echo ""
echo -e "${BLUE}[7/7] Downloading encoder package from server...${NC}"

# Check if server is reachable
if ! curl -sf "$ANNEX_HTTP_URL/api/encoder/package/info" >/dev/null 2>&1; then
  echo -e "${RED}Error: Cannot reach Annex server at $ANNEX_HTTP_URL${NC}"
  echo "Make sure the server is running and the encoder package is built:"
  echo "  pnpm --filter @annex/encoder build:dist"
  exit 1
fi

# Get package info
PACKAGE_INFO=$(curl -sf "$ANNEX_HTTP_URL/api/encoder/package/info")
PACKAGE_VERSION=$(echo "$PACKAGE_INFO" | grep -o '"version":"[^"]*"' | sed 's/"version":"//;s/"//')
echo "Available encoder version: $PACKAGE_VERSION"

# Download and extract
TEMP_DIR=$(mktemp -d)
echo "Downloading encoder package..."
curl -sf "$ANNEX_HTTP_URL/api/encoder/package/download" -o "$TEMP_DIR/encoder.tar.gz"

if [[ ! -f "$TEMP_DIR/encoder.tar.gz" ]]; then
  echo -e "${RED}Failed to download encoder package${NC}"
  rm -rf "$TEMP_DIR"
  exit 1
fi

# Extract to install directory
tar -xzf "$TEMP_DIR/encoder.tar.gz" -C "$ANNEX_HOME"
chmod +x "$ANNEX_HOME/encoder.js"
chown -R "$ANNEX_USER:$ANNEX_USER" "$ANNEX_HOME"
rm -rf "$TEMP_DIR"

echo "Installed encoder version $PACKAGE_VERSION"

# =============================================================================
# Create Environment and Service Files
# =============================================================================

echo ""
echo -e "${BLUE}Creating configuration files...${NC}"

# Environment file
cat > /etc/annex-encoder.env << ENVFILE
ANNEX_SERVER_URL=$ANNEX_SERVER_URL
ANNEX_ENCODER_ID=$ANNEX_ENCODER_ID
ANNEX_GPU_DEVICE=$ANNEX_GPU_DEVICE
ANNEX_MAX_CONCURRENT=$ANNEX_MAX_CONCURRENT
ANNEX_NFS_BASE_PATH=$ANNEX_NFS_MOUNT
ANNEX_LOG_LEVEL=info
ENVFILE

chmod 600 /etc/annex-encoder.env

# Systemd service
cat > /etc/systemd/system/annex-encoder.service << SYSTEMD
[Unit]
Description=Annex Remote Encoder
After=network-online.target nfs-client.target
Wants=network-online.target

[Service]
Type=simple
User=$ANNEX_USER
Group=$ANNEX_USER
WorkingDirectory=$ANNEX_HOME
EnvironmentFile=/etc/annex-encoder.env
ExecStart=/usr/bin/node $ANNEX_HOME/encoder.js
Restart=always
RestartSec=10

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$ANNEX_NFS_MOUNT
PrivateTmp=true

# GPU access
SupplementaryGroups=video render

[Install]
WantedBy=multi-user.target
SYSTEMD

systemctl daemon-reload
systemctl enable annex-encoder.service

# =============================================================================
# Verify Installation
# =============================================================================

echo ""
echo -e "${BLUE}Verifying installation...${NC}"

echo -n "  GPU access: "
if sudo -u "$ANNEX_USER" test -r "$ANNEX_GPU_DEVICE" -a -w "$ANNEX_GPU_DEVICE"; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${YELLOW}WARNING${NC}"
fi

echo -n "  VAAPI drivers: "
if vainfo --display drm --device "$ANNEX_GPU_DEVICE" &>/dev/null; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${YELLOW}WARNING${NC}"
fi

echo -n "  FFmpeg: "
if ffmpeg -version &>/dev/null; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${RED}FAILED${NC}"
fi

echo -n "  Node.js: "
if node --version &>/dev/null; then
  echo -e "${GREEN}OK ($(node --version))${NC}"
else
  echo -e "${RED}FAILED${NC}"
fi

echo -n "  Encoder: "
if [[ -f "$ANNEX_HOME/encoder.js" ]]; then
  echo -e "${GREEN}OK (v$PACKAGE_VERSION)${NC}"
else
  echo -e "${RED}FAILED${NC}"
fi

if [[ -n "$ANNEX_NFS_SERVER" ]]; then
  echo -n "  NFS mount: "
  if mountpoint -q "$ANNEX_NFS_MOUNT"; then
    echo -e "${GREEN}OK${NC}"
  else
    echo -e "${YELLOW}NOT MOUNTED${NC}"
  fi
fi

# =============================================================================
# Done
# =============================================================================

echo ""
echo -e "${GREEN}=============================================="
echo "     Installation Complete!"
echo "==============================================${NC}"
echo ""
echo "Commands:"
echo "  Start:   sudo systemctl start annex-encoder"
echo "  Stop:    sudo systemctl stop annex-encoder"
echo "  Status:  sudo systemctl status annex-encoder"
echo "  Logs:    sudo journalctl -u annex-encoder -f"
echo "  Update:  sudo $ANNEX_HOME/update.sh"
echo ""
echo "Configuration: /etc/annex-encoder.env"
echo ""

# Start service
if [[ "$ANNEX_YES" == "true" ]] || [[ ! -t 0 ]]; then
  echo "Starting encoder service..."
  systemctl start annex-encoder
  sleep 2
  systemctl status annex-encoder --no-pager || true
else
  read -p "Start the encoder service now? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    systemctl start annex-encoder
    sleep 2
    systemctl status annex-encoder --no-pager || true
  fi
fi
