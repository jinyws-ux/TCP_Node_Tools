# core/config_manager.py
import logging
import os
import time
from typing import Any, Dict, List, Optional

from .json_store import JsonStore


class ConfigManager:
    def __init__(self, config_dir: str):
        self.config_dir = config_dir
        self.server_configs_file = os.path.join(config_dir, 'server_configs.json')
        self.logger = logging.getLogger(__name__)
        os.makedirs(config_dir, exist_ok=True)
        self._store = JsonStore(self.server_configs_file, default_factory=list)
        self._init_config_file()

    def _init_config_file(self):
        """初始化配置文件"""
        if not os.path.exists(self.server_configs_file):
            default_server_configs = [
                {
                    "id": "1",
                    "factory": "大东厂区",
                    "system": "OSM 测试系统",
                    "server": {
                        "alias": "taipso71",
                        "hostname": "ltvshe0ipso13",
                        "username": "vifrk490",
                        "password": "OSM2024@linux"
                    }
                }
            ]
            if self._store.save(default_server_configs):
                self.logger.info("创建服务器配置文件")

    def _load_configs(self) -> List[Dict[str, Any]]:
        """从JSON文件加载数据"""
        return self._store.load()

    def _save_configs(self, configs: List[Dict[str, Any]]) -> bool:
        """保存数据到JSON文件"""
        if self._store.save(configs):
            self.logger.info(f"配置保存成功: {self.server_configs_file}")
            return True
        self.logger.error("保存配置文件失败")
        return False

    def _allocate_config_id(self, configs: List[Dict[str, Any]]) -> str:
        numeric_ids = [
            int(config["id"])
            for config in configs
            if str(config.get("id", "")).isdigit()
        ]
        return str(max(numeric_ids) + 1) if numeric_ids else "1"

    def _find_config_index(self, configs: List[Dict[str, Any]], config_id: str) -> int:
        for index, config in enumerate(configs):
            if config.get('id') == config_id:
                return index
        return -1

    def _ensure_unique(self, configs: List[Dict[str, Any]], factory: str, system: str, alias: str, *, exclude_id: Optional[str] = None) -> None:
        for config in configs:
            if exclude_id and config.get('id') == exclude_id:
                continue
            if (config.get('factory') == factory and
                    config.get('system') == system and
                    config.get('server', {}).get('alias') == alias):
                raise ValueError("已存在相同厂区、系统和服务器别名的配置")

    def get_server_configs(self) -> List[Dict[str, Any]]:
        """获取服务器配置列表"""
        return self._load_configs()

    def get_config_by_id(self, config_id: str) -> Optional[Dict[str, Any]]:
        """根据ID获取配置"""
        configs = self._load_configs()
        for config in configs:
            if config.get('id') == config_id:
                return config
        return None

    def add_server_config(self, factory: str, system: str, server: Dict[str, str]) -> Dict[str, Any]:
        """添加新的服务器配置 - 修复ID生成逻辑"""
        configs = self._load_configs()

        # 检查是否已存在相同配置
        self._ensure_unique(
            configs,
            factory,
            system,
            server.get('alias', ''),
        )

        config_id = self._allocate_config_id(configs)

        # 创建新配置
        new_config = {
            'id': config_id,
            'factory': factory,
            'system': system,
            'server': server,
            'created_time': time.time()
        }

        # 添加到配置列表并保存
        configs.append(new_config)

        if self._save_configs(configs):
            self.logger.info(f"成功添加服务器配置: {factory}/{system}/{server.get('alias')}")
            return new_config
        raise RuntimeError("保存配置失败")

    def update_server_config(self, config_id: str, factory: str, system: str, server: Dict[str, str]) -> bool:
        """更新服务器配置 - 修复更新逻辑"""
        try:
            configs = self._load_configs()

            # 查找要更新的配置
            config_index = self._find_config_index(configs, config_id)

            if config_index == -1:
                self.logger.error(f"未找到要更新的配置: {config_id}")
                return False

            # 检查是否与其他配置冲突（排除自身）
            self._ensure_unique(
                configs,
                factory,
                system,
                server.get('alias', ''),
                exclude_id=config_id,
            )

            # 更新配置
            configs[config_index] = {
                'id': config_id,
                'factory': factory,
                'system': system,
                'server': server,
                'updated_time': time.time()  # 添加更新时间
            }

            # 保存配置
            if self._save_configs(configs):
                self.logger.info(f"成功更新服务器配置: {factory}/{system}/{server.get('alias')} (ID: {config_id})")
                return True
            else:
                self.logger.error(f"保存更新后的配置失败")
                return False

        except ValueError as e:
            self.logger.error(f"更新配置验证失败: {str(e)}")
            raise e
        except Exception as e:
            self.logger.error(f"更新服务器配置失败: {str(e)}")
            return False

    def delete_server_config(self, config_id: str) -> bool:
        """删除服务器配置"""
        configs = self._load_configs()
        new_configs = [config for config in configs if config.get('id') != config_id]

        if len(new_configs) == len(configs):
            return False

        return self._save_configs(new_configs)

    def get_factories(self) -> List[Dict[str, str]]:
        """获取所有厂区"""
        configs = self._load_configs()
        factories = []
        seen_factories = set()

        for config in configs:
            factory_name = config.get('factory')
            if factory_name and factory_name not in seen_factories:
                factories.append({
                    'id': factory_name,
                    'name': factory_name
                })
                seen_factories.add(factory_name)

        return factories

    def get_systems(self, factory: str) -> List[Dict[str, str]]:
        """获取指定厂区的系统"""
        configs = self._load_configs()
        systems = []
        seen_systems = set()

        for config in configs:
            if config.get('factory') == factory:
                system_name = config.get('system')
                if system_name and system_name not in seen_systems:
                    systems.append({
                        'id': system_name,
                        'name': system_name
                    })
                    seen_systems.add(system_name)

        return systems

