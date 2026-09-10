"""NAS updater: no configuration writes, no network work on the Tk thread."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time


def version_tuple(value):
    match = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9.-]+)?', str(value))
    if not match:
        raise ValueError('版本号必须为 x.y.z')
    return tuple(map(int, match.groups()))


def read_manifest(path):
    path = Path(os.path.expandvars(str(path))).expanduser().absolute()
    with path.open('r', encoding='utf-8-sig') as stream:
        data = json.load(stream)
    version_tuple(data['version'])
    name = data['file']
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*\.exe', name, re.I):
        raise ValueError('更新文件必须是当前目录中的 EXE 文件名')
    if not re.fullmatch(r'[a-fA-F0-9]{64}', str(data.get('sha256', ''))):
        raise ValueError('版本文件缺少有效 SHA-256')
    if data.get('packageType') != 'onefile':
        raise ValueError('仅支持 onefile 更新包')
    return dict(data, source=str(path.parent / name))


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def stage_update(manifest):
    directory = Path(tempfile.mkdtemp(prefix='TicketMonitor-update-'))
    try:
        target = directory / 'new.exe'
        shutil.copyfile(manifest['source'], target)
        if sha256(target).lower() != manifest['sha256'].lower():
            raise ValueError('更新文件校验失败，请联系发布者重新发布')
        with target.open('rb') as stream:
            if stream.read(2) != b'MZ':
                raise ValueError('更新文件不是 Windows EXE')
        return target
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise


# Parameters are carried in JSON, never interpolated into PowerShell code.
SCRIPT = r'''
param([string]$JobFile)
$ErrorActionPreference = 'Stop'
$j = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
$backup = $j.target + '.update-backup'
$incoming = $j.target + '.update-incoming'
$log = Join-Path (Split-Path $JobFile) 'update.log'
$oldMoved = $false
$newInstalled = $false
function Start-Client {
    $env:PYINSTALLER_RESET_ENVIRONMENT = '1'
    Start-Process -FilePath $j.target -WorkingDirectory (Split-Path $j.target) -ErrorAction Stop | Out-Null
}
try {
    # Acquire a process object before signalling ready; avoids PID reuse races.
    $oldProcess = Get-Process -Id $j.processId -ErrorAction Stop
    Set-Content -LiteralPath $j.ready -Value 'ready'
    if (-not $oldProcess.WaitForExit(60000)) { throw 'Old client did not exit in 60 seconds.' }
    if ((Get-FileHash -LiteralPath $j.staged -Algorithm SHA256).Hash -ne $j.sha256) { throw 'SHA256 mismatch.' }
    Copy-Item -LiteralPath $j.staged -Destination $incoming -Force
    $moved = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            Move-Item -LiteralPath $j.target -Destination $backup -Force
            $oldMoved = $true
            $moved = $true
            break
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $moved) { throw 'Cannot replace EXE. Check permissions or other running instances.' }
    Move-Item -LiteralPath $incoming -Destination $j.target -Force
    $newInstalled = $true
    Start-Client
    'Updated and launched successfully.' | Out-File -LiteralPath $log -Encoding UTF8
} catch {
    $reason = $_.Exception.Message
    try {
        if ($oldMoved) {
            if ($newInstalled) { Remove-Item -LiteralPath $j.target -Force }
            Move-Item -LiteralPath $backup -Destination $j.target -Force
        }
        if (-not (Get-Process -Id $j.processId -ErrorAction SilentlyContinue)) { Start-Client }
    } catch { $reason += " Rollback/restart failed: " + $_.Exception.Message }
    $reason | Out-File -LiteralPath $log -Encoding UTF8
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show("Update failed: $reason`nLog: $log", 'TicketMonitor update') | Out-Null
} finally {
    Remove-Item -LiteralPath $incoming -Force -ErrorAction SilentlyContinue
}
'''


def launch_updater(staged, target, digest):
    if os.name != 'nt':
        raise RuntimeError('自动替换只支持 Windows EXE')
    staged, target = Path(staged), Path(target).resolve()
    # Verify destination is writable before asking the client to exit.
    with tempfile.TemporaryFile(dir=target.parent):
        pass
    directory = staged.parent
    script = directory / 'update.ps1'
    job = directory / 'job.json'
    ready = directory / 'ready'
    script.write_text(SCRIPT, encoding='utf-8-sig')
    job.write_text(json.dumps(dict(staged=str(staged), target=str(target),
                                  processId=os.getpid(), sha256=digest, ready=str(ready))), encoding='utf-8')
    powershell = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    process = subprocess.Popen([str(powershell), '-NoProfile', '-NonInteractive', '-File',
                                str(script), '-JobFile', str(job)],
                               creationflags=subprocess.CREATE_NO_WINDOW)
    for _ in range(100):
        if ready.exists():
            return
        if process.poll() is not None:
            raise RuntimeError('更新脚本未能启动，请检查 PowerShell 脚本执行策略。当前程序不会退出。')
        time.sleep(0.1)
    process.terminate()
    raise RuntimeError('更新脚本启动超时，当前程序不会退出。')
