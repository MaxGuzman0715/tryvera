@echo off
REM One-time build: install workspace deps + compile server (TS) and client (Vite).
REM Run after pulling new code. Idempotent — safe to re-run.

setlocal
cd /d "%~dp0\.."

echo [build] Repo: %CD%
echo [build] Installing workspace dependencies (npm install)...
call npm install
if errorlevel 1 goto :err

echo [build] Compiling server + client (npm run build)...
call npm run build
if errorlevel 1 goto :err

echo.
echo [build] Done. Now run deploy\run.cmd to start Caddy + the server.
endlocal
exit /b 0

:err
echo.
echo [build] FAILED with errorlevel %errorlevel%
endlocal
exit /b 1
