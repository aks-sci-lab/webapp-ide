@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo 처음 실행: 필요한 패키지를 설치합니다...
  call npm install
)
echo 웹앱 IDE 를 시작합니다. 이 창을 닫으면 IDE 도 꺼집니다.
start "" cmd /c "timeout /t 2 >/dev/null & start http://localhost:5180"
node server.js
pause
