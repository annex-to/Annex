/**
 * Help Command
 *
 * Displays CLI usage information.
 */

import { VERSION } from "../version.js";

export function help(): void {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║    ██████╗███╗   ██╗ ██████╗ ██████╗ ██████╗ ███████╗██████╗  ║
║   ██╔════╝████╗  ██║██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔══██╗ ║
║   █████╗  ██╔██╗ ██║██║     ██║   ██║██║  ██║█████╗  ██████╔╝ ║
║   ██╔══╝  ██║╚██╗██║██║     ██║   ██║██║  ██║██╔══╝  ██╔══██╗ ║
║   ███████╗██║ ╚████║╚██████╗╚██████╔╝██████╔╝███████╗██║  ██║ ║
║   ╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝ ║
║                                                               ║
║    Annex Remote Encoder v${VERSION.padEnd(38)}║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝

Remote AV1 encoding service for Annex media platform.

USAGE:
  annex-encoder [COMMAND] [OPTIONS]

COMMANDS:
  (none)           Run the encoder (default)
  --help, -h       Show this help message
  --version, -v    Show version information
  --update         Update encoder from server
  --setup          Generate service files

UPDATE OPTIONS:
  --server URL     Specify server URL (default: from config)
  --force, -f      Force update even if same version

SETUP OPTIONS:
  --install        Generate and install service (requires admin/root)
  --user USER      Specify service user (Linux only, default: annex)
  --work-dir PATH  Specify working directory (default: /opt/annex-encoder)

ENVIRONMENT VARIABLES:
  ANNEX_SERVER_URL        WebSocket URL (ws://server:3000/encoder)
  ANNEX_ENCODER_ID        Unique encoder ID
  ANNEX_GPU_DEVICE        GPU device path (default: /dev/dri/renderD128)
  ANNEX_MAX_CONCURRENT    Max concurrent jobs (default: 1)
  ANNEX_NFS_BASE_PATH     NFS mount base path (default: /mnt/downloads)
  ANNEX_LOG_LEVEL         Log level (debug/info/warn/error, default: info)

EXAMPLES:
  annex-encoder                    # Run encoder
  annex-encoder --version          # Show version
  annex-encoder --update           # Update from configured server
  annex-encoder --setup            # Generate service files
  annex-encoder --setup --install  # Generate and install service

For more information, visit: https://github.com/annex-to/annex
`);
}
