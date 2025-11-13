# core/template_manager.py
import os
import json
import uuid
from datetime import datetime
from typing import List, Dict, Any, Optional

ISO = "%Y-%m-%dT%H:%M:%S"


class TemplateManager:
    """
    区域模板：文件型存储
    - 根目录：base_dir
    - 每个模板一个 JSON：{id}.json

    字段（向后兼容）：
    - id, name
    - nodes: [str]
    - factory/system（旧版仅存“名字”）
    - factory_name/system_name（等价于 factory/system，用于兼容）
    - factory_id/system_id（新版用于下拉回填）
    - server_config_id（与服务器配置绑定；用于联动更新/删除）
    - created_at/updated_at
    """

    def __init__(self, base_dir: str):
        self.base_dir = base_dir
        os.makedirs(self.base_dir, exist_ok=True)

    def _path(self, tid: str) -> str:
        return os.path.join(self.base_dir, f"{tid}.json")

    def _now(self) -> str:
        return datetime.now().strftime(ISO)

    # ---------- 公共：列表/读取 ----------
    def list(
        self,
        factory: str = "",
        system: str = "",
        q: str = "",
        page: int = 1,
        page_size: int = 20,
    ) -> Dict[str, Any]:
        """
        过滤规则（向后兼容）：
        - 若传入 factory：同时尝试匹配 factory_id / factory_name / factory
        - 若传入 system：同时尝试匹配 system_id / system_name / system
        - q：命中 name 或 nodes 中的任意一个
        """
        items: List[Dict[str, Any]] = []
        for fn in os.listdir(self.base_dir):
            if not fn.endswith(".json"):
                continue
            p = os.path.join(self.base_dir, fn)
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)

                # 兼容字段归一：确保 name 别名存在
                self._ensure_alias_fields(data)

                # 工厂过滤
                if factory and not self._match_any(
                    factory,
                    data.get("factory_id"),
                    data.get("factory_name"),
                    data.get("factory"),
                ):
                    continue

                # 系统过滤
                if system and not self._match_any(
                    system,
                    data.get("system_id"),
                    data.get("system_name"),
                    data.get("system"),
                ):
                    continue

                # 关键词过滤
                if q:
                    ql = q.lower()
                    name_hit = ql in (data.get("name", "").lower())
                    nodes_hit = any(ql in str(n).lower() for n in data.get("nodes", []))
                    if not (name_hit or nodes_hit):
                        continue

                items.append(data)
            except Exception:
                # 单个文件异常不影响整体
                continue

        # 最新更新在前（若缺失 updated_at，则回退 created_at）
        items.sort(
            key=lambda x: (x.get("updated_at") or x.get("created_at") or ""),
            reverse=True,
        )
        total = len(items)
        start = max(page - 1, 0) * page_size
        end = start + page_size
        return {"items": items[start:end], "total": total}

    def get(self, tid: str) -> Optional[Dict[str, Any]]:
        p = self._path(tid)
        if not os.path.exists(p):
            return None
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        # 兼容：保证别名字段齐全
        self._ensure_alias_fields(data)
        return data

    # ---------- 创建/更新/删除 ----------
    def create(
        self,
        name: str,
        factory: str,
        system: str,
        nodes: List[str],
        server_config_id: Optional[str] = None,
        factory_id: Optional[str] = None,
        system_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        兼容旧调用：仅 name/factory/system/nodes 也可。
        新增参数：
        - server_config_id：绑定的服务器配置ID
        - factory_id/system_id：下拉的真实值（用于回填）
        """
        tid = uuid.uuid4().hex
        now = self._now()
        doc = {
            "id": tid,
            "name": str(name).strip(),
            # 名称与别名并存（向后兼容）
            "factory": factory,
            "factory_name": factory,
            "system": system,
            "system_name": system,
            "factory_id": (str(factory_id).strip() if factory_id else None),
            "system_id": (str(system_id).strip() if system_id else None),
            "server_config_id": (str(server_config_id).strip() if server_config_id else None),
            "nodes": self._sanitize_nodes(nodes),
            "created_at": now,
            "updated_at": now,
        }
        self._atomic_write(tid, doc)
        return doc

    def update(self, tid: str, patch: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        cur = self.get(tid)
        if not cur:
            return None

        # name
        if "name" in patch and patch["name"] is not None:
            cur["name"] = str(patch["name"]).strip()

        # factory / factory_name / factory_id（全都兼容，任意一个变更就同步）
        if "factory" in patch and patch["factory"]:
            cur["factory"] = patch["factory"]
            cur["factory_name"] = patch["factory"]
        if "factory_name" in patch and patch["factory_name"]:
            cur["factory_name"] = patch["factory_name"]
            cur["factory"] = patch["factory_name"]
        if "factory_id" in patch:
            cur["factory_id"] = (str(patch["factory_id"]).strip() if patch["factory_id"] else None)

        # system / system_name / system_id
        if "system" in patch and patch["system"]:
            cur["system"] = patch["system"]
            cur["system_name"] = patch["system"]
        if "system_name" in patch and patch["system_name"]:
            cur["system_name"] = patch["system_name"]
            cur["system"] = patch["system_name"]
        if "system_id" in patch:
            cur["system_id"] = (str(patch["system_id"]).strip() if patch["system_id"] else None)

        # server_config 绑定
        if "server_config_id" in patch:
            cur["server_config_id"] = (
                str(patch["server_config_id"]).strip() if patch["server_config_id"] else None
            )

        # nodes
        if "nodes" in patch and patch["nodes"] is not None:
            cur["nodes"] = self._sanitize_nodes(patch["nodes"])

        cur["updated_at"] = self._now()
        self._atomic_write(tid, cur)
        return cur

    def delete(self, tid: str) -> bool:
        p = self._path(tid)
        if not os.path.exists(p):
            return False
        os.remove(p)
        return True

    # ---------- 联动：按 server_config 批量更新/删除 ----------
    def update_by_server(
        self,
        server_config_id: str,
        factory_id: Optional[str] = None,
        factory_name: Optional[str] = None,
        system_id: Optional[str] = None,
        system_name: Optional[str] = None,
    ) -> int:
        """
        将绑定到 server_config_id 的所有模板的厂区/系统信息联动更新。
        返回：更新数量
        """
        if not server_config_id:
            return 0
        count = 0
        for fn in os.listdir(self.base_dir):
            if not fn.endswith(".json"):
                continue
            p = os.path.join(self.base_dir, fn)
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if data.get("server_config_id") != str(server_config_id):
                    continue

                changed = False
                if factory_id is not None:
                    data["factory_id"] = str(factory_id).strip() or None
                    changed = True
                if factory_name:
                    data["factory_name"] = factory_name
                    data["factory"] = factory_name  # 兼容旧键
                    changed = True
                if system_id is not None:
                    data["system_id"] = str(system_id).strip() or None
                    changed = True
                if system_name:
                    data["system_name"] = system_name
                    data["system"] = system_name  # 兼容旧键
                    changed = True

                if changed:
                    data["updated_at"] = self._now()
                    # 使用文件名推导 tid
                    tid = os.path.splitext(fn)[0]
                    self._atomic_write(tid, data)
                    count += 1
            except Exception:
                continue
        return count

    def delete_by_server(self, server_config_id: str) -> int:
        """
        删除所有绑定到 server_config_id 的模板。
        返回：删除数量
        """
        if not server_config_id:
            return 0
        to_delete: List[str] = []
        for fn in os.listdir(self.base_dir):
            if not fn.endswith(".json"):
                continue
            p = os.path.join(self.base_dir, fn)
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if data.get("server_config_id") == str(server_config_id):
                    to_delete.append(os.path.splitext(fn)[0])
            except Exception:
                continue

        count = 0
        for tid in to_delete:
            try:
                if self.delete(tid):
                    count += 1
            except Exception:
                continue
        return count

    # ---------- 内部工具 ----------
    def _sanitize_nodes(self, nodes: List[str]) -> List[str]:
        out: List[str] = []
        for n in nodes or []:
            s = str(n).strip()
            if s and s.isdigit() and len(s) <= 6:
                out.append(s)
        # 去重且保序
        out = list(dict.fromkeys(out))
        return out

    def _atomic_write(self, tid: str, doc: Dict[str, Any]) -> None:
        tmp = self._path(f"{tid}.tmp")
        dst = self._path(tid)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
        os.replace(tmp, dst)

    def _match_any(self, needle: str, *candidates: Optional[str]) -> bool:
        """needle 同时尝试匹配若干候选（字符串化后比较）"""
        ns = str(needle).strip()
        for c in candidates:
            if c is None:
                continue
            if ns == str(c).strip():
                return True
        return False

    def _ensure_alias_fields(self, data: Dict[str, Any]) -> None:
        """
        老数据可能只有 factory/system；确保别名存在以便前端统一使用。
        """
        if "factory_name" not in data and "factory" in data:
            data["factory_name"] = data["factory"]
        if "system_name" not in data and "system" in data:
            data["system_name"] = data["system"]
