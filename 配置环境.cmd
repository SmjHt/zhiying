@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal EnableExtensions

echo [知映] 检查运行环境...
if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" -c "import PIL, imageio_ffmpeg" >nul 2>nul
    if not errorlevel 1 goto :ready
    echo [知映] 依赖不完整，正在补齐...
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 goto :fail
    goto :ready
)

set "PY="
call :probe "D:\Anaconda3\python.exe"
if defined PY goto :create
call :probe "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if defined PY goto :create
call :probe "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if defined PY goto :create
call :probe "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if defined PY goto :create
call :probe "python"
if defined PY goto :create
call :probe "py"
if defined PY goto :create
echo [知映] 没找到可用的 Python 3.10+（64 位）。请先安装 https://www.python.org/downloads/windows/ 再重试。
goto :fail

:create
echo [知映] 使用 %PY% 创建 .venv ...
"%PY%" -m venv .venv
if errorlevel 1 goto :fail
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto :fail

:ready
".venv\Scripts\python.exe" -c "import PIL, imageio_ffmpeg; print('[zhiying] Pillow', PIL.__version__, '| imageio-ffmpeg OK')"
if errorlevel 1 goto :fail
echo [知映] 环境就绪，双击 启动知映.cmd 即可使用。
exit /b 0

:fail
echo [知映] 环境配置失败，请把上面的报错保留下来。
exit /b 1

:probe
if "%~1"=="" exit /b 0
where "%~1" >nul 2>nul
if errorlevel 1 exit /b 0
"%~1" -m pip --version >nul 2>nul
if errorlevel 1 exit /b 0
"%~1" -c "import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 10) and sys.maxsize > 2**32 else 1)" >nul 2>nul
if errorlevel 1 exit /b 0
set "PY=%~1"
exit /b 0
