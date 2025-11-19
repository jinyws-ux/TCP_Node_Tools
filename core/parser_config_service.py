"""围绕解析配置构建的纯业务逻辑封装。"""
from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, List, Optional

from core.parser_config_manager import ParserConfigManager


class ParserConfigService:
    def __init__(self, manager: ParserConfigManager) -> None:
        self._manager = manager

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------
    def load_config(self, factory: str, system: str) -> Dict[str, Any]:
        return self._manager.load_config(factory, system) or {}

    def build_tree(self, factory: str, system: str) -> List[Dict[str, Any]]:
        config = self.load_config(factory, system)
        return self._build_config_tree(config, factory, system)

    def collect_stats(self, factory: str, system: str) -> Dict[str, Any]:
        config = self.load_config(factory, system)
        stats = self._calculate_config_stats(config)
        config_path = self._manager.get_config_path(factory, system)
        stats["last_modified"] = self._safe_mtime(config_path)
        stats["file_size"] = self._safe_size(config_path)
        return stats

    def search(self, factory: str, system: str, query: str, search_type: str) -> List[Dict[str, Any]]:
        config = self.load_config(factory, system)
        return self._search_in_config(config, query, search_type, factory, system)

    # ------------------------------------------------------------------
    # 保存 / 更新
    # ------------------------------------------------------------------
    def save(self, factory: str, system: str, config: Dict[str, Any]) -> Dict[str, Any]:
        self._validate_config(config)
        ok = self._manager.save_config(factory, system, config)
        if not ok:
            raise ValueError("保存配置失败")
        return config

    def update(self, factory: str, system: str, updates: Dict[str, Any]) -> Dict[str, Any]:
        existing = self._manager.load_config(factory, system)
        if not existing:
            raise ValueError("未找到现有配置")
        patched = self._apply_config_updates(existing, updates)
        self._validate_config(patched)
        ok = self._manager.save_config(factory, system, patched)
        if not ok:
            raise ValueError("保存配置失败")
        return patched

    def merge(self, factory: str, system: str, incoming: Dict[str, Any]) -> Dict[str, Any]:
        existing = self._manager.load_config(factory, system) or {}
        merged = self._merge_config(existing, incoming or {})
        self._validate_config(merged)
        ok = self._manager.save_config(factory, system, merged)
        if not ok:
            raise ValueError("保存配置失败")
        return merged

    def transfer_namespace(
        self,
        old_factory: str,
        old_system: str,
        new_factory: str,
        new_system: str,
    ) -> bool:
        """当厂区/系统改名时，联动迁移解析配置文件。"""
        if not all([old_factory, old_system, new_factory, new_system]):
            return False
        if old_factory == new_factory and old_system == new_system:
            return False
        return self._manager.rename_namespace(
            old_factory,
            old_system,
            new_factory,
            new_system,
        )

    # ------------------------------------------------------------------
    # 纯数据算法（以下方法全部是内部实现）
    # ------------------------------------------------------------------
    def _merge_config(self, existing: Dict[str, Any], incoming: Dict[str, Any]) -> Dict[str, Any]:
        result = deepcopy(existing or {})
        if not isinstance(incoming, dict):
            return result
        for msg_type, msg_cfg in (incoming or {}).items():
            if msg_type not in result:
                result[msg_type] = deepcopy(msg_cfg)
                continue
            tgt_msg = result[msg_type]
            if msg_cfg.get("Description") and not tgt_msg.get("Description"):
                tgt_msg["Description"] = msg_cfg.get("Description", "")
            tgt_versions = tgt_msg.setdefault("Versions", {})
            src_versions = (msg_cfg.get("Versions") or {})
            for ver, ver_cfg in src_versions.items():
                if ver not in tgt_versions:
                    tgt_versions[ver] = {"Fields": deepcopy((ver_cfg.get("Fields") or {}))}
                    continue
                tgt_fields = tgt_versions[ver].setdefault("Fields", {})
                src_fields = (ver_cfg.get("Fields") or {})
                for field, f_cfg in src_fields.items():
                    if field not in tgt_fields:
                        new_field = {
                            "Start": f_cfg.get("Start", 0),
                            "Length": f_cfg.get("Length", -1),
                        }
                        esc = f_cfg.get("Escapes")
                        if isinstance(esc, dict):
                            new_field["Escapes"] = deepcopy(esc)
                        tgt_fields[field] = new_field
                        continue
                    tgt_field = tgt_fields[field]
                    src_esc = (f_cfg.get("Escapes") or {})
                    if isinstance(src_esc, dict) and src_esc:
                        tgt_esc = tgt_field.setdefault("Escapes", {})
                        for k, v in src_esc.items():
                            if k not in tgt_esc:
                                tgt_esc[k] = v
        return result

    def _build_config_tree(self, config: Dict[str, Any], factory: str, system: str) -> List[Dict[str, Any]]:
        tree_data: List[Dict[str, Any]] = []
        for message_type, message_config in (config or {}).items():
            message_node = {
                "type": "message_type",
                "name": message_type,
                "description": message_config.get("Description", ""),
                "path": f"{factory}/{system}/{message_type}",
                "children": [],
            }

            versions = message_config.get("Versions", {})
            for version, version_config in versions.items():
                version_node = {
                    "type": "version",
                    "name": version,
                    "path": f"{factory}/{system}/{message_type}/{version}",
                    "parent": message_type,
                    "children": [],
                }

                fields = version_config.get("Fields", {})
                for field, field_config in fields.items():
                    field_node = {
                        "type": "field",
                        "name": field,
                        "path": f"{factory}/{system}/{message_type}/{version}/{field}",
                        "parent": message_type,
                        "version": version,
                        "start": field_config.get("Start", 0),
                        "length": field_config.get("Length", -1),
                        "has_escapes": bool(field_config.get("Escapes")),
                        "children": [],
                    }

                    escapes = field_config.get("Escapes", {})
                    for escape_key, escape_value in escapes.items():
                        escape_node = {
                            "type": "escape",
                            "name": escape_key,
                            "value": escape_value,
                            "path": f"{factory}/{system}/{message_type}/{version}/{field}/{escape_key}",
                            "parent": message_type,
                            "version": version,
                            "field": field,
                        }
                        field_node["children"].append(escape_node)

                    version_node["children"].append(field_node)

                message_node["children"].append(version_node)

            tree_data.append(message_node)
        return tree_data

    def _calculate_config_stats(self, config: Dict[str, Any]) -> Dict[str, int]:
        stats = {
            "message_types": 0,
            "versions": 0,
            "fields": 0,
            "escapes": 0,
        }
        if not config:
            return stats

        stats["message_types"] = len(config)
        for message_config in config.values():
            versions = message_config.get("Versions", {})
            stats["versions"] += len(versions)
            for version_config in versions.values():
                fields = version_config.get("Fields", {})
                stats["fields"] += len(fields)
                for field_config in fields.values():
                    escapes = field_config.get("Escapes", {})
                    stats["escapes"] += len(escapes)
        return stats

    def _search_in_config(
        self,
        config: Dict[str, Any],
        query: str,
        search_type: str,
        factory: str,
        system: str,
    ) -> List[Dict[str, Any]]:
        results: List[Dict[str, Any]] = []
        if not query:
            return results
        query_lower = query.lower()

        for message_type, message_config in config.items():
            if search_type in ("all", "message_type"):
                description = message_config.get("Description", "")
                if (
                    query_lower in message_type.lower()
                    or (description and query_lower in description.lower())
                ):
                    results.append(
                        {
                            "type": "message_type",
                            "name": message_type,
                            "description": description,
                            "path": f"{factory}/{system}/{message_type}",
                            "match_type": "name"
                            if query_lower in message_type.lower()
                            else "description",
                        }
                    )

            versions = message_config.get("Versions", {})
            for version, version_config in versions.items():
                if search_type in ("all", "version") and query_lower in version.lower():
                    results.append(
                        {
                            "type": "version",
                            "name": version,
                            "path": f"{factory}/{system}/{message_type}/{version}",
                            "parent": message_type,
                            "match_type": "name",
                        }
                    )

                fields = version_config.get("Fields", {})
                for field, field_config in fields.items():
                    if search_type in ("all", "field") and query_lower in field.lower():
                        results.append(
                            {
                                "type": "field",
                                "name": field,
                                "path": f"{factory}/{system}/{message_type}/{version}/{field}",
                                "parent": message_type,
                                "version": version,
                                "start": field_config.get("Start", 0),
                                "length": field_config.get("Length", -1),
                                "match_type": "name",
                            }
                        )

                    escapes = field_config.get("Escapes", {})
                    for escape_key, escape_value in escapes.items():
                        if search_type in ("all", "escape") and (
                            query_lower in escape_key.lower()
                            or query_lower in str(escape_value).lower()
                        ):
                            results.append(
                                {
                                    "type": "escape",
                                    "name": escape_key,
                                    "value": escape_value,
                                    "path": f"{factory}/{system}/{message_type}/{version}/{field}/{escape_key}",
                                    "parent": message_type,
                                    "version": version,
                                    "field": field,
                                    "match_type": "escape",
                                }
                            )
        return results

    def _validate_config(self, config: Dict[str, Any]) -> None:
        if not isinstance(config, dict):
            raise ValueError("配置必须是字典类型")

        for message_type, message_config in config.items():
            if not isinstance(message_config, dict):
                raise ValueError(f"报文类型 {message_type} 的配置必须是字典类型")

            versions = message_config.get("Versions", {})
            if not isinstance(versions, dict):
                raise ValueError(f"报文类型 {message_type} 的版本配置必须是字典类型")

            for version, version_config in versions.items():
                if not isinstance(version_config, dict):
                    raise ValueError(f"版本 {version} 的配置必须是字典类型")

                fields = version_config.get("Fields", {})
                if not isinstance(fields, dict):
                    raise ValueError(f"版本 {version} 的字段配置必须是字典类型")

                for field, field_config in fields.items():
                    if not isinstance(field_config, dict):
                        raise ValueError(f"字段 {field} 的配置必须是字典类型")

                    if "Start" not in field_config:
                        raise ValueError(f"字段 {field} 缺少 Start 属性")
                    if not isinstance(field_config.get("Start"), int) or field_config["Start"] < 0:
                        raise ValueError(f"字段 {field} 的 Start 必须是大于等于0的整数")

                    if "Length" in field_config and field_config["Length"] is not None:
                        if (
                            not isinstance(field_config["Length"], int)
                            or field_config["Length"] < -1
                        ):
                            raise ValueError(f"字段 {field} 的 Length 必须是大于等于-1的整数")

    def _apply_config_updates(self, existing_config: Dict[str, Any], updates: Dict[str, Any]) -> Dict[str, Any]:
        updated_config = deepcopy(existing_config)
        for key, value in updates.items():
            keys = key.split(".")
            current: Dict[str, Any] = updated_config
            for part in keys[:-1]:
                current = current.setdefault(part, {})
            current[keys[-1]] = value
        return updated_config

    def _safe_mtime(self, path: str) -> Optional[float]:
        try:
            import os

            if os.path.exists(path):
                return os.path.getmtime(path)
            return None
        except OSError:
            return None

    def _safe_size(self, path: str) -> Optional[int]:
        try:
            import os

            if os.path.exists(path):
                return os.path.getsize(path)
            return None
        except OSError:
            return None
