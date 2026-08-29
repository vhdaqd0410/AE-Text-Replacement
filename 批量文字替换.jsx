// ============================================================
//  批量文字替换工具  V1.1
//  ------------------------------------------------
//  功能：
//   1. 递归扫描当前合成及其预合成中的全部文字层
//   2. 多选列表 + 路径显示 + 搜索过滤
//   3. 智能单字顺序匹配填充（逐字模板）
//   4. 普通批量替换（多图层替换为同一文字）
//   5. 撤销历史（分组记录，可整体撤回）
//   6. 跳转定位选中文字层
//   7. 【核心】CSV 表格数据驱动批量填充：
//      - 变量映射界面（给每层指定变量名对应 CSV 表头，可保存复用）
//      - 逐行填充 → 逐行验证 → 逐行同步渲染（渲染完成后自动处理下一行）
//      - 主界面实时进度条（每完成一行推进一格）
//      - 渲染沿用模板已有输出设置，产物用指定列值命名
//  作者：根据需求定制开发
// ============================================================

// ============================================================
//  全局状态
// ============================================================
var BT_TextLayerHistory = [];   // 撤销历史
var BT_AllTextLayers = [];      // 当前扫描出的全部文字层
var BT_MappingConfig = {};      // 变量名 -> 图层唯一标识 的映射
var BT_OutputDir = "";          // 渲染输出目录
var BT_NameColumn = "";         // 用于命名产物的列名

// 主界面进度条相关（由批量处理过程实时更新）
var BT_ProgressBar = null;      // 主窗口中的 progressbar 控件
var BT_ProgressText = null;     // 主窗口中的进度文字 statictext
var BT_ProgressStatus = null;   // 主窗口中的行内状态文字 statictext

// 更新进度条 + 进度文字（done=已完成行数, total=总行数, msg=可选提示）
// 用 Graphics.updateNow() 强制立即重绘，保证同步循环里进度条也能"实时"推进
function BT_UpdateProgress(done, total, msg) {
    if (BT_ProgressBar) {
        try {
            BT_ProgressBar.maxvalue = Math.max(1, total);
            BT_ProgressBar.value = done;
        } catch (e) {}
    }
    if (BT_ProgressText) {
        var pct = total > 0 ? Math.round(done / total * 100) : 0;
        BT_ProgressText.text = "进度：" + done + " / " + total + " 行（" + pct + "%）";
    }
    if (BT_ProgressStatus) {
        BT_ProgressStatus.text = msg || "";
    }
    try {
        if (BT_ProgressBar) BT_ProgressBar.graphics.updateNow();
        if (BT_ProgressText) BT_ProgressText.graphics.updateNow();
        if (BT_ProgressStatus) BT_ProgressStatus.graphics.updateNow();
    } catch (e) {}
}

// ============================================================
//  对称对齐配置（称号/人名以参考图层为中心左右对称排列）
// ============================================================
var BT_AlignEnabled = false;      // 是否启用自动对称对齐（默认关闭：只替换文字，不动位置）
var BT_RefLayerName = "op光";     // 参考图层名（屏幕正中央的那个图层）
var BT_LeftVarName = "称号";      // 放在参考图层左侧的变量名
var BT_RightVarName = "中文名";   // 放在参考图层右侧的变量名（人名）
var BT_Gap = 20;                  // 称号/人名与参考图层中心之间的水平间距（像素）
var BT_LeftOffset = 0;            // 称号的额外水平偏移（正值向右，负值向左）
var BT_RightOffset = 0;           // 人名的额外水平偏移（正值向右，负值向左）
var BT_DebugAlign = false;        // 是否在对齐时弹出诊断信息（定位问题用）

// 在指定合成中按名字查找图层（大小写不敏感、去除首尾空格）
function BT_FindLayerByName(comp, name) {
    if (!comp) return null;
    var target = (name || "").replace(/^\s+|\s+$/g, "").toLowerCase();
    if (!target) return null;
    for (var i = 1; i <= comp.numLayers; i++) {
        var l = comp.layers[i];
        try {
            var ln = (l.name || "").replace(/^\s+|\s+$/g, "").toLowerCase();
            if (ln === target) return l;
        } catch (e) {}
    }
    return null;
}

// 核心对齐：以参考图层（如 op光）为对称中心，把"左侧变量"的文字右边缘、以及"右侧变量"的
// 文字左边缘，分别摆到距中心 gap 的位置；同时两者垂直中心都对齐到参考图层的垂直中心。
// 只调整 position，不改锚点，因此不会造成锚点相关的跑偏。
// 参数：
//   resolvedLayers  { key -> 图层对象 }（已在 BT_ProcessRows 解析好）
//   comp            当前模板合成
// 返回 { ok: bool, msg: string }
function BT_AlignToReference(resolvedLayers, comp) {
    if (!BT_AlignEnabled) return { ok: true, msg: "对齐已关闭" };
    if (!comp) return { ok: false, msg: "无有效合成" };

    // 1. 找参考图层（op光）
    var refLayer = BT_FindLayerByName(comp, BT_RefLayerName);
    if (!refLayer) return { ok: false, msg: "未找到参考图层 \"" + BT_RefLayerName + "\"" };

    // 参考图层的合成坐标（中心）
    var refPos = null;
    try {
        var posProp = refLayer.property("ADBE Transform Group").property("ADBE Position");
        if (posProp) refPos = posProp.value;
        else if (refLayer.position !== undefined) refPos = refLayer.position.value;
    } catch (e) {}
    if (!refPos) return { ok: false, msg: "无法读取参考图层 \"" + BT_RefLayerName + "\" 的位置" };
    var refX = refPos[0];
    var refY = refPos[1];

    // 2. 找到左侧、右侧变量对应的图层
    var leftLayer = null, rightLayer = null;
    for (var k in BT_MappingConfig) {
        var vn = BT_MappingConfig[k];
        var l = resolvedLayers[k];
        if (!l) continue;
        if (vn === BT_LeftVarName) leftLayer = l;
        else if (vn === BT_RightVarName) rightLayer = l;
    }

    var gap = (typeof BT_Gap === "number") ? BT_Gap : 20;
    var leftOff = (typeof BT_LeftOffset === "number") ? BT_LeftOffset : 0;
    var rightOff = (typeof BT_RightOffset === "number") ? BT_RightOffset : 0;
    var msgs = [];

    // 3. 左侧变量：文字水平中心对齐到 refX - gap（再叠加左侧额外偏移）
    if (leftLayer) {
        var r1 = BT_AlignLayerCenter(leftLayer, refX - gap + leftOff, refY, comp);
        msgs.push("称号(" + leftLayer.name + "): " + r1.msg);
    } else {
        msgs.push("未找到左侧变量 \"" + BT_LeftVarName + "\" 对应的图层");
    }

    // 4. 右侧变量：文字水平中心对齐到 refX + gap（再叠加右侧额外偏移）
    if (rightLayer) {
        var r2 = BT_AlignLayerCenter(rightLayer, refX + gap + rightOff, refY, comp);
        msgs.push("人名(" + rightLayer.name + "): " + r2.msg);
    } else {
        msgs.push("未找到右侧变量 \"" + BT_RightVarName + "\" 对应的图层");
    }

    // 诊断信息头部：参考图层位置
    var head = "参考[" + BT_RefLayerName + "] pos=(" + Math.round(refX) + "," + Math.round(refY) + ") 错开=" + gap + " 左偏=" + leftOff + " 右偏=" + rightOff;
    return { ok: true, msg: head + "\n" + msgs.join("\n") };
}

