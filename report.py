    def generate_html_logs(self, log_entries: List[Dict[str, Any]], output_path: str) -> str:
        """
        生成双文件HTML报告：
        1. Index页：包含筛选、时间轴和摘要，链接指向Raw页。
        2. Raw页：包含纯净的日志原文，用于查阅细节。
        """
        try:
            # 1. 准备路径和文件名
            # 例如: /path/to/report.html -> /path/to/report_raw.html
            root, ext = os.path.splitext(output_path)
            raw_output_path = f"{root}_raw{ext}"
            
            # 获取用于 HTML href 链接的相对文件名 (例如: report_raw.html)
            raw_filename = os.path.basename(raw_output_path)

            # 确保输出目录存在
            output_dir = os.path.dirname(output_path)
            os.makedirs(output_dir, exist_ok=True)

            self.logger.info(f"生成双HTML报告，Index: {output_path}, Raw: {raw_output_path}")

            # 2. 预处理：收集所有出现的报文类型（用于筛选下拉框）
            all_msg_types = set()
            for entry in log_entries:
                for seg in entry.get('segments', []):
                    if seg.get('kind') == 'msg_type':
                        mt = seg.get('text', '').strip()
                        if mt:
                            all_msg_types.add(mt)
            sorted_msg_types = sorted(list(all_msg_types))

            # 3. 同时打开两个文件进行流式写入
            with open(output_path, 'w', encoding='utf-8') as f_index, \
                 open(raw_output_path, 'w', encoding='utf-8') as f_raw:

                # =======================
                # 写入 Index 页头部 (含 JS/CSS)
                # =======================
                f_index.write(f"""<!DOCTYPE html>
            <html>
            <head>
                <title>日志分析索引</title>
                <script>
                    const ALL_MESSAGE_TYPES = {sorted_msg_types};
                </script>
                <style>
                    /* 基础字体与背景 */
                    body {{ font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 20px; background-color: #f0f2f5; color: #1f2937; }}
                    
                    /* 时间轴行样式 */
                    .timestamp {{
                        display: flex; align-items: center; padding: 8px 12px; margin: 4px 0;
                        background-color: #ffffff; border-radius: 8px; cursor: default;
                        font-size: 14px; border: 1px solid transparent; flex-wrap: wrap; gap: 4px 8px;
                        transition: all 0.2s;
                    }}
                    .timestamp:hover {{ box-shadow: 0 2px 4px rgba(0,0,0,0.05); border-color: #e5e7eb; }}
                    
                    /* 片段标签样式 */
                    .seg-fixed {{ display: inline-block; padding: 2px 8px; margin: 0 2px; border-radius: 6px; vertical-align: middle; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 13px; white-space: nowrap; }}
                    .seg-ts {{ width: 170px; font-weight: 500; }}
                    .seg-dir {{ width: 80px; text-align: center; font-weight: 600; }}
                    .seg-node {{ width: 60px; text-align: center; }}
                    .seg-msgtype {{ width: 160px; text-align: center; font-weight: 600; letter-spacing: 0.5px; position: relative; cursor: help; }}
                    .seg-ver {{ width: 60px; text-align: center; opacity: 0.8; }}
                    .seg-node-sm {{ width: 50px; text-align: center; }}
                    .seg-msgtype-sm {{ width: 120px; text-align: center; }}
                    .seg-ver-sm {{ width: 50px; text-align: center; }}
                    .seg-pid {{ width: 140px; text-align: center; }}
                    .seg-free {{ display: inline-block; padding: 2px 8px; margin: 0 2px; border-radius: 6px; font-family: 'JetBrains Mono', Consolas, monospace; font-size: 13px; white-space: nowrap; }}
                    
                    /* Tooltip 样式 */
                    .seg-msgtype:hover::after {{
                        content: attr(data-title); position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%);
                        background-color: rgba(17, 24, 39, 0.9); color: #fff; padding: 6px 12px; border-radius: 6px;
                        font-size: 12px; white-space: nowrap; z-index: 20; pointer-events: none; margin-bottom: 8px;
                    }}

                    /* 筛选栏样式 */
                    #filterBar {{
                        position: sticky; top: 10px; background: rgba(255, 255, 255, 0.95); backdrop-filter: blur(12px);
                        padding: 12px 20px; margin-bottom: 24px; border-radius: 16px;
                        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05); z-index: 100; border: 1px solid rgba(255, 255, 255, 0.6);
                        display: flex; flex-wrap: wrap; gap: 16px; align-items: center;
                    }}
                    .filter-group {{ display: flex; align-items: center; gap: 10px; background: #f9fafb; padding: 6px 12px; border-radius: 10px; border: 1px solid #e5e7eb; }}
                    .filter-label {{ font-size: 12px; color: #6b7280; font-weight: 600; text-transform: uppercase; }}
                    .crystal-input {{ height: 32px; padding: 0 8px; border: none; background: transparent; font-size: 13px; outline: none; font-family: inherit; }}
                    
                    /* 按钮样式 */
                    .btn {{ height: 36px; padding: 0 20px; border: 1px solid #d1d5db; border-radius: 8px; background: white; cursor: pointer; font-size: 13px; font-weight: 600; color: #4b5563; }}
                    .btn:hover {{ background-color: #f3f4f6; color: #111827; }}
                    .btn-primary {{ background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); border: none; color: white; }}
                    .btn-primary:hover {{ background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: white; }}
                    
                    /* 跳转按钮 */
                    .jump-btn {{ 
                        height: 24px; padding: 0 12px; border-radius: 9999px; font-size: 12px;
                        background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe; margin-left: auto; text-decoration: none; display: inline-flex; align-items: center;
                    }}
                    .jump-btn:hover {{ background: #2563eb; color: white; border-color: #2563eb; }}
                    
                    /* 下拉框和标签样式 (保留原有逻辑) */
                    .msg-type-container {{ position: relative; min-width: 240px; }}
                    .msg-type-dropdown {{ position: absolute; top: calc(100% + 8px); left: 0; width: 300px; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; display: none; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1); z-index: 50; padding: 6px; max-height: 300px; overflow-y: auto; }}
                    .msg-type-option {{ padding: 8px 12px; cursor: pointer; font-size: 13px; border-radius: 6px; }}
                    .msg-type-option:hover {{ background: #eff6ff; color: #1d4ed8; }}
                    .selected-tags {{ display: flex; flex-wrap: wrap; gap: 6px; }}
                    .tag {{ background: #eff6ff; border: 1px solid #bfdbfe; color: #1e40af; padding: 2px 8px; border-radius: 6px; font-size: 12px; display: flex; gap: 6px; }}
                    .tag-remove {{ cursor: pointer; opacity: 0.6; }} .tag-remove:hover {{ opacity: 1; }}
                </style>
                <script>
                    // 这里的 JS 代码主要负责筛选逻辑，保持不变
                    let selectedMsgTypes = new Set();
                    
                    function init() {{
                        const input = document.getElementById('msgTypeInput');
                        const dropdown = document.getElementById('msgTypeDropdown');
                        
                        input.addEventListener('focus', () => {{ renderDropdown(input.value); dropdown.style.display = 'block'; }});
                        input.addEventListener('input', (e) => {{ renderDropdown(e.target.value); dropdown.style.display = 'block'; }});
                        document.addEventListener('click', (e) => {{ if (!e.target.closest('.msg-type-container')) dropdown.style.display = 'none'; }});
                    }}
                    
                    function renderDropdown(filterText) {{
                        const dropdown = document.getElementById('msgTypeDropdown');
                        dropdown.innerHTML = '';
                        const lower = filterText.toLowerCase();
                        const filtered = ALL_MESSAGE_TYPES.filter(mt => mt.toLowerCase().includes(lower) && !selectedMsgTypes.has(mt));
                        
                        if (filtered.length === 0) {{
                            dropdown.innerHTML = '<div class="msg-type-option" style="color:#9ca3af;cursor:default">无匹配项</div>';
                            return;
                        }}
                        filtered.forEach(mt => {{
                            const div = document.createElement('div');
                            div.className = 'msg-type-option';
                            div.textContent = mt;
                            div.onclick = () => addMsgType(mt);
                            dropdown.appendChild(div);
                        }});
                    }}
                    
                    function addMsgType(mt) {{
                        selectedMsgTypes.add(mt); renderTags();
                        document.getElementById('msgTypeInput').value = '';
                        document.getElementById('msgTypeDropdown').style.display = 'none';
                        applyFilter();
                    }}
                    function removeMsgType(mt) {{ selectedMsgTypes.delete(mt); renderTags(); applyFilter(); }}
                    function renderTags() {{
                        const container = document.getElementById('selectedTags');
                        container.innerHTML = '';
                        selectedMsgTypes.forEach(mt => {{
                            const t = document.createElement('div'); t.className = 'tag';
                            t.innerHTML = `${{mt}}<span class="tag-remove" onclick="removeMsgType('${{mt}}')">×</span>`;
                            container.appendChild(t);
                        }});
                    }}

                    // 筛选逻辑
                    function applyFilter() {{
                        var qRaw = document.getElementById('filterInput').value.trim();
                        var re = null;
                        try {{ if(qRaw) re = new RegExp(qRaw, 'i'); }} catch(e){{}}
                        
                        var startTimeStr = document.getElementById('startTime').value.trim();
                        var endTimeStr = document.getElementById('endTime').value.trim();
                        var startTime = startTimeStr ? parseTime(startTimeStr) : null;
                        var endTime = endTimeStr ? parseTime(endTimeStr) : null;
                        var timeOnlyMode = (startTime !== null && startTime < 0) || (endTime !== null && endTime < 0);
                        
                        var rows = document.querySelectorAll('.timestamp');
                        for (var i = 0; i < rows.length; i++) {{
                            var r = rows[i];
                            var show = true;
                            
                            // 1. 文本筛选 (只筛选 Index 页上显示的内容)
                            if (re && !re.test(r.textContent)) show = false;
                            
                            // 2. 时间筛选
                            if (show && (startTime || endTime)) {{
                                var rowTs = parseInt(r.getAttribute('data-timestamp') || '0', 10);
                                if (rowTs > 0) {{
                                    if (timeOnlyMode) {{
                                        var d = new Date(rowTs);
                                        var ms = d.getHours()*3600000 + d.getMinutes()*60000 + d.getSeconds()*1000 + d.getMilliseconds();
                                        if (startTime && startTime < 0 && ms < -startTime) show = false;
                                        if (endTime && endTime < 0 && ms > -endTime) show = false;
                                    }} else {{
                                        if (startTime && startTime > 0 && rowTs < startTime) show = false;
                                        if (endTime && endTime > 0 && rowTs > endTime) show = false;
                                    }}
                                }}
                            }}
                            
                            // 3. 报文类型筛选
                            if (show && selectedMsgTypes.size > 0) {{
                                var mtSpan = r.querySelector('.seg-msgtype');
                                if (!mtSpan || !selectedMsgTypes.has(mtSpan.textContent.trim())) show = false;
                            }}
                            r.style.display = show ? '' : 'none';
                        }}
                    }}
                    
                    // 简化的时间解析 (保留原逻辑)
                    function parseTime(str) {{
                        if (!str) return null;
                        var s = str.trim().replace('T', ' ');
                        // 完整日期
                        var m1 = s.match(/^(\\d{{4}})-(\\d{{1,2}})-(\\d{{1,2}})\\s+(\\d{{1,2}}):(\\d{{1,2}})(?::(\\d{{1,2}}))?/);
                        if (m1) return new Date(m1[1], m1[2]-1, m1[3], m1[4], m1[5], m1[6]||0).getTime();
                        // 仅时间
                        var m3 = s.match(/^(\\d{{1,2}}):(\\d{{1,2}})(?::(\\d{{1,2}}))?/);
                        if (m3) return -(parseInt(m3[1])*3600000 + parseInt(m3[2])*60000 + (parseInt(m3[3])||0)*1000);
                        return null;
                    }}
                    function clearFilter() {{
                        document.getElementById('filterInput').value = '';
                        document.getElementById('startTime').value = '';
                        document.getElementById('endTime').value = '';
                        selectedMsgTypes.clear(); renderTags(); applyFilter();
                    }}
                    window.onload = init;
                </script>
            </head>
            <body>
                <div id="filterBar">
                    <div class="filter-group" style="flex: 1; min-width: 200px;">
                        <span class="filter-label">内容搜索</span>
                        <input id="filterInput" class="crystal-input" style="width: 100%;" type="text" placeholder="正则筛选 (仅匹配当前列表内容)..." onkeydown="if(event.key==='Enter') applyFilter()" />
                    </div>
                    <div class="filter-group">
                        <span class="filter-label">时间范围</span>
                        <input id="startTime" class="crystal-input" style="width: 160px;" type="datetime-local" step="1" />
                        <span style="color:#9ca3af">-</span>
                        <input id="endTime" class="crystal-input" style="width: 160px;" type="datetime-local" step="1" />
                    </div>
                    <div class="filter-group msg-type-container">
                        <span class="filter-label">报文类型</span>
                        <div class="selected-tags" id="selectedTags"></div>
                        <input id="msgTypeInput" class="crystal-input" style="width: 100px;" type="text" placeholder="选择..." />
                        <div id="msgTypeDropdown" class="msg-type-dropdown"></div>
                    </div>
                    <div style="display:flex; gap:8px; margin-left:auto;">
                        <button class="btn btn-primary" onclick="applyFilter()">筛选</button>
                        <button class="btn" onclick="clearFilter()">重置</button>
                    </div>
                </div>
                
                <div id="timestamps">\n""")

                # =======================
                # 写入 Raw 页头部 (极简)
                # =======================
                f_raw.write(f"""<!DOCTYPE html>
            <html>
            <head>
                <title>日志原文详情</title>
                <style>
                    body {{ font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 20px; background-color: #f8f9fa; color: #333; }}
                    .log-entry {{
                        margin: 10px 0; padding: 12px; background-color: white;
                        border: 1px solid #e5e7eb; border-radius: 6px;
                        box-shadow: 0 1px 2px rgba(0,0,0,0.05);
                    }}
                    /* 目标高亮样式 */
                    .log-entry:target {{
                        border-color: #3b82f6;
                        box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.2);
                        background-color: #eff6ff;
                    }}
                    pre {{
                        white-space: pre-wrap; word-wrap: break-word;
                        font-family: 'JetBrains Mono', Consolas, monospace; font-size: 13px;
                        margin: 0; line-height: 1.5; color: #374151;
                    }}
                </style>
            </head>
            <body>
                <h3>日志原文详情</h3>
                <p style="font-size:12px; color:#666;">提示：通过 Index 页的“查看原文”按钮跳转至此。每条日志都有唯一 ID。</p>
                <hr style="border:0; border-top:1px solid #ddd; margin:20px 0;">\n""")

                # =======================
                # 核心循环：同时生成两份内容
                # =======================
                palette = ['#e3f2fd', '#e8f5e9', '#fff3e0', '#ede7f6', '#e0f7fa']
                
                for index, entry in enumerate(log_entries):
                    log_id = f"log_{index}"
                    
                    # --- 1. 处理 Index 页的内容 (HTML片段拼接) ---
                    segs = entry.get('segments') or []
                    parts = []
                    block_map = {'ts': '', 'dir': '', 'node': '', 'msg_type': '', 'ver': '', 'pid': '', 'pid_msg1': '', 'pid_msg2': ''}
                    for s in segs:
                        k = s.get('kind')
                        if k in block_map and not block_map[k]:
                            block_map[k] = s.get('text', '')
                    
                    nbsp = '&nbsp;'
                    has_dir = bool(block_map['dir'])
                    ts_text_display = block_map['ts'] or nbsp
                    timestamp_ms = 0
                    if ts_text_display != nbsp and entry.get('timestamp'):
                        dt = entry['timestamp']
                        ts_text_display = dt.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
                        timestamp_ms = int(dt.timestamp() * 1000)

                    # 构建 Index 行内 HTML
                    parts.append(f'<span class="seg-fixed seg-ts" style="background:#e3f2fd;color:#1b1f23;">{ts_text_display}</span>')
                    
                    if has_dir:
                        dir_text = block_map['dir'] or nbsp
                        dlow = str(block_map['dir']).lower()
                        bg_color = "#d1fae5" if dlow.startswith('input') else ("#fee2e2" if dlow.startswith('output') else "#ede7f6")
                        parts.append(f'<span class="seg-fixed seg-dir" style="background:{bg_color};color:#1b1f23;">{dir_text}</span>')
                        parts.append(f'<span class="seg-fixed seg-node-sm" style="background:#e8f5e9;color:#1b1f23;">{block_map["node"] or nbsp}</span>')
                        parts.append(':')
                        
                        # 处理报文类型 (带 Tooltip)
                        msg_desc = next((s.get('description', '') for s in segs if s.get('kind') == 'msg_type'), "")
                        mt_attr = f'data-title="{html.escape(msg_desc)}"' if msg_desc else ''
                        cls_extra = "seg-msgtype" if msg_desc else ""
                        parts.append(f'<span class="seg-fixed seg-msgtype-sm {cls_extra}" {mt_attr} style="background:#fff3e0;color:#1b1f23;">{block_map["msg_type"] or nbsp}</span>')
                        parts.append(f'<span class="seg-fixed seg-ver-sm" style="background:#e0f7fa;color:#1b1f23;">{block_map["ver"] or nbsp}</span>')
                    else:
                        if block_map['pid']: parts.append(f'<span class="seg-fixed seg-pid" style="background:#fde68a;color:#1b1f23;">{block_map["pid"]}</span>')
                        if block_map['node']: parts.append(f'<span class="seg-fixed seg-node-sm" style="background:#e8f5e9;color:#1b1f23;">{block_map["node"]}</span>')
                        if block_map['pid_msg1']: parts.append(f'<span class="seg-free" style="background:#e3f2fd;color:#1b1f23;">{block_map["pid_msg1"]}</span>')
                        if block_map['pid_msg2']: parts.append(f'<span class="seg-free" style="background:#e8f5e9;color:#1b1f23;">{block_map["pid_msg2"]}</span>')

                    # 写入 Index 文件
                    line_html = ''.join(parts)
                    # 注意 href 这里的变化：指向外部文件 raw_filename
                    f_index.write(f"""        <div class="timestamp" data-timestamp="{timestamp_ms}">
                                <span style="color:#9ca3af;width:30px;display:inline-block;text-align:right;margin-right:8px;">{index + 1}.</span>
                                {line_html}
                                <a class="jump-btn" href="{raw_filename}#{log_id}" target="_blank" title="在新标签页查看原文">查看原文</a>
                            </div>\n""")
                    
                    # --- 2. 处理 Raw 页的内容 ---
                    raw_text = f"{entry['original_line1']}\n{entry['original_line2']}"
                    # 写入 Raw 文件 (只包含带ID的PRE块)
                    f_raw.write(f"""    <div class="log-entry" id="{log_id}">
        <div style="color:#999;font-size:12px;margin-bottom:4px;">#{index+1}</div>
        <pre>{html.escape(raw_text)}</pre>
    </div>\n""")

                # =======================
                # 写入尾部并结束
                # =======================
                f_index.write("    </div>\n</body>\n</html>")
                f_raw.write("</body>\n</html>")

            self.logger.info(f"HTML报告生成完成。Index: {len(log_entries)} 条, Raw: {len(log_entries)} 条")
            return output_path

        except Exception as e:
            self.logger.error(f"生成HTML报告失败: {str(e)}")
            import traceback
            self.logger.error(traceback.format_exc())
            return None
