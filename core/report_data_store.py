# core/report_data_store.py
import json
import logging
import os
from datetime import datetime
from typing import List, Dict, Any, Optional

class ReportDataStore:
    """报告数据存储管理类
    
    负责报告数据的存储和管理，包括：
    - 报告元数据管理
    - 报告内容数据管理
    - 报告查询和检索
    """
    
    def __init__(self, output_dir: str):
        self.output_dir = output_dir
        self.logger = logging.getLogger(__name__)
        self.reports_dir = os.path.join(output_dir, 'reports_data')
        self.metadata_file = os.path.join(self.reports_dir, 'report_metadata.json')
        self.report_content_dir = os.path.join(self.reports_dir, 'content')
        
        # 确保目录存在
        os.makedirs(self.reports_dir, exist_ok=True)
        os.makedirs(self.report_content_dir, exist_ok=True)
        
        # 初始化元数据文件
        if not os.path.exists(self.metadata_file):
            with open(self.metadata_file, 'w', encoding='utf-8') as f:
                json.dump([], f, ensure_ascii=False, indent=2)
    
    def save_report(self, report_data: Dict[str, Any]) -> str:
        """保存报告数据
        
        Args:
            report_data: 报告数据，包含元数据和内容数据
            
        Returns:
            str: 报告ID
        """
        try:
            # 生成报告ID和时间戳
            report_id = f"report_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')[:-3]}"
            created_at = datetime.now().isoformat()
            
            # 提取或生成元数据
            metadata = {
                'report_id': report_id,
                'name': report_data.get('name', f'报告_{report_id}'),
                'created_at': created_at,
                'updated_at': created_at,
                'log_count': len(report_data.get('log_entries', [])),
                'abnormal_count': len(report_data.get('abnormal_items', [])),
                'factory': report_data.get('factory', ''),
                'system': report_data.get('system', ''),
                'nodes': report_data.get('nodes', []),
                'related_logs': report_data.get('related_logs', []),
                'start_time': report_data.get('start_time'),
                'end_time': report_data.get('end_time'),
                'size': 0,  # 后续计算
                'status': 'completed'
            }
            
            # 提取内容数据
            content_data = {
                'report_id': report_id,
                'log_entries': report_data.get('log_entries', []),
                'abnormal_items': report_data.get('abnormal_items', []),
                'message_types': report_data.get('message_types', []),
                'stats': report_data.get('stats', [])
            }
            
            # 保存内容数据
            content_file = os.path.join(self.report_content_dir, f'{report_id}.json')
            with open(content_file, 'w', encoding='utf-8') as f:
                json.dump(content_data, f, ensure_ascii=False, indent=2)
            
            # 更新内容大小
            metadata['size'] = os.path.getsize(content_file)
            
            # 保存元数据
            self._save_metadata(metadata)
            
            self.logger.info(f"报告数据保存成功: {report_id}")
            return report_id
        except Exception as e:
            self.logger.error(f"保存报告数据失败: {str(e)}", exc_info=True)
            raise
    
    def get_report_metadata(self, report_id: str) -> Optional[Dict[str, Any]]:
        """获取报告元数据
        
        Args:
            report_id: 报告ID
            
        Returns:
            Optional[Dict[str, Any]]: 报告元数据，如果不存在返回None
        """
        try:
            metadata_list = self._load_metadata()
            for metadata in metadata_list:
                if metadata['report_id'] == report_id:
                    return metadata
            return None
        except Exception as e:
            self.logger.error(f"获取报告元数据失败: {str(e)}", exc_info=True)
            return None
    
    def get_report_content(self, report_id: str) -> Optional[Dict[str, Any]]:
        """获取报告内容数据
        
        Args:
            report_id: 报告ID
            
        Returns:
            Optional[Dict[str, Any]]: 报告内容数据，如果不存在返回None
        """
        try:
            content_file = os.path.join(self.report_content_dir, f'{report_id}.json')
            if not os.path.exists(content_file):
                return None
            
            with open(content_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            self.logger.error(f"获取报告内容失败: {str(e)}", exc_info=True)
            return None
    
    def get_report(self, report_id: str) -> Optional[Dict[str, Any]]:
        """获取完整报告数据
        
        Args:
            report_id: 报告ID
            
        Returns:
            Optional[Dict[str, Any]]: 完整报告数据，如果不存在返回None
        """
        metadata = self.get_report_metadata(report_id)
        if not metadata:
            return None
        
        content = self.get_report_content(report_id)
        if not content:
            return None
        
        return {
            **metadata,
            **content
        }
    
    def list_reports(self, filters: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """获取报告列表
        
        Args:
            filters: 过滤条件
            
        Returns:
            List[Dict[str, Any]]: 报告元数据列表
        """
        try:
            metadata_list = self._load_metadata()
            
            # 应用过滤条件
            if filters:
                filtered = metadata_list
                if 'factory' in filters and filters['factory']:
                    filtered = [m for m in filtered if m['factory'] == filters['factory']]
                if 'system' in filters and filters['system']:
                    filtered = [m for m in filtered if m['system'] == filters['system']]
                if 'status' in filters and filters['status']:
                    filtered = [m for m in filtered if m['status'] == filters['status']]
                return filtered
            
            return metadata_list
        except Exception as e:
            self.logger.error(f"获取报告列表失败: {str(e)}", exc_info=True)
            return []
    
    def delete_report(self, report_id: str) -> bool:
        """删除报告
        
        Args:
            report_id: 报告ID
            
        Returns:
            bool: 是否删除成功
        """
        try:
            # 删除内容文件
            content_file = os.path.join(self.report_content_dir, f'{report_id}.json')
            if os.path.exists(content_file):
                os.remove(content_file)
            
            # 删除元数据
            metadata_list = self._load_metadata()
            updated_metadata = [m for m in metadata_list if m['report_id'] != report_id]
            self._save_metadata_list(updated_metadata)
            
            self.logger.info(f"报告删除成功: {report_id}")
            return True
        except Exception as e:
            self.logger.error(f"删除报告失败: {str(e)}", exc_info=True)
            return False
    
    def _load_metadata(self) -> List[Dict[str, Any]]:
        """加载所有报告元数据
        
        Returns:
            List[Dict[str, Any]]: 报告元数据列表
        """
        try:
            with open(self.metadata_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            self.logger.error(f"加载报告元数据失败: {str(e)}", exc_info=True)
            return []
    
    def _save_metadata_list(self, metadata_list: List[Dict[str, Any]]) -> None:
        """保存报告元数据列表
        
        Args:
            metadata_list: 报告元数据列表
        """
        try:
            with open(self.metadata_file, 'w', encoding='utf-8') as f:
                json.dump(metadata_list, f, ensure_ascii=False, indent=2)
        except Exception as e:
            self.logger.error(f"保存报告元数据列表失败: {str(e)}", exc_info=True)
            raise
    
    def _save_metadata(self, metadata: Dict[str, Any]) -> None:
        """保存单个报告元数据
        
        Args:
            metadata: 报告元数据
        """
        metadata_list = self._load_metadata()
        
        # 检查是否已存在
        existing_index = -1
        for i, m in enumerate(metadata_list):
            if m['report_id'] == metadata['report_id']:
                existing_index = i
                break
        
        if existing_index >= 0:
            # 更新现有元数据
            metadata_list[existing_index] = metadata
        else:
            # 添加新元数据
            metadata_list.append(metadata)
        
        # 按创建时间倒序排序
        metadata_list.sort(key=lambda x: x['created_at'], reverse=True)
        
        self._save_metadata_list(metadata_list)
    
    def update_report_status(self, report_id: str, status: str) -> bool:
        """更新报告状态
        
        Args:
            report_id: 报告ID
            status: 新状态
            
        Returns:
            bool: 是否更新成功
        """
        try:
            metadata = self.get_report_metadata(report_id)
            if not metadata:
                return False
            
            metadata['status'] = status
            metadata['updated_at'] = datetime.now().isoformat()
            
            self._save_metadata(metadata)
            return True
        except Exception as e:
            self.logger.error(f"更新报告状态失败: {str(e)}", exc_info=True)
            return False
    
    def get_reports_count(self) -> int:
        """获取报告总数
        
        Returns:
            int: 报告总数
        """
        return len(self._load_metadata())
    
    def get_report_stats(self) -> Dict[str, Any]:
        """获取报告统计信息
        
        Returns:
            Dict[str, Any]: 统计信息
        """
        metadata_list = self._load_metadata()
        
        total_reports = len(metadata_list)
        total_size = sum(m['size'] for m in metadata_list)
        
        # 按状态统计
        status_counts = {}
        for m in metadata_list:
            status = m['status']
            status_counts[status] = status_counts.get(status, 0) + 1
        
        return {
            'total_reports': total_reports,
            'total_size': total_size,
            'status_counts': status_counts,
            'latest_report': metadata_list[0] if metadata_list else None
        }
