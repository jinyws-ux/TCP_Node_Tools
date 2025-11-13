"""封装服务器配置的增删改查以及与区域模板之间的联动。"""
from __future__ import annotations

from typing import Any, Dict, List

from core.config_manager import ConfigManager
from core.template_manager import TemplateManager


class ServerConfigService:
    """为 Flask 视图提供一个纯数据层，避免在路由中堆业务逻辑。"""

    def __init__(self, config_manager: ConfigManager, template_manager: TemplateManager) -> None:
        self._config_manager = config_manager
        self._template_manager = template_manager

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------
    def list_configs(self) -> List[Dict[str, Any]]:
        configs = self._config_manager.get_server_configs() or []
        return [self._format_config(cfg) for cfg in configs]

    def get_config(self, config_id: str) -> Dict[str, Any]:
        cfg = self._config_manager.get_config_by_id(config_id)
        if not cfg:
            raise ValueError("未找到服务器配置")
        return self._format_config(cfg)

    # ------------------------------------------------------------------
    # 新增 / 更新 / 删除
    # ------------------------------------------------------------------
    def create(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        factory, system, server = self._extract_payload(payload)
        created = self._config_manager.add_server_config(factory, system, server)
        return self._format_config(created)

    def update(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        config_id = (payload.get("id") or payload.get("config_id") or "").strip()
        if not config_id:
            raise ValueError("缺少配置 ID")

        factory, system, server = self._extract_payload(payload)
        updated = self._config_manager.update_server_config(config_id, factory, system, server)
        if not updated:
            raise ValueError("更新配置失败，配置可能不存在")

        # 取最新数据，用于返回
        fresh = self._config_manager.get_config_by_id(config_id)
        if not fresh:
            raise ValueError("更新后无法读取配置")

        # 联动模板
        self._template_manager.update_by_server(
            server_config_id=config_id,
            factory_name=factory,
            system_name=system,
        )

        return self._format_config(fresh)

    def delete(self, config_id: str) -> Dict[str, Any]:
        if not config_id:
            raise ValueError("缺少配置 ID")
        deleted = self._config_manager.delete_server_config(config_id)
        if not deleted:
            raise ValueError("删除配置失败")

        removed_templates = self._template_manager.delete_by_server(config_id)
        return {"deleted": True, "deleted_templates": removed_templates, "id": config_id}

    # ------------------------------------------------------------------
    # 内部工具
    # ------------------------------------------------------------------
    def _extract_payload(self, payload: Dict[str, Any]):
        factory = (payload.get("factory") or "").strip()
        system = (payload.get("system") or "").strip()
        server = payload.get("server") or {}
        alias = (server.get("alias") or "").strip()
        hostname = (server.get("hostname") or "").strip()
        username = (server.get("username") or "").strip()
        password = (server.get("password") or "").strip()

        if not all([factory, system, alias, hostname, username, password]):
            raise ValueError("请完整填写厂区/系统以及服务器信息")

        return (
            factory,
            system,
            {
                "alias": alias,
                "hostname": hostname,
                "username": username,
                "password": password,
            },
        )

    def _format_config(self, config: Dict[str, Any]) -> Dict[str, Any]:
        server = config.get("server") or {}
        return {
            "id": config.get("id"),
            "factory": config.get("factory"),
            "system": config.get("system"),
            "server": {
                "alias": server.get("alias"),
                "hostname": server.get("hostname"),
                "username": server.get("username"),
                "password": server.get("password"),
            },
            "created_time": config.get("created_time"),
            "updated_time": config.get("updated_time"),
        }
