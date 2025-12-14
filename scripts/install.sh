#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║                                                               ║"
echo "║     █████╗ ███╗   ██╗███╗   ██╗███████╗██╗  ██╗               ║"
echo "║    ██╔══██╗████╗  ██║████╗  ██║██╔════╝╚██╗██╔╝               ║"
echo "║    ███████║██╔██╗ ██║██╔██╗ ██║█████╗   ╚███╔╝                ║"
echo "║    ██╔══██║██║╚██╗██║██║╚██╗██║██╔══╝   ██╔██╗                ║"
echo "║    ██║  ██║██║ ╚████║██║ ╚████║███████╗██╔╝ ██╗               ║"
echo "║    ╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝               ║"
echo "║                                                               ║"
echo "║    Ubuntu Installation Script                                 ║"
echo "║                                                               ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo -e "${RED}Please do not run this script as root.${NC}"
    echo "Run as a regular user with sudo privileges."
    exit 1
fi

# Check Ubuntu version
if [ -f /etc/os-release ]; then
    . /etc/os-release
    if [ "$ID" != "ubuntu" ]; then
        echo -e "${YELLOW}Warning: This script is designed for Ubuntu. Detected: $ID${NC}"
        read -p "Continue anyway? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
fi

echo -e "${GREEN}[1/6] Updating system packages...${NC}"
sudo apt-get update
sudo apt-get upgrade -y

echo -e "${GREEN}[2/6] Installing Docker...${NC}"
if ! command -v docker &> /dev/null; then
    # Install Docker using official script
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    rm get-docker.sh

    # Add current user to docker group
    sudo usermod -aG docker $USER
    echo -e "${YELLOW}Note: You may need to log out and back in for docker group to take effect.${NC}"
else
    echo "Docker is already installed."
fi

echo -e "${GREEN}[3/6] Installing Docker Compose...${NC}"
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    sudo apt-get install -y docker-compose-plugin
else
    echo "Docker Compose is already installed."
fi

echo -e "${GREEN}[4/6] Installing FFmpeg (for AV1 encoding)...${NC}"
if ! command -v ffmpeg &> /dev/null; then
    sudo apt-get install -y ffmpeg
else
    echo "FFmpeg is already installed."
fi

echo -e "${GREEN}[5/6] Creating directory structure...${NC}"
ANNEX_DIR="${ANNEX_DIR:-/opt/annex}"
sudo mkdir -p "$ANNEX_DIR"
sudo chown $USER:$USER "$ANNEX_DIR"

mkdir -p "$ANNEX_DIR/data"
mkdir -p "$ANNEX_DIR/downloads"
mkdir -p "$ANNEX_DIR/encoded"

echo -e "${GREEN}[6/6] Setting up configuration...${NC}"
if [ ! -f "$ANNEX_DIR/.env" ]; then
    cat > "$ANNEX_DIR/.env" << 'EOF'
# Annex Configuration
# Edit this file with your settings

# TMDB API Key (required for movie/TV discovery)
# Get one at: https://www.themoviedb.org/settings/api
TMDB_API_KEY=

# qBittorrent settings
QBITTORRENT_URL=http://qbittorrent:8080
QBITTORRENT_USERNAME=admin
QBITTORRENT_PASSWORD=adminadmin

# Paths
DOWNLOADS_PATH=./downloads
ENCODED_PATH=./encoded

# Timezone
TZ=UTC
EOF
    echo -e "${YELLOW}Created .env file at $ANNEX_DIR/.env${NC}"
    echo -e "${YELLOW}Please edit this file to add your TMDB API key and configure settings.${NC}"
else
    echo ".env file already exists, skipping."
fi

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}Installation complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. Edit the configuration file:"
echo "     ${BLUE}nano $ANNEX_DIR/.env${NC}"
echo ""
echo "  2. Copy docker-compose.yml to the install directory:"
echo "     ${BLUE}cp docker-compose.yml $ANNEX_DIR/${NC}"
echo ""
echo "  3. Start Annex:"
echo "     ${BLUE}cd $ANNEX_DIR && docker compose up -d${NC}"
echo ""
echo "  4. Access the web UI at:"
echo "     ${BLUE}http://localhost:3000${NC}"
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
