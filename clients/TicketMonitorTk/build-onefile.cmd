@echo off
setlocal
cd /d "%~dp0"

set "PYTHON_CMD=py -3.10"
%PYTHON_CMD% --version >nul 2>nul
if errorlevel 1 set "PYTHON_CMD=python"

%PYTHON_CMD% -m PyInstaller --version >nul 2>nul
if errorlevel 1 (
    %PYTHON_CMD% -m pip install pyinstaller
    if errorlevel 1 goto :failed
)

%PYTHON_CMD% -m PyInstaller --noconfirm --clean --windowed --onefile ^
  --name TicketMonitor main.py
if errorlevel 1 goto :failed

if not exist "ticket-monitor.json" copy /Y "ticket-monitor.example.json" "ticket-monitor.json" >nul
copy /Y "ticket-monitor.json" "dist\ticket-monitor.json" >nul
copy /Y "README.md" "dist\README.md" >nul

echo.
echo Build completed: dist\TicketMonitor.exe
echo Keep ticket-monitor.json beside the EXE.
pause
exit /b 0

:failed
echo.
echo [ERROR] Build failed. Review the output above.
pause
exit /b 1
