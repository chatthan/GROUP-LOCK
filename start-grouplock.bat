@echo off
title GROUP-LOCK - System Launcher
color 0B

echo =====================================================================
echo                GROUP-LOCK — FULL SYSTEM LAUNCHER
echo =====================================================================
echo.
echo Starting Backend API Server (Port 5000) and Frontend (Port 5173)...
echo.

cd /d "%~dp0"

start "GROUP-LOCK Backend Server" cmd /k "cd server && npm run dev"
timeout /t 3 /nobreak >nul

start "GROUP-LOCK Frontend (Vite)" cmd /k "cd client && npm run dev"

echo.
echo =====================================================================
echo  GROUP-LOCK is now running!
echo.
echo  PC Local URL:       https://localhost:5173
echo  Backend API:        http://localhost:5000
echo =====================================================================
echo.
pause
