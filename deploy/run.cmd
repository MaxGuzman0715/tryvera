@echo off
REM Start the Enpply stack on this VPS so it serves HTTPS at tealbridge.online.
REM
REM What this does:
REM   1. Stops any process holding port 80 or 3001 (old node, old caddy).
REM   2. Stops any running Caddy via its admin API.
REM   3. Starts Caddy from C:\Caddy (binds 80 + 443, reverse-proxies localhost:3001).
REM   4. Starts the node server on PORT=3001, detached (window hidden, survives this shell closing).
REM   5. Health-checks https://tealbridge.online/api/health.
REM
REM Persistence note: this script makes the processes survive THIS terminal closing,
REM but they do NOT survive a VPS reboot. For that, install Caddy as a service
REM (`caddy.exe service install`) and use Task Scheduler / nssm for node.

setlocal
cd /d "%~dp0\.."
set "REPO=%CD%"

echo [run] Repo: %REPO%

if not exist "%REPO%\server\dist\index.js" (
  echo [run] ERROR: server\dist\index.js missing. Run deploy\build.cmd first.
  endlocal
  exit /b 1
)

if not exist "C:\Caddy\caddy.exe" (
  echo [run] ERROR: C:\Caddy\caddy.exe not found.
  endlocal
  exit /b 1
)

echo [run] Stopping anything on ports 80 / 3001...
powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort 80,3001 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { try { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } catch {} }"

echo [run] Stopping any running Caddy...
"C:\Caddy\caddy.exe" stop >nul 2>&1

echo [run] Starting Caddy (80 + 443, reverse proxy to localhost:3001)...
pushd "C:\Caddy"
"C:\Caddy\caddy.exe" start --config Caddyfile
popd
if errorlevel 1 (
  echo [run] ERROR: Caddy failed to start.
  endlocal
  exit /b 1
)

echo [run] Waiting for Caddy to bind 443...
powershell -NoProfile -Command "$ok=$false; for ($i=0; $i -lt 30; $i++) { if (Get-NetTCPConnection -State Listen -LocalPort 443 -ErrorAction SilentlyContinue) { $ok=$true; break }; Start-Sleep 1 }; if (-not $ok) { Write-Host '[run] WARNING: Caddy not listening on 443 after 30s'; exit 1 }"

echo [run] Starting node server on PORT=3001 (hidden window, detached)...
powershell -NoProfile -Command "Start-Process -FilePath 'node.exe' -ArgumentList 'dist/index.js' -WorkingDirectory '%REPO%\server' -WindowStyle Hidden"

echo [run] Waiting for node to bind 3001...
powershell -NoProfile -Command "$ok=$false; for ($i=0; $i -lt 30; $i++) { if (Get-NetTCPConnection -State Listen -LocalPort 3001 -ErrorAction SilentlyContinue) { $ok=$true; break }; Start-Sleep 1 }; if (-not $ok) { Write-Host '[run] WARNING: node not listening on 3001 after 30s'; exit 1 }"

echo [run] Health check via HTTPS...
powershell -NoProfile -Command "Start-Sleep -Seconds 2; try { $r = Invoke-WebRequest -Uri 'https://tealbridge.online/api/health' -UseBasicParsing -TimeoutSec 15; Write-Host ('[run] OK ' + $r.StatusCode + ' ' + $r.Content) } catch { Write-Host ('[run] HEALTH CHECK FAILED: ' + $_.Exception.Message); exit 1 }"

echo.
echo [run] Stack is up. You can close this window — Caddy and node keep running.
endlocal
exit /b 0
