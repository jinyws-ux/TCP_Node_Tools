"""智能清理管理器 - 处理未锁定文件的自动清理。"""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timedelta
from typing import Dict, Iterable, List, Set

from .log_metadata_store import LogMetadataStore
from .report_mapping_store import ReportMappingStore


class CleanupManager:
    """智能清理管理器，根据日志锁定状态清理文件。"""

    def __init__(
        self,
        download_dir: str,
        html_logs_dir: str,
        report_mapping_store: ReportMappingStore,
        metadata_store: LogMetadataStore,
    ):
        """初始化清理管理器。"""
        self.download_dir = download_dir
        self.html_logs_dir = html_logs_dir
        self.report_mapping_store = report_mapping_store
        self.metadata_store = metadata_store
        self.logger = logging.getLogger(__name__)

    def get_all_logs_with_reports(self) -> List[Dict[str, any]]:
        """获取所有日志及其关联报告。"""
        all_logs = []
        
        # 遍历 downloads 目录获取所有日志文件
        if os.path.exists(self.download_dir):
            for root, _, files in os.walk(self.download_dir):
                for file in files:
                    if not file.startswith("tcp_trace") or file.endswith(".meta.json"):
                        continue
                        
                    log_path = os.path.abspath(os.path.join(root, file))
                    log_info = self._get_log_info(log_path)
                    all_logs.append(log_info)
        
        return all_logs
    
    def _get_log_info(self, log_path: str) -> Dict[str, any]:
        """获取单个日志文件的详细信息。"""
        # 读取元数据并明确判断锁定状态
        metadata = self.metadata_store.read(log_path)
        
        # 锁定状态判断：
        # 1. 如果元数据中明确包含 is_locked 字段，使用其值
        # 2. 如果没有 is_locked 字段，默认为 True（保守策略，避免误删）
        is_locked = metadata.get("is_locked", True)
        # 确保是布尔类型
        is_locked = bool(is_locked)
        
        # 过期状态判断 (14天限制)
        is_expired = False
        file_age_days = 0
        
        # 优先使用元数据中的下载时间
        download_time_str = metadata.get("download_time") or metadata.get("timestamp")
        if download_time_str:
            try:
                # 处理 ISO 格式 (2025-12-29T10:00:00.000)
                if 'T' in download_time_str:
                    # 简单处理，移除毫秒部分如果存在
                    dt_str = download_time_str.split('.')[0]
                    download_time = datetime.fromisoformat(dt_str)
                else:
                    # 处理其他格式 (2025-12-29 10:00:00)
                    download_time = datetime.strptime(download_time_str, "%Y-%m-%d %H:%M:%S")
                
                delta = datetime.now() - download_time
                file_age_days = delta.total_seconds() / (24 * 3600)
            except Exception as e:
                self.logger.warning(f"解析下载时间失败 {download_time_str}: {e}")
                # 解析失败则回退到文件系统时间
                if os.path.exists(log_path):
                    mtime = os.path.getmtime(log_path)
                    file_age_days = (time.time() - mtime) / (24 * 3600)
        else:
            # 如果没有元数据时间，使用文件系统修改时间
            if os.path.exists(log_path):
                mtime = os.path.getmtime(log_path)
                file_age_days = (time.time() - mtime) / (24 * 3600)
        
        # 超过 14 天视为过期
        is_expired = file_age_days > 14
        
        # 获取关联报告
        related_reports = self.report_mapping_store.get(log_path)
        
        return {
            "log_path": log_path,
            "is_locked": is_locked,
            "is_expired": is_expired,
            "file_age_days": round(file_age_days, 1),
            "metadata_path": self.metadata_store.path_for(log_path),
            "related_reports": related_reports,
        }

    def cleanup_unlocked_files(self) -> Dict[str, any]:
        """清理所有未锁定的文件。"""
        start_time = time.time()
        stats = {
            "total_logs": 0,
            "locked_logs": 0,
            "unlocked_logs": 0,
            "deleted_logs": 0,
            "deleted_metadata": 0,
            "deleted_reports": 0,
            "deleted_directories": 0,
            "start_time": datetime.now().isoformat(),
        }
        
        try:
            # 获取所有日志及其关联报告
            all_logs = self.get_all_logs_with_reports()
            stats["total_logs"] = len(all_logs)
            
            deleted_files = set()
            
            # 处理每个日志
            for log_info in all_logs:
                log_path = log_info["log_path"]
                is_locked = log_info["is_locked"]
                is_expired = log_info.get("is_expired", False)
                metadata_path = log_info["metadata_path"]
                related_reports = log_info["related_reports"]
                
                # 清理逻辑：
                # 1. 如果未锁定，直接清理
                # 2. 如果已锁定但已过期 (超过14天)，也清理
                if is_locked and not is_expired:
                    stats["locked_logs"] += 1
                    self.logger.info(f"跳过锁定文件 (未过期): {log_path}")
                    continue
                
                if is_locked and is_expired:
                    self.logger.info(f"处理已过期锁定文件 (超过14天): {log_path}")
                else:
                    self.logger.info(f"处理未锁定文件: {log_path}")
                
                stats["unlocked_logs"] += 1
                
                # 删除日志文件和关联元数据
                try:
                    # 删除日志文件
                    if os.path.exists(log_path):
                        os.remove(log_path)
                        deleted_files.add(log_path)
                        stats["deleted_logs"] += 1
                        self.logger.info(f"已删除未锁定日志: {log_path}")
                    
                    # 无论日志文件是否存在，都删除关联的元数据文件
                    if os.path.exists(metadata_path):
                        os.remove(metadata_path)
                        deleted_files.add(metadata_path)
                        stats["deleted_metadata"] += 1
                        self.logger.info(f"已删除关联元数据: {metadata_path}")
                except Exception as e:
                    self.logger.error(f"删除文件失败 {log_path}: {e}")
                
                # 删除关联报告
                for report_path in related_reports:
                    if os.path.exists(report_path):
                        try:
                            os.remove(report_path)
                            deleted_files.add(report_path)
                            stats["deleted_reports"] += 1
                            self.logger.info(f"已删除关联报告: {report_path}")
                        except Exception as e:
                            self.logger.error(f"删除报告失败 {report_path}: {e}")
                
                # 从映射中删除日志记录
                self.report_mapping_store.delete(log_path)
            
            # 删除空目录
            deleted_dirs = self._clean_empty_directories()
            stats["deleted_directories"] = deleted_dirs
            
            # 处理孤立报告文件
            orphaned_reports = self._clean_orphaned_reports()
            stats["deleted_reports"] += orphaned_reports
            
            # 处理孤立元数据文件
            orphaned_metadata = self._clean_orphaned_metadata()
            stats["deleted_metadata"] += orphaned_metadata
            
            stats["end_time"] = datetime.now().isoformat()
            stats["duration_seconds"] = round(time.time() - start_time, 2)
            
            self.logger.info(
                "清理完成: 删除 %d 个日志, %d 个元数据, %d 个报告, %d 个空目录",
                stats["deleted_logs"],
                stats["deleted_metadata"],
                stats["deleted_reports"],
                stats["deleted_directories"],
            )
            
            return {
                "success": True,
                "stats": stats,
                "deleted_files": list(deleted_files),
            }
            
        except Exception as e:
            self.logger.error(f"清理过程失败: {e}", exc_info=True)
            return {
                "success": False,
                "error": str(e),
                "stats": stats,
            }

    def _clean_empty_directories(self) -> int:
        """清理空目录。"""
        deleted_count = 0
        
        # 清理 downloads 目录下的空目录
        deleted_count += self._clean_empty_dirs_recursive(self.download_dir)
        
        # 清理 html_logs 目录下的空目录
        deleted_count += self._clean_empty_dirs_recursive(self.html_logs_dir)
        
        # 清理映射配置目录下的空目录
        mapping_config_dir = getattr(self.metadata_store, 'metadata_dir', self.download_dir)
        if mapping_config_dir != self.download_dir:
            deleted_count += self._clean_empty_dirs_recursive(mapping_config_dir)
        
        return deleted_count

    def _clean_empty_dirs_recursive(self, directory: str) -> int:
        """递归清理空目录。"""
        deleted_count = 0
        
        if not os.path.exists(directory):
            return deleted_count
        
        # 先清理子目录
        for root, dirs, _ in os.walk(directory, topdown=False):
            for dir_name in dirs:
                dir_path = os.path.join(root, dir_name)
                try:
                    # 检查目录是否为空
                    if not os.listdir(dir_path):
                        os.rmdir(dir_path)
                        deleted_count += 1
                        self.logger.info(f"已删除空目录: {dir_path}")
                except Exception as e:
                    self.logger.error(f"删除目录失败 {dir_path}: {e}")
        
        return deleted_count

    def _clean_orphaned_reports(self) -> int:
        """清理孤立的报告文件（没有关联日志的报告）。"""
        deleted_count = 0
        
        # 1. 获取所有有映射的报告文件
        mapped_reports = self.report_mapping_store.get_all_reports()
        
        # 2. 遍历整个 html_logs 目录，检查每个报告文件
        if os.path.exists(self.html_logs_dir):
            for root, _, files in os.walk(self.html_logs_dir):
                for file in files:
                    # 跳过分析统计文件和报告映射文件
                    if file == 'analysis_stats.json' or file == 'report_mappings.json':
                        continue
                        
                    # 只处理报告相关文件（.html, .json等）
                    if file.endswith(('.html', '.json', '.txt')):
                        report_path = os.path.abspath(os.path.join(root, file))
                        
                        # 检查该报告是否有关联日志
                        related_logs = self.report_mapping_store.get_related_logs(report_path)
                        
                        # 如果报告没有关联日志，删除它
                        if not related_logs:
                            try:
                                os.remove(report_path)
                                deleted_count += 1
                                self.logger.info(f"已删除孤立报告: {report_path}")
                            except Exception as e:
                                self.logger.error(f"删除孤立报告失败 {report_path}: {e}")
        
        return deleted_count

    def cleanup_log(self, log_path: str) -> Dict[str, any]:
        """清理指定的单个日志文件及其关联文件。"""
        start_time = time.time()
        stats = {
            "total_logs": 1,
            "locked_logs": 0,
            "unlocked_logs": 0,
            "deleted_logs": 0,
            "deleted_metadata": 0,
            "deleted_reports": 0,
            "deleted_directories": 0,
            "start_time": datetime.now().isoformat(),
        }
        
        try:
            deleted_files = set()
            
            # 检查日志文件是否存在
            if not os.path.exists(log_path):
                return {
                    "success": False,
                    "error": f"日志文件不存在: {log_path}",
                    "stats": stats
                }
            
            # 获取日志信息
            log_info = self._get_log_info(log_path)
            is_locked = log_info["is_locked"]
            is_expired = log_info.get("is_expired", False)
            metadata_path = log_info["metadata_path"]
            related_reports = log_info["related_reports"]
            
            # 如果已锁定且未过期，禁止删除
            if is_locked and not is_expired:
                stats["locked_logs"] += 1
                return {
                    "success": False,
                    "error": f"日志文件已锁定且未过期: {log_path}",
                    "stats": stats
                }
            
            if is_locked and is_expired:
                self.logger.info(f"手动清理已过期的锁定文件: {log_path}")
            
            stats["unlocked_logs"] += 1
            
            # 删除日志文件
            try:
                os.remove(log_path)
                deleted_files.add(log_path)
                stats["deleted_logs"] += 1
                self.logger.info(f"已删除日志: {log_path}")
            except Exception as e:
                self.logger.error(f"删除日志失败 {log_path}: {e}")
                return {
                    "success": False,
                    "error": f"删除日志失败: {str(e)}",
                    "stats": stats
                }
            
            # 删除关联元数据
            if os.path.exists(metadata_path):
                try:
                    os.remove(metadata_path)
                    deleted_files.add(metadata_path)
                    stats["deleted_metadata"] += 1
                    self.logger.info(f"已删除元数据: {metadata_path}")
                except Exception as e:
                    self.logger.error(f"删除元数据失败 {metadata_path}: {e}")
            
            # 删除关联报告
            for report_path in related_reports:
                if os.path.exists(report_path):
                    try:
                        os.remove(report_path)
                        deleted_files.add(report_path)
                        stats["deleted_reports"] += 1
                        self.logger.info(f"已删除报告: {report_path}")
                    except Exception as e:
                        self.logger.error(f"删除报告失败 {report_path}: {e}")
            
            # 从映射中删除日志记录
            self.report_mapping_store.delete(log_path)
            
            # 清理空目录
            deleted_dirs = self._clean_empty_directories()
            stats["deleted_directories"] = deleted_dirs
            
            stats["end_time"] = datetime.now().isoformat()
            stats["duration_seconds"] = round(time.time() - start_time, 2)
            
            self.logger.info(
                "单个日志清理完成: 删除 %d 个日志, %d 个元数据, %d 个报告, %d 个空目录",
                stats["deleted_logs"],
                stats["deleted_metadata"],
                stats["deleted_reports"],
                stats["deleted_directories"],
            )
            
            return {
                "success": True,
                "stats": stats,
                "deleted_files": list(deleted_files),
            }
            
        except Exception as e:
            self.logger.error(f"清理单个日志失败: {e}", exc_info=True)
            return {
                "success": False,
                "error": str(e),
                "stats": stats,
            }
    
    def _clean_orphaned_metadata(self) -> int:
        """清理孤立的元数据文件（没有对应日志的元数据）。"""
        deleted_count = 0
        
        # 处理同目录存储的元数据文件
        if os.path.exists(self.download_dir):
            for root, _, files in os.walk(self.download_dir):
                for file in files:
                    if not file.endswith(".meta.json"):
                        continue
                        
                    metadata_path = os.path.abspath(os.path.join(root, file))
                    # 生成对应的日志文件路径
                    log_path = metadata_path[:-10]  # 移除 .meta.json 后缀
                    
                    # 如果对应的日志文件不存在，删除元数据文件
                    if not os.path.exists(log_path):
                        try:
                            os.remove(metadata_path)
                            deleted_count += 1
                            self.logger.info(f"已删除孤立元数据: {metadata_path}")
                        except Exception as e:
                            self.logger.error(f"删除孤立元数据失败 {metadata_path}: {e}")
        
        # 处理单独目录存储的元数据文件
        # 获取元数据存储目录
        metadata_dir = getattr(self.metadata_store, 'metadata_dir', self.download_dir)
        if metadata_dir != self.download_dir and os.path.exists(metadata_dir):
            for root, _, files in os.walk(metadata_dir):
                for file in files:
                    if not file.endswith(".meta.json"):
                        continue
                        
                    metadata_path = os.path.abspath(os.path.join(root, file))
                    
                    # 生成对应的日志文件路径
                    # 从元数据文件名中提取日志文件名
                    log_filename = file[:-10]  # 移除 .meta.json 后缀
                    
                    # 尝试在 downloads 目录中查找对应的日志文件
                    log_found = False
                    for download_root, _, download_files in os.walk(self.download_dir):
                        if log_filename in download_files:
                            log_found = True
                            break
                    
                    # 如果对应的日志文件不存在，删除元数据文件
                    if not log_found:
                        try:
                            os.remove(metadata_path)
                            deleted_count += 1
                            self.logger.info(f"已删除孤立元数据: {metadata_path}")
                        except Exception as e:
                            self.logger.error(f"删除孤立元数据失败 {metadata_path}: {e}")
        
        return deleted_count

    def schedule_daily_cleanup(self, hour: int = 5, minute: int = 0) -> None:
        """安排每天的自动清理任务。"""
        def run_cleanup():
            """执行清理的内部函数。"""
            self.logger.info("开始执行每日自动清理任务...")
            result = self.cleanup_unlocked_files()
            if result["success"]:
                stats = result["stats"]
                self.logger.info(
                    "每日清理任务完成: 删除 %d 个日志, %d 个元数据, %d 个报告",
                    stats["deleted_logs"],
                    stats["deleted_metadata"],
                    stats["deleted_reports"],
                )
            else:
                self.logger.error(f"每日清理任务失败: {result['error']}")
            
            # 安排下一次执行
            schedule_next_run()
        
        def schedule_next_run():
            """安排下一次清理任务。"""
            now = datetime.now()
            next_run = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
            
            # 如果今天的时间已过，安排到明天
            if next_run <= now:
                next_run += timedelta(days=1)
            
            delay_seconds = (next_run - now).total_seconds()
            self.logger.info(f"下次清理任务安排在: {next_run.strftime('%Y-%m-%d %H:%M:%S')}")
            
            # 使用线程定时器执行
            import threading
            threading.Timer(delay_seconds, run_cleanup).start()
        
        # 启动第一次执行
        schedule_next_run()
