# core/log_analyzer.py
import json
import logging
import os
import re
from time import perf_counter
from typing import Any, Dict, List, Optional, Tuple

from .log_parser import LogParser
from .report_generator import ReportGenerator
from .log_metadata_store import LogMetadataStore


class LogAnalyzer:
    def __init__(
        self,
        output_dir: str,
        config_manager: Any,
        parser_config_manager: Any,
        *,
        metadata_store: Optional[LogMetadataStore] = None,
    ):
        self.output_dir = output_dir
        self.config_manager = config_manager
        self.parser_config_manager = parser_config_manager
        self.logger = logging.getLogger(__name__)
        os.makedirs(output_dir, exist_ok=True)
        self.metadata_store = metadata_store

    def analyze_logs(
        self,
        log_paths: List[str],
        factory: str,
        system: str,
        *,
        options: Dict[str, Any] | None = None,
    ) -> Dict[str, Any]:
        """分析日志文件并生成报告，顺便记录阶段耗时。"""
        stats: List[Dict[str, Any]] = []
        opts = {
            'generate_html': True,
            'generate_original_log': True,
            'generate_sorted_log': True,
        }
        if options:
            opts.update(options)

        try:
            if not log_paths:
                self.logger.error("未选择日志文件")
                return {'success': False, 'error': '未选择日志文件', 'stats': stats}

            parser_config = self.parser_config_manager.load_config(factory, system)
            if not parser_config:
                self.logger.error(f"未找到解析配置: {factory}/{system}")
                return {
                    'success': False,
                    'error': f'未找到解析配置: {factory}/{system}',
                    'stats': stats
                }

            parser = LogParser(parser_config)
            report_generator = ReportGenerator(self.output_dir)

            stage_start = perf_counter()
            all_log_lines, _ = self._read_log_files(log_paths)
            self._record_stage(stats, '读取日志文件', stage_start, len(log_paths), len(all_log_lines))
            if not all_log_lines:
                self.logger.error("未读取到有效的日志内容")
                return {'success': False, 'error': '未读取到有效的日志内容', 'stats': stats}

            stage_start = perf_counter()
            log_entries = parser.parse_log_lines(all_log_lines)
            self._record_stage(stats, '解析日志条目', stage_start, len(all_log_lines), len(log_entries))
            if not log_entries:
                self.logger.error("未解析到有效的日志条目")
                return {'success': False, 'error': '未解析到有效的日志条目', 'stats': stats}

            timestamp = self._get_timestamp()
            html_report_path = ''
            if opts.get('generate_html', True):
                report_filename = self._generate_smart_filename(factory, system, log_paths, timestamp)
                html_report_path = os.path.join(self.output_dir, report_filename)
                stage_start = perf_counter()
                generated_html_path = report_generator.generate_html_logs(log_entries, html_report_path)
                self._record_stage(stats, '生成HTML报告', stage_start, len(log_entries), 1)

                if not generated_html_path or not os.path.exists(generated_html_path):
                    self.logger.error("HTML报告生成失败")
                    return {'success': False, 'error': 'HTML报告生成失败', 'stats': stats}
                html_report_path = generated_html_path

            original_log_path = ''
            sorted_log_path = ''
            if opts.get('generate_original_log', True):
                stage_start = perf_counter()
                original_log_path = self._generate_text_log(log_entries, "converted", timestamp)
                self._record_stage(stats, '输出文本日志', stage_start, len(log_entries), 1 if original_log_path else 0)

            if opts.get('generate_sorted_log', True):
                stage_start = perf_counter()
                sorted_log_path = self._generate_sorted_text_log(log_entries, "sorted", timestamp)
                self._record_stage(stats, '输出排序日志', stage_start, len(log_entries), 1 if sorted_log_path else 0)

            self._write_stats_record(factory, system, log_paths, len(log_entries), stats, opts)
            self.logger.info(
                "分析完成: 生成%s条日志记录，报告文件: %s",
                len(log_entries),
                html_report_path or '未生成',
            )

            return {
                'success': True,
                'html_report': html_report_path,
                'original_log': original_log_path,
                'sorted_log': sorted_log_path,
                'log_entries_count': len(log_entries),
                'stats': stats,
            }

        except Exception as e:
            self.logger.error(f"分析日志失败: {str(e)}", exc_info=True)
            return {'success': False, 'error': str(e), 'stats': stats}

    def delete_log(self, log_path: str) -> Dict[str, Any]:
        """删除日志文件"""
        try:
            if not os.path.exists(log_path):
                self.logger.error(f"日志文件不存在: {log_path}")
                return {'success': False, 'error': '日志文件不存在'}

            os.remove(log_path)
            if self.metadata_store:
                self.metadata_store.delete(log_path)
            else:
                meta_path = f"{log_path}.meta.json"
                if os.path.exists(meta_path):
                    try:
                        os.remove(meta_path)
                    except Exception:
                        self.logger.warning("删除日志元数据失败: %s", meta_path)
            self.logger.info(f"成功删除日志文件: {log_path}")
            return {'success': True}
        except Exception as e:
            self.logger.error(f"删除日志失败: {str(e)}")
            return {'success': False, 'error': str(e)}

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

    def _record_stage(
        self,
        stats: List[Dict[str, Any]],
        name: str,
        started_at: float,
        input_items: int,
        output_items: int,
    ) -> None:
        duration_ms = round((perf_counter() - started_at) * 1000, 2)
        stats.append({
            'stage': name,
            'duration_ms': duration_ms,
            'input_items': input_items,
            'output_items': output_items,
        })

    def _read_log_files(self, log_paths: List[str]) -> Tuple[List[str], int]:
        lines: List[str] = []
        read_files = 0
        for log_path in log_paths:
            if not os.path.exists(log_path):
                self.logger.warning(f"日志文件不存在: {log_path}")
                continue
            try:
                with open(log_path, 'r', encoding='utf-8', errors='ignore') as f:
                    file_lines = f.readlines()
                    lines.extend(file_lines)
                    read_files += 1
            except Exception as exc:
                self.logger.error(f"读取日志文件失败: {log_path}, 错误: {exc}")
        return lines, read_files

    def _write_stats_record(
        self,
        factory: str,
        system: str,
        log_paths: List[str],
        entry_count: int,
        stats: List[Dict[str, Any]],
        options: Dict[str, Any],
    ) -> None:
        record = {
            'timestamp': self._get_timestamp(),
            'factory': factory,
            'system': system,
            'log_files': [os.path.basename(p) for p in log_paths],
            'log_file_count': len(log_paths),
            'log_entry_count': entry_count,
            'options': options,
            'stages': stats,
        }
        stats_path = os.path.join(self.output_dir, 'analysis_stats.json')
        try:
            data: List[Dict[str, Any]] = []
            if os.path.exists(stats_path):
                with open(stats_path, 'r', encoding='utf-8') as f:
                    loaded = json.load(f)
                    if isinstance(loaded, list):
                        data = loaded
            data.append(record)
            data = data[-50:]
            with open(stats_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as exc:
            self.logger.warning(f"写入分析统计失败: {exc}")

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