// 把文字层的水平中心和垂直中心都对齐到目标 (targetX, targetY)。
// 用 sourceRectAtTime 计算文字的几何中心，再补偿锚点偏移，得到正确的 position。
// 不改锚点（保持模板原有锚点/对齐方式）。
// 返回 { ok, msg }
function BT_AlignLayerCenter(layer, targetX, targetY, comp) {
    try {
        if (!layer) return { ok: false, msg: "图层为空" };

        // 读取当前锚点（不动它）
        var ax = 0, ay = 0;
        try {
            if (layer.anchorPoint !== undefined) {
                var apv = layer.anchorPoint.value;
                ax = apv[0]; ay = apv[1];
            }
        } catch (e) {}

        var t = comp ? comp.time : 0;
        var rect = layer.sourceRectAtTime(t, true);
        if (!rect) return { ok: false, msg: "无法读取文字包围盒" };

        // 文字的几何中心（相对图层原点）
        var centerX = rect.left + rect.width / 2;
        var centerY = rect.top + rect.height / 2;

        // 文字中心相对锚点的偏移
        var offX = centerX - ax;
        var offY = centerY - ay;

        // 目标 position：让文字中心落在 (targetX, targetY)
        //   文字中心(合成坐标) = position + off  =>  position = target - off
        var px = targetX - offX;
        var py = targetY - offY;

        var posProp = layer.property("ADBE Transform Group").property("ADBE Position");
        if (posProp) posProp.setValue([px, py]);
        else if (layer.position !== undefined) layer.position.setValue([px, py]);

        if (BT_DebugAlign) {
            return { ok: true, msg: layer.name + " | 锚点=(" + Math.round(ax) + "," + Math.round(ay) + ") 文字中心=(" + Math.round(centerX) + "," + Math.round(centerY) + ") → position=(" + Math.round(px) + "," + Math.round(py) + ")" };
        }
        return { ok: true, msg: "已居中(" + Math.round(targetX) + "," + Math.round(targetY) + ")" };
    } catch (e) {
        return { ok: false, msg: "对齐出错: " + e.message };
    }
}

// 图层唯一标识：记录"合成项目索引 + 逐级图层索引路径"
// 例如：主合成索引3，文字层在 [预合成A(层2) -> 文字层(层1)]，则 key = "3:2.1"
// 文字层直接在合成中则 key = "3:5"（层索引5）。
// 加固版：遍历时逐层向上，绝不返回 null。
function BT_LayerKey(layer) {
    // 构建从顶层合成到文字层的索引路径
    // layer.containingComp 是文字层直属合成
    var path = [];
    var cur = layer;
    while (cur) {
        path.unshift(cur.index);
        var parentComp = cur.containingComp;
        if (!parentComp) break;
        // 查找 parentComp 作为预合成被哪个上层图层引用
        var foundParentLayer = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (!(item instanceof CompItem)) continue;
            for (var j = 1; j <= item.numLayers; j++) {
                var pl = item.layers[j];
                if (pl instanceof AVLayer && pl.source === parentComp) {
                    foundParentLayer = pl;
                    break;
                }
            }
            if (foundParentLayer) break;
        }
        if (!foundParentLayer) break; // 到达顶层合成
        cur = foundParentLayer;
    }
    // cur 现在是最顶层合成（不含路径），找其在项目中的索引
    var rootComp = cur ? cur.containingComp : layer.containingComp;
    var rootIdx = -1;
    try {
        for (var k = 1; k <= app.project.numItems; k++) {
            if (app.project.item(k) === rootComp) { rootIdx = k; break; }
        }
    } catch (e) {}
    if (rootIdx >= 1) {
        return rootIdx + ":" + path.join(".");
    }
    // 退化情况：找不到合成索引
    return "c:" + path.join(".");
}

// 根据唯一标识解析回图层对象
function BT_ResolveLayer(key) {
    if (!key) return null;
    var idxSep = key.indexOf(":");
    if (idxSep < 0) return null;
    var rootIdx = parseInt(key.substring(0, idxSep));
    var pathStr = key.substring(idxSep + 1);
    if (isNaN(rootIdx) || rootIdx < 1) return null;
    // 越界保护：rootIdx 超出当前项目 item 范围时直接判定为失效（避免 app.project.item 抛异常）
    try {
        if (rootIdx > app.project.numItems) return null;
    } catch (e) {
        return null;
    }
    var comp = app.project.item(rootIdx);
    if (!comp || !(comp instanceof CompItem)) return null;
    var parts = pathStr.split(".");
    var layer = null;
    for (var i = 0; i < parts.length; i++) {
        var idx = parseInt(parts[i]);
        if (isNaN(idx) || idx < 1 || idx > comp.numLayers) return null;
        layer = comp.layers[idx];
        if (!layer) return null;
        // 若是最后一级，必须是文字层
        if (i === parts.length - 1) {
            if (!layer.property("Source Text")) return null;
        } else {
            // 中间级必须是预合成
            if (!(layer.source instanceof CompItem)) return null;
            comp = layer.source;
        }
    }
    return layer;
}

// ============================================================
//  工具函数
// ============================================================
function BT_GetSourceText(layer) {
    try {
        var p = layer.property("Source Text");
        if (p) return p.value.toString();
    } catch (e) {}
    return null;
}

function BT_SetSourceText(layer, text) {
    try {
        layer.property("Source Text").setValue(text);
        return true;
    } catch (e) {
        return false;
    }
}

// ============================================================
//  CSV 解析模块
//  - 自动探测编码：UTF-8 BOM / UTF-8 / GBK
//  - 支持引号包裹字段、转义双引号、字段内逗号/换行
//  - 自动识别分隔符：逗号 或 制表符
// ============================================================
function BT_ReadFileBytes(file) {
    // 以二进制方式读取，返回字节数组
    var f = new File(file);
    if (!f.open("r")) return null;
    f.encoding = "BINARY";
    var content = f.read();
    f.close();
    var bytes = [];
    for (var i = 0; i < content.length; i++) {
        bytes.push(content.charCodeAt(i) & 0xFF);
    }
    return bytes;
}

function BT_UTF8ToStr(bytes) {
    var i = 0, out = "";
    while (i < bytes.length) {
        var b = bytes[i];
        if (b < 0x80) {
            out += String.fromCharCode(b);
            i++;
        } else if (b >= 0xC0 && b < 0xE0) {
            var c = ((b & 0x1F) << 6) | (bytes[i+1] & 0x3F);
            out += String.fromCharCode(c);
            i += 2;
        } else if (b >= 0xE0 && b < 0xF0) {
            var c2 = ((b & 0x0F) << 12) | ((bytes[i+1] & 0x3F) << 6) | (bytes[i+2] & 0x3F);
            out += String.fromCharCode(c2);
            i += 3;
        } else {
            // 4字节等跳过
            i += 4;
        }
    }
    return out;
}

// GBK 解码：直接以 GBK 编码读取文件（尝试多种编码名，取成功者）
function BT_GBKReadFile(filePath) {
    var encodings = ["GBK", "GB2312", "gb2312", "GB18030", "gb18030"];
    for (var e = 0; e < encodings.length; e++) {
        var f = new File(filePath);
        try {
            if (f.open("r")) {
                f.encoding = encodings[e];
                var txt = f.read();
                f.close();
                // 检查是否读出了乱码（若全是替换字符则失败）
                if (txt && txt.indexOf("\uFFFD") < 0 && txt.length > 0) {
                    return txt;
                }
            }
        } catch (err) {}
    }
    // 全部失败，回退到二进制字节转换
    var bytes = BT_ReadFileBytes(filePath);
    return BT_GBKBytesToStr(bytes);
}

// 从字节数组做 GBK 解码（回退方案）：用临时文件 + GBK 编码读取
function BT_GBKBytesToStr(bytes) {
    // 构造 latin1 字符串（字节值 0-255 对应 Latin-1 码点）
    var latin = "";
    for (var i = 0; i < bytes.length; i++) latin += String.fromCharCode(bytes[i]);
    var tmp = new File(Folder.temp.fsName + "/_bt_gbk_tmp_" + (new Date().getTime()) + ".txt");
    var out = "";
    try {
        if (tmp.open("w")) {
            tmp.encoding = "BINARY";
            tmp.write(latin);
            tmp.close();
        }
        if (tmp.open("r")) {
            tmp.encoding = "GBK";
            out = tmp.read();
            tmp.close();
        }
    } catch (e) {}
    try { if (tmp.exists) tmp.remove(); } catch (e) {}
    return out;
}

