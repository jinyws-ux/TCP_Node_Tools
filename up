# core/report_generator.py
import html
import json
import logging
import os
from datetime import datetime
from typing import List, Dict, Any

class ReportGenerator:
    def __init__(self, output_dir: str):
        self.output_dir = output_dir
        self.logger = logging.getLogger(__name__)
        os.makedirs(output_dir, exist_ok=True)

    def _get_timestamp(self) -> str:
        """获取当前时间戳"""
        return datetime.now().strftime("%Y%m%d_%H%M%S")

    def _get_attr(self, obj: Any, key: str, default: Any = None) -> Any:
        if obj is None:
            return default
        if isinstance(obj, dict):
            return obj.get(key, default)
        return getattr(obj, key, default)

    def _safe_json(self, data: Any) -> str:
        return json.dumps(data, ensure_ascii=False).replace('</', '<\\/').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')

    def generate_html_logs(self, log_entries: List[Any], output_path: str, raw_log_entries: List[Dict[str, Any]] = None) -> str:
        """生成HTML格式的日志报告"""
        try:
            output_dir = os.path.dirname(output_path)
            os.makedirs(output_dir, exist_ok=True)
            
            filename = os.path.basename(output_path)
            name_without_ext = os.path.splitext(filename)[0]
            raw_filename = f"{name_without_ext}_raw.html"
            raw_output_path = os.path.join(output_dir, raw_filename)

            if raw_log_entries is None:
                raw_log_entries = log_entries

            self.logger.info(f"生成HTML报告，主文件: {output_path}")

            # 数据收集逻辑保持不变
            all_msg_types = set()
            for entry in raw_log_entries:
                segments = self._get_attr(entry, 'segments', [])
                for seg in segments:
                    if self._get_attr(seg, 'kind') == 'msg_type':
                        mt = str(self._get_attr(seg, 'text', '')).strip()
                        if mt:
                            all_msg_types.add(mt)
            sorted_msg_types = sorted(list(all_msg_types))
            abnormal_items = self._collect_abnormal_items(log_entries)

            js_msg_types = self._safe_json(sorted_msg_types)
            js_abnormal_items = self._safe_json(abnormal_items)

            entry_id_map = {id(entry): i for i, entry in enumerate(raw_log_entries)}
            def get_raw_anchor(entry_obj):
                if entry_obj is None: return ""
                raw_idx = entry_id_map.get(id(entry_obj))
                return f"log_{raw_idx}" if raw_idx is not None else ""

            # =================================================================
            # 1. 生成主分析页面 (Index Page) - 布局完全重构
            # =================================================================
            with open(output_path, 'w', encoding='utf-8') as f:
                f.write(f"""<!DOCTYPE html>
            <html>
            <head>
                <title>日志分析报告</title>
                <meta charset="utf-8">
                <script>
                    const ALL_MESSAGE_TYPES = {js_msg_types};
                    const ABNORMAL_ITEMS = {js_abnormal_items};
                </script>
                <style>
                    /* Reset & Layout Base */
                    * {{ box-sizing: border-box; }}
                    body {{
                        margin: 0;
                        padding: 0;
                        font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                        background-color: #f0f2f5;
                        color: #1f2937;
                        height: 100vh; /* 全屏高度 */
                        overflow: hidden; /* 禁止 Body 滚动，由内部容器接管 */
                        display: flex;
                    }}

                    /* =========================================
                       Sidebar Styles (性能优化版)
                       不再使用 fixed，改为 flex item，避免重排
                    ========================================= */
                    #sidebar {{
                        width: 60px; /* 默认折叠宽度 */
                        height: 100%;
                        background: #ffffff;
                        border-right: 1px solid #e5e7eb;
                        display: flex;
                        flex-direction: column;
                        transition: width 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                        z-index: 50;
                        flex-shrink: 0; /* 防止被挤压 */
                        box-shadow: 2px 0 8px rgba(0,0,0,0.05);
                    }}
                    
                    /* 展开状态类 */
                    #sidebar.expanded {{
                        width: 320px;
                    }}

                    /* Sidebar Header (Toggle Area) */
                    .sidebar-header {{
                        height: 60px;
                        display: flex;
                        align-items: center;
                        justify-content: center; /* 折叠时居中 */
                        cursor: pointer;
                        border-bottom: 1px solid #f3f4f6;
                        background: #f9fafb;
                        transition: background 0.2s;
                    }}
                    .sidebar-header:hover {{ background: #eff6ff; }}
                    #sidebar.expanded .sidebar-header {{
                        justify-content: flex-start;
                        padding-left: 16px;
                    }}

                    /* Sidebar Icon & Text */
                    .icon-box {{
                        position: relative;
                        width: 40px;
                        height: 40px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        font-size: 20px;
                    }}
                    .sb-title {{
                        display: none;
                        font-weight: 700;
                        color: #111827;
                        margin-left: 8px;
                        white-space: nowrap;
                        overflow: hidden;
                    }}
                    #sidebar.expanded .sb-title {{ display: block; }}

                    /* Badges */
                    .count-badge {{
                        position: absolute;
                        top: 2px;
                        right: 2px;
                        background: #fee2e2;
                        color: #991b1b;
                        border: 1px solid #fecdd3;
                        font-size: 10px;
                        font-weight: 700;
                        height: 18px;
                        min-width: 18px;
                        border-radius: 9px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        padding: 0 4px;
                    }}
                    .count-badge.zero {{ background: #f3f4f6; color: #9ca3af; border-color: #e5e7eb; }}

                    /* Sidebar Content (Scrollable List) */
                    .sidebar-content {{
                        flex: 1;
                        overflow-y: auto;
                        overflow-x: hidden;
                        opacity: 0; /* 折叠时隐藏内容 */
                        pointer-events: none;
                        transition: opacity 0.1s;
                        padding: 12px;
                    }}
                    #sidebar.expanded .sidebar-content {{
                        opacity: 1;
                        pointer-events: auto;
                        transition: opacity 0.2s 0.1s; /* 延迟显示内容 */
                    }}

                    /* Abnormal Item Card */
                    .abnormal-item {{
                        background: #fff;
                        border: 1px solid #e5e7eb;
                        border-left: 4px solid #f43f5e; /* 红色左边框醒目 */
                        border-radius: 6px;
                        margin-bottom: 8px;
                        padding: 10px;
                        cursor: pointer;
                        transition: transform 0.1s, box-shadow 0.1s;
                    }}
                    .abnormal-item:hover {{
                        transform: translateY(-1px);
                        box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);
                        border-color: #fecdd3; /* hover border */
                    }}
                    .ab-time {{ font-size: 12px; color: #6b7280; display: block; margin-bottom: 4px; }}
                    .ab-detail-row {{
                        font-size: 12px;
                        color: #374151;
                        font-family: 'JetBrains Mono', Consolas, monospace;
                        background: #fdf2f8;
                        padding: 2px 4px;
                        border-radius: 4px;
                        margin-top: 2px;
                        word-break: break-all;
                    }}
                    .ab-empty {{ text-align: center; color: #9ca3af; padding: 20px; font-size: 13px; }}

                    /* =========================================
                       Main Content Area
                    ========================================= */
                    #main-wrapper {{
                        flex: 1;
                        display: flex;
                        flex-direction: column;
                        min-width: 0; /* Flexbox 溢出修复 */
                        height: 100%;
                    }}

                    /* Filter Bar (Sticky inside main wrapper) */
                    #filterBar {{
                        flex-shrink: 0;
                        background: #fff;
                        padding: 12px 20px;
                        border-bottom: 1px solid #e5e7eb;
                        display: flex;
                        flex-wrap: wrap;
                        gap: 16px;
                        align-items: center;
                        z-index: 10;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.02);
                    }}

                    /* Log Scroll Container (Independent Scroll) */
                    #log-container {{
                        flex: 1;
                        overflow-y: auto; /* 只有这个区域滚动 */
                        padding: 20px;
                        scroll-behavior: smooth;
                    }}

                    /* =========================================
                       Existing Log Styles (Preserved)
                    ========================================= */
                    .timestamp {{
                        display: flex;
                        align-items: center;
                        padding: 6px 10px; /*稍微紧凑一点*/
                        margin: 2px 0;
                        background-color: #ffffff;
                        border-radius: 6px;
                        font-size: 14px;
                        border: 1px solid transparent; /* 预留边框防抖动 */
                        flex-wrap: wrap;
                        gap: 4px 8px;
                    }}
                    .timestamp:hover {{ background-color: #f9fafb; border-color: #e5e7eb; }}
                    
                    /* Segment Styles */
                    .seg-fixed {{ display: inline-block; box-sizing: border-box; padding: 2px 6px; margin: 0 2px; border-radius: 4px; vertical-align: middle; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 12px; white-space: nowrap; }}
                    .seg-ts {{ width: 160px; font-weight: 500; }}
                    .seg-dir {{ width: 70px; text-align: center; font-weight: 600; }}
                    .seg-node {{ width: 50px; text-align: center; }}
                    .seg-msgtype {{ width: 150px; text-align: center; font-weight: 600; letter-spacing: 0.5px; }}
                    
                    .seg-node-sm {{ width: 40px; text-align: center; }}
                    .seg-msgtype-sm {{ width: 110px; text-align: center; }}
                    .seg-pid {{ width: 130px; text-align: center; }}
                    .seg-free {{ display: inline-block; padding: 2px 6px; margin: 0 2px; border-radius: 4px; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 12px; white-space: nowrap; }}

                    /* 筛选组件样式 (保持一致) */
                    .filter-group {{ display: flex; align-items: center; gap: 8px; background: #f9fafb; padding: 4px 10px; border-radius: 8px; border: 1px solid #e5e7eb; }}
                    .filter-label {{ font-size: 11px; color: #6b7280; font-weight: 600; text-transform: uppercase; }}
                    .crystal-input {{ border: none; background: transparent; font-size: 13px; outline: none; color: #1f2937; }}
                    
                    /* Buttons */
                    .btn {{ padding: 6px 16px; border-radius: 6px; border: 1px solid #d1d5db; background: white; cursor: pointer; font-size: 12px; font-weight: 600; }}
                    .btn-primary {{ background: #2563eb; color: white; border: none; }}
                    .btn-primary:hover {{ background: #1d4ed8; }}
                    .jump-btn {{ 
                        height: 22px; padding: 0 10px; border-radius: 11px; font-size: 11px;
                        background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe;
                        margin-left: auto; text-decoration: none; display: flex; align-items: center;
                    }}
                    .jump-btn:hover {{ background: #2563eb; color: white; }}

                    /* Dropdown & Tags */
                    .msg-type-container {{ position: relative; }}
                    .msg-type-dropdown {{ position: absolute; top: 100%; left: 0; width: 280px; background: white; border: 1px solid #e5e7eb; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); z-index: 100; max-height: 300px; overflow-y: auto; display: none; padding: 4px; border-radius: 8px; }}
                    .msg-type-option {{ padding: 6px 10px; cursor: pointer; font-size: 12px; border-radius: 4px; }}
                    .msg-type-option:hover {{ background: #eff6ff; color: #1d4ed8; }}
                    .selected-tags {{ display: flex; flex-wrap: wrap; gap: 4px; }}
                    .tag {{ background: #eff6ff; border: 1px solid #bfdbfe; color: #1e40af; padding: 1px 6px; border-radius: 4px; font-size: 11px; display: flex; align-items: center; gap: 4px; }}
                    .tag-remove {{ cursor: pointer; opacity: 0.6; }}
                    .tag-remove:hover {{ opacity: 1; }}

                    /* Highlighting */
                    .flash-highlight {{ animation: flash-bg 2s ease-out forwards; border: 1px solid #ef4444 !important; }}
                    @keyframes flash-bg {{ 0% {{ background: #fee2e2; }} 100% {{ background: #fff; }} }}
                    .trans-highlight {{ background-color: #f0f9ff !important; border-left: 3px solid #3b82f6 !important; }}

                    /* Tree Structure */
                    .badge-req {{ padding: 1px 4px; background: #dbeafe; color: #1e40af; border-radius: 3px; font-size: 10px; font-weight: bold; margin-right: 6px; border: 1px solid #bfdbfe; }}
                    .badge-resp {{ padding: 1px 4px; background: #dcfce7; color: #166534; border-radius: 3px; font-size: 10px; font-weight: bold; margin-right: 6px; border: 1px solid #bbf7d0; }}
                    .tree-connector {{ width: 20px; text-align: right; color: #9ca3af; margin-right: 4px; font-family: monospace; font-weight: bold; }}
                    .resp-container {{ display: flex; align-items: center; }}
                    .tag-abnormal {{ background: #fef2f2; border: 1px solid #fecdd3; color: #b91c1c; font-size: 11px; padding: 0 4px; border-radius: 3px; margin-left: 4px; }}

                </style>
                <script>
                    let selectedMsgTypes = new Set();
                    
                    // Sidebar Toggle Logic
                    function toggleSidebar() {{
                        const sb = document.getElementById('sidebar');
                        sb.classList.toggle('expanded');
                    }}

                    function renderAbnormalNav() {{
                        const list = document.getElementById('sidebarContent');
                        const badge = document.getElementById('sidebarBadge');
                        
                        // Set Badge
                        const count = ABNORMAL_ITEMS.length;
                        badge.textContent = count;
                        if(count === 0) badge.classList.add('zero');
                        else badge.classList.remove('zero');

                        // Render List
                        if (!list) return;
                        list.innerHTML = '';
                        
                        if (count === 0) {{
                            list.innerHTML = '<div class="ab-empty">🎉 无异常报错</div>';
                            return;
                        }}

                        ABNORMAL_ITEMS.forEach((item) => {{
                            const div = document.createElement('div');
                            div.className = 'abnormal-item';
                            
                            // 生成详情HTML，确保显示Key=Value
                            let detailsHtml = '';
                            if(item.details && item.details.length > 0) {{
                                detailsHtml = item.details.map(d => `<div class="ab-detail-row">${{d}}</div>`).join('');
                            }} else {{
                                detailsHtml = `<div class="ab-detail-row" style="color:#9ca3af">(无详细信息)</div>`;
                            }}

                            div.innerHTML = `
                                <span class="ab-time">${{item.time}}</span>
                                <div style="font-weight:600; font-size:13px; margin-bottom:4px;">${{item.msgType}}</div>
                                ${{detailsHtml}}
                            `;
                            div.onclick = () => {{
                                const target = document.getElementById(item.anchor);
                                if (target) {{
                                    // 查找滚动容器
                                    const container = document.getElementById('log-container');
                                    // 计算位置并滚动
                                    target.scrollIntoView({{ behavior: 'smooth', block: 'center' }});
                                    target.classList.remove('flash-highlight');
                                    void target.offsetWidth; // trigger reflow
                                    target.classList.add('flash-highlight');
                                }}
                            }};
                            list.appendChild(div);
                        }});
                    }}

                    function init() {{
                        // Filter UI Event Bindings
                        const input = document.getElementById('msgTypeInput');
                        const dropdown = document.getElementById('msgTypeDropdown');
                        if(input && dropdown) {{
                            input.addEventListener('focus', () => {{ renderDropdown(input.value); dropdown.style.display = 'block'; }});
                            input.addEventListener('input', (e) => {{ renderDropdown(e.target.value); dropdown.style.display = 'block'; }});
                            document.addEventListener('click', (e) => {{
                                if (!e.target.closest('.msg-type-container')) dropdown.style.display = 'none';
                            }});
                        }}
                        
                        renderAbnormalNav();
                    }}

                    // --- Filtering Logic (Original) ---
                    function renderDropdown(filterText) {{
                        const dropdown = document.getElementById('msgTypeDropdown');
                        dropdown.innerHTML = '';
                        const lower = filterText.toLowerCase();
                        const filtered = ALL_MESSAGE_TYPES.filter(mt => mt.toLowerCase().includes(lower) && !selectedMsgTypes.has(mt));
                        
                        if (filtered.length === 0) {{
                            const d = document.createElement('div'); d.className = 'msg-type-option'; d.style.color='#9ca3af'; d.textContent='无匹配项'; dropdown.appendChild(d); return;
                        }}
                        filtered.forEach(mt => {{
                            const d = document.createElement('div'); d.className='msg-type-option'; d.textContent=mt; d.onclick=()=>addMsgType(mt); dropdown.appendChild(d);
                        }});
                    }}
                    function addMsgType(mt) {{ selectedMsgTypes.add(mt); renderTags(); document.getElementById('msgTypeInput').value=''; document.getElementById('msgTypeDropdown').style.display='none'; applyFilter(); }}
                    function removeMsgType(mt) {{ selectedMsgTypes.delete(mt); renderTags(); applyFilter(); }}
                    function renderTags() {{
                        const c = document.getElementById('selectedTags'); c.innerHTML='';
                        selectedMsgTypes.forEach(mt => {{
                            const t = document.createElement('div'); t.className='tag'; t.innerHTML=`${{mt}}<span class="tag-remove" onclick="removeMsgType('${{mt}}')">×</span>`; c.appendChild(t);
                        }});
                    }}
                    
                    function applyFilter() {{
                        const qRaw = document.getElementById('filterInput').value.trim();
                        let re = null;
                        if(qRaw) {{
                            try {{ re = new RegExp(qRaw.startsWith('/') ? qRaw.slice(1, qRaw.lastIndexOf('/')) : qRaw, 'i'); }} catch(e) {{}}
                        }}
                        
                        // Time Filter Logic (Simplified for brevity, same as before)
                        const sStr = document.getElementById('startTime').value;
                        const eStr = document.getElementById('endTime').value;
                        const sTime = sStr ? new Date(sStr).getTime() : null;
                        const eTime = eStr ? new Date(eStr).getTime() : null;

                        const rows = document.querySelectorAll('.timestamp');
                        rows.forEach(r => {{
                            let show = true;
                            if(re && !re.test(r.textContent)) show = false;
                            
                            const ts = parseInt(r.getAttribute('data-timestamp')||0);
                            if(show && ts > 0) {{
                                if(sTime && ts < sTime) show = false;
                                if(eTime && ts > eTime) show = false;
                            }}

                            if(show && selectedMsgTypes.size > 0) {{
                                const mt = r.querySelector('.seg-msgtype');
                                if(!mt || !selectedMsgTypes.has(mt.textContent.trim())) show = false;
                            }}
                            r.style.display = show ? 'flex' : 'none'; // Flex display
                        }});
                    }}
                    function clearFilter() {{ document.getElementById('filterInput').value=''; document.getElementById('startTime').value=''; document.getElementById('endTime').value=''; selectedMsgTypes.clear(); renderTags(); applyFilter(); }}
                    function filterKey(e) {{ if(e.key==='Enter') applyFilter(); }}
                    
                    function highlightTransaction(gid) {{ if(!gid)return; document.querySelectorAll(`[data-trans-group="${{gid}}"]`).forEach(el=>el.classList.add('trans-highlight')); }}
                    function clearHighlight() {{ document.querySelectorAll('.trans-highlight').forEach(el=>el.classList.remove('trans-highlight')); }}
                    
                    window.addEventListener('DOMContentLoaded', init);
                </script>
            </head>
            <body>
                <div id="sidebar">
                    <div class="sidebar-header" onclick="toggleSidebar()" title="点击展开/收起">
                        <div class="icon-box">
                            ⚠️
                            <div id="sidebarBadge" class="count-badge">0</div>
                        </div>
                        <span class="sb-title">异常报错列表</span>
                    </div>
                    <div id="sidebarContent" class="sidebar-content">
                        </div>
                </div>

                <div id="main-wrapper">
                    <div id="filterBar">
                        <div class="filter-group" style="flex: 1; min-width: 200px;">
                            <span class="filter-label">🔍 搜索</span>
                            <input id="filterInput" class="crystal-input" style="width: 100%;" type="text" placeholder="正则支持..." onkeydown="filterKey(event)" />
                        </div>
                        <div class="filter-group">
                            <span class="filter-label">🕒 时间</span>
                            <input id="startTime" class="crystal-input" type="datetime-local" step="1" style="width:170px;" />
                            <span style="color:#ccc">-</span>
                            <input id="endTime" class="crystal-input" type="datetime-local" step="1" style="width:170px;" />
                        </div>
                        <div class="filter-group msg-type-container">
                            <span class="filter-label">🏷️ 报文</span>
                            <div class="selected-tags" id="selectedTags"></div>
                            <input id="msgTypeInput" class="crystal-input" style="width: 100px;" placeholder="选择类型..." />
                            <div id="msgTypeDropdown" class="msg-type-dropdown"></div>
                        </div>
                        <button class="btn btn-primary" onclick="applyFilter()">筛选</button>
                        <button class="btn" onclick="clearFilter()">重置</button>
                    </div>

                    <div id="log-container">
            \n""")

                # -------------------------------------------------------------
                # 以下 Python 渲染循环保持逻辑一致，但结构微调
                # -------------------------------------------------------------
                for index, item in enumerate(log_entries):
                    is_transaction = hasattr(item, 'requests') and hasattr(item, 'response')
                    
                    if is_transaction:
                        main_entry = getattr(item, 'latest_request', None)
                        if not main_entry: continue
                        retry_count = len(getattr(item, 'requests', [])) - 1
                        has_response = getattr(item, 'response', None) is not None
                    else:
                        main_entry = item
                        retry_count = 0
                        has_response = False

                    log_id = f"log_{index}"
                    trans_group_id = f"trans_{index}" if is_transaction else ""
                    trans_attr = f'data-trans-group="{trans_group_id}" onmouseover="highlightTransaction(\'{trans_group_id}\')" onmouseout="clearHighlight()"' if is_transaction else ""

                    # 辅助：渲染单行内容
                    def render_line_content(entry, extra_badges=""):
                        segs = self._get_attr(entry, 'segments', [])
                        block_map = {'ts': '', 'dir': '', 'node': '', 'msg_type': '', 'ver': '', 'pid': ''}
                        # 简化读取
                        for s in segs:
                            k = self._get_attr(s, 'kind')
                            if k in block_map and not block_map[k]: block_map[k] = self._get_attr(s, 'text', '')
                        
                        # Timestamp processing
                        ts_display = block_map['ts'] or '&nbsp;'
                        ts_val = self._get_attr(entry, 'timestamp')
                        if ts_val and isinstance(ts_val, datetime):
                             ts_display = ts_val.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
                        elif ts_val:
                             ts_display = str(ts_val)

                        parts = []
                        has_dir = bool(block_map['dir'])
                        
                        # Render Logic
                        parts.append(f'<span class="seg-fixed seg-ts" style="background:#e3f2fd;color:#0c4a6e;">{ts_display}</span>')
                        
                        if has_dir:
                            dlow = str(block_map['dir']).lower()
                            bg_c = '#fee2e2' if 'output' in dlow else '#d1fae5' # Red/Green
                            parts.append(f'<span class="seg-fixed seg-dir" style="background:{bg_c};color:#1b1f23;">{block_map["dir"]}</span>')
                            parts.append(f'<span class="seg-fixed seg-node-sm" style="background:#f3f4f6;">{block_map["node"]}</span>')
                            parts.append('<span style="color:#9ca3af;margin:0 2px;">:</span>')
                            
                            # Msg Type Description
                            desc = ""
                            for s in segs: 
                                if self._get_attr(s, 'kind')=='msg_type': desc = self._get_attr(s, 'description', ''); break
                            title_attr = f'title="{html.escape(str(desc))}"' if desc else ''
                            parts.append(f'<span class="seg-fixed seg-msgtype-sm seg-msgtype" {title_attr} style="background:#fff7ed;color:#9a3412;">{block_map["msg_type"]}</span>')
                        else:
                            # Free format fallback
                            if block_map['pid']: parts.append(f'<span class="seg-fixed seg-pid" style="background:#fef3c7;">{block_map["pid"]}</span>')
                            for s in segs:
                                if self._get_attr(s,'kind') not in block_map and self._get_attr(s,'kind') != 'field':
                                    parts.append(f'<span class="seg-free" style="background:#f3f4f6;">{self._get_attr(s,"text","")}</span>')

                        # Field rendering
                        if has_dir:
                            palette = ['#e0f2fe', '#f0fdf4', '#ffedd5', '#f3e8ff', '#ecfeff']
                            for s in segs:
                                if self._get_attr(s, 'kind') == 'field':
                                    idx = int(self._get_attr(s, 'idx', 0))
                                    bg = palette[idx % len(palette)]
                                    parts.append(f'<span class="seg-free" style="background:{bg};color:#374151;">{self._get_attr(s, "text", "")}</span>')

                        return "".join(parts) + extra_badges

                    def append_abnormal_badge(entry, badges=""):
                        if self._get_attr(entry, 'escape_hits'):
                            badges += ' <span class="tag-abnormal">异常报错</span>'
                        return badges

                    # 主行
                    badges = ""
                    if is_transaction:
                        prefix = '<span class="badge-req">发送</span>'
                        if retry_count > 0: badges += f' <span class="tag" style="background:#fee2e2;color:#991b1b;cursor:pointer;" onclick="toggleRetries(\'{log_id}\')">◀ 重试 x{retry_count}</span>'
                        if not has_response: badges += ' <span class="tag" style="background:#f3f4f6;color:#6b7280;">[无回复]</span>'
                    else:
                        prefix = ""
                    
                    badges = append_abnormal_badge(main_entry, badges)
                    line_html = prefix + render_line_content(main_entry, badges)
                    
                    ts_val = self._get_attr(main_entry, 'timestamp')
                    ts_ms = int(ts_val.timestamp() * 1000) if ts_val and isinstance(ts_val, datetime) else 0

                    f.write(f"""        <div class="timestamp" id="ts_{index}" data-timestamp="{ts_ms}" {trans_attr}>
                            {line_html}
                            <a class="jump-btn" href="{raw_filename}#{get_raw_anchor(main_entry)}" target="_blank">原文</a>
                        </div>\n""")

                    # 重试行
                    if is_transaction and retry_count > 0:
                        f.write(f'<div id="retries_{log_id}" style="display:none; margin-left: 20px; border-left: 2px solid #e5e7eb; padding-left: 8px;">\n')
                        for req in getattr(item, 'requests', [])[:-1]:
                            r_html = render_line_content(req, append_abnormal_badge(req))
                            f.write(f"""            <div class="timestamp" style="border:none; padding: 2px 0;">
                                    <span style="color:#9ca3af; margin-right:8px; font-size:12px;">├─ 重试</span>
                                    {r_html}
                                    <a class="jump-btn" href="{raw_filename}#{get_raw_anchor(req)}" target="_blank">原文</a>
                                </div>\n""")
                        f.write('</div>\n')

                    # 回复行
                    if is_transaction and has_response:
                        resp = getattr(item, 'response')
                        resp_html = render_line_content(resp, append_abnormal_badge(resp))
                        f.write(f"""        <div class="timestamp" id="ts_{index}_resp" data-timestamp="{ts_ms}" {trans_attr} style="border-top:none; margin-top:-1px;">
                            <div class="resp-container">
                                <span class="tree-connector">└──</span>
                                <span class="badge-resp">回复</span>
                                {resp_html}
                            </div>
                            <a class="jump-btn" href="{raw_filename}#{get_raw_anchor(resp)}" target="_blank">原文</a>
                        </div>\n""")

                f.write("""    </div> </div> <script>
                    function toggleRetries(id) {
                        var el = document.getElementById('retries_' + id);
                        if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
                    }
                </script>
            </body>
            </html>""")

            # =================================================================
            # 2. 生成原文页面 (Raw Page) - 保持不变，仅修复读取逻辑
            # =================================================================
            with open(raw_output_path, 'w', encoding='utf-8') as f_raw:
                f_raw.write(f"""<!DOCTYPE html>
            <html>
            <head>
                <title>日志原文 - {filename}</title>
                <style>
                    body {{ font-family: 'Segoe UI', sans-serif; margin: 20px; background: #f0f2f5; color: #374151; }}
                    .log-entry {{ margin: 10px 0; padding: 12px; background: white; border-radius: 6px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }}
                    pre {{ margin: 0; white-space: pre-wrap; font-family: 'JetBrains Mono', monospace; font-size: 13px; }}
                    .flash-highlight {{ animation: flash 2s ease-out forwards; border: 1px solid #dc2626; }}
                    @keyframes flash {{ 0% {{ background: #fee2e2; }} 100% {{ background: white; }} }}
                </style>
                <script>
                    window.onload = function() {{
                        if(location.hash) {{
                            var el = document.getElementById(location.hash.substring(1));
                            if(el) {{ el.scrollIntoView({{behavior:'smooth', block:'center'}}); el.classList.add('flash-highlight'); }}
                        }}
                    }};
                </script>
            </head>
            <body>""")
                for index, entry in enumerate(raw_log_entries):
                    l1 = self._get_attr(entry, 'original_line1', '')
                    l2 = self._get_attr(entry, 'original_line2', '')
                    f_raw.write(f'<div class="log-entry" id="log_{index}"><pre>{html.escape(str(l1))}\\n{html.escape(str(l2))}</pre></div>\n')
                f_raw.write("</body></html>")

            self.logger.info(f"HTML报告生成完成: {output_path}")
            return output_path

        except Exception as e:
            self.logger.error(f"生成HTML报告失败: {str(e)}", exc_info=True)
            return None

    def _extract_msg_type(self, entry: Dict[str, Any]) -> str:
        try:
            if self._get_attr(entry, 'message_type'):
                return str(self._get_attr(entry, 'message_type', '')).strip()
            for seg in self._get_attr(entry, 'segments', []):
                if self._get_attr(seg, 'kind') == 'msg_type':
                    return str(self._get_attr(seg, 'text', '')).strip()
        except Exception:
            pass
        return ''

    def _extract_timestamp_text(self, entry: Dict[str, Any]) -> str:
        try:
            ts = self._get_attr(entry, 'timestamp')
            if ts:
                if isinstance(ts, datetime):
                    return ts.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
                else:
                    return str(ts)
            for seg in self._get_attr(entry, 'segments', []):
                if self._get_attr(seg, 'kind') == 'ts':
                    return str(self._get_attr(seg, 'text', '')).strip()
        except Exception:
            pass
        return ''

    def _build_abnormal_item(self, entry: Dict[str, Any], index: int, suffix: str = '') -> Dict[str, Any]:
        hits = self._get_attr(entry, 'escape_hits') or []
        fields = set()
        details = []
        for hit in hits:
            f = str(self._get_attr(hit, 'field', '') or '').strip()
            fields.add(f)
            
            # 优先使用 display, 其次 value
            d = self._get_attr(hit, 'display')
            v = self._get_attr(hit, 'value')
            val_str = str(d if d is not None else (v if v is not None else ''))
            
            # 【关键修改】确保 details 包含完整的键值对字符串，供前端直接渲染
            details.append(f"{f}={val_str}")
            
        return {
            'anchor': f"ts_{index}{suffix}",
            'time': self._extract_timestamp_text(entry),
            'msgType': self._extract_msg_type(entry) or '未知报文',
            'fields': sorted(list(fields)),
            'count': len(hits),
            'details': details, # 这里现在包含 ["FieldA=Value1", "FieldB=Value2"]
        }

    def _collect_abnormal_items(self, log_entries: List[Any]) -> List[Dict[str, Any]]:
        abnormal_items: List[Dict[str, Any]] = []
        for index, item in enumerate(log_entries):
            is_transaction = hasattr(item, 'requests') and hasattr(item, 'response')
            if is_transaction:
                main_entry = getattr(item, 'latest_request', None)
                if main_entry and self._get_attr(main_entry, 'escape_hits'):
                    abnormal_items.append(self._build_abnormal_item(main_entry, index))
                resp_entry = getattr(item, 'response', None)
                if resp_entry and self._get_attr(resp_entry, 'escape_hits'):
                    abnormal_items.append(self._build_abnormal_item(resp_entry, index, '_resp'))
            else:
                if self._get_attr(item, 'escape_hits'):
                    abnormal_items.append(self._build_abnormal_item(item, index))
        return abnormal_items

    def _parse_filename_info(self, filename: str) -> Dict[str, str]:
        # 保持不变
        try:
            name_without_ext = os.path.splitext(filename)[0]
            parts = name_without_ext.split('_')
            info = {'title': filename.replace('_', ' '), 'filename': filename}
            if len(parts) >= 4:
                info.update({'type': parts[0], 'factory': parts[1], 'system': parts[2], 'scope': parts[3]})
            return info
        except Exception:
            return {'title': filename}
