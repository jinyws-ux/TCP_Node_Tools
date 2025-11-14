"""分析模块的协调服务。"""
from __future__ import annotations

import os
from typing import Any, Dict, Iterable, List, Optional

from .report_mapping_store import ReportMappingStore


class AnalysisService:
    """把“已下载日志 + 分析 + 报告映射”整合在一起，方便 Flask 层复用。"""

    def __init__(
        self,
        log_downloader: Any,
        log_analyzer: Any,
        report_store: ReportMappingStore,
    ) -> None:
        self.log_downloader = log_downloader
        self.log_analyzer = log_analyzer
        self.report_store = report_store

    # -------- 列表与辅助 --------
    def list_downloaded_logs(self) -> List[Dict[str, Any]]:
        return self.log_downloader.get_downloaded_logs()

    def get_reports_directory(self) -> str:
        return getattr(self.log_analyzer, "output_dir", "")

    # -------- 核心动作 --------
    def analyze_logs(
        self,
        log_paths: Iterable[str],
        config_id: str,
        *,
        options: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        log_paths = [p for p in (log_paths or []) if p]
        if not log_paths:
            raise ValueError("请至少选择一个日志文件")

        factory, system = self._parse_config_id(config_id)
        result = self.log_analyzer.analyze_logs(
            log_paths,
            factory,
            system,
            options=options,
        )

        if result.get("success") and result.get("html_report"):
            self.report_store.save_many(log_paths, result["html_report"])
        return result

    def delete_log(self, log_path: str) -> Dict[str, Any]:
        if not log_path:
            raise ValueError("缺少日志路径")
        result = self.log_analyzer.delete_log(log_path)
        if result.get("success"):
            self.report_store.delete(log_path)
        return result

    def check_report(self, log_path: str) -> Dict[str, Any]:
        if not log_path:
            raise ValueError("缺少日志路径")
        report_path = self.report_store.get(log_path)
        has_report = bool(report_path and os.path.exists(report_path))
        return {
            "success": True,
            "report_path": report_path,
            "has_report": has_report,
        }

    # -------- 私有工具 --------
    def _parse_config_id(self, config_id: str) -> List[str]:
        if not config_id:
            raise ValueError("请选择解析配置")
        filename = config_id.strip()
        if filename.endswith(".json"):
            filename = filename[:-5]
        if "_" not in filename:
            raise ValueError("解析配置命名需遵循“厂区_系统.json”格式")
        factory, system = filename.split("_", 1)
        factory = factory.strip()
        system = system.strip()
        if not factory or not system:
            raise ValueError("解析配置命名不完整，缺少厂区或系统")
        return [factory, system]
