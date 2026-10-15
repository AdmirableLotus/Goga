@echo off
cd /d "c:\Users\redre\Desktop\mom\Goga-clean"
"node_modules\electron\dist\electron.exe" . > electron-live-test.log 2>&1
echo Exit code: %ERRORLEVEL% >> electron-live-test.log
