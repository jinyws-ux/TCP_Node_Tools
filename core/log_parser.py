# core/log_parser.py
import logging
import re
from datetime import datetime
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)
ABNORMAL_ESCAPE_TAG = "abnormal_error"


class LogParser:
    def __init__(self, parser_config: Dict[str, Any]):
        self.parser_config = parser_config
        self.logger = logging.getLogger(__name__)

    def _strip_noise_prefix(self, content: str) -> str:
        try:
            s = content or ""
            s = s.lstrip()
            m = re.match(r'^[^A-Za-z0-9]{5,12}', s)
            if m:
                s = s[m.end():]
            return s.lstrip()
        except Exception:
            return content

    def extract_timestamp(self, line: str) -> Optional[datetime]:
        """提取日志行中的时间戳"""
        try:
            match = re.search(r'^(\d{2}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}\.\d{3})', line.strip())
            if match:
                timestamp_str = match.group(1)
                return datetime.strptime(timestamp_str, '%d.%m.%y %H:%M:%S.%f')
            return None
        except Exception as e:
            self.logger.error(f"提取时间戳时发生错误：{e}")
            return None

    def get_version_from_content(self, content: str) -> Optional[str]:
        try:
            if len(content) >= 28:
                return content[28:32].strip()
            return ""
        except Exception as e:
            self.logger.error(f"获取版本信息时发生错误：{e}")
            return ""

    def parse_message_content(self, content: str) -> str:
        """根据配置解析消息内容"""
        try:
            if len(content) < 25:
                return content

            msg_type = content[16:24]
            if msg_type not in self.parser_config:
                return content
            msg_config = self.parser_config[msg_type]

            version = self.get_version_from_content(content)
            if version is None:
                return content

            # 获取字段配置
            if 'Versions' in msg_config:
                if version in msg_config['Versions']:
                    fields_config = msg_config['Versions'][version].get('Fields', {})
                else:
                    return content
            else:
                fields_config = msg_config.get('Fields', {})

            # 解析字段
            # 按 Order 排序（缺省使用定义顺序）
            field_values = {}
            items = list(fields_config.items())
            indexed = [(fname, fcfg, idx) for idx, (fname, fcfg) in enumerate(items)]
            sorted_items = sorted(indexed, key=lambda t: (t[1].get('Order', t[2])))
            for field, field_cfg, _ in sorted_items:
                try:
                    start = field_cfg['Start']
                    length = field_cfg.get('Length', -1)

                    # 检查内容长度是否足够
                    if start < 0 or len(content) < start:
                        field_values[field] = "内容不足，未能提取"
                        continue

                    # 提取字段值
                    if length == -1:
                        field_value = content[start:].strip()
                    else:
                        end = start + length
                        if end > len(content):
                            field_value = "内容不足，未能提取"
                        else:
                            field_value = content[start:end].strip()

                    # 处理转义值
                    escape_config = field_cfg.get('Escape', {})
                    if escape_config:
                        if field_value in escape_config:
                            escaped_value = escape_config[field_value]
                            field_values[field] = f"{field_value}({escaped_value})"
                        else:
                            field_values[field] = f"{field_value}(未定义的转义值)"
                    else:
                        field_values[field] = field_value
                except Exception as e:
                    logger.error(f"解析字段 {field} 时发生错误：{e}")
                    field_values[field] = "解析错误"

            # 构建解析结果
            description = msg_config.get('Description', '')
            parsed_content = f"{description}："
            parsed_content += ",".join(f"{field}={value}" for field, value in field_values.items())
            return parsed_content
        except Exception as e:
            logger.error(f"解析消息内容时发生错误：{e}")
            return content

    def parse_message_segments(self, content: str) -> Dict[str, Any]:
        result = {"message_type": "", "version": "", "fields": [], "segments": [], "description": "", "escape_hits": []}
        try:
            msg_type = content[16:24].strip() if len(content) >= 24 else ""
            version = self.get_version_from_content(content) or ""
            result["message_type"] = msg_type
            result["version"] = version
            fields_config = {}
            if msg_type and msg_type in self.parser_config:
                msg_config = self.parser_config[msg_type]
                result["description"] = msg_config.get("Description", "")
                if 'Versions' in msg_config and version in msg_config['Versions']:
                    fields_config = msg_config['Versions'][version].get('Fields', {})
                else:
                    fields_config = msg_config.get('Fields', {})
            # 按 Order 排序（缺省使用定义顺序）
            idx = 0
            escape_hits = []
            items = list(fields_config.items())
            indexed = [(fname, fcfg, i) for i, (fname, fcfg) in enumerate(items)]
            sorted_items = sorted(indexed, key=lambda t: (t[1].get('Order', t[2])))
            for field, field_cfg, _ in sorted_items:
                start = field_cfg.get('Start', 0)
                length = field_cfg.get('Length', -1)
                if start < 0 or len(content) < start:
                    value = "内容不足"
                else:
                    if length == -1:
                        value = content[start:].strip()
                    else:
                        end = start + length
                        value = content[start:end].strip() if end <= len(content) else "内容不足"
                esc = field_cfg.get('Escapes') or field_cfg.get('Escape') or {}
                escape_tags = field_cfg.get('EscapeTags') or {}
                tags = []
                if isinstance(escape_tags, dict):
                    raw_tags = escape_tags.get(value) or []
                    if isinstance(raw_tags, list):
                        tags = [t for t in raw_tags if isinstance(t, str)]

                if isinstance(esc, dict) and value in esc:
                    disp = f"{value}({esc[value]})"
                else:
                    disp = value if not esc else f"{value}(未定义转义)"

                if ABNORMAL_ESCAPE_TAG in tags:
                    escape_hits.append({
                        "field": field,
                        "value": value,
                        "display": disp,
                        "tags": tags,
                    })
                
                seg_entry = {"kind": "field", "text": f"{field}={disp}", "idx": idx}
                if tags:
                    seg_entry["escape_tags"] = tags

                result["fields"].append({"name": field, "value": disp, "start": start, "length": length})
                result["segments"].append(seg_entry)
                idx += 1
            result["escape_hits"] = escape_hits
            return result
        except Exception:
            result["message_type"] = content[16:24].strip() if len(content) >= 24 else ""
            result["version"] = self.get_version_from_content(content) or ""
            return result

    def parse_log_lines(self, log_lines: List[str]) -> List[Dict[str, Any]]:
        """解析日志行，返回结构化日志条目"""
        log_entries = []
        i = 0
        total_lines = len(log_lines)

        # 预编译正则表达式提高效率
        specific_pattern = re.compile(
            r'^\d{2}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}\.\d{3} PID=\d+ D Node \d+, \*\*\* (.*) \*\*\* \((.*)\)$')
        direction_pattern = re.compile(
            r'^(\d{2}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(Input|Output):\s+Node\s+(\d+),\s+(\d+)\s+bytes\s+(<==|==>)\s+(\d+)$')

        while i < total_lines:
            current_line = log_lines[i].strip()
            if not current_line:
                i += 1
                continue

            # 处理特定格式的日志行
            if specific_pattern.match(current_line):
                timestamp = self.extract_timestamp(current_line)
                original_line1 = current_line
                original_line2 = log_lines[i + 1].strip() if i + 1 < total_lines else "无内容"

                # PID 分支的类型/版本/字段来自第二行的消息体
                msg = self.parse_message_segments(original_line2)
                # 如果第二行无法提供类型/版本，尝试从第一行的 *** ... *** 中解析
                msg_type_fallback = ""
                version_fallback = ""
                try:
                    m2 = specific_pattern.match(original_line1)
                    header = m2.group(1) if m2 else ""
                    if header:
                        toks = header.strip().split()
                        if len(toks) >= 2:
                            msg_type_fallback = toks[0].strip()
                            cand_ver = toks[-1].strip()
                            if re.match(r"^\d{4}$", cand_ver):
                                version_fallback = cand_ver
                except Exception:
                    pass
                segs = []
                if timestamp:
                    ts_txt = timestamp.strftime('%d.%m.%y %H:%M:%S.%f')[:-3]
                    segs.append({'kind': 'ts', 'text': ts_txt, 'idx': 0})
                # 追加 PID 与节点号（基于第一行）
                try:
                    pid_text = ""
                    if len(original_line1) >= 31:
                        pid_text = original_line1[22:31].strip()
                    if not pid_text:
                        m_pid = re.search(r"PID=\d+", original_line1)
                        pid_text = m_pid.group(0) if m_pid else ""
                    if pid_text:
                        segs.append({'kind': 'pid', 'text': pid_text, 'idx': 1})
                except Exception:
                    pass
                try:
                    node_text = ""
                    if len(original_line1) >= 40:
                        sub = original_line1[39:]
                        comma_idx = sub.find(',')
                        if comma_idx != -1:
                            node_text = sub[:comma_idx].strip()
                    if not node_text:
                        m_node = re.search(r"Node\s+(\d+)", original_line1)
                        node_text = m_node.group(1) if m_node else ""
                    if node_text:
                        segs.append({'kind': 'node', 'text': node_text, 'idx': 2})
                except Exception:
                    pass
                # 追加两条消息块：第一行与第二行
                try:
                    msg1 = ""
                    if len(original_line1) >= 46:
                        start = 45
                        msg1 = original_line1[start:].strip()
                    if msg1:
                        segs.append({'kind': 'pid_msg1', 'text': msg1, 'idx': 3})
                except Exception:
                    pass
                try:
                    msg2 = ""
                    if len(original_line2) >= 46:
                        start2 = 45
                        msg2 = original_line2[start2:].strip()
                    if msg2:
                        segs.append({'kind': 'pid_msg2', 'text': msg2, 'idx': 4})
                except Exception:
                    pass
                # PID 分支仅保留五块（ts, pid, node, msg1, msg2），不追加其他字段块
                log_entries.append({
                    'timestamp': timestamp,
                    'original_line1': original_line1,
                    'original_line2': original_line2,
                    'parsed': self.parse_message_content(original_line2),
                    'segments': segs,
                    'message_type': msg.get('message_type', ''),
                    'version': msg.get('version', ''),
                    'description': msg.get('description', ''),
                    'escape_hits': msg.get('escape_hits', []),
                })
                i += 2
                continue

            # 处理方向性日志行
            match = direction_pattern.match(current_line)
            if match:
                time_str = match.group(1)
                direction = match.group(2)
                node_number = match.group(3)
                raw_message_content = log_lines[i + 1].strip() if i + 1 < total_lines else "无内容"

                # 跳过无效内容
                if raw_message_content.startswith("???") and len(raw_message_content) < 10:
                    i += 1
                    continue
                if "PING_IPS" in raw_message_content or "PING_I_R" in raw_message_content:
                    i += 1
                    continue

                # 恢复旧对齐：Output 分支先去除固定前缀，再进行噪声清理
                base_content = raw_message_content
                if direction == "Output" and len(base_content) >= 7:
                    base_content = base_content[7:]
                # 清理第二行前置无意义字符后再解析
                message_content = self._strip_noise_prefix(base_content)

                # 解析消息内容
                try:
                    parsed_content = self.parse_message_content(message_content)
                    log_line = f"{time_str:<16} {direction:<6} {node_number:>3}：{parsed_content}"
                except Exception as e:
                    logger.error(f"解析消息内容时发生错误：{e}")
                    log_line = f"{time_str:<16} {direction:<6} {node_number:>3}：解析错误"

                timestamp = self.extract_timestamp(current_line)
                msg = self.parse_message_segments(message_content)
                segs = []
                segs.append({'kind': 'ts', 'text': time_str, 'idx': 0})
                segs.append({'kind': 'dir', 'text': direction, 'idx': 1})
                segs.append({'kind': 'node', 'text': str(node_number), 'idx': 2})
                if msg.get('message_type'):
                    segs.append({
                        'kind': 'msg_type',
                        'text': msg.get('message_type'),
                        'idx': 3,
                        'description': msg.get('description', '')
                    })
                if msg.get('version'):
                    segs.append({'kind': 'ver', 'text': msg.get('version'), 'idx': 4})
                base = 5
                for s in msg.get('segments', []):
                    segs.append({'kind': 'field', 'text': s.get('text', ''), 'idx': base + s.get('idx', 0)})
                log_entries.append({
                    'timestamp': timestamp,
                    'original_line1': current_line,
                    'original_line2': raw_message_content,
                    'parsed': log_line,
                    'segments': segs,
                    'message_type': msg.get('message_type', ''),
                    'version': msg.get('version', ''),
                    'description': msg.get('description', ''),
                    'escape_hits': msg.get('escape_hits', []),
                })
                i += 2
            else:
                i += 1

        return log_entries