// 探测编码并读取 CSV
function BT_ReadCSV(filePath) {
    var bytes = BT_ReadFileBytes(filePath);
    if (!bytes || bytes.length === 0) return null;

    // 探测 UTF-8 BOM
    var isUtf8 = false;
    var isBom = false;
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        isBom = true;
        isUtf8 = true;
    }
    // 无 BOM 时探测是否为合法 UTF-8 序列
    if (!isBom) {
        isUtf8 = BT_IsValidUTF8(bytes);
    }

    var text;
    if (isUtf8) {
        // 去掉 BOM（用循环复制，避免 slice 兼容问题）
        var startIdx = isBom ? 3 : 0;
        var utf8bytes = [];
        for (var bIdx = startIdx; bIdx < bytes.length; bIdx++) utf8bytes.push(bytes[bIdx]);
        text = BT_UTF8ToStr(utf8bytes);
    } else {
        // GBK 文件：优先尝试 File 直接 GBK 读取（更可靠）
        text = BT_GBKReadFile(filePath);
    }

    return BT_ParseCSV(text);
}


function BT_IsValidUTF8(bytes) {
    var i = 0;
    var validUtf8 = 0;   // 合法 UTF-8 多字节序列数
    var nonAscii = 0;    // 非 ASCII 字节（>=0x80）触发的高位字节数
    while (i < bytes.length) {
        var b = bytes[i];
        var len;
        if (b < 0x80) { i++; continue; }
        nonAscii++;
        if (b >= 0xC2 && b < 0xE0) len = 2;
        else if (b >= 0xE0 && b < 0xF0) len = 3;
        else if (b >= 0xF0 && b < 0xF8) len = 4;
        else { i++; continue; }  // 高位字节非法，继续（GBK 常见）
        if (i + len > bytes.length) { i++; continue; }
        var ok = true;
        for (var j = 1; j < len; j++) {
            var nb = bytes[i+j];
            if (nb < 0x80 || nb > 0xBF) { ok = false; break; }
        }
        if (ok) {
            validUtf8++;
            i += len;
        } else {
            i++;
        }
    }
    // 没有非 ASCII 字节 → 纯 ASCII，UTF-8 与 GBK 等价，判定为 UTF-8
    if (nonAscii === 0) return true;
    // 合法 UTF-8 多字节序列占比高 → UTF-8；占比低 → GBK
    return (validUtf8 / nonAscii) > 0.8;
}

// 解析 CSV 文本为二维数组 [[header...], [row1...], ...]
function BT_ParseCSV(text) {
    // 判断分隔符
    var delim = BT_DetectDelimiter(text);
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    var i = 0;
    var len = text.length;
    while (i < len) {
        var ch = text.charAt(i);
        if (inQuotes) {
            if (ch === '"') {
                if (text.charAt(i+1) === '"') {
                    field += '"';
                    i += 2;
                    continue;
                } else {
                    inQuotes = false;
                    i++;
                    continue;
                }
            } else {
                field += ch;
                i++;
            }
        } else {
            if (ch === '"' && field.length === 0) {
                inQuotes = true;
                i++;
            } else if (ch === delim) {
                row.push(field);
                field = "";
                i++;
            } else if (ch === "\n") {
                row.push(field);
                rows.push(row);
                row = [];
                field = "";
                i++;
            } else if (ch === "\r") {
                // 忽略 \r
                i++;
            } else {
                field += ch;
                i++;
            }
        }
    }
    // 收尾
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    // 清理空行
    var cleaned = [];
    for (var r = 0; r < rows.length; r++) {
        var hasContent = false;
        for (var c = 0; c < rows[r].length; c++) {
            if (rows[r][c] !== "" && rows[r][c] !== undefined) { hasContent = true; break; }
        }
        if (hasContent) cleaned.push(rows[r]);
    }
    return cleaned;
}

function BT_DetectDelimiter(text) {
    var firstLine = text.split(/\r?\n/)[0] || "";
    var countComma = (firstLine.match(/,/g) || []).length;
    var countTab = (firstLine.match(/\t/g) || []).length;
    if (countTab > countComma) return "\t";
    return ",";
}

// ============================================================
//  文字层扫描
// ============================================================
function BT_FindAllTextLayers() {
    BT_AllTextLayers = [];
    if (!app.project || !app.project.activeItem || !(app.project.activeItem instanceof CompItem)) {
        alert("请先打开一个合成");
        return false;
    }
    var activeComp = app.project.activeItem;
    BT_TraverseLayers(activeComp, activeComp.name);
    return true;
}

function BT_TraverseLayers(comp, parentPath) {
    for (var i = 1; i <= comp.numLayers; i++) {
        var layer = comp.layers[i];
        try {
            if (layer.property("Source Text") !== null) {
                layer.parentCompPath = parentPath;
                layer.originalComp = comp;
                layer.originalCompIndex = BT_GetCompIndexInProject(comp);
                layer.layerKey = BT_LayerKey(layer);
                BT_AllTextLayers.push(layer);
            }
        } catch (e) {}
        // 预合成递归
        try {
            if (layer instanceof AVLayer && layer.source instanceof CompItem) {
                var newPath = parentPath + " > " + layer.name;
                BT_TraverseLayers(layer.source, newPath);
            }
        } catch (e) {}
    }
}

function BT_GetCompIndexInProject(targetComp) {
    for (var i = 1; i <= app.project.numItems; i++) {
        if (app.project.item(i) === targetComp) return i;
    }
    return -1;
}

// ============================================================
//  撤销历史
// ============================================================
function BT_SaveToHistory(indices) {
    var entry = [];
    for (var i = 0; i < indices.length; i++) {
        var idx = indices[i];
        if (idx >= 0 && idx < BT_AllTextLayers.length) {
            var layer = BT_AllTextLayers[idx];
            var oldText = BT_GetSourceText(layer);
            if (oldText !== null) {
                entry.push({ key: layer.layerKey, oldText: oldText });
            }
        }
    }
    BT_TextLayerHistory.push(entry);
    if (BT_TextLayerHistory.length > 50) BT_TextLayerHistory.shift();
}

function BT_UndoLastChange() {
    if (BT_TextLayerHistory.length === 0) {
        alert("没有可撤销的操作");
        return;
    }
    var last = BT_TextLayerHistory.pop();
    app.beginUndoGroup("批量文字替换-撤销");
    for (var i = 0; i < last.length; i++) {
        var layer = BT_ResolveLayer(last[i].key);
        if (layer) BT_SetSourceText(layer, last[i].oldText);
    }
    app.endUndoGroup();
    alert("已撤销 " + last.length + " 个图层的修改");
}

// ============================================================
//  基础替换逻辑（保留参考插件两种模式）
// ============================================================
function BT_ReplaceSelected(listBox, editText) {
    var newText = editText.text;
    var selectedItems = listBox.selection;
    if (!selectedItems || selectedItems.length === 0) {
        alert("请先选择要替换的文字层");
        return;
    }
    // 获取选中索引
    var selIdx = [];
    for (var i = 0; i < selectedItems.length; i++) {
        for (var j = 0; j < listBox.items.length; j++) {
            if (listBox.items[j] === selectedItems[i]) { selIdx.push(j); break; }
        }
    }
    // 判断是否全为单字符图层
    var isAllSingle = true;
    var selLayers = [];
    for (var k = 0; k < selIdx.length; k++) {
        var layer = BT_AllTextLayers[selIdx[k]];
        selLayers.push(layer);
        var cur = BT_GetSourceText(layer);
        if (!cur || cur.length !== 1) { isAllSingle = false; break; }
    }
    app.beginUndoGroup("批量文字替换");
    if (isAllSingle && newText.length === selLayers.length) {
        // 智能单字匹配
        BT_SaveToHistory(selIdx);
        for (var m = 0; m < selLayers.length; m++) {
            BT_SetSourceText(selLayers[m], newText.charAt(m));
        }
        alert("已按字符顺序替换 " + selLayers.length + " 个文字层");
    } else {
        if (isAllSingle && newText.length !== selLayers.length) {
            alert("选中了 " + selLayers.length + " 个单个文字层，但输入了 " + newText.length + " 个字符\n将使用普通替换模式（所有图层替换为相同内容）");
        }
        BT_SaveToHistory(selIdx);
        for (var n = 0; n < selIdx.length; n++) {
            BT_SetSourceText(BT_AllTextLayers[selIdx[n]], newText);
        }
        alert("已将 " + selIdx.length + " 个图层替换为相同内容");
    }
    app.endUndoGroup();
}

