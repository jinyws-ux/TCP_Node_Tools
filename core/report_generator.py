# core/report_generator.py
import logging
import os
from datetime import datetime
from typing import List, Dict, Any
import html


class ReportGenerator:
    def __init__(self, output_dir: str):
        self.output_dir = output_dir
        self.logger = logging.getLogger(__name__)
        os.makedirs(output_dir, exist_ok=True)

    def _get_timestamp(self) -> str:
        """获取当前时间戳"""
        return datetime.now().strftime("%Y%m%d_%H%M%S")

    def generate_html_logs(self, log_entries: List[Dict[str, Any]], output_path: str) -> str:
        """生成HTML格式的日志报告 - 修复参数问题"""
        try:

            # filename = os.path.basename(output_path)
            # analysis_info = self._parse_filename_info(filename)

            # 确保输出目录存在
            output_dir = os.path.dirname(output_path)
            os.makedirs(output_dir, exist_ok=True)

            self.logger.info(f"生成HTML报告，输出路径: {output_path}，日志条目数: {len(log_entries)}")

            # 使用流式写入提高大文件处理效率
            with open(output_path, 'w', encoding='utf-8') as f:
                # 写入HTML头部
                f.write("""<!DOCTYPE html>
            <html>
            <head>
                <title>日志分析报告</title>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        margin: 20px;
                        background-color: #f0f2f5;
                    }
                    .timestamp {
                        display: flex;
                        align-items: center;
                        padding: 10px;
                        margin: 5px 0;
                        background-color: #ffffff;
                        border-radius: 4px;
                        cursor: text;
                        font-size: 14px;
                        scroll-margin-top: 80px;
                    }
                    .index-number {
                        font-weight: bold;
                        margin-right: 10px;
                        color: #007bff;
                    }
                    .seg-fixed { display: inline-block; box-sizing: border-box; padding: 2px 6px; margin: 2px; border-radius: 6px; vertical-align: top; }
                    .seg-ts { width: 170px; }
                    .seg-dir { width: 80px; text-align: center; }
                    .seg-node { width: 90px; text-align: center; }
                    .seg-msgtype { width: 150px; text-align: center; }
                    .seg-ver { width: 90px; text-align: center; }
                    .seg-node-sm { width: 60px; text-align: center; }
                    .seg-msgtype-sm { width: 100px; text-align: center; }
                    .seg-ver-sm { width: 60px; text-align: center; }
                    .seg-pid { width: 140px; text-align: center; }
                    .seg-free { display: inline-block; padding: 2px 6px; margin: 2px; border-radius: 6px; }
                    .log-entry {
                        margin: 10px 0;
                        padding: 8px;
                        background-color: white;
                        border-radius: 4px;
                        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                        scroll-margin-top: 80px;
                    }
                    .log-entry pre {
                        white-space: pre-wrap;
                        word-wrap: break-word;
                        font-size: 13px;
                        line-height: 1.05;
                        margin: 0;
                        padding: 0;
                    }
                    .back-link {
                        display: inline-block;
                        margin-top: 2px;
                        text-align: right;
                        color: #007bff;
                        text-decoration: underline;
                        font-size: 12px;
                    }
                    #filterBar { position: sticky; top: 0; background: #ffffff; padding: 10px; margin-bottom: 10px; border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.08); display: flex; gap: 8px; align-items: center; }
                    #filterInput { flex: 1; height: 28px; font-size: 14px; padding: 4px 8px; border: 1px solid #d1d5db; border-radius: 4px; outline: none; }
                    .btn { height: 28px; padding: 0 12px; border: 1px solid #d1d5db; border-radius: 4px; background: #f9fafb; cursor: pointer; font-size: 13px; }
                    .btn-primary { background: #e5f0ff; border-color: #93c5fd; }
                    .jump-btn { height: 24px; padding: 0 10px; border-radius: 9999px; border: 1px solid #93c5fd; background: linear-gradient(to bottom, #eaf3ff, #dbeafe); color: #1b1f23; box-shadow: 0 1px 2px rgba(0,0,0,0.06); white-space: nowrap; margin-left: 16px; }
                    .jump-btn:hover { background: #cfe3ff; border-color: #60a5fa; }
                    .divider { height: 1px; background: linear-gradient(to right, #e5e7eb, #cbd5e1, #e5e7eb); margin: 40px 0 32px; border: none; }
                    .filter-error { color: #dc2626; font-size: 12px; padding: 2px 6px; }
                    .gap { height: 100vh; }
                    @keyframes flashHighlight {
                        from { background-color: #fde68a; }
                        to { background-color: #ffffff; }
                    }
                    .flash-highlight { animation: flashHighlight 900ms ease-in-out 2 alternate; }
                </style>
                <script>
                    function applyFilter() {
                        var qRaw = document.getElementById('filterInput').value.trim();
                        var errBox = document.getElementById('filterError');
                        if (errBox) errBox.textContent = '';
                        var rows = document.querySelectorAll('.timestamp');
                        if (!qRaw) {
                            for (var i = 0; i < rows.length; i++) {
                                var r = rows[i];
                                var id = r.getAttribute('data-id');
                                var raw = document.getElementById(id);
                                r.style.display = '';
                                if (raw) raw.style.display = '';
                            }
                            return;
                        }
                        var re = null;
                        if (qRaw.startsWith('/') && qRaw.lastIndexOf('/') > 0) {
                            var last = qRaw.lastIndexOf('/');
                            var body = qRaw.slice(1, last);
                            var flags = qRaw.slice(last + 1) || 'i';
                            try { re = new RegExp(body, flags); } catch (e) { re = null; }
                        } else {
                            try { re = new RegExp(qRaw, 'i'); } catch (e) { re = null; }
                        }
                        if (!re) {
                            if (errBox) errBox.textContent = '正则表达式无效';
                            return;
                        }
                        for (var i = 0; i < rows.length; i++) {
                            var r = rows[i];
                            var id = r.getAttribute('data-id');
                            var raw = document.getElementById(id);
                            var text = (r.textContent || '');
                            var pre = raw ? raw.querySelector('pre') : null;
                            var rawText = pre ? (pre.textContent || '') : '';
                            var show = re.test(text) || re.test(rawText);
                            r.style.display = show ? '' : 'none';
                            if (raw) raw.style.display = show ? '' : 'none';
                        }
                    }
                    function clearFilter() {
                        document.getElementById('filterInput').value = '';
                        applyFilter();
                    }
                    function filterKey(e) { if (e.key === 'Enter') applyFilter(); }
                    function filterKey(e) { if (e.key === 'Enter') window.applyFilter(); }
                    var applyFilter = window.applyFilter;
                    var clearFilter = window.clearFilter;
                    var filterKey = window.filterKey;
                    function flashTargetById(id) {
                        if (!id) return;
                        var el = document.getElementById(id);
                        if (!el) return;
                        el.classList.remove('flash-highlight');
                        void el.offsetWidth;
                        el.classList.add('flash-highlight');
                    }
                    window.addEventListener('hashchange', function() {
                        var id = (location.hash || '').replace('#','');
                        flashTargetById(id);
                    });
                    (function(){
                        var id = (location.hash || '').replace('#','');
                        flashTargetById(id);
                    })();
                </script>
            </head>
            <body>
                <h1>日志索引</h1>
                <div id="filterBar">
                    <input id="filterInput" type="text" placeholder="支持正则，例如 (?=.*INPUT)(?=.*OKAY) 或 /TRIG_P.*0001/i" onkeydown="filterKey(event)" />
                    <button class="btn btn-primary" onclick="applyFilter()">筛选</button>
                    <button class="btn" onclick="clearFilter()">重置</button>
                    <span id="filterError" class="filter-error"></span>
                </div>
                <div id="timestamps">\n""")

                # 写入时间戳索引（模块化片段，仅影响可点击行）
                for index, entry in enumerate(log_entries):
                    log_id = f"log_{index}"
                    segs = entry.get('segments') or []
                    palette = ['#e3f2fd', '#e8f5e9', '#fff3e0', '#ede7f6', '#e0f7fa']
                    parts = []
                    block_map = {'ts': '', 'dir': '', 'node': '', 'msg_type': '', 'ver': '', 'pid': '', 'pid_msg1': '', 'pid_msg2': ''}
                    for s in segs:
                        k = s.get('kind')
                        if k in block_map and not block_map[k]:
                            block_map[k] = s.get('text', '')
                    nbsp = '&nbsp;'
                    has_dir = bool(block_map['dir'])
                    if has_dir:
                        ts_text = block_map['ts'] or nbsp
                        dir_text = block_map['dir'] or nbsp
                        node_text = block_map['node'] or nbsp
                        msgtype_text = block_map['msg_type'] or nbsp
                        ver_text = block_map['ver'] or nbsp
                        parts.append(f'<span class="seg-fixed seg-ts" style="background:#e3f2fd;color:#1b1f23;">{ts_text}</span>')
                        dlow = str(block_map['dir']).lower()
                        if dlow.startswith('input'):
                            parts.append(f'<span class="seg-fixed seg-dir" style="background:#d1fae5;color:#1b1f23;">{dir_text}</span>')
                        elif dlow.startswith('output'):
                            parts.append(f'<span class="seg-fixed seg-dir" style="background:#fee2e2;color:#1b1f23;">{dir_text}</span>')
                        else:
                            parts.append(f'<span class="seg-fixed seg-dir" style="background:#ede7f6;color:#1b1f23;">{dir_text}</span>')
                        parts.append(f'<span class="seg-fixed seg-node-sm" style="background:#e8f5e9;color:#1b1f23;">{node_text}</span>')
                        parts.append(':')
                        parts.append(f'<span class="seg-fixed seg-msgtype-sm" style="background:#fff3e0;color:#1b1f23;">{msgtype_text}</span>')
                        parts.append(f'<span class="seg-fixed seg-ver-sm" style="background:#e0f7fa;color:#1b1f23;">{ver_text}</span>')
                    else:
                        ts_text = block_map['ts'] or nbsp
                        pid_text = (block_map['pid'] or '').strip()
                        node_text = (block_map['node'] or '').strip()
                        parts.append(f'<span class="seg-fixed seg-ts" style="background:#e3f2fd;color:#1b1f23;">{ts_text}</span>')
                        if pid_text:
                            parts.append(f'<span class="seg-fixed seg-pid" style="background:#fde68a;color:#1b1f23;">{pid_text}</span>')
                        if node_text:
                            parts.append(f'<span class="seg-fixed seg-node-sm" style="background:#e8f5e9;color:#1b1f23;">{node_text}</span>')
                        msg1 = (block_map['pid_msg1'] or '').strip()
                        msg2 = (block_map['pid_msg2'] or '').strip()
                        if msg1:
                            parts.append(f'<span class="seg-free" style="background:#e3f2fd;color:#1b1f23;">{msg1}</span>')
                        if msg2:
                            parts.append(f'<span class="seg-free" style="background:#e8f5e9;color:#1b1f23;">{msg2}</span>')
                    if has_dir:
                        for s in segs:
                            if s.get('kind') != 'field':
                                continue
                            idx = int(s.get('idx', 0))
                            bg = palette[idx % len(palette)]
                            text = s.get('text', '')
                            parts.append(f'<span class="seg-free" style="background:{bg};color:#1b1f23;">{text}</span>')
                    line_html = ''.join(parts)
                    f.write(f"""        <div class="timestamp" id="ts_{index}" data-id="{log_id}">
                        <span class="index-number">{index + 1}.</span>
                        {line_html}
                        <a class="btn btn-primary jump-btn" href="#{log_id}" title="查看日志原文本">查看日志原文本</a>
                    </div>\n""")

                f.write("    </div>\n")
                f.write("    <hr class=\"divider\">\n")
                f.write("    <div class=\"gap\"></div>\n")

                # 写入日志条目（保持原始日志原文，不做模块化）
                for index, entry in enumerate(log_entries):
                    log_id = f"log_{index}"
                    raw_text = f"{entry['original_line1']}\n{entry['original_line2']}"
                    f.write(f"""    <div class="log-entry" id="{log_id}">
<pre>{html.escape(raw_text)}</pre>
<a href="#ts_{index}" class="back-link">返回索引</a>
</div>\n""")

                # 写入HTML尾部
                f.write("</body>\n</html>")

            self.logger.info(f"HTML报告生成完成: {output_path}")
            return output_path

        except Exception as e:
            self.logger.error(f"生成HTML报告失败: {str(e)}")
            return None

    def _parse_filename_info(self, filename: str) -> Dict[str, str]:
        """从文件名中解析分析信息"""
        try:
            # 移除扩展名
            name_without_ext = os.path.splitext(filename)[0]
            parts = name_without_ext.split('_')

            info = {
                'title': filename.replace('_', ' '),
                'filename': filename
            }

            if len(parts) >= 4:
                info['type'] = parts[0]  # 单节点/多节点
                info['factory'] = parts[1]
                info['system'] = parts[2]
                info['scope'] = parts[3]  # 节点信息
                info['timestamp'] = parts[4] if len(parts) > 4 else '未知'

            return info

        except Exception as e:
            self.logger.error(f"解析文件名信息失败: {str(e)}")
            return {'title': filename}
