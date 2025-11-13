# core/template_store.py
import os, json, uuid, time
from typing import List, Dict, Any, Optional, Tuple

def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())

class TemplateStore:
    """
    文件存储：config/log_templates/<id>.json
    结构：
    {
      "id": "uuid",
      "name": "东厂-系统A-早班",
      "factory": "东厂",
      "system": "系统A",
      "nodes": ["2001","2002"],
      "created_at": "...",
      "updated_at": "..."
    }
    """
    def __init__(self, base_dir: str = "config/log_templates"):
        self.base_dir = base_dir
        os.makedirs(self.base_dir, exist_ok=True)

    def _path(self, tid: str) -> str:
        return os.path.join(self.base_dir, f"{tid}.json")

    def _load(self, tid: str) -> Optional[Dict[str, Any]]:
        p = self._path(tid)
        if not os.path.exists(p): return None
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)

    def _save(self, tid: str, data: Dict[str, Any]) -> None:
        with open(self._path(tid), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def _list_all(self) -> List[Dict[str, Any]]:
        out = []
        for fn in os.listdir(self.base_dir):
            if fn.endswith(".json"):
                try:
                    with open(os.path.join(self.base_dir, fn), "r", encoding="utf-8") as f:
                        out.append(json.load(f))
                except: pass
        out.sort(key=lambda x: x.get("updated_at") or x.get("created_at") or "", reverse=True)
        return out

    @staticmethod
    def _norm_nodes(nodes) -> List[str]:
        if nodes is None: return []
        if isinstance(nodes, str):
            parts = [p.strip() for p in nodes.split(",")]
        else:
            parts = [str(p).strip() for p in list(nodes)]
        seen, out = set(), []
        for p in parts:
            if p and p not in seen:
                seen.add(p); out.append(p)
        return out

    # —— CRUD ——
    def create(self, name: str, factory: str, system: str, nodes) -> Dict[str, Any]:
        tid = uuid.uuid4().hex
        now = _now_iso()
        data = {
            "id": tid,
            "name": name.strip(),
            "factory": factory.strip(),
            "system": system.strip(),
            "nodes": self._norm_nodes(nodes),
            "created_at": now,
            "updated_at": now,
        }
        self._save(tid, data)
        return data

    def get(self, tid: str) -> Optional[Dict[str, Any]]:
        return self._load(tid)

    def update(self, tid: str, patch: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        cur = self._load(tid)
        if not cur: return None
        if "name" in patch: cur["name"] = str(patch["name"]).strip()
        if "factory" in patch: cur["factory"] = str(patch["factory"]).strip()
        if "system" in patch: cur["system"] = str(patch["system"]).strip()
        if "nodes" in patch: cur["nodes"] = self._norm_nodes(patch["nodes"])
        cur["updated_at"] = _now_iso()
        self._save(tid, cur)
        return cur

    def delete(self, tid: str) -> bool:
        p = self._path(tid)
        if os.path.exists(p):
            os.remove(p)
            return True
        return False

    def list(self, q: Optional[str]=None, factory: Optional[str]=None, system: Optional[str]=None,
             page: int=1, page_size: int=20) -> Tuple[List[Dict[str, Any]], int]:
        items = self._list_all()
        if q:
            ql = q.lower()
            items = [x for x in items if ql in (x.get("name","")+x.get("factory","")+x.get("system","")).lower()]
        if factory:
            items = [x for x in items if x.get("factory")==factory]
        if system:
            items = [x for x in items if x.get("system")==system]
        total = len(items)
        page = max(1, int(page)); page_size = max(1, int(page_size))
        s = (page-1)*page_size; e = s+page_size
        return items[s:e], total