// ============================================================
//  跳转定位
// ============================================================
function BT_JumpToSelected(listBox) {
    var selItems = listBox.selection;
    if (!selItems || selItems.length === 0) { alert("请先选择文字层"); return; }
    var selIdx = [];
    for (var i = 0; i < selItems.length; i++) {
        for (var j = 0; j < listBox.items.length; j++) {
            if (listBox.items[j] === selItems[i]) { selIdx.push(j); break; }
        }
    }
    var targetComp = null, targetCompIdx = -1, count = 0;
    for (var k = 0; k < selIdx.length; k++) {
        var layer = BT_AllTextLayers[selIdx[k]];
        if (layer && layer.property("Source Text")) {
            if (!targetComp) { targetComp = layer.originalComp; targetCompIdx = layer.originalCompIndex; }
            count++;
        }
    }
    if (!targetComp) { alert("未找到有效文字层"); return; }
    try {
        // 取消项目选中
        try { app.project.deselectAll(); } catch(e){}
        var pc = app.project.item(targetCompIdx);
        if (pc && pc instanceof CompItem) {
            pc.selected = true;
            try { targetComp.openInViewer(); } catch(e2){
                try { app.activeView.composition = targetComp; } catch(e3){}
            }
            try { targetComp.deselectAllLayers(); } catch(e){}
            var selCnt = 0;
            for (var m = 0; m < selIdx.length; m++) {
                var l = BT_AllTextLayers[selIdx[m]];
                if (l.originalComp === targetComp) {
                    try { l.selected = true; } catch(e){}
                    selCnt++;
                    if (selCnt === 1) {
                        try { targetComp.time = l.inPoint; } catch(e){}
                    }
                }
            }
            alert("已跳转到合成：\n" + targetComp.name + "\n选中 " + selCnt + " 个文字层");
        }
    } catch (e) {
        alert("跳转失败：\n" + e.message);
    }
}

// ============================================================
//  变量映射相关
// ============================================================
// 打开映射编辑界面
function BT_OpenMappingUI(ui) {
    var win = new Window("palette", "变量映射配置", [0, 0, 640, 520]);
    // 顶部说明
    win.add("statictext", [10, 8, 630, 30], "为每个文字层指定一个变量名（对应CSV表头），然后点“设为变量”，全部设置完再点“保存映射”。");
    // 诊断状态栏
    var diagText = win.add("statictext", [10, 30, 630, 48], "", {multiline:true});
    diagText.graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 11);
    // 左：文字层列表，右：变量名输入
    var layerLabel = win.add("statictext", [10, 52, 300, 70], "文字层列表");
    var nameLabel = win.add("statictext", [320, 52, 630, 70], "变量名（CSV表头）");
    var layerList = win.add("listbox", [10, 75, 300, 430], [], {multiselect: false});
    var nameEdit = win.add("edittext", [320, 75, 630, 100], "", {multiline: false});
    nameEdit.alignment = ["left", "top"];
    var assignBtn = win.add("button", [320, 110, 420, 135], "设为变量");
    var clearBtn = win.add("button", [430, 110, 530, 135], "清除变量");
    var showAllBtn = win.add("button", [540, 110, 630, 135], "显示全部");

    // 当前映射的临时存储
    var tempMap = {}; // layerKey -> 变量名

    // 更新诊断信息
    function updateDiag() {
        var info = "扫描到文字层：" + BT_AllTextLayers.length + " 个  |  已映射：" + BT_CountMapping() + " 条";
        var sel = layerList.selection;
        if (sel && sel.length > 0) {
            info += "  |  当前选中：" + sel[0].text;
        } else {
            info += "  |  当前未选中";
        }
        diagText.text = info;
    }

    // 维护一个与 listbox 列表项一一对应的图层 key 数组（解决选中解析不可靠问题）
    var displayKeys = [];
    var lastSelectedKey = null; // 最近一次点击选中的图层 key（最强兜底）

    // 重新填充列表（可筛选已映射的）
    function refillList(showAll) {
        layerList.removeAll();
        displayKeys.length = 0;
        for (var i = 0; i < BT_AllTextLayers.length; i++) {
            var layer = BT_AllTextLayers[i];
            var mapped = BT_MappingConfig[layer.layerKey];
            if (!showAll && mapped) continue; // 仅显示未映射
            var txt = layer.name + "  [" + layer.parentCompPath + "]";
            if (mapped) txt += "  =  " + mapped;
            layerList.add("item", txt);
            displayKeys.push(layer.layerKey);
        }
        updateDiag();
    }
    // 初始填充列表
    refillList(true);

    // 从当前列表选中项解析对应图层 key（遍历 items 找选中项，最可靠）
    function getSelectedKey() {
        // 方法1：遍历所有 items，找 selected 为 true 的
        var foundIndex = -1;
        for (var i = 0; i < layerList.items.length; i++) {
            try {
                if (layerList.items[i].selected) { foundIndex = i; break; }
            } catch (e) {}
        }
        // 方法2：用 selection（部分系统可靠）
        if (foundIndex < 0) {
            var sel = layerList.selection;
            if (sel && sel.length > 0) {
                for (var j = 0; j < layerList.items.length; j++) {
                    if (layerList.items[j] === sel[0]) { foundIndex = j; break; }
                }
            }
        }
        if (foundIndex >= 0 && foundIndex < displayKeys.length) {
            lastSelectedKey = displayKeys[foundIndex];
            return displayKeys[foundIndex];
        }
        // 方法3：兜底用最近点击记住的 key
        return lastSelectedKey;
    }

    // 点击列表项时回填当前映射的变量名
    layerList.onChange = function() {
        var key = getSelectedKey();
        if (key && BT_MappingConfig[key]) {
            nameEdit.text = BT_MappingConfig[key];
        } else {
            nameEdit.text = "";
        }
        updateDiag();
    };

    assignBtn.onClick = function() {
        var vname = nameEdit.text.replace(/^\s+|\s+$/g, "");
        if (!vname) { alert("请输入变量名"); return; }
        if (vname.indexOf(",") >= 0 || vname.indexOf("\t") >= 0) { alert("变量名不能包含逗号或制表符"); return; }
        var key = getSelectedKey();
        if (key) {
            BT_MappingConfig[key] = vname;
            nameEdit.text = "";
            refillList(true);
            updateDiag();
            alert("已将图层映射为变量：" + vname + "\n当前共映射 " + BT_CountMapping() + " 条");
        } else {
            var selCount = 0;
            for (var di = 0; di < layerList.items.length; di++) {
                try { if (layerList.items[di].selected) selCount++; } catch (e) {}
            }
            alert("未能识别选中的文字层（当前列表共 " + layerList.items.length + " 项，检测到选中 " + selCount + " 项）。\n请先在左侧列表点击选中一个文字层，再点“设为变量”。");
        }
    };

    clearBtn.onClick = function() {
        var key = getSelectedKey();
        if (key && BT_MappingConfig[key]) {
            delete BT_MappingConfig[key];
            nameEdit.text = "";
            refillList(true);
            updateDiag();
            alert("已清除该图层映射");
        } else {
            alert("当前图层没有映射");
        }
    };

    showAllBtn.onClick = function() { refillList(true); };

    var saveBtn = win.add("button", [10, 475, 160, 505], "保存映射到项目");
    var loadBtn = win.add("button", [170, 475, 320, 505], "从项目载入映射");
    var closeBtn = win.add("button", [330, 475, 480, 505], "关闭");

    saveBtn.onClick = function() {
        if (BT_CountMapping() === 0) {
            alert("当前没有任何映射！\n请先在左侧选中文字层，右侧输入变量名，点“设为变量”后再保存。");
            return;
        }
        var saveFile = BT_MappingFilePath();
        var f = new File(saveFile);
        if (f.open("w")) {
            var content = "";
            for (var k in BT_MappingConfig) {
                content += k + "\t" + BT_MappingConfig[k] + "\n";
            }
            f.write(content);
            f.close();
            updateDiag();
            alert("映射已保存（共 " + BT_CountMapping() + " 条）到：\n" + saveFile);
        } else {
            alert("保存映射失败，请检查权限");
        }
    };
    loadBtn.onClick = function() {
        if (BT_LoadMappingFromFile()) {
            refillList(true);
            alert("已载入 " + BT_CountMapping() + " 条映射");
        } else {
            alert("未找到保存的映射配置文件\n" + BT_MappingFilePath());
        }
    };
    closeBtn.onClick = function() { win.close(); };

    win.center();
    win.show();
}

