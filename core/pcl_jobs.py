import os
import threading
import time
import uuid
from typing import Any, Callable, Dict, Optional, Tuple

from core.pcl_service import convert_pcl_to_pdf, default_ghostpcl_exe, download_remote_file


class PclJobManager:
    def __init__(
        self,
        download_dir: str,
        project_root: str,
        ghostpcl_exe: Optional[str] = None,
        server_resolver: Optional[Callable[[str], Tuple[Optional[Dict[str, Any]], Optional[str]]]] = None,
    ) -> None:
        self._download_dir = download_dir
        self._project_root = project_root
        self._ghostpcl_exe = ghostpcl_exe or default_ghostpcl_exe(project_root)
        self._server_resolver = server_resolver
        self._lock = threading.RLock()
        self._jobs: Dict[str, Dict[str, Any]] = {}

    @property
    def ghostpcl_exe(self) -> str:
        return self._ghostpcl_exe

    def set_server_resolver(self, resolver: Callable[[str], Tuple[Optional[Dict[str, Any]], Optional[str]]]) -> None:
        self._server_resolver = resolver

    def create_convert_job(self, server_id: str, filename: str, password: str) -> Tuple[Optional[str], Optional[str]]:
        if not self._server_resolver:
            return None, "服务器解析器未配置"
        server, err = self._server_resolver(server_id)
        if err:
            return None, err
        if not server:
            return None, "服务器不存在或未配置"
        if not filename:
            return None, "缺少文件名"

        job_id = uuid.uuid4().hex
        job_dir = os.path.join(self._download_dir, "pcl_jobs", job_id)
        local_pcl = os.path.join(job_dir, filename)
        local_pdf = os.path.join(job_dir, filename + ".pdf")

        job: Dict[str, Any] = {
            "id": job_id,
            "serverId": server_id,
            "filename": filename,
            "status": "queued",
            "step": "queued",
            "progress": 0,
            "error": "",
            "createdAt": int(time.time()),
            "localPcl": local_pcl,
            "localPdf": local_pdf,
        }
        with self._lock:
            self._jobs[job_id] = job

        t = threading.Thread(target=self._run_convert_job, args=(job_id, server, filename, password), daemon=True)
        t.start()
        return job_id, None

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            return dict(job)

    def get_job_pdf_path(self, job_id: str) -> Optional[str]:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            if job.get("status") != "done":
                return None
            pdf = str(job.get("localPdf") or "")
            return pdf if pdf and os.path.exists(pdf) else None

    def _update(self, job_id: str, **patch: Any) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            job.update(patch)

    def _run_convert_job(self, job_id: str, server: Dict[str, Any], filename: str, password: str) -> None:
        self._update(job_id, status="running", step="downloading", progress=5, error="")

        try:
            job = self.get_job(job_id) or {}
            local_pcl = str(job.get("localPcl") or "")
            local_pdf = str(job.get("localPdf") or "")

            err = download_remote_file(server, password, filename, local_pcl)
            if err:
                self._update(job_id, status="error", step="downloading", progress=100, error=err)
                return

            self._update(job_id, step="converting", progress=60)
            ok, msg = convert_pcl_to_pdf(self._ghostpcl_exe, local_pcl, local_pdf)
            if not ok:
                self._update(job_id, status="error", step="converting", progress=100, error=msg or "转换失败")
                return

            self._update(job_id, status="done", step="done", progress=100, error="")
        except Exception as exc:
            self._update(job_id, status="error", step="error", progress=100, error=str(exc))
