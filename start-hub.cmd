@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  start-hub.cmd - one-click launcher for the Agent Hub
REM  Boots the FastAPI command center, builds the frontend if
REM  needed, and opens your browser to it.
REM ============================================================
cd /d "%~dp0"

set "PY=%~dp0.venv\Scripts\python.exe"
set "NPM=C:\Users\User\tools\node\npm.cmd"
set "PORT=8000"
set "URL=http://127.0.0.1:%PORT%"

echo.
echo  ============================================
echo   Agent Hub - Command Center
echo  ============================================
echo.

REM ---- 1. Python venv + deps ---------------------------------
if not exist "%PY%" (
    echo  [1/4] Creating Python venv...
    where python >nul 2>nul
    if errorlevel 1 (
        echo  ERROR: python not found on PATH. Install Python 3.10+ first.
        pause
        exit /b 1
    )
    python -m venv .venv
    if errorlevel 1 ( echo  ERROR: could not create venv. & pause & exit /b 1 )
)
echo  [1/4] Python venv ready.

echo  [2/4] Installing Python deps (first run only)...
"%PY%" -m pip install -q -r server\requirements.txt
if errorlevel 1 ( echo  ERROR: pip install failed. & pause & exit /b 1 )
echo        deps OK.

REM ---- 2. Frontend build --------------------------------------
if not exist "frontend\dist\index.html" (
    echo  [3/4] Building frontend...
    if not exist "frontend\node_modules" (
        pushd frontend
        call "%NPM%" install
        if errorlevel 1 ( echo  ERROR: npm install failed. & popd & pause & exit /b 1 )
        popd
    )
    pushd frontend
    call "%NPM%" run build
    if errorlevel 1 ( echo  ERROR: frontend build failed. & popd & pause & exit /b 1 )
    popd
) else (
    echo  [3/4] Frontend already built.
)

REM ---- 3. Load OPENCODE_BIN from .env if present --------------
if exist ".env" (
    for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
        if /i "%%a"=="OPENCODE_BIN" set "OPENCODE_BIN=%%b"
    )
)
REM Fallback: opencode isn't on PATH on this machine.
if not defined OPENCODE_BIN (
    if exist "C:\Users\User\tools\node\opencode.cmd" set "OPENCODE_BIN=C:\Users\User\tools\node\opencode.cmd"
)
if defined OPENCODE_BIN set "OPENCODE_BIN=%OPENCODE_BIN%"

REM ---- 4. Start server + open browser -------------------------
echo  [4/4] Starting hub server on %URL% ...
start "" "%URL%"
"%PY%" -m uvicorn main:app --host 127.0.0.1 --port %PORT% --app-dir server

echo.
echo  Server stopped.
pause