function BT_CountMapping() {
    var c = 0;
    for (var k in BT_MappingConfig) c++;
    return c;
}

// 映射配置文件路径（脚本同目录，持久保存）
function BT_MappingFilePath() {
    try {
        var f = new File($.fileName);
        var dir = f.path;
        return dir + "/_批量文字替换_映射配置.txt";
    } catch (e) {
        return Folder.myDocuments.fsName + "/_批量文字替换_映射配置.txt";
    }
}

// 从映射配置文件载入映射到 BT_MappingConfig；成功返回 true，无文件返回 false
function BT_LoadMappingFromFile() {
    var loadFile = BT_MappingFilePath();
    var f = new File(loadFile);
    if (f.exists && f.open("r")) {
        var content = f.read();
        f.close();
        BT_MappingConfig = {};
        var lines = content.split("\n");
        for (var i = 0; i < lines.length; i++) {
            if (lines[i] === "") continue;
            var sep = lines[i].indexOf("\t");
            if (sep > 0) {
                var key = lines[i].substring(0, sep);
                var vname = lines[i].substring(sep+1);
                BT_MappingConfig[key] = vname;
            }
        }
        return BT_CountMapping() > 0;
    }
    return false;
}

// 清理失效的映射：换模板/换项目后，旧映射的图层 key（形如 "131:2.2.6.1.1.1"）无法再
// 解析到当前项目中的文字层。此函数自动检测并删除这些失效 key，返回被清理的数量。
function BT_PruneInvalidMappings() {
    var removed = 0;
    var badKeys = [];
    for (var k in BT_MappingConfig) {
        var l = null;
        try {
            l = BT_ResolveLayer(k);
        } catch (e) {
            l = null; // 解析抛异常也视为失效
        }
        if (!l) {
            badKeys.push(k);
        }
    }
    for (var i = 0; i < badKeys.length; i++) {
        delete BT_MappingConfig[badKeys[i]];
        removed++;
    }
    return removed;
}

// ============================================================
//  数据驱动批量填充 + 渲染
// ============================================================
function BT_BatchFill(ui) {
    // 检查映射
    if (BT_CountMapping() === 0) {
        alert("请先配置变量映射（点击“变量映射”按钮）");
        return;
    }

    // 自动清理失效映射：换了模板/项目后，旧映射的图层 key 无法解析，先剔除，避免静默失败
    var pruned = BT_PruneInvalidMappings();
    if (pruned > 0) {
        alert("检测到 " + pruned + " 条映射已失效（可能是更换了模板或项目文件）。\n已自动清除这些旧映射。\n\n请点【变量映射配置】为新模板重新指定变量名，再重新批量填充。");
    }
    if (BT_CountMapping() === 0) {
        alert("当前没有可用的变量映射（旧映射已失效）。\n请先点【变量映射配置】，为新模板的文字层指定变量名。");
        return;
    }

    // 选择 CSV
    var csvFile = File.openDialog("请选择 CSV 数据文件", "CSV 文件:*.csv;*.txt;所有文件:*.*");
    if (!csvFile) return;
    var data = BT_ReadCSV(csvFile.fsName);
    if (!data || data.length < 2) {
        alert("CSV 文件为空或只有表头，请检查");
        return;
    }
    var header = data[0];
    var rows = data.slice(1);

    // 数据预览：用可靠的 confirm() 确认数据（ScriptUI 窗口在部分环境不稳定，故用简单对话框）
    var preview = "";
    var previewRows = Math.min(rows.length, 8);
    for (var p = 0; p < previewRows; p++) {
        var pf = [];
        for (var pc = 0; pc < Math.min(header.length, 5); pc++) {
            pf.push(rows[p][pc] === undefined ? "" : String(rows[p][pc]));
        }
        preview += "  " + pf.join(" | ") + "\n";
    }
    if (rows.length > previewRows) preview += "  ...等共 " + rows.length + " 行\n";

    var okGo = confirm("已导入数据：共 " + rows.length + " 行，表头 " + header.length + " 列。\n\n数据预览（前几行）：\n" + preview + "\n\n点【确定】开始批量渲染。\n点【取消】停止（如需编辑数据，请修改 CSV 文件后重新导入）。");
    if (!okGo) return; // 用户取消

    if (rows.length < 1) {
        alert("数据为空或只有表头，无法批量处理");
        return;
    }

    // 校验表头与映射对应
    var mapToCol = {}; // 变量名 -> 列索引
    for (var h = 0; h < header.length; h++) {
        var hv = (header[h] || "").replace(/^\s+|\s+$/g, "");
        mapToCol[hv] = h;
    }
    // 检查映射的变量是否都在表头中
    var missing = [];
    for (var mk in BT_MappingConfig) {
        var vn = BT_MappingConfig[mk];
        if (vn && !(vn in mapToCol)) {
            missing.push(vn);
        }
    }
    if (missing.length > 0) {
        alert("以下变量在 CSV 表头中未找到：\n" + missing.join(", ") + "\n请检查表头或映射配置。");
        return;
    }

    // ===== 输出设置（精简）：不再让用户选输出目录（产物实际输出到模板旧路径）=====
    // 用项目文件所在目录作为默认输出目录（仅用于记录，实际渲染由 AE 决定）
    var outDir = "";
    try {
        var projFile = app.project.file;
        if (projFile) {
            outDir = new Folder(projFile.parent).fsName;
        } else {
            outDir = Folder.myDocuments.fsName;
        }
    } catch (e) {
        outDir = Folder.myDocuments.fsName;
    }
    BT_OutputDir = outDir;

    // 命名列：固定使用"中文名"列；若无则用第一列
    var nameColChoice = -1;
    for (var ni = 0; ni < header.length; ni++) {
        var hvName = (header[ni] || "").replace(/^\s+|\s+$/g, "");
        if (hvName === "中文名") { nameColChoice = ni; break; }
    }
    if (nameColChoice < 0) nameColChoice = 0;
    BT_NameColumn = header[nameColChoice];

    // 验证映射 key 能否在模板合成中解析（提前诊断，避免每行都失败）
    var tplComp = app.project.activeItem;
    if (!tplComp || !(tplComp instanceof CompItem)) {
        alert("请先打开要渲染的模板合成（当前激活的合成）");
        return;
    }
    var diagBad = [];
    for (var dk in BT_MappingConfig) {
        var dl = null;
        try {
            dl = BT_ResolveLayer(dk);
        } catch (e) {
            dl = null;
        }
        if (!dl) {
            diagBad.push(BT_MappingConfig[dk] + " (key=" + dk + ")");
        }
    }
    if (diagBad.length > 0) {
        alert("以下映射无法在模板合成中找到对应文字层：\n" + diagBad.join("\n") + "\n\n请重新打开模板合成并【刷新】后重新映射。");
        return;
    }

    // 进入批量处理（BT_ProcessRows 内部会逐行渲染并弹出完成提示）
    BT_ProcessRows(rows, header, mapToCol, nameColChoice, outDir.fsName);
}

