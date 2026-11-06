@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo ============================================
echo  올영프라이스 검색 서버 설치 및 실행
echo ============================================
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 설치되어 있지 않습니다. https://nodejs.org 에서 Node.js 20 LTS 이상을 설치해 주세요.
  pause
  exit /b 1
)
if not exist node_modules (
  echo [1/2] 필요한 패키지를 설치합니다...
  call npm install
  if errorlevel 1 (echo 패키지 설치에 실패했습니다. 인터넷 연결을 확인해 주세요.& pause & exit /b 1)
)
echo [2/2] Chromium 브라우저를 확인 및 설치합니다...
call npx playwright install chromium
if errorlevel 1 (echo Chromium 설치에 실패했습니다.& pause & exit /b 1)
echo 서버를 시작합니다. 종료하려면 Ctrl+C를 누르세요.
call npm start
pause
