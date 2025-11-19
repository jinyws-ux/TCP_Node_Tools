# core/report_generator.py
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
                        background-color: #e9f7ff;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 14px;
                    }
                    .index-number {
                        font-weight: bold;
                        margin-right: 10px;
                        color: #007bff;
                    }
                    .log-entry {
                        margin: 10px 0;
                        padding: 10px;
                        background-color: white;
                        border-radius: 4px;
                        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                    }
                    .log-entry pre {
                        white-space: pre-wrap;
                        word-wrap: break-word;
                        font-size: 14px;
                        line-height: 1.2;
                        margin: 0;
                        padding: 5px;
                    }
                    .back-link {
                        display: block;
                        margin-top: 10px;
                        text-align: right;
                        color: #007bff;
                        text-decoration: underline;
                        font-size: 14px;
                    }
                </style>
            </head>
            <body>
                <h1>日志索引</h1>
                <div id="timestamps">\n""")

                # 写入时间戳索引（模块化片段，仅影响可点击行）
                for index, entry in enumerate(log_entries):
                    log_id = f"log_{index}"
                    segs = entry.get('segments') or []
                    palette = ['#e3f2fd', '#e8f5e9', '#fff3e0', '#ede7f6', '#e0f7fa']
                    parts = []
                    for s in segs:
                        kind = s.get('kind', 'field')
                        text = s.get('text', '')
                        idx = int(s.get('idx', 0))
                        bg = '#e3f2fd'
                        fg = '#1b1f23'
                        if kind == 'ts':
                            bg = '#e3f2fd'
                        elif kind == 'dir':
                            t = str(text).lower()
                            if t.startswith('input'):
                                bg = '#d1fae5'
                            elif t.startswith('output'):
                                bg = '#fee2e2'
                            else:
                                bg = '#ede7f6'
                        elif kind == 'node':
                            bg = '#e8f5e9'
                        elif kind == 'msg_type':
                            bg = '#fff3e0'
                        elif kind == 'ver':
                            bg = '#e0f7fa'
                        else:
                            bg = palette[idx % len(palette)]
                        parts.append(f'<span style="display:inline-block;padding:2px 6px;margin:2px;border-radius:6px;background:{bg};color:{fg};">{text}</span>')
                        if kind == 'node':
                            parts.append(':')
                    line_html = ''.join(parts)
                    f.write(f"""        <div class="timestamp" onclick="location.href='#{log_id}'">
                        <span class="index-number">{index + 1}.</span>
                        {line_html}
                    </div>\n""")

                f.write("    </div>\n")

                # 写入日志条目（保持原始日志原文，不做模块化）
                for index, entry in enumerate(log_entries):
                    log_id = f"log_{index}"
                    f.write(f"""    <div class="log-entry" id="{log_id}">
                    <pre>
            {entry['original_line1']}
            {entry['original_line2']}
                    </pre>
                    <a href="#timestamps" class="back-link">返回索引</a>
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
