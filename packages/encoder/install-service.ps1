# Annex Encoder Windows Service Setup
# Run this script as Administrator

$ErrorActionPreference = "Stop"

# Configuration
$serviceName = "AnnexEncoder"
$displayName = "Annex Remote Encoder"
$description = "Remote AV1 encoding service for Annex media platform"
$installPath = "C:\Program Files\Annex Encoder"
$execPath = "$installPath\annex-encoder.exe"

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Error: This script must be run as Administrator" -ForegroundColor Red
    exit 1
}

Write-Host "╔═══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║    Annex Encoder - Windows Service Installation              ║" -ForegroundColor Cyan
Write-Host "╚═══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Check if service already exists
$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existingService) {
    Write-Host "Service already exists. Stopping and removing..." -ForegroundColor Yellow
    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $serviceName
    Start-Sleep -Seconds 2
}

# Set environment variables for the service
Write-Host "[1/3] Setting environment variables..." -ForegroundColor Cyan
[Environment]::SetEnvironmentVariable("ANNEX_SERVER_URL", "ws://server:3000/encoder", "Machine")
[Environment]::SetEnvironmentVariable("ANNEX_ENCODER_ID", "encoder-test-host", "Machine")
[Environment]::SetEnvironmentVariable("ANNEX_GPU_DEVICE", "0", "Machine")
[Environment]::SetEnvironmentVariable("ANNEX_NFS_BASE_PATH", "Z:\downloads", "Machine")
[Environment]::SetEnvironmentVariable("ANNEX_LOG_LEVEL", "info", "Machine")
Write-Host "  ✓ Environment variables set" -ForegroundColor Green

# Create the service
Write-Host ""
Write-Host "[2/3] Creating Windows Service..." -ForegroundColor Cyan
sc.exe create $serviceName binPath= "$execPath" start= auto DisplayName= "$displayName"
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ✗ Failed to create service" -ForegroundColor Red
    exit 1
}

sc.exe description $serviceName "$description"
sc.exe failure $serviceName reset= 86400 actions= restart/60000/restart/60000/restart/60000
Write-Host "  ✓ Service created: $serviceName" -ForegroundColor Green

# Start the service
Write-Host ""
Write-Host "[3/3] Starting service..." -ForegroundColor Cyan
Start-Service -Name $serviceName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$service = Get-Service -Name $serviceName
if ($service.Status -eq "Running") {
    Write-Host "  ✓ Service started successfully" -ForegroundColor Green
} else {
    Write-Host "  ⚠ Service created but not running. Check Event Viewer for errors." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "╔═══════════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║    Installation Complete                                      ║" -ForegroundColor Green
Write-Host "╚═══════════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Edit environment variables in System Properties"
Write-Host "  2. Ensure encoder binary is at: $execPath"
Write-Host "  3. Restart service: Restart-Service $serviceName"
Write-Host "  4. Check status: Get-Service $serviceName"
Write-Host "  5. View logs: Get-EventLog -LogName Application -Source $serviceName -Newest 50"
Write-Host ""
