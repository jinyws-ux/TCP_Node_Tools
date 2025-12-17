# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[('web', 'web'), ('configs', 'configs'), ('paths.json', '.')],
    hiddenimports=['platform', 'socket', 'ssl', 'flask', 'core.analysis_service', 'core.config_manager', 'core.download_service', 'core.log_analyzer', 'core.log_downloader', 'core.log_metadata_store', 'core.log_parser', 'core.parser_config_manager', 'core.parser_config_service', 'core.report_generator', 'core.report_mapping_store', 'core.server_config_service', 'core.template_manager'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='app',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='app',
)
