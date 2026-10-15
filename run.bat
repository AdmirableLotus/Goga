@echo off
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
echo Building...
call npx tsc -p tsconfig.main.json
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)
echo Launching Goga...
node_modules\electron\dist\electron.exe .
