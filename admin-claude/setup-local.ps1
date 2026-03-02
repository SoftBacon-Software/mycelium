# ============================================================
# admin-claude Local Setup — Drop this file on any Windows machine
# Installs Ollama + Qwen 2.5 14B, clones admin-claude, starts polling
# ============================================================
# Usage: Right-click > Run with PowerShell
#   OR: powershell -ExecutionPolicy Bypass -File setup-local.ps1
# ============================================================

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  admin-claude Local Setup" -ForegroundColor Cyan
Write-Host "  Mycelium Network Admin on Local LLM" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ---- Configuration ----
$INSTALL_DIR = "$env:USERPROFILE\admin-claude"
$OLLAMA_MODEL = "qwen2.5:14b"
$MYCELIUM_API_URL = "https://mycelium.fyi/api/mycelium"
$MYCELIUM_ADMIN_KEY = "KPeO7ZspKsAQotZsrvnZ2vYk"
$GITHUB_TOKEN = ""  # Optional: paste your GitHub token here for PR reviews
$GITHUB_REPOS = "grbarajas-soymd/mycelium"
$REPO_URL = "https://github.com/grbarajas-soymd/mycelium.git"

# ---- Step 1: Check/Install Node.js ----
Write-Host "[1/6] Checking Node.js..." -ForegroundColor Yellow
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    $nodeVersion = & node --version
    Write-Host "  Node.js $nodeVersion found" -ForegroundColor Green
} else {
    Write-Host "  Node.js not found. Installing via winget..." -ForegroundColor Yellow
    winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    # Refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    $nodeVersion = & node --version
    Write-Host "  Node.js $nodeVersion installed" -ForegroundColor Green
}

# ---- Step 2: Check/Install Ollama ----
Write-Host "[2/6] Checking Ollama..." -ForegroundColor Yellow
$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if ($ollama) {
    Write-Host "  Ollama found" -ForegroundColor Green
} else {
    Write-Host "  Ollama not found. Installing via winget..." -ForegroundColor Yellow
    winget install Ollama.Ollama --accept-source-agreements --accept-package-agreements
    # Refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    Write-Host "  Ollama installed" -ForegroundColor Green
}

# ---- Step 3: Start Ollama and pull model ----
Write-Host "[3/6] Pulling model: $OLLAMA_MODEL (this may take a while on first run)..." -ForegroundColor Yellow

# Make sure Ollama serve is running
$ollamaProcess = Get-Process ollama -ErrorAction SilentlyContinue
if (-not $ollamaProcess) {
    Write-Host "  Starting Ollama server..." -ForegroundColor Yellow
    Start-Process ollama -ArgumentList "serve" -WindowStyle Hidden
    Start-Sleep -Seconds 5
}

# Pull the model
& ollama pull $OLLAMA_MODEL
Write-Host "  Model $OLLAMA_MODEL ready" -ForegroundColor Green

# ---- Step 4: Get admin-claude code ----
Write-Host "[4/6] Setting up admin-claude..." -ForegroundColor Yellow

if (Test-Path "$INSTALL_DIR\package.json") {
    Write-Host "  Updating existing installation..." -ForegroundColor Yellow
    Push-Location $INSTALL_DIR
    # If it's a git clone, pull latest
    if (Test-Path ".git") {
        git pull origin master 2>$null
    }
} else {
    Write-Host "  Cloning repository..." -ForegroundColor Yellow
    # Clone just the admin-claude directory via sparse checkout
    git clone --depth 1 --filter=blob:none --sparse $REPO_URL "$INSTALL_DIR-repo" 2>$null
    Push-Location "$INSTALL_DIR-repo"
    git sparse-checkout set admin-claude
    Pop-Location

    # Copy admin-claude files to install dir
    New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null
    Copy-Item "$INSTALL_DIR-repo\admin-claude\*" $INSTALL_DIR -Recurse -Force
    Remove-Item "$INSTALL_DIR-repo" -Recurse -Force
    Push-Location $INSTALL_DIR
}

# ---- Step 5: Install dependencies + create .env ----
Write-Host "[5/6] Installing dependencies..." -ForegroundColor Yellow
npm install --omit=optional 2>$null
Write-Host "  Dependencies installed" -ForegroundColor Green

# Create .env file
$envContent = @"
# admin-claude local configuration
MODE=poll
LLM_BACKEND=ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=$OLLAMA_MODEL
MYCELIUM_API_URL=$MYCELIUM_API_URL
MYCELIUM_ADMIN_KEY=$MYCELIUM_ADMIN_KEY
POLL_INTERVAL=30000
GITHUB_TOKEN=$GITHUB_TOKEN
GITHUB_REPOS=$GITHUB_REPOS
"@

$envContent | Out-File -FilePath ".env" -Encoding utf8
Write-Host "  .env created" -ForegroundColor Green

# ---- Step 6: Create start script ----
$startScript = @'
@echo off
title admin-claude (local)
cd /d "%~dp0"

:: Load .env file
for /f "tokens=1,2 delims==" %%a in (.env) do (
    set "line=%%a"
    if not "!line:~0,1!"=="#" (
        set "%%a=%%b"
    )
)

:: Start with env vars
set MODE=poll
set LLM_BACKEND=ollama

:: Check Ollama is running
ollama list >nul 2>&1
if errorlevel 1 (
    echo Starting Ollama...
    start /min ollama serve
    timeout /t 5 /nobreak >nul
)

echo.
echo  ========================================
echo   admin-claude [LOCAL MODE]
echo   Model: %OLLAMA_MODEL%
echo   API: %MYCELIUM_API_URL%
echo  ========================================
echo.

node index.js
pause
'@

$startScript | Out-File -FilePath "start.bat" -Encoding ascii

# Also create a stop script
$stopScript = @'
@echo off
taskkill /f /im node.exe /fi "WINDOWTITLE eq admin-claude*" 2>nul
echo admin-claude stopped.
pause
'@
$stopScript | Out-File -FilePath "stop.bat" -Encoding ascii

Pop-Location

# ---- Done ----
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Setup complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Install dir: $INSTALL_DIR" -ForegroundColor White
Write-Host "  Model: $OLLAMA_MODEL (12GB VRAM)" -ForegroundColor White
Write-Host "  Mode: Poll (no public URL needed)" -ForegroundColor White
Write-Host ""
Write-Host "  To start: double-click $INSTALL_DIR\start.bat" -ForegroundColor Cyan
Write-Host "  To stop:  double-click $INSTALL_DIR\stop.bat" -ForegroundColor Cyan
Write-Host "  Or run:   cd $INSTALL_DIR && node index.js" -ForegroundColor Cyan
Write-Host ""

# Ask if user wants to start now
$start = Read-Host "Start admin-claude now? (y/n)"
if ($start -eq "y" -or $start -eq "Y") {
    Write-Host "Starting admin-claude..." -ForegroundColor Yellow
    Push-Location $INSTALL_DIR
    # Load env vars
    Get-Content .env | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
            [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process")
        }
    }
    node index.js
}
