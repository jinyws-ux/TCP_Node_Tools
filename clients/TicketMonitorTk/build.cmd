@echo off
setlocal
cd /d "%~dp0"

set "PYTHON_CMD=py -3.10"
%PYTHON_CMD% --version >nul 2>nul
if errorlevel 1 set "PYTHON_CMD=python"

%PYTHON_CMD% --version
if errorlevel 1 (
    echo [ERROR] Python 3.10 was not found.
    pause
    exit /b 1
)

%PYTHON_CMD% -m PyInstaller --version >nul 2>nul
if errorlevel 1 (
    %PYTHON_CMD% -m pip install pyinstaller
    if errorlevel 1 goto :failed
)

%PYTHON_CMD% -m PyInstaller --noconfirm --clean --windowed --onedir ^
  --name TicketMonitor main.py
if errorlevel 1 goto :failed

if not exist "ticket-monitor.json" copy /Y "ticket-monitor.example.json" "ticket-monitor.json" >nul
copy /Y "ticket-monitor.json" "dist\TicketMonitor\ticket-monitor.json" >nul
copy /Y "README.md" "dist\TicketMonitor\README.md" >nul

powershell -NoProfile -Command ^
  "Compress-Archive -Path 'dist\TicketMonitor\*' -DestinationPath 'dist\TicketMonitor-portable.zip' -Force"

echo.
echo Build completed:
echo   dist\TicketMonitor\TicketMonitor.exe
echo   dist\TicketMonitor-portable.zip
pause
exit /b 0

:failed
echo.
echo [ERROR] Build failed. Review the output above.
pause
exit /b 1