// 恢复图层到原始文字（以及原始 position，若已记录）
// originals: key -> {layer: 图层对象, text: 原始文本, pos: 原始位置数组（可选）}
function BT_RestoreLayers(originals) {
    if (!originals) return;
    for (var rk in originals) {
        var rec = originals[rk];
        if (rec && rec.layer) {
            if (rec.text !== null) {
                BT_SetSourceText(rec.layer, rec.text);
            }
            // 恢复原始 position（对齐功能会改 position，逐行渲染需还原）
            if (rec.pos) {
                try {
                    var pp = rec.layer.property("ADBE Transform Group").property("ADBE Position");
                    if (pp) pp.setValue(rec.pos);
                    else if (rec.layer.position !== undefined) rec.layer.position.setValue(rec.pos);
                } catch (e) {}
            }
        }
    }
}

// 逐行处理：每行 填充模板 -> 验证 -> 加入渲染队列并同步渲染 -> 恢复模板 -> 下一行
// 为什么逐行渲染而不是"先填充所有再批量渲染"？
// 文字层可能深藏在嵌套预合成中，duplicate() 对嵌套预合成为共享引用，
// 无法通过"副本隔离"实现批量渲染（撤销填充会污染副本）。
// 因此采用逐行渲染：每行填充后立即渲染输出，渲染完成后再恢复模板处理下一行。
// 每行渲染时模板内容就是该行的正确内容，保证每个产物正确。
function BT_ProcessRows(rows, header, mapToCol, nameColIdx, outDir) {
    var allOk = true;
    var failRows = [];
    var successCount = 0;

    var templateComp = app.project.activeItem;
    if (!templateComp || !(templateComp instanceof CompItem)) {
        alert("请先打开要渲染的模板合成");
        return false;
    }
    var rq = app.project.renderQueue;

    // 0. 清空渲染队列：删除所有旧渲染项，避免旧项（含模板乱码输出路径）被误渲染干扰。
    var removedCount = 0;
    var stuckCount = 0;
    for (var ci = rq.numItems; ci >= 1; ci--) {
        try {
            var citem = rq.item(ci);
            var cstatus = citem.status;
            // 状态 1=等待 2=待输出 3=渲染中 4=完成 5=出错 6=停止 7=暂停
            if (cstatus === 3 || cstatus === 7) {
                // 渲染中/暂停的项无法删除，跳过并计数
                stuckCount++;
            } else {
                citem.remove();
                removedCount++;
            }
        } catch (e) {}
    }
    if (stuckCount > 0) {
        alert("警告：渲染队列中有 " + stuckCount + " 个正在渲染/暂停的项无法自动清除。\n请先在 AE 渲染队列面板手动停止/删除它们，否则可能导致渲染冲突。");
    }

    // 渲染前综合提示（合并原清空提示和开始提示，减少打断）
    var startMsg = "开始批量渲染：共 " + rows.length + " 行。\n\n脚本将逐行渲染，每行渲染完成后自动继续下一行。\n渲染期间脚本会暂停，请耐心等待，界面底部的进度条会实时显示进度。\n\n点击“确定”开始。";
    if (removedCount > 0) {
        startMsg = "已清空渲染队列中 " + removedCount + " 个旧项。\n\n" + startMsg;
    }
    alert(startMsg);

    // 初始化进度条
    BT_UpdateProgress(0, rows.length, "开始批量渲染...");

    for (var r = 0; r < rows.length; r++) {
        var row = rows[r];

        // 更新进度条：进入第 r+1 行
        BT_UpdateProgress(r, rows.length, "正在处理第 " + (r + 1) + " / " + rows.length + " 行");

        // 0. 解析所有映射图层并记录原始文字（缓存图层对象，填充/验证/恢复复用，避免重复解析）
        var resolvedLayers = {}; // key -> 图层对象
        var originals = {};      // key -> {layer, text, pos}
        for (var omk in BT_MappingConfig) {
            var ol = BT_ResolveLayer(omk);
            resolvedLayers[omk] = ol;
            var opos = null;
            if (ol) {
                try {
                    var opp = ol.property("ADBE Transform Group").property("ADBE Position");
                    if (opp) opos = opp.value;
                    else if (ol.position !== undefined) opos = ol.position.value;
                } catch (e) {}
            }
            originals[omk] = { layer: ol, text: ol ? BT_GetSourceText(ol) : null, pos: opos };
        }

        // 1. 在原始模板合成中填充
        var fillErrors = [];
        for (var mk in BT_MappingConfig) {
            var vn = BT_MappingConfig[mk];
            var colIdx = mapToCol[vn];
            var val = (colIdx !== undefined && colIdx < row.length) ? row[colIdx] : "";
            var layer = resolvedLayers[mk];
            if (layer) {
                if (!BT_SetSourceText(layer, val)) {
                    fillErrors.push(vn + "(图层:" + layer.name + ", 赋值失败)");
                }
            } else {
                fillErrors.push(vn + "(图层解析失败, key=" + mk + ", 变量=" + vn + ")");
            }
        }

        if (fillErrors.length > 0) {
            failRows.push("第" + (r+1) + "行 填充失败: " + fillErrors.join("; "));
            allOk = false;
            BT_RestoreLayers(originals);
            continue;
        }

        // 1.5 对称对齐：以参考图层（op光）为中心，把称号/人名左右对称摆放
        var alignResult = BT_AlignToReference(resolvedLayers, templateComp);
        if (BT_DebugAlign) {
            alert("【对齐诊断】第 " + (r+1) + " 行\n" + alignResult.msg);
        } else if (!alignResult.ok) {
            // 对齐失败不中断渲染，仅提示（记录到进度状态）
            BT_UpdateProgress(successCount, rows.length, "第 " + (r+1) + " 行 对齐提示：" + alignResult.msg);
        }

        // 2. 验证填充是否正确
        var verifyErrors = [];
        for (var mk2 in BT_MappingConfig) {
            var vn2 = BT_MappingConfig[mk2];
            var colIdx2 = mapToCol[vn2];
            var expect = (colIdx2 !== undefined && colIdx2 < row.length) ? row[colIdx2] : "";
            var layer2 = resolvedLayers[mk2];
            var actual = layer2 ? BT_GetSourceText(layer2) : null;
            if (actual !== expect) {
                verifyErrors.push(vn2 + "(期望:" + expect + ", 实际:" + actual + ")");
            }
        }
        if (verifyErrors.length > 0) {
            failRows.push("第" + (r+1) + "行 验证失败: " + verifyErrors.join("; "));
            allOk = false;
            BT_RestoreLayers(originals);
            continue;
        }

        // 3. 加入渲染队列并同步渲染该行
        var nameVal = (nameColIdx < row.length) ? row[nameColIdx] : ("row_" + (r+1));
        nameVal = BT_SanitizeFilename(nameVal);
        var renderOK = BT_RenderRow(rq, templateComp, outDir, nameVal, r+1);
        if (!renderOK) {
            failRows.push("第" + (r+1) + "行 渲染失败");
            allOk = false;
            BT_RestoreLayers(originals);
            continue;
        }

        // 4. 显式恢复模板原始状态，处理下一行
        BT_RestoreLayers(originals);
        successCount++;

        // 更新进度条：该行完成
        BT_UpdateProgress(successCount, rows.length, "第 " + (r + 1) + " 行已渲染完成：" + nameVal);

        // 5. 行间等待：渲染完一行后短暂停留（用 $.sleep 等待，不弹窗打断），随后自动继续下一行
        if (r < rows.length - 1) {
            $.sleep(1200);
        }
    }

    if (failRows.length > 0) {
        BT_UpdateProgress(successCount, rows.length, "批量处理结束：成功 " + successCount + " 行，失败 " + failRows.length + " 行");
        alert("以下行处理存在问题：\n" + failRows.join("\n"));
    }
    BT_UpdateProgress(rows.length, rows.length, "全部处理完成，成功 " + successCount + " 行，失败 " + failRows.length + " 行");
    alert("批量处理完成：\n成功 " + successCount + " 行，失败 " + failRows.length + " 行。\n产物已输出到：" + outDir + "\n（若脚本执行慢，属正常现象，每行需渲染后才能继续）");
    return allOk;
}

