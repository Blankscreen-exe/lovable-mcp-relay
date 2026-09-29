@echo off
REM Starts the Lovable MCP relay and opens its setup page.
REM Leave this window open while you use Claude Code.
cd /d "%~dp0"
title Lovable MCP relay
where node >nul 2>nul || (echo Node.js is required. Install it from https://nodejs.org and run this again. & pause & exit /b 1)
node src/relay.mjs --open
echo.
echo The relay has stopped. Press any key to close this window.
pause >nul
