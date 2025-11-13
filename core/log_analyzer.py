# core/log_analyzer.py
import logging
import os
from typing import List, Dict, Any
import re

from .log_parser import LogParser
from .report_generator import ReportGenerator


class LogAnalyzer:
    def __init__(self, output_dir: str, config_manager: Any, parser_config_manager: Any):
        self.output_dir = output_dir
        self.config_manager = config_manager
        self.parser_config_manager = parser_config_manager
        self.logger = logging.getLogger(__name__)
        os.makedirs(output_dir, exist_ok=True)

    def analyze_logs(self, log_paths: List[str], factory: str, system: str) -> Dict[str, Any]:
        """分析日志文件并生成报告 - 修复映射关系"""
        try:
            if not log_paths:
                self.logger.error("未选择日志文件")
                return {'success': False, 'error': '未选择日志文件'}

            # 加载解析配置
            parser_config = self.parser_config_manager.load_config(factory, system)
            if not parser_config:
                self.logger.error(f"未找到解析配置: {factory}/{system}")
                return {'success': False, 'error': f'未找到解析配置: {factory}/{system}'}

            # 创建解析器和报告生成器
            parser = LogParser(parser_config)
            report_generator = ReportGenerator(self.output_dir)

            # 存储日志文件与报告的映射关系
            report_mappings = {}

            # 读取所有日志文件内容
            all_log_lines = []
            for log_path in log_paths:
                if not os.path.exists(log_path):
                    self.logger.error(f"日志文件不存在: {log_path}")
                    continue

                try:
                    with open(log_path, 'r', encoding='utf-8', errors='ignore') as f:
                        lines = f.readlines()
                        all_log_lines.extend(lines)
                except Exception as e:
                    self.logger.error(f"读取日志文件失败: {log_path}, 错误: {str(e)}")
                    continue

            if not all_log_lines:
                self.logger.error("未读取到有效的日志内容")
                return {'success': False, 'error': '未读取到有效的日志内容'}

            # 解析日志
            log_entries = parser.parse_log_lines(all_log_lines)

            if not log_entries:
                self.logger.error("未解析到有效的日志条目")
                return {'success': False, 'error': '未解析到有效的日志条目'}

            # 生成报告 - 为每个日志文件生成对应的报告
            timestamp = self._get_timestamp()

            # 生成HTML报告
            report_filename = self._generate_smart_filename(factory, system, log_paths, timestamp)
            html_report_path = os.path.join(self.output_dir, report_filename)

            # 调用报告生成器 - 确保参数正确
            generated_html_path = report_generator.generate_html_logs(log_entries, html_report_path)

            if not generated_html_path or not os.path.exists(generated_html_path):
                self.logger.error("HTML报告生成失败")
                return {'success': False, 'error': 'HTML报告生成失败'}

            # 建立映射关系：每个日志文件都映射到同一个报告文件
            for log_path in log_paths:
                report_mappings[log_path] = generated_html_path

            # 生成文本日志（可选）
            original_log_path = self._generate_text_log(log_entries, "converted", timestamp)
            sorted_log_path = self._generate_sorted_text_log(log_entries, "sorted", timestamp)

            self.logger.info(f"分析完成: 生成{len(log_entries)}条日志记录，报告文件: {generated_html_path}")

            return {
                'success': True,
                'html_report': generated_html_path,
                'original_log': original_log_path,
                'sorted_log': sorted_log_path,
                'log_entries_count': len(log_entries),
                'report_mappings': report_mappings  # 返回映射关系
            }

        except Exception as e:
            self.logger.error(f"分析日志失败: {str(e)}", exc_info=True)
            return {'success': False, 'error': str(e)}

    def view_log_content(self, log_path: str) -> Dict[str, Any]:
        """查看日志文件内容"""
        try:
            if not os.path.exists(log_path):
                self.logger.error(f"日志文件不存在: {log_path}")
                return {'success': False, 'error': '日志文件不存在'}

            with open(log_path, 'r', encoding='utf-8') as f:
                content = f.read()

            self.logger.info(f"成功查看日志内容: {log_path}")
            return {
                'success': True,
                'content': content,
                'path': log_path
            }
        except Exception as e:
            self.logger.error(f"查看日志内容失败: {str(e)}")
            return {'success': False, 'error': str(e)}

    def delete_log(self, log_path: str) -> Dict[str, Any]:
        """删除日志文件"""
        try:
            if not os.path.exists(log_path):
                self.logger.error(f"日志文件不存在: {log_path}")
                return {'success': False, 'error': '日志文件不存在'}

            os.remove(log_path)
            self.logger.info(f"成功删除日志文件: {log_path}")
            return {'success': True}
        except Exception as e:
            self.logger.error(f"删除日志失败: {str(e)}")
            return {'success': False, 'error': str(e)}

    def get_downloaded_logs(self) -> List[Dict[str, Any]]:
        """获取已下载的日志列表"""
        try:
            downloaded_logs = []

            if os.path.exists(self.output_dir):
                for root, dirs, files in os.walk(self.output_dir):
                    for file in files:
                        if file.startswith('tcp_trace'):
                            file_path = os.path.join(root, file)
                            # 从路径中提取信息
                            path_parts = file_path.split(os.sep)
                            if len(path_parts) >= 4:
                                factory = path_parts[-4] if len(path_parts) >= 4 else '未知'
                                system = path_parts[-3] if len(path_parts) >= 3 else '未知'
                                node = path_parts[-2] if len(path_parts) >= 2 else '未知'

                                downloaded_logs.append({
                                    'id': len(downloaded_logs) + 1,
                                    'path': file_path,
                                    'name': file,
                                    'factory': factory,
                                    'system': system,
                                    'node': node,
                                    'timestamp': os.path.getctime(file_path),
                                    'size': os.path.getsize(file_path)
                                })

            self.logger.info(f"成功获取已下载日志列表，共{len(downloaded_logs)}个文件")
            return downloaded_logs
        except Exception as e:
            self.logger.error(f"获取已下载日志失败: {str(e)}")
            return []

    def _get_timestamp(self) -> str:
        """获取当前时间戳"""
        from datetime import datetime
        return datetime.now().strftime("%Y%m%d_%H%M%S")

    def _generate_text_log(self, log_entries: List[Dict[str, Any]], prefix: str, timestamp: str) -> str:
        """生成文本日志文件"""
        try:
            filename = f"{prefix}_{timestamp}.log"
            file_path = os.path.join(self.output_dir, filename)

            with open(file_path, 'w', encoding='utf-8') as f:
                for entry in log_entries:
                    f.write(entry['parsed'] + '\n')

            self.logger.info(f"生成文本日志: {file_path}")
            return file_path
        except Exception as e:
            self.logger.error(f"生成文本日志失败: {str(e)}")
            return ""

    def _generate_sorted_text_log(self, log_entries: List[Dict[str, Any]], prefix: str, timestamp: str) -> str:
        """生成排序后的文本日志文件"""
        try:
            # 按时间戳排序
            sorted_entries = sorted(
                [entry for entry in log_entries if entry.get('timestamp')],
                key=lambda x: x['timestamp']
            )

            filename = f"{prefix}_{timestamp}.log"
            file_path = os.path.join(self.output_dir, filename)

            with open(file_path, 'w', encoding='utf-8') as f:
                for entry in sorted_entries:
                    f.write(entry['parsed'] + '\n')

            self.logger.info(f"生成排序日志: {file_path}")
            return file_path
        except Exception as e:
            self.logger.error(f"生成排序日志失败: {str(e)}")
            return ""

    def _generate_smart_filename(self, factory: str, system: str, log_paths: List[str], timestamp: str) -> str:
        """生成智能报告文件名"""
        # 从日志路径中提取节点信息
        nodes = set()
        for log_path in log_paths:
            node = self._extract_node_from_path(log_path)
            if node:
                nodes.add(node)

        # 对节点进行排序
        sorted_nodes = sorted(nodes, key=lambda x: int(x) if x.isdigit() else x)

        # 根据节点数量确定分析类型和节点表示
        if len(sorted_nodes) == 1:
            analysis_type = "单节点"
            node_info = f"节点{sorted_nodes[0]}"
        elif len(sorted_nodes) <= 3:
            analysis_type = "多节点"
            node_info = f"节点{'+'.join(sorted_nodes)}"
        else:
            analysis_type = "多节点"
            node_info = f"节点{sorted_nodes[0]}-{sorted_nodes[-1]}_共{len(sorted_nodes)}个"

        # 清理厂区和系统名称中的特殊字符
        clean_factory = re.sub(r'[\\/*?:"<>|]', '_', factory)
        clean_system = re.sub(r'[\\/*?:"<>|]', '_', system)

        return f"{analysis_type}_{clean_factory}_{clean_system}_{node_info}_{timestamp}.html"

    def _extract_node_from_path(self, log_path: str) -> str:
        """从日志文件路径中提取节点号"""
        try:
            filename = os.path.basename(log_path)

            # 匹配常见的日志文件名格式
            patterns = [
                r'tcp_trace\.(\d+)',  # tcp_trace.200
                r'tcp_trace\.(\d+)\.old',  # tcp_trace.200.old
                r'tcp_trace\.(\d+)\.\d+',  # tcp_trace.200.12345
                r'tcp_trace\.(\d+)\.l',  # tcp_trace.500.l (您遇到的格式)
                r'tcp_trace\.(\d+)\.log',  # tcp_trace.200.log
                r'tcp_trace_(\d+)',  # tcp_trace_200
                r'tcp_?trace[._-](\d+)',  # 更通用的匹配
            ]

            for pattern in patterns:
                match = re.search(pattern, filename)
                if match:
                    return match.group(1)

            # 如果无法匹配，尝试从路径中提取
            path_parts = log_path.split(os.sep)
            for part in path_parts:
                if part.isdigit() and len(part) >= 2:  # 节点号通常至少2位
                    return part

            return "未知"

        except Exception as e:
            self.logger.error(f"提取节点号失败 {log_path}: {str(e)}")
            return "未知"