// 将指定合成加入渲染队列并同步渲染这一行
// 返回 true 表示渲染成功，false 表示失败/被取消
// 说明：AE 渲染时坚持输出到模板输出模块保存的旧路径，脚本无法通过 om.file 控制输出目录。
// 因此这里不再设置 om.file，只通过"临时改合成名"解决产物命名（AE 用合成名作为默认输出名）。
function BT_RenderRow(rq, comp, outDir, baseName, rowNum) {
    var item = null;
    try {
        item = rq.items.add(comp);
        var om = item.outputModule;

        // 渲染范围：优先用合成工作区（入点/出点），否则全时长
        try {
            item.timeSpanStart = comp.workAreaStart;
            item.timeSpanDuration = comp.workAreaEnd - comp.workAreaStart;
        } catch (e) {
            item.timeSpanStart = 0;
            item.timeSpanDuration = comp.duration;
        }
        item.name = "批量-" + baseName;
        item.render = true;

        // ---- 关键：临时把合成名改为中文名，让 AE 输出时用中文名命名 ----
        var originalCompName = comp.name;
        try { comp.name = baseName; } catch (e) {}

        // 只渲染当前项：尝试把其它项设为不渲染。
        // 注意：状态为"渲染中/完成/停止"的项无法修改 render，需跳过，否则报错。
        for (var i = 1; i <= rq.numItems; i++) {
            var other = rq.item(i);
            if (other === item) continue;
            try {
                var otherStatus = other.status;
                // 状态 1=等待 2=待输出 3=渲染中 4=完成 5=出错 6=停止
                if (otherStatus === 1 || otherStatus === 2) {
                    other.render = false;
                }
            } catch (e) {}
        }

        // 启动渲染（AE 中 render() 同步阻塞，渲染完成才返回）
        rq.render();

        // 恢复合成原名
        try { comp.name = originalCompName; } catch (e) {}

        // 渲染完成判断：只要不是明确错误/停止状态即视为成功
        var finalStatus = item.status;
        var ok = !(finalStatus === 5 || finalStatus === 6);
        if (!ok) {
            var statusName = "状态码 " + finalStatus;
            if (finalStatus === 5) statusName = "出错";
            else if (finalStatus === 6) statusName = "被停止";
            alert("第" + rowNum + "行渲染未完成（" + statusName + "）");
        }
        return ok;
    } catch (e) {
        alert("渲染第" + rowNum + "行出错：" + e.message);
        return false;
    } finally {
        try {
            if (item) item.remove();
        } catch (e) {}
    }
}

