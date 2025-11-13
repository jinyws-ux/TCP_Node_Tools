# core/config_manager.py
import json
import logging
import os
import time
from typing import List, Dict, Any, Optional


class ConfigManager:
    def __init__(self, config_dir: str):
        self.config_dir = config_dir
        self.server_configs_file = os.path.join(config_dir, 'server_configs.json')
        self.logger = logging.getLogger(__name__)
        os.makedirs(config_dir, exist_ok=True)
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
            with open(self.server_configs_file, 'w', encoding='utf-8') as f:
                json.dump(default_server_configs, f, indent=2, ensure_ascii=False)
            self.logger.info("创建服务器配置文件")

    def _load_configs(self) -> List[Dict[str, Any]]:
        """从JSON文件加载数据"""
        try:
            if os.path.exists(self.server_configs_file):
                with open(self.server_configs_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            return []
        except Exception as e:
            self.logger.error(f"加载配置文件失败: {str(e)}")
            return []

    def _save_configs(self, configs: List[Dict[str, Any]]) -> bool:
        """保存数据到JSON文件 - 使用原子操作"""
        import tempfile

        try:
            # 创建临时文件
            with tempfile.NamedTemporaryFile(
                    mode='w',
                    encoding='utf-8',
                    delete=False,
                    dir=os.path.dirname(self.server_configs_file)
            ) as f:
                json.dump(configs, f, indent=2, ensure_ascii=False)
                temp_file = f.name

            # 原子替换：重命名是原子操作
            if os.path.exists(self.server_configs_file):
                os.replace(temp_file, self.server_configs_file)
            else:
                os.rename(temp_file, self.server_configs_file)

            self.logger.info(f"配置保存成功: {self.server_configs_file}")
            return True

        except Exception as e:
            self.logger.error(f"保存配置文件失败: {str(e)}")
            # 清理临时文件
            if 'temp_file' in locals() and os.path.exists(temp_file):
                try:
                    os.remove(temp_file)
                except:
                    pass
            return False

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
        for config in configs:
            if (config.get('factory') == factory and
                    config.get('system') == system and
                    config.get('server', {}).get('alias') == server.get('alias')):
                raise ValueError("该配置已存在")

        # 生成唯一ID - 使用时间戳+随机数避免冲突
        import time
        import random
        config_id = f"{int(time.time())}_{random.randint(1000, 9999)}"

        # 或者使用最大ID+1
        if configs:
            existing_ids = [int(c['id']) for c in configs if c['id'].isdigit()]
            config_id = str(max(existing_ids) + 1) if existing_ids else "1"
        else:
            config_id = "1"

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
            config_index = -1
            for i, config in enumerate(configs):
                if config.get('id') == config_id:
                    config_index = i
                    break

            if config_index == -1:
                self.logger.error(f"未找到要更新的配置: {config_id}")
                return False

            # 检查是否与其他配置冲突（排除自身）
            for config in configs:
                if (config.get('id') != config_id and
                        config.get('factory') == factory and
                        config.get('system') == system and
                        config.get('server', {}).get('alias') == server.get('alias')):
                    raise ValueError("已存在相同厂区、系统和服务器别名的配置")

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

