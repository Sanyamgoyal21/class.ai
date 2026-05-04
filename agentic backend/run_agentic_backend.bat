@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "PYTHON_EXE=%SCRIPT_DIR%.venv\Scripts\python.exe"

if not exist "%PYTHON_EXE%" (
  for %%I in ("%SCRIPT_DIR%..\.venv\Scripts\python.exe") do set "PYTHON_EXE=%%~fI"
)

if not exist "%PYTHON_EXE%" (
  echo Could not find a project virtualenv Python.
  echo Tried:
  echo   %SCRIPT_DIR%.venv\Scripts\python.exe
  echo   %SCRIPT_DIR%..\.venv\Scripts\python.exe
  exit /b 1
)

echo Using Python: %PYTHON_EXE%
"%PYTHON_EXE%" "%SCRIPT_DIR%main.py" %*
