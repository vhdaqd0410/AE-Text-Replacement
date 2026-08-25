# ============================================================
#  xlsx → CSV 转换脚本（供 AE 批量文字替换工具使用）
#  ------------------------------------------------
#  功能：
#   1. 读取 xlsx 第一个工作表
#   2. 自动定位表头行：找包含"中文名"等关键字的那一行作为表头
#   3. 跳过表头前面的标题行
#   4. 逐单元格读取，字段含 逗号/换行/引号 时自动用双引号包裹（CSV标准）
#   5. 导出为 UTF-8 带 BOM 编码（保证 AE 中文不乱码）
#   6. 每行用"中文名"作为后续文件名参考（可选）
#  ------------------------------------------------
#  用法：双击 run_转换.bat，或在 PowerShell 中运行本脚本
# ============================================================

param(
    [string]$InputFile = "",
    [string]$OutputFile = ""
)

$ErrorActionPreference = "Stop"

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  xlsx → CSV 转换工具（AE批量替换用）" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# ---------- 选择输入文件 ----------
if ($InputFile -eq "") {
    Add-Type -AssemblyName System.Windows.Forms
    $ofd = New-Object System.Windows.Forms.OpenFileDialog
    $ofd.Filter = "Excel 文件 (*.xlsx;*.xls)|*.xlsx;*.xls"
    $ofd.Title = "请选择要转换的 Excel 文件"
    if ($ofd.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
        Write-Host "已取消" -ForegroundColor Yellow
        exit 0
    }
    $InputFile = $ofd.FileName
}

if (-not (Test-Path $InputFile)) {
    Write-Host "错误：文件不存在 - $InputFile" -ForegroundColor Red
    Read-Host "按回车退出"
    exit 1
}

# ---------- 生成默认输出路径（与源文件同目录，同名.csv） ----------
if ($OutputFile -eq "") {
    $dir = Split-Path $InputFile
    $base = [System.IO.Path]::GetFileNameWithoutExtension($InputFile)
    $OutputFile = Join-Path $dir ($base + ".csv")
}

Write-Host "输入文件：$InputFile"
Write-Host "输出文件：$OutputFile"

