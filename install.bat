@echo off
chcp 65001 >nul
title My-Comfnode 依赖安装

echo ============================================
echo   My-Comfnode 依赖安装
echo ============================================
echo.

REM 优先使用 ComfyUI 便携版（整合包）自带的 Python
set "PYTHON="
if exist "%~dp0..\..\python_embeded\python.exe" (
    set "PYTHON=%~dp0..\..\python_embeded\python.exe"
    echo 检测到 ComfyUI 便携版 Python
) else (
    where python >nul 2>nul && set "PYTHON=python"
)

if not defined PYTHON (
    echo [错误] 未找到 Python，请先安装 Python 或使用 ComfyUI 便携版。
    pause
    exit /b 1
)

echo 使用 Python: %PYTHON%
echo 开始安装依赖（如已安装会自动跳过）...
echo.
"%PYTHON%" -m pip install -r "%~dp0requirements.txt"

echo.
echo ============================================
echo   安装完成！请重启 ComfyUI 使插件生效。
echo ============================================
pause
