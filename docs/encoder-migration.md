# Encoder Migration Guide (Ubuntu)

This guide walks through migrating from the old Bun-based encoder installation to the new standalone binary encoder.

## Overview

The old encoder installation used:
- Bun runtime with `encoder.js`
- Installation at `/opt/annex-encoder`
- Service running `bun encoder.js`
- Configuration in `/etc/annex-encoder.env`

The new encoder uses:
- Standalone compiled binary (no Bun runtime required)
- Installation at `/usr/local/bin/annex-encoder`
- Service running the binary directly
- Same configuration file location

## Migration Steps

### 1. Backup Current Configuration

First, save your current configuration so you can migrate it:

```bash
# View current configuration
sudo cat /etc/annex-encoder.env

# Create a backup
sudo cp /etc/annex-encoder.env /tmp/annex-encoder.env.backup
```

Make note of these values:
- `ANNEX_SERVER_URL`
- `ANNEX_ENCODER_ID`
- `ANNEX_GPU_DEVICE`
- `ANNEX_NFS_BASE_PATH`

### 2. Stop and Disable Old Service

```bash
# Stop the service
sudo systemctl stop annex-encoder

# Disable it from starting on boot
sudo systemctl disable annex-encoder

# Verify it's stopped
sudo systemctl status annex-encoder
```

### 3. Remove Old Service Files

```bash
# Remove systemd service file
sudo rm /etc/systemd/system/annex-encoder.service

# Reload systemd to remove the service
sudo systemctl daemon-reload

# Verify service is gone
systemctl list-units --all | grep annex-encoder
```

### 4. Remove Old Installation

```bash
# Remove the old installation directory
sudo rm -rf /opt/annex-encoder

# Remove old Bun installation (optional, only if Bun is not used for other purposes)
# sudo rm -rf /root/.bun
# sudo rm /usr/local/bin/bun
```

### 5. Clean Up Old Configuration (Optional)

You can remove the old config file since we'll recreate it, or keep it for reference:

```bash
# Option A: Remove it (we'll recreate it)
sudo rm /etc/annex-encoder.env

# Option B: Keep it as backup (recommended)
sudo mv /etc/annex-encoder.env /etc/annex-encoder.env.old
```

### 6. Download New Encoder Binary

```bash
# Download the latest binary
curl -L https://github.com/WeHaveNoEyes/Annex/releases/latest/download/annex-encoder-linux-x64 -o annex-encoder

# Make it executable
chmod +x annex-encoder

# Move to system binary location
sudo mv annex-encoder /usr/local/bin/annex-encoder

# Verify installation
annex-encoder --version
```

### 7. Generate New Service Files

The new encoder can automatically generate its service files:

```bash
# Generate and install service (creates /etc/systemd/system/annex-encoder.service)
sudo annex-encoder --setup --install
```

This creates:
- Service file: `/etc/systemd/system/annex-encoder.service`
- Environment file: `/etc/annex-encoder.env` (with defaults)

### 8. Configure the Encoder

Edit the configuration file with your backed-up values:

```bash
sudo nano /etc/annex-encoder.env
```

Set these values from your backup:

```bash
ANNEX_SERVER_URL=ws://YOUR_SERVER:3000/encoder
ANNEX_ENCODER_ID=your-encoder-id
ANNEX_GPU_DEVICE=/dev/dri/renderD128
ANNEX_NFS_BASE_PATH=/mnt/downloads
ANNEX_LOG_LEVEL=info
ANNEX_MAX_CONCURRENT=1
```

Save and exit (Ctrl+O, Enter, Ctrl+X).

### 9. Start New Service

```bash
# Start the service
sudo systemctl start annex-encoder

# Check status
sudo systemctl status annex-encoder

# View logs
sudo journalctl -u annex-encoder -f
```

### 10. Verify Operation

Check that the encoder connects to your Annex server:

```bash
# Watch logs for successful connection
sudo journalctl -u annex-encoder -n 50

# You should see:
# - "Connected to Annex server"
# - "Registered as encoder: your-encoder-id"
```

In the Annex web UI, go to Settings > Encoders and verify your encoder appears as online.

## Troubleshooting

### Service won't start

Check the logs:
```bash
sudo journalctl -u annex-encoder -n 100 --no-pager
```

Common issues:
- **Permission denied on GPU**: Add user to video/render groups (already done by --setup --install)
- **Cannot connect to server**: Check `ANNEX_SERVER_URL` is correct
- **NFS mount not found**: Verify `ANNEX_NFS_BASE_PATH` is correct and mounted

### GPU not detected

Verify GPU access:
```bash
# Check GPU device exists
ls -la /dev/dri/renderD*

# Test VAAPI
vainfo --display drm --device /dev/dri/renderD128
```

### Encoder not appearing in UI

1. Check encoder is running: `sudo systemctl status annex-encoder`
2. Verify WebSocket connection in logs: `sudo journalctl -u annex-encoder -f`
3. Check firewall allows outbound WebSocket connections
4. Verify server URL is reachable: `curl -v http://YOUR_SERVER:3000/health`

## Rolling Back

If you need to roll back to the old encoder:

1. Stop new service: `sudo systemctl stop annex-encoder`
2. Remove new binary: `sudo rm /usr/local/bin/annex-encoder`
3. Restore old config: `sudo cp /tmp/annex-encoder.env.backup /etc/annex-encoder.env`
4. Follow original installation instructions from `scripts/setup-remote-encoder.sh`

## Cleanup After Successful Migration

Once you've verified the new encoder works correctly for a few days:

```bash
# Remove old backups
sudo rm /tmp/annex-encoder.env.backup
sudo rm /etc/annex-encoder.env.old  # if you kept it

# Remove old Bun installation (if not used elsewhere)
sudo rm -rf /root/.bun
sudo rm /usr/local/bin/bun
```

## Benefits of New Encoder

- **No Bun dependency**: Standalone binary, easier to deploy
- **Smaller installation**: Single binary vs full Bun runtime
- **Faster startup**: Compiled code starts instantly
- **Auto-update**: Built-in `--update` command
- **Cross-platform**: Same binary format for all platforms

## Getting Help

If you encounter issues during migration:

1. Check logs: `sudo journalctl -u annex-encoder -n 100`
2. Verify configuration: `sudo cat /etc/annex-encoder.env`
3. Test manually: `sudo -u annex annex-encoder` (Ctrl+C to stop)
4. Report issues: https://github.com/WeHaveNoEyes/Annex/issues
