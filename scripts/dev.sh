#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}Starting Annex development environment...${NC}"

# Check if pnpm is installed
if ! command -v pnpm &> /dev/null; then
    echo "pnpm is not installed. Installing..."
    npm install -g pnpm
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo -e "${GREEN}Installing dependencies...${NC}"
    pnpm install
fi

# Run database migrations
echo -e "${GREEN}Running database migrations...${NC}"
cd packages/server
pnpm db:generate || true
pnpm db:migrate || true
cd ../..

# Start development servers
echo -e "${GREEN}Starting development servers...${NC}"
pnpm dev
