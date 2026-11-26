@echo off
setlocal
set "PACKAGING_OCR_RUNTIME=%LOCALAPPDATA%\PackagingProofWorkbench\ocr"
set "PACKAGING_OCR_EXE=%PACKAGING_OCR_RUNTIME%\Scripts\python.exe"
if not exist "%PACKAGING_OCR_EXE%" (
  python -m venv "%PACKAGING_OCR_RUNTIME%"
  if errorlevel 1 exit /b 1
)
"%PACKAGING_OCR_EXE%" -m pip install rapidocr==3.10.0 openvino==2026.4.1
if errorlevel 1 exit /b 1
"%PACKAGING_OCR_EXE%" "%~dp0ocr_paddle.py" --prepare
exit /b %ERRORLEVEL%