// 清理文件名非法字符
function BT_SanitizeFilename(name) {
    name = (name || "").replace(/[\\\/:*?"<>|]/g, "_");
    if (name === "") name = "output";
    return name;
}

// ============================================================
//  主界面
// ============================================================
function BT_CreateUI() {
    var isPanelMode = (this instanceof Panel);
    var container = isPanelMode ? this : new Window("palette", "批量文字替换工具", [0, 0, 560, 736], {resizeable: true});

    // ===== 顶部标题 =====
    var title = container.add("statictext", [8, 6, 280, 28], "批量文字替换工具");
    title.graphics.font = ScriptUI.newFont("Microsoft YaHei", "bold", 16);

    // ===== 模块1：基础文字替换 =====
    var sec1 = container.add("statictext", [8, 34, 540, 52], "━━ 基础文字替换 ━━");
    sec1.graphics.font = ScriptUI.newFont("Microsoft YaHei", "bold", 12);
    try { sec1.graphics.foregroundColor = ScriptUI.newColor(0, 120, 215); } catch (e) {}

    // 文字层列表 + 替换输入
    var searchEdit = container.add("edittext", [8, 56, 340, 78], "", "搜索文字层...");
    searchEdit.graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 11);

    var listBox = container.add("listbox", [8, 84, 340, 320], [], {multiselect: true});
    listBox.graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 11);

    var replaceEdit = container.add("edittext", [352, 84, 545, 320], "", {multiline: true});
    replaceEdit.graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 11);

    container.add("statictext", [352, 62, 460, 82], "输入替换文字", {multiline:true}).graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 11);

    // 操作按钮（右侧竖排）
    var refreshBtn = container.add("button", [352, 330, 445, 356], "刷新");
    var selectAllBtn = container.add("button", [455, 330, 545, 356], "全选");
    var applyBtn = container.add("button", [352, 364, 445, 390], "应用");
    var undoBtn = container.add("button", [455, 364, 545, 390], "撤回");
    var jumpBtn = container.add("button", [352, 398, 545, 424], "跳转定位");

    // ===== 模块2：数据驱动批量填充 =====
    var sec2 = container.add("statictext", [8, 434, 540, 452], "━━ 数据驱动批量填充 ━━");
    sec2.graphics.font = ScriptUI.newFont("Microsoft YaHei", "bold", 12);
    try { sec2.graphics.foregroundColor = ScriptUI.newColor(215, 90, 0); } catch (e) {}

    var mapBtn = container.add("button", [8, 458, 160, 484], "1.变量映射配置");
    var csvInfo = container.add("statictext", [170, 460, 545, 482], "为文字层指定变量名（对应CSV表头），脚本启动时自动载入", {multiline:true});
    csvInfo.graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 11);

    var batchBtn = container.add("button", [8, 492, 160, 518], "2.选择CSV并批量填充");
    var batchInfo = container.add("statictext", [170, 494, 545, 516], "选CSV→确认→自动逐行渲染，文件名取中文名列", {multiline:true});
    batchInfo.graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 11);

    // ===== 对称对齐设置（称号/人名以参考图层 op光 为中心左右对称） =====
    var alignChk = container.add("checkbox", [8, 524, 180, 546], "对称对齐（以op光为中心）");
    alignChk.value = BT_AlignEnabled;
    alignChk.graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 11);
    alignChk.onClick = function() { BT_AlignEnabled = alignChk.value; };

    container.add("statictext", [188, 526, 300, 546], "参考图层名：", {multiline:false}).graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 11);
    var refNameEdit = container.add("edittext", [300, 524, 400, 546], BT_RefLayerName);
    refNameEdit.graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 11);
    refNameEdit.onChange = function() { BT_RefLayerName = refNameEdit.text; };

    container.add("statictext", [408, 526, 470, 546], "错开：", {multiline:false}).graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 11);
    var gapEdit = container.add("edittext", [470, 524, 545, 546], String(BT_Gap));
    gapEdit.graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 11);
    gapEdit.onChange = function() { var g = parseInt(gapEdit.text); if (!isNaN(g)) BT_Gap = g; };

    // 第二行：称号/人名的独立水平偏移微调
    container.add("statictext", [8, 552, 90, 572], "称号偏移：", {multiline:false}).graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 11);
    var leftOffEdit = container.add("edittext", [90, 550, 180, 572], String(BT_LeftOffset));
    leftOffEdit.graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 11);
    leftOffEdit.onChange = function() { var v = parseInt(leftOffEdit.text); if (!isNaN(v)) BT_LeftOffset = v; };

    container.add("statictext", [190, 552, 270, 572], "人名偏移：", {multiline:false}).graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 11);
    var rightOffEdit = container.add("edittext", [270, 550, 360, 572], String(BT_RightOffset));
    rightOffEdit.graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 11);
    rightOffEdit.onChange = function() { var v = parseInt(rightOffEdit.text); if (!isNaN(v)) BT_RightOffset = v; };

    container.add("statictext", [370, 552, 545, 572], "偏移：正值向右、负值向左", {multiline:false}).graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 10);

    // ===== 批量处理进度 =====
    var secProg = container.add("statictext", [8, 580, 540, 598], "━━ 批量处理进度 ━━");
    secProg.graphics.font = ScriptUI.newFont("Microsoft YaHei", "bold", 12);
    try { secProg.graphics.foregroundColor = ScriptUI.newColor(0, 150, 90); } catch (e) {}

    var progressBar = container.add("progressbar", [8, 602, 545, 622]);
    progressBar.maxvalue = 1;
    progressBar.value = 0;

    var progressText = container.add("statictext", [8, 626, 545, 646], "进度：0 / 0 行", {multiline:true});
    progressText.graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 11);

    var progressStatus = container.add("statictext", [8, 648, 545, 668], "尚未开始批量处理", {multiline:true});
    progressStatus.graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 11);

    // ===== 状态栏 + 帮助 =====
    var statusText = container.add("statictext", [8, 672, 545, 694], "状态：未扫描", {multiline:true});
    statusText.graphics.font = ScriptUI.newFont("Microsoft YaHei", "regular", 11);

    var helpBtn = container.add("button", [460, 698, 545, 720], "使用帮助");

    // ---- 绑定事件 ----
    (function(ui) {
        var fullLayers = [];  // 完整列表（未过滤）

        function refreshList() {
            ui.listBox.removeAll();
            fullLayers.length = 0;
            BT_FindAllTextLayers();
            fullLayers = BT_AllTextLayers.slice();
            var kw = (ui.searchEdit.text || "").toLowerCase();
            for (var i = 0; i < fullLayers.length; i++) {
                var layer = fullLayers[i];
                var display = layer.name + "  (" + layer.parentCompPath + ")";
                if (kw && display.toLowerCase().indexOf(kw) < 0) continue;
                ui.listBox.add("item", display);
            }
            ui.statusText.text = "状态：扫描到 " + BT_AllTextLayers.length + " 个文字层，当前显示 " + ui.listBox.items.length + " 个";
        }

        ui.refreshBtn.onClick = function() { refreshList(); };

        ui.selectAllBtn.onClick = function() {
            if (ui.listBox.items.length > 0) {
                var all = [];
                for (var i = 0; i < ui.listBox.items.length; i++) all.push(ui.listBox.items[i]);
                ui.listBox.selection = all;
            }
        };

        ui.applyBtn.onClick = function() {
            BT_ReplaceSelected(ui.listBox, ui.replaceEdit);
            ui.statusText.text = "状态：已完成替换（可点“撤回”撤销）";
        };

        ui.undoBtn.onClick = function() {
            BT_UndoLastChange();
        };

        ui.jumpBtn.onClick = function() {
            BT_JumpToSelected(ui.listBox);
        };

        // 搜索过滤
        ui.searchEdit.onChanging = function() {
            refreshList();
        };

        ui.listBox.onChange = function() {
            var sel = ui.listBox.selection;
            if (sel && sel.length === 1) {
                // 找到对应图层
                var dispIdx = sel[0].index;
                // 通过显示列表找对应
                var layer = BT_DisplayIndexToLayer(ui.listBox, fullLayers, dispIdx);
                if (layer) {
                    var t = BT_GetSourceText(layer);
                    if (t !== null) ui.replaceEdit.text = t;
                }
            }
        };

        ui.mapBtn.onClick = function() {
            BT_OpenMappingUI(ui);
        };

        ui.batchBtn.onClick = function() {
            BT_BatchFill(ui);
        };

        ui.helpBtn.onClick = function() {
            BT_ShowHelp();
        };

        // 初始化
        refreshList();

        // 启动时自动载入映射（无需每次手动设置）
        if (BT_LoadMappingFromFile()) {
            // 载入后自动清理失效映射（换模板/项目后旧 key 失效）
            var prunedAtStart = BT_PruneInvalidMappings();
            if (prunedAtStart > 0) {
                if (BT_CountMapping() === 0) {
                    ui.statusText.text = "状态：检测到旧模板映射已失效（已清除 " + prunedAtStart + " 条）。请点【变量映射配置】重新映射";
                } else {
                    ui.statusText.text = "状态：已载入 " + BT_CountMapping() + " 条映射，自动清除 " + prunedAtStart + " 条失效旧映射";
                }
            } else {
                ui.statusText.text = "状态：已自动载入 " + BT_CountMapping() + " 条映射（可点【变量映射配置】查看/修改）";
            }
        } else {
            alert("尚未配置变量映射。\n请点击【变量映射配置】，为模板中的文字层指定变量名（对应CSV表头）。");
        }
    })({
        listBox: listBox,
        replaceEdit: replaceEdit,
        searchEdit: searchEdit,
        statusText: statusText,
        refreshBtn: refreshBtn,
        selectAllBtn: selectAllBtn,
        applyBtn: applyBtn,
        undoBtn: undoBtn,
        jumpBtn: jumpBtn,
        mapBtn: mapBtn,
        batchBtn: batchBtn,
        helpBtn: helpBtn,
        progressBar: progressBar,
        progressText: progressText,
        progressStatus: progressStatus
    });

    // 挂载进度条到全局，供批量处理过程实时更新
    BT_ProgressBar = progressBar;
    BT_ProgressText = progressText;
    BT_ProgressStatus = progressStatus;
    BT_UpdateProgress(0, 0, "尚未开始批量处理");

    if (!isPanelMode) {
        container.center();
        container.show();
    }
    return container;
}

// 根据显示列表行号找到图层（考虑过滤：通过 item 文本去 fullLayers 匹配）
function BT_DisplayIndexToLayer(listBox, fullLayers, dispIdx) {
    var item = listBox.items[dispIdx];
    if (!item) return null;
    var txt = item.text;
    // 文本格式 "name  (parentPath)"
    for (var i = 0; i < fullLayers.length; i++) {
        var layer = fullLayers[i];
        var display = layer.name + "  (" + layer.parentCompPath + ")";
        if (display === txt) return layer;
    }
    return null;
}

// 使用帮助
function BT_ShowHelp() {
    var help = "【批量文字替换工具】使用说明\n\n" +
        "一、基础替换\n" +
        "1. 打开目标合成，点【刷新】扫描所有文字层\n" +
        "2. 在列表多选图层，右侧输入文字，点【应用】\n" +
        "   - 若选中多个单字图层且输入长度一致：按字符顺序逐字填入\n" +
        "   - 否则：所有选中图层替换为相同文字\n" +
        "3. 【撤回】撤销上一次批量操作\n\n" +
        "二、数据驱动批量填充（核心）\n" +
        "1. 点【变量映射配置】：为每个要替换的文字层指定一个变量名（对应CSV表头）\n" +
        "2. 准备CSV文件：第一行为表头（变量名），每行是一条记录\n" +
        "3. 点【选择CSV并批量填充】：\n" +
        "   - 选择CSV文件\n" +
        "   - 选择输出文件夹\n" +
        "   - 产物文件名自动取CSV【中文名】列的值（如 白术.mov）\n" +
        "   - 脚本自动：逐行填充→逐行验证→逐行自动渲染\n" +
        "   - 每行渲染完成才处理下一行，全部完成即全部输出\n\n" +
        "三、CSV格式示例\n" +
        "标题,副标题,日期,集号\n" +
        "第一集标题,副标题内容,2025-01-01,第一集\n" +
        "第二集标题,副标题内容,2025-01-02,第二集\n\n" +
        "提示：产物文件名取“集号”列的值，如 第一集.mp4，渲染格式沿用模板设置";
    alert(help);
}

// 入口
if (this instanceof Panel) {
    BT_CreateUI.call(this);
} else {
    BT_CreateUI();
}
