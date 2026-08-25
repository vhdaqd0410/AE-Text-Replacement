@echo off
chcp 65001 >nul
title xlsx 转 CSV 转换工具（AE批量替换用）
echo ==============================================
echo   xlsx 转 CSV 转换工具（AE批量文字替换用）
echo ==============================================
echo.
echo 本工具会把 Excel 表格转换成 AE 脚本可读的 CSV 文件
echo 支持：自动识别表头行、处理含换行/逗号的内容、UTF-8编码
echo.
echo 即将启动转换窗口，请在弹出窗口中选择你的 Excel 文件...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0xlsx转CSV.ps1"
if errorlevel 1 (
    echo.
    echo 转换失败，请检查是否安装了 Microsoft Excel。
    pause
)
