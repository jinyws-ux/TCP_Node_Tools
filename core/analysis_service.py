"""分析模块的协调服务。"""
from __future__ import annotations

import os
from typing import Any, Dict, Iterable, List, Optional

from .report_mapping_store import ReportMappingStore
from .report_data_store import ReportDataStore


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
        # 初始化报告数据存储
        self.report_data_store = ReportDataStore(getattr(log_analyzer, "output_dir", "."))

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

        if result.get("success"):
            # 保存报告数据到报告数据存储
            if result.get("report_data"):
                report_id = self.save_report_data(result["report_data"])
                result["report_id"] = report_id
            # 不再保存HTML报告映射，因为我们已经迁移到报告数据存储
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
        report_paths = self.report_store.get(log_path)
        has_report = bool(report_paths and any(os.path.exists(p) for p in report_paths))
        return {
            "success": True,
            "report_path": report_paths[0] if report_paths else "",
            "report_paths": report_paths,
            "has_report": has_report,
        }

    def get_log_reports(self, log_path: str) -> List[Dict[str, Any]]:
        """获取特定日志的报告列表
        
        Args:
            log_path: 日志路径
            
        Returns:
            List[Dict[str, Any]]: 报告列表
        """
        if not log_path:
            raise ValueError("缺少日志路径")
        
        # 获取所有报告
        all_reports = self.report_data_store.list_reports()
        
        # 过滤出与当前日志关联的报告
        log_reports = []
        for report in all_reports:
            if report.get("related_logs") and log_path in report["related_logs"]:
                log_reports.append(report)
        
        return log_reports

    # -------- 报告数据管理 --------
    def save_report_data(self, report_data: Dict[str, Any]) -> str:
        """保存报告数据
        
        Args:
            report_data: 报告数据，包含元数据和内容数据
            
        Returns:
            str: 报告ID
        """
        return self.report_data_store.save_report(report_data)

    def get_report_list(self, filters: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """获取报告列表
        
        Args:
            filters: 过滤条件
            
        Returns:
            List[Dict[str, Any]]: 报告列表
        """
        return self.report_data_store.list_reports(filters)

    def get_report_details(self, report_id: str) -> Optional[Dict[str, Any]]:
        """获取报告详情
        
        Args:
            report_id: 报告ID
            
        Returns:
            Optional[Dict[str, Any]]: 报告详情
        """
        return self.report_data_store.get_report(report_id)

    def delete_report(self, report_id: str) -> bool:
        """删除报告
        
        Args:
            report_id: 报告ID
            
        Returns:
            bool: 是否删除成功
        """
        return self.report_data_store.delete_report(report_id)

    def get_report_stats(self) -> Dict[str, Any]:
        """获取报告统计信息
        
        Returns:
            Dict[str, Any]: 报告统计信息
        """
        return self.report_data_store.get_report_stats()

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
