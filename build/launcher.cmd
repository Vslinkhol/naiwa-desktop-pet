@echo off
rem ============================================================
rem  Naiwa Desktop Pet - compatibility launcher
rem
rem  Why this file exists:
rem    Chromium 130 aborts its own sandbox setup (IMMEDIATE_CRASH,
rem    exit 0x80000003) when the executable lives in a directory
rem    carrying a Low integrity label. The app then dies before it
rem    prints anything, so a normal double-click looks like
rem    "nothing happened, no error".
rem
rem    (Diagnosis detail, see docs/04 section 3.4: the cause is the
rem     *directory*, not the machine and not the app code. Copying
rem     the same exe to a normal folder needs no flag at all.)
rem
rem  What it does:
rem    1. starts the app normally (Chromium sandbox kept), then
rem    2. if the process is not alive a couple of seconds later,
rem       retries once with --no-sandbox.
rem
rem  On healthy machines / normal folders step 1 succeeds and the
rem  sandbox is kept untouched. You only need this file if
rem  double-clicking "Naiwa Desktop Pet.exe" does nothing.
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