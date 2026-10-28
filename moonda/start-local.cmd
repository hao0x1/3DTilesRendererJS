@echo off
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo Install a current Node.js release first, then run this launcher again.
  pause
  exit /b 1
)
if not exist node_modules call npm ci
if errorlevel 1 exit /b 1
call npm run build
if errorlevel 1 exit /b 1
echo MOONDA will be available at http://127.0.0.1:5183/
call npm run preview -- --port 5183 --strictPort