# ---------- 启动 Excel COM ----------
$excel = $null
try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false

    $wb = $excel.Workbooks.Open($InputFile, $null, $true)  # 只读打开
    $ws = $wb.Worksheets.Item(1)
    $wsName = $ws.Name
    Write-Host "工作表：$wsName"

    # ---------- 计算实际数据范围 ----------
    $usedRange = $ws.UsedRange
    $maxRow = $usedRange.Row + $usedRange.Rows.Count - 1
    $maxCol = $usedRange.Column + $usedRange.Columns.Count - 1
    Write-Host "数据范围：行1-$maxRow, 列1-$maxCol"

    # ---------- 读取全部单元格到内存（避免逐个COM调用，性能更好） ----------
    $data = $usedRange.Value2  # 二维数组

    # ---------- 自动定位表头行 ----------
    # 表头特征：包含"中文名"这一列，或行内多个已知列名
    $keywordCols = @("中文名","称号","性别","人物背景","首次出场集数","序号")
    $headerRow = -1
    $headerColIdx = @{}  # 列名 -> 数组列索引(0-based)

    # 遍历所有行找表头（找包含"中文名"的那一行）
    for ($r = 0; $r -lt $maxRow; $r++) {
        $rowHasChinese = $false
        $foundCols = @()
        for ($c = 0; $c -lt $maxCol; $c++) {
            $val = $null
            try { $val = $data.GetValue($r+1, $c+1) } catch { $val = $null }
            if ($val -isnot [string]) { $val = [string]$val }
            $val = $val.Trim()
            if ($val -eq "中文名") {
                $rowHasChinese = $true
            }
            if ($keywordCols -contains $val) {
                $foundCols += $val
            }
        }
        # 若该行同时包含"中文名"且至少还有1个其它关键字列，判定为表头行
        if ($rowHasChinese -and $foundCols.Count -ge 2) {
            $headerRow = $r
            Write-Host "检测到表头行：Excel第 $($r+1) 行"
            # 记录列名 -> 列索引
            for ($c = 0; $c -lt $maxCol; $c++) {
                $val = $null
                try { $val = $data.GetValue($r+1, $c+1) } catch { $val = $null }
                if ($val -isnot [string]) { $val = [string]$val }
                $val = $val.Trim()
                if ($val -ne "") {
                    $headerColIdx[$val] = $c
                }
            }
            break
        }
    }

    if ($headerRow -lt 0) {
        Write-Host "错误：未找到表头行（需要包含'中文名'列）" -ForegroundColor Red
        Read-Host "按回车退出"
        exit 1
    }

    # 表头列名（按原列顺序）
    $headerNames = @()
    for ($c = 0; $c -lt $maxCol; $c++) {
        $val = $null
        try { $val = $data.GetValue($headerRow+1, $c+1) } catch { $val = $null }
        if ($val -isnot [string]) { $val = [string]$val }
        $headerNames += $val.Trim()
    }

    # ---------- 拼接 CSV 内容 ----------
    function Get-CellVal($r, $c) {
        $val = $null
        try { $val = $data.GetValue($r+1, $c+1) } catch { $val = $null }
        if ($null -eq $val) { return "" }
        if ($val -is [System.DateTime]) { return $val.ToString("yyyy-MM-dd") }
        if ($val -is [double] -or $val -is [single] -or $val -is [int] -or $val -is [long]) {
            # 数字：若为整数则不带小数
            if ([math]::Abs($val - [math]::Round($val)) -lt 0.0000001) {
                return ([long]$val).ToString()
            }
            return $val.ToString()
        }
        return [string]$val
    }

    function ConvertTo-CsvField($value) {
        # CSV 字段转义：含逗号/换行/引号时用双引号包裹，内部双引号翻倍
        $s = [string]$value
        if ($s -match '["\r\n,]' -or $s.StartsWith(" ") -or $s.EndsWith(" ")) {
            $s = $s.Replace('"', '""')
            return '"' + $s + '"'
        }
        return $s
    }

    $sb = New-Object System.Text.StringBuilder

    # 表头行
    $headerParts = @()
    foreach ($hn in $headerNames) {
        $headerParts += (ConvertTo-CsvField $hn)
    }
    [void]$sb.AppendLine(($headerParts -join ","))

    # 数据行：从表头行的下一行到最后
    $dataRows = 0
    $nameColIdx = -1
    if ($headerColIdx.ContainsKey("中文名")) { $nameColIdx = $headerColIdx["中文名"] }

    for ($r = $headerRow + 1; $r -lt $maxRow; $r++) {
        # 跳过整行全空的行
        $allEmpty = $true
        for ($c = 0; $c -lt $maxCol; $c++) {
            $v = Get-CellVal $r $c
            if ($v -ne "") { $allEmpty = $false; break }
        }
        if ($allEmpty) { continue }

        $rowParts = @()
        for ($c = 0; $c -lt $maxCol; $c++) {
            $v = Get-CellVal $r $c
            $rowParts += (ConvertTo-CsvField $v)
        }
        [void]$sb.AppendLine(($rowParts -join ","))
        $dataRows++
    }

    # ---------- 写文件（UTF-8 带 BOM） ----------
    $utf8Bom = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllText($OutputFile, $sb.ToString(), $utf8Bom)

    Write-Host ""
    Write-Host "转换完成！" -ForegroundColor Green
    Write-Host "  数据行数：$dataRows"
    Write-Host "  输出文件：$OutputFile"
    Write-Host ""
    Write-Host "下一步：在 AE 批量文字替换工具中："
    Write-Host "  1. 变量映射：为模板文字层指定变量名（对应表头：中文名/称号/性别/年龄/人物背景/首次出场集数）"
    Write-Host "  2. 选择此 CSV 文件"
    Write-Host "  3. 命名列建议选【中文名】（每行一个角色 → 一个成品）"
    Write-Host ""

    $wb.Close($false)
    $excel.Quit()
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($ws) | Out-Null
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($wb) | Out-Null
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
    $excel = $null

    # 可选：打开输出文件预览（注释掉则自动完成）
    # Start-Process $OutputFile

    Read-Host "按回车退出"

} catch {
    Write-Host "发生错误：$($_.Exception.Message)" -ForegroundColor Red
    if ($excel) {
        try { $excel.Quit() } catch {}
    }
    Read-Host "按回车退出"
    exit 1
} finally {
    if ($excel) { try { $excel.Quit() } catch {} }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
