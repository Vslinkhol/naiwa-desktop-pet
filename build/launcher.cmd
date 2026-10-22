@echo off
rem ============================================================
rem  Naiwa Desktop Pet - compatibility launcher
rem
rem  Why this file exists:
rem    On some machines Chromium's sandbox cannot start at all.
rem    The app then exits before it prints anything, so a normal
rem    double-click looks like "nothing happened, no error".
rem
rem  What it does:
rem    1. starts the app normally (Chromium sandbox kept), then
rem    2. if the process is not alive a couple of seconds later,
rem       retries once with --no-sandbox.
rem
rem  On healthy machines step 1 succeeds and the sandbox is kept.
rem  You only need this file if double-clicking
rem  "Naiwa Desktop Pet.exe" does nothing on your machine.
rem ============================================================
setlocal
set "EXE=%~dp0Naiwa Desktop Pet.exe"

if not exist "%EXE%" (
  echo [naiwa] Naiwa Desktop Pet.exe was not found next to this script.
  echo [naiwa] Keep this launcher in the same folder as the app.
  pause
  exit /b 1
)

rem --- attempt 1: normal start (sandbox enabled) ---
start "" "%EXE%" %*

rem A sandbox failure exits almost instantly, so a short wait is enough.
ping -n 3 127.0.0.1 >nul

tasklist /fi "imagename eq Naiwa Desktop Pet.exe" 2>nul | find /i "Naiwa Desktop Pet.exe" >nul
if not errorlevel 1 (
  rem It is running - nothing else to do.
  exit /b 0
)

rem --- attempt 2: fall back to --no-sandbox ---
echo [naiwa] Normal start did not work on this machine.
echo [naiwa] Retrying with --no-sandbox ...
start "" "%EXE%" --no-sandbox %*
exit /b 0