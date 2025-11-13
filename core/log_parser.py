# core/log_parser.py
import logging
import re
from datetime import datetime
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)


class LogParser:
    def __init__(self, parser_config: Dict[str, Any]):
        self.parser_config = parser_config
        self.logger = logging.getLogger(__name__)

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
        """从消息内容中提取版本信息"""
        try:
            if len(content) >= 32:
                return content[28:32].strip()
            return None
        except Exception as e:
            self.logger.error(f"获取版本信息时发生错误：{e}")
            return None

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
            field_values = {}
            for field, field_cfg in fields_config.items():
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

                log_entries.append({
                    'timestamp': timestamp,
                    'original_line1': original_line1,
                    'original_line2': original_line2,
                    'parsed': self.parse_message_content(original_line1)
                })
                i += 2
                continue

            # 处理方向性日志行
            match = direction_pattern.match(current_line)
            if match:
                time_str = match.group(1)
                direction = match.group(2)
                node_number = match.group(3)
                message_content = log_lines[i + 1].strip() if i + 1 < total_lines else "无内容"

                # 跳过无效内容
                if message_content.startswith("???") and len(message_content) < 10:
                    i += 1
                    continue
                if "PING_IPS" in message_content or "PING_I_R" in message_content:
                    i += 1
                    continue

                # 处理输出方向的消息
                if direction == "Output" and len(message_content) >= 7:
                    message_content = message_content[7:]

                # 解析消息内容
                try:
                    parsed_content = self.parse_message_content(message_content)
                    log_line = f"{time_str:<16} {direction:<6} {node_number:>3}：{parsed_content}"
                except Exception as e:
                    logger.error(f"解析消息内容时发生错误：{e}")
                    log_line = f"{time_str:<16} {direction:<6} {node_number:>3}：解析错误"

                timestamp = self.extract_timestamp(current_line)
                log_entries.append({
                    'timestamp': timestamp,
                    'original_line1': current_line,
                    'original_line2': message_content,
                    'parsed': log_line
                })
                i += 2
            else:
                i += 1

        return log_entries