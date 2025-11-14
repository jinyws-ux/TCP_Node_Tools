# core/parser_config_manager.py
import json
import logging
import os
import shutil
import time
from typing import Dict, Any, Optional


class ParserConfigManager:
    def __init__(self, config_dir: str):
        self.config_dir = config_dir
        self.logger = logging.getLogger(__name__)
        os.makedirs(config_dir, exist_ok=True)

    def get_config_path(self, factory: str, system: str) -> str:
        """获取配置文件路径"""
        filename = f"{factory}_{system}.json"
        return os.path.join(self.config_dir, filename)

    def load_config(self, factory: str, system: str) -> Optional[Dict[str, Any]]:
        try:
            config_path = self.get_config_path(factory, system)

            if not os.path.exists(config_path):
                return None

            with open(config_path, 'r', encoding='utf-8') as f:
                content = f.read().strip()
                if not content:
                    self.logger.warning(f"配置文件为空: {config_path}")
                    return None

                try:
                    return json.loads(content)
                except json.JSONDecodeError as e:
                    self.logger.error(f"配置文件格式错误: {config_path}, 错误: {e}")
                    # 创建备份
                    backup_path = f"{config_path}.backup.{int(time.time())}"
                    import shutil
                    shutil.copy2(config_path, backup_path)
                    self.logger.info(f"已备份损坏的配置文件到: {backup_path}")
                    return None

        except Exception as e:
            self.logger.error(f"加载解析配置失败: {str(e)}")
            return None

    def save_config(self, factory: str, system: str, config: Dict[str, Any]) -> bool:
        """保存解析配置"""
        try:
            config_path = self.get_config_path(factory, system)

            with open(config_path, 'w', encoding='utf-8') as f:
                json.dump(config, f, indent=2, ensure_ascii=False)

            self.logger.info(f"成功保存解析配置: {config_path}")
            return True
        except Exception as e:
            self.logger.error(f"保存解析配置失败: {config_path}, 错误: {str(e)}")
            return False

    def rename_namespace(
        self,
        old_factory: str,
        old_system: str,
        new_factory: str,
        new_system: str,
    ) -> bool:
        """将解析配置从旧厂区/系统移动到新名称下。"""
        try:
            src = self.get_config_path(old_factory, old_system)
            if not os.path.exists(src):
                return False

            dst = self.get_config_path(new_factory, new_system)
            os.makedirs(self.config_dir, exist_ok=True)

            if os.path.exists(dst):
                backup = f"{dst}.backup.{int(time.time())}"
                shutil.copy2(dst, backup)
                self.logger.warning(
                    "解析配置重命名时检测到目标已存在，已备份到: %s", backup
                )

            shutil.move(src, dst)
            self.logger.info(
                "解析配置已从 %s/%s 重命名为 %s/%s",
                old_factory,
                old_system,
                new_factory,
                new_system,
            )
            return True
        except Exception as e:
            self.logger.error(
                "重命名解析配置失败: %s/%s -> %s/%s, 错误: %s",
                old_factory,
                old_system,
                new_factory,
                new_system,
                str(e),
            )
            return False

    def add_message_type(self, factory: str, system: str, msg_type: str, description: str) -> bool:
        """添加报文类型"""
        try:
            config = self.load_config(factory, system) or {}

            if msg_type not in config:
                config[msg_type] = {
                    "Description": description,
                    "Versions": {}
                }
            else:
                config[msg_type]["Description"] = description

            return self.save_config(factory, system, config)
        except Exception as e:
            self.logger.error(f"添加报文类型失败: {factory}/{system}/{msg_type}, 错误: {str(e)}")
            return False

    def add_version(self, factory: str, system: str, msg_type: str, version: str) -> bool:
        """添加版本"""
        try:
            config = self.load_config(factory, system) or {}

            if msg_type not in config:
                config[msg_type] = {
                    "Description": "",
                    "Versions": {}
                }

            if "Versions" not in config[msg_type]:
                config[msg_type]["Versions"] = {}

            if version not in config[msg_type]["Versions"]:
                config[msg_type]["Versions"][version] = {
                    "Fields": {}
                }

            return self.save_config(factory, system, config)
        except Exception as e:
            self.logger.error(f"添加版本失败: {factory}/{system}/{msg_type}/{version}, 错误: {str(e)}")
            return False

    def add_field(self, factory: str, system: str, msg_type: str, version: str,
                  field_name: str, start: int, length: int = -1) -> bool:
        """添加字段 - 修复参数数量问题"""
        try:
            config = self.load_config(factory, system) or {}

            # 确保报文类型存在
            if msg_type not in config:
                config[msg_type] = {
                    "Description": "",
                    "Versions": {}
                }

            # 确保版本存在
            if "Versions" not in config[msg_type]:
                config[msg_type]["Versions"] = {}

            if version not in config[msg_type]["Versions"]:
                config[msg_type]["Versions"][version] = {
                    "Fields": {}
                }

            # 确保字段集合存在
            if "Fields" not in config[msg_type]["Versions"][version]:
                config[msg_type]["Versions"][version]["Fields"] = {}

            # 添加字段
            config[msg_type]["Versions"][version]["Fields"][field_name] = {
                "Start": start,
                "Length": length
            }

            return self.save_config(factory, system, config)
        except Exception as e:
            self.logger.error(f"添加字段失败: {factory}/{system}/{msg_type}/{version}/{field_name}, 错误: {str(e)}")
            return False

    def add_escape(self, factory: str, system: str, msg_type: str, version: str,
                   field_name: str, key: str, value: str) -> bool:
        """添加转义值"""
        try:
            config = self.load_config(factory, system)
            if not config:
                self.logger.error(f"配置不存在: {factory}/{system}")
                return False

            # 检查字段是否存在
            if (msg_type not in config or
                    "Versions" not in config[msg_type] or
                    version not in config[msg_type]["Versions"] or
                    "Fields" not in config[msg_type]["Versions"][version] or
                    field_name not in config[msg_type]["Versions"][version]["Fields"]):
                self.logger.error(f"字段不存在: {field_name}")
                return False

            # 确保Escapes字典存在
            if "Escapes" not in config[msg_type]["Versions"][version]["Fields"][field_name]:
                config[msg_type]["Versions"][version]["Fields"][field_name]["Escapes"] = {}

            # 添加转义值
            config[msg_type]["Versions"][version]["Fields"][field_name]["Escapes"][key] = value

            return self.save_config(factory, system, config)
        except Exception as e:
            self.logger.error(f"添加转义值失败: {factory}/{system}/{msg_type}/{version}/{field_name}, 错误: {str(e)}")
            return False
