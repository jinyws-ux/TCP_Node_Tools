# web/server.py
import ast
import json
import logging
import os
from typing import Any, Dict, List
from datetime import datetime
import webbrowser
import subprocess
import platform
import paramiko

from flask import Blueprint, Flask, render_template, request, jsonify, send_from_directory, Response

from core.analysis_service import AnalysisService
from core.cleanup_manager import CleanupManager
from core.config_manager import ConfigManager
from core.download_service import DownloadService
from core.log_analyzer import LogAnalyzer
from core.log_downloader import LogDownloader
from core.log_metadata_store import LogMetadataStore
from core.parser_config_manager import ParserConfigManager
from core.parser_config_service import ParserConfigService
from core.report_mapping_store import ReportMappingStore
from core.server_config_service import ServerConfigService
from core.template_manager import TemplateManager

app = Flask(__name__)

# 获取当前文件所在目录的绝对路径
base_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(base_dir)

def _resolve_dir(path_value: str, base: str) -> str:
    p = (path_value or '').strip()
    if not p:
        return base
    return p if os.path.isabs(p) else os.path.join(base, p)

def _load_paths_config(root: str) -> Dict[str, str]:
    cfg_file = os.environ.get('LOGTOOL_PATHS_FILE') or os.path.join(root, 'paths.json')
    data: Dict[str, Any] = {}
    if os.path.exists(cfg_file):
        try:
            with open(cfg_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except Exception:
            data = {}
    return {
        'CONFIG_DIR': _resolve_dir(data.get('CONFIG_DIR', 'configs'), root),
        'PARSER_CONFIGS_DIR': _resolve_dir(data.get('PARSER_CONFIGS_DIR', 'configs/parser_configs'), root),
        'REGION_TEMPLATES_DIR': _resolve_dir(data.get('REGION_TEMPLATES_DIR', 'configs/region_templates'), root),
        'MAPPING_CONFIG_DIR': _resolve_dir(data.get('MAPPING_CONFIG_DIR', 'configs/mappingconfig'), root),
        'DOWNLOAD_DIR': _resolve_dir(data.get('DOWNLOAD_DIR', 'downloads'), root),
        'HTML_LOGS_DIR': _resolve_dir(data.get('HTML_LOGS_DIR', 'html_logs'), root),
        'REPORT_MAPPING_FILE': _resolve_dir(data.get('REPORT_MAPPING_FILE', ''), root) if data.get('REPORT_MAPPING_FILE') else ''
    }

paths_cfg = _load_paths_config(project_root)
CONFIG_DIR = paths_cfg['CONFIG_DIR']
SERVER_CONFIGS_FILE = os.path.join(CONFIG_DIR, 'server_configs.json')
PARSER_CONFIGS_DIR = paths_cfg['PARSER_CONFIGS_DIR']
REGION_TEMPLATES_DIR = paths_cfg['REGION_TEMPLATES_DIR']
MAPPING_CONFIG_DIR = paths_cfg['MAPPING_CONFIG_DIR']

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 初始化配置管理器
config_manager = ConfigManager(CONFIG_DIR)
parser_config_manager = ParserConfigManager(PARSER_CONFIGS_DIR)

DOWNLOAD_DIR = paths_cfg['DOWNLOAD_DIR']
metadata_store = LogMetadataStore(DOWNLOAD_DIR, MAPPING_CONFIG_DIR)
log_downloader = LogDownloader(
    DOWNLOAD_DIR,
    config_manager,
    metadata_store=metadata_store,
)

HTML_LOGS_DIR = paths_cfg['HTML_LOGS_DIR']
log_analyzer = LogAnalyzer(
    HTML_LOGS_DIR,
    config_manager,
    parser_config_manager,
    metadata_store=metadata_store,
)

# 确保配置目录存在
os.makedirs(CONFIG_DIR, exist_ok=True)
os.makedirs(DOWNLOAD_DIR, exist_ok=True)
os.makedirs(HTML_LOGS_DIR, exist_ok=True)
os.makedirs(PARSER_CONFIGS_DIR, exist_ok=True)
os.makedirs(REGION_TEMPLATES_DIR, exist_ok=True)
os.makedirs(MAPPING_CONFIG_DIR, exist_ok=True)

REPORT_MAPPING_FILE = paths_cfg['REPORT_MAPPING_FILE'] or os.path.join(HTML_LOGS_DIR, 'report_mappings.json')

# 服务对象
region_template_manager = TemplateManager(REGION_TEMPLATES_DIR)
download_service = DownloadService(log_downloader, region_template_manager)
report_mapping_store = ReportMappingStore(REPORT_MAPPING_FILE)
parser_config_service = ParserConfigService(parser_config_manager)
server_config_service = ServerConfigService(
    config_manager,
    region_template_manager,
    parser_config_service,
)
analysis_service = AnalysisService(
    log_downloader=log_downloader,
    log_analyzer=log_analyzer,
    report_store=report_mapping_store,
)

# 初始化清理管理器
cleanup_manager = CleanupManager(
    download_dir=DOWNLOAD_DIR,
    html_logs_dir=HTML_LOGS_DIR,
    report_mapping_store=report_mapping_store,
    metadata_store=metadata_store,
)

# 安排每日清理任务（使用默认时间）
cleanup_manager.schedule_daily_cleanup()

app.config['HTML_LOGS_DIR'] = HTML_LOGS_DIR


# 通用工具
def _get_bool(payload: Dict[str, Any], *keys, default: bool = False) -> bool:
    for key in keys:
        if key in payload:
            value = payload.get(key)
            if isinstance(value, bool):
                return value
            if isinstance(value, str):
                return value.lower() in {'1', 'true', 'yes', 'on'}
            return bool(value)
    return default


# 初始化配置文件
def init_config_files():
    """初始化配置文件"""
    # 创建默认的服务器配置
    if not os.path.exists(SERVER_CONFIGS_FILE):
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
        with open(SERVER_CONFIGS_FILE, 'w', encoding='utf-8') as f:
            json.dump(default_server_configs, f, indent=2, ensure_ascii=False)
        logger.info("创建服务器配置文件")

    # 创建解析配置文件目录
    os.makedirs(PARSER_CONFIGS_DIR, exist_ok=True)


# 路由定义
@app.route('/')
def index():
    """主页面"""
    return render_template('index.html')


@app.route('/api/factories', methods=['GET'])
def get_factories():
    """获取厂区列表"""
    try:
        factories = config_manager.get_factories()
        logger.info(f"成功获取厂区列表，共{len(factories)}个厂区")
        return jsonify(factories)
    except Exception as e:
        logger.error(f"获取厂区列表失败: {str(e)}")
        return jsonify({'error': '获取厂区列表失败'}), 500


@app.route('/api/systems', methods=['GET'])
def get_systems():
    """获取系统列表"""
    try:
        factory_id = request.args.get('factory')
        systems = config_manager.get_systems(factory_id)
        logger.info(f"成功获取系统列表，共{len(systems)}个系统")
        return jsonify(systems)
    except Exception as e:
        logger.error(f"获取系统列表失败: {str(e)}")
        return jsonify({'error': '获取系统列表失败'}), 500


@app.route('/api/server-configs', methods=['GET'])
def get_server_configs():
    """获取服务器配置列表"""
    try:
        configs = server_config_service.list_configs()
        logger.info(f"成功获取服务器配置列表，共{len(configs)}个配置")
        return jsonify({'success': True, 'configs': configs, 'total': len(configs)})
    except Exception as e:
        logger.error(f"获取服务器配置列表失败: {str(e)}")
        return jsonify({'success': False, 'error': '获取服务器配置列表失败'}), 500


@app.route('/api/save-config', methods=['POST'])
def save_server_config():
    """保存服务器配置"""
    try:
        data = request.get_json(force=True) or {}
        config = server_config_service.create(data)
        return jsonify({'success': True, 'config': config})
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f"保存服务器配置失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/update-config', methods=['POST'])
def update_server_config():
    """更新服务器配置 - 修复更新逻辑"""
    try:
        data = request.get_json(force=True) or {}
        updated = server_config_service.update(data)
        logger.info(
            "更新服务器配置成功: ID=%s, 厂区=%s, 系统=%s",
            updated.get('id'),
            updated.get('factory'),
            updated.get('system'),
        )
        return jsonify({'success': True, 'config': updated})
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f"更新服务器配置失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/delete-config', methods=['POST'])
def delete_config():
    """删除服务器配置"""
    try:
        data = request.get_json(force=True) or {}
        result = server_config_service.delete(data.get('id'))
        logger.info(
            "删除服务器配置后级联删除模板：server=%s, deleted=%s",
            result.get('id'),
            result.get('deleted_templates'),
        )
        return jsonify({'success': True, **result})
    except Exception as e:
        logger.error(f"删除配置失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/test-config', methods=['POST'])
def test_server_config():
    """测试服务器配置的连通性与日志路径可访问性。"""
    try:
        data = request.get_json(force=True) or {}
        config_id = (data.get('id') or data.get('config_id') or '').strip()
        if not config_id:
            return jsonify({'success': False, 'error': '缺少配置 ID'}), 400

        cfg = server_config_service.get_config(config_id)
        server = cfg.get('server') or {}
        hostname = server.get('hostname') or ''
        username = server.get('username') or ''
        password = server.get('password') or ''
        realtime_path = server.get('realtime_path') or ''
        archive_path = server.get('archive_path') or ''

        if not all([hostname, username, password, realtime_path, archive_path]):
            return jsonify({'success': False, 'error': '配置不完整，缺少服务器或路径信息'}), 400

        result = {
            'success': False,
            'connect_ok': False,
            'realtime_ok': False,
            'archive_ok': False,
            'errors': {}
        }

        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            ssh.connect(hostname, username=username, password=password, timeout=15)
            result['connect_ok'] = True
        except Exception as exc:
            result['errors']['connect'] = str(exc)
            logger.error(f"测试服务器连接失败: host={hostname}", exc_info=True)
            return jsonify(result), 200

        try:
            sftp = ssh.open_sftp()
        except Exception as exc:
            result['errors']['connect'] = f"SFTP 打开失败: {exc}"
            try:
                ssh.close()
            except Exception:
                pass
            return jsonify(result), 200

        try:
            sftp.stat(realtime_path)
            result['realtime_ok'] = True
        except Exception as exc:
            result['errors']['realtime'] = str(exc)

        try:
            sftp.stat(archive_path)
            result['archive_ok'] = True
        except Exception as exc:
            result['errors']['archive'] = str(exc)

        try:
            sftp.close()
        except Exception:
            pass
        try:
            ssh.close()
        except Exception:
            pass

        result['success'] = bool(result['connect_ok'] and result['realtime_ok'] and result['archive_ok'])
        return jsonify(result)

    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        logger.error(f"测试服务器配置失败: {str(e)}", exc_info=True)
        return jsonify({'success': False, 'error': '测试服务器配置失败'}), 500


@app.route('/api/parser-configs', methods=['GET'])
def get_parser_configs():
    """获取所有解析配置列表"""
    try:
        configs = []
        if os.path.exists(PARSER_CONFIGS_DIR):
            for filename in os.listdir(PARSER_CONFIGS_DIR):
                if filename.endswith('.json'):
                    configs.append({
                        'id': filename,
                        'name': filename,
                        'path': os.path.join(PARSER_CONFIGS_DIR, filename)
                    })
        return jsonify({'success': True, 'configs': configs})
    except Exception as e:
        logger.error(f"获取解析配置列表失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


# 解析配置管理API
@app.route('/api/parser-config', methods=['GET'])
def get_parser_config():
    """获取解析配置 - 增强版本，支持多种格式"""
    try:
        factory = request.args.get('factory')
        system = request.args.get('system')
        format_type = request.args.get('format', 'full')  # full, tree, stats

        if not factory or not system:
            return jsonify({'success': False, 'error': '缺少厂区或系统参数'}), 400

        logger.info(f"获取解析配置: {factory}/{system}, 格式: {format_type}")

        if format_type == 'tree':
            tree_data = parser_config_service.build_tree(factory, system)
            return jsonify({'success': True, 'tree': tree_data})
        if format_type == 'stats':
            stats = parser_config_service.collect_stats(factory, system)
            return jsonify({'success': True, 'stats': stats})

        config = parser_config_service.load_config(factory, system)
        return jsonify({'success': True, 'config': config})

    except Exception as e:
        logger.error(f"获取解析配置失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/parser-config-tree', methods=['GET'])
def get_parser_config_tree():
    """获取解析配置的树形结构 - 专门用于前端树形视图"""
    try:
        factory = request.args.get('factory')
        system = request.args.get('system')

        if not factory or not system:
            return jsonify({'success': False, 'error': '缺少厂区或系统参数'}), 400

        logger.info(f"获取解析配置树形结构: {factory}/{system}")

        tree_data = parser_config_service.build_tree(factory, system)
        return jsonify({'success': True, 'tree': tree_data})

    except Exception as e:
        logger.error(f"获取解析配置树失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


# 配置项管理API
@app.route('/api/add-message-type', methods=['POST'])
def add_message_type():
    """添加报文类型"""
    try:
        data = request.json
        factory = data.get('factory')
        system = data.get('system')
        message_type = data.get('message_type')
        description = data.get('description', '')
        response_type = data.get('response_type', '')
        trans_id_pos = data.get('trans_id_pos', '')
        timeout_ms = data.get('timeout_ms')

        if not all([factory, system, message_type]):
            return jsonify({'success': False, 'error': '缺少必要参数'}), 400

        logger.info(f"添加报文类型: {factory}/{system}/{message_type}")

        # 加载现有配置
        config = parser_config_manager.load_config(factory, system) or {}

        # 检查是否已存在
        if message_type in config:
            return jsonify({'success': False, 'error': '报文类型已存在'}), 400

        # 添加新的报文类型
        config[message_type] = {
            'Description': description,
            'ResponseType': response_type,
            'TransIdPosition': trans_id_pos,
            'Versions': {}
        }
        # 写入可选阈值
        try:
            if timeout_ms is not None and str(timeout_ms).strip() != '':
                config[message_type]['TimeoutThresholdMs'] = int(timeout_ms)
        except Exception:
            pass

        # 保存配置
        success = parser_config_manager.save_config(factory, system, config)
        if success:
            logger.info(f"成功添加报文类型: {message_type}")
            return jsonify({'success': True, 'message': '报文类型添加成功'})
        else:
            return jsonify({'success': False, 'error': '添加报文类型失败'}), 500

    except Exception as e:
        logger.error(f"添加报文类型失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/update-message-type', methods=['POST'])
def update_message_type():
    """更新报文类型"""
    try:
        data = request.json
        factory = data.get('factory')
        system = data.get('system')
        old_name = data.get('old_name')
        new_name = data.get('new_name')
        description = data.get('description')
        response_type = data.get('response_type')
        trans_id_pos = data.get('trans_id_pos')
        timeout_ms = data.get('timeout_ms')

        if not all([factory, system, old_name, new_name]):
            return jsonify({'success': False, 'error': '缺少必要参数'}), 400

        logger.info(f"更新报文类型: {factory}/{system} {old_name} -> {new_name}")

        config = parser_config_manager.load_config(factory, system)
        if not config or old_name not in config:
            return jsonify({'success': False, 'error': '报文类型不存在'}), 404

        # 如果名称改变，需要检查新名称是否已存在
        if old_name != new_name and new_name in config:
            return jsonify({'success': False, 'error': '新名称已存在'}), 400

        # 更新报文类型
        message_config = config.pop(old_name)
        if description is not None:
            message_config['Description'] = description
        if response_type is not None:
            message_config['ResponseType'] = response_type
        if trans_id_pos is not None:
            message_config['TransIdPosition'] = trans_id_pos
        # 更新可选阈值
        try:
            if timeout_ms is not None and str(timeout_ms).strip() != '':
                message_config['TimeoutThresholdMs'] = int(timeout_ms)
        except Exception:
            pass

        config[new_name] = message_config

        # 保存配置
        success = parser_config_manager.save_config(factory, system, config)
        if success:
            logger.info(f"成功更新报文类型: {old_name} -> {new_name}")
            return jsonify({'success': True, 'message': '报文类型更新成功'})
        else:
            return jsonify({'success': False, 'error': '更新报文类型失败'}), 500

    except Exception as e:
        logger.error(f"更新报文类型失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/delete-message-type', methods=['POST'])
def delete_message_type():
    """删除报文类型"""
    try:
        data = request.json
        factory = data.get('factory')
        system = data.get('system')
        message_type = data.get('message_type')

        if not all([factory, system, message_type]):
            return jsonify({'success': False, 'error': '缺少必要参数'}), 400

        logger.info(f"删除报文类型: {factory}/{system}/{message_type}")

        config = parser_config_manager.load_config(factory, system)
        if not config or message_type not in config:
            return jsonify({'success': False, 'error': '报文类型不存在'}), 404

        # 删除报文类型
        del config[message_type]

        # 保存配置
        success = parser_config_manager.save_config(factory, system, config)
        if success:
            logger.info(f"成功删除报文类型: {message_type}")
            return jsonify({'success': True, 'message': '报文类型删除成功'})
        else:
            return jsonify({'success': False, 'error': '删除报文类型失败'}), 500

    except Exception as e:
        logger.error(f"删除报文类型失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/add-version', methods=['POST'])
def add_version():
    data = request.get_json()
    required_params = ['factory', 'system', 'msg_type', 'version']
    for param in required_params:
        if param not in data:
            return jsonify({'success': False, 'error': f'缺少参数：{param}'})

    factory = data['factory']
    system = data['system']
    msg_type = data['msg_type']
    version = data['version']
    remark = data.get('remark', '')  # 新增：接收版本备注参数（可选）

    # 调用Core方法（原有逻辑不变，仅在配置中补充remark字段）
    success = parser_config_manager.add_version(factory, system, msg_type, version)

    # 补充：更新版本备注（若Core方法未处理，可手动加载配置后添加）
    if success:
        config = parser_config_manager.load_config(factory, system)
        if msg_type in config and version in config[msg_type].get('versions', {}):
            config[msg_type]['versions'][version]['remark'] = remark
            parser_config_manager.save_config(factory, system, config)

    return jsonify({'success': success})


@app.route('/api/parser-config-stats', methods=['GET'])
def get_parser_config_stats():
    """获取解析配置统计信息"""
    try:
        factory = request.args.get('factory')
        system = request.args.get('system')

        if not factory or not system:
            return jsonify({'success': False, 'error': '缺少厂区或系统参数'}), 400

        stats = parser_config_service.collect_stats(factory, system)
        return jsonify({'success': True, 'stats': stats})

    except Exception as e:
        logger.error(f"获取配置统计失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


# 配置搜索API
@app.route('/api/search-parser-config', methods=['GET'])
def search_parser_config():
    """搜索解析配置"""
    try:
        factory = request.args.get('factory')
        system = request.args.get('system')
        query = request.args.get('q', '').strip()
        search_type = request.args.get('type', 'all')  # all, message_type, version, field

        if not factory or not system:
            return jsonify({'success': False, 'error': '缺少厂区或系统参数'}), 400

        if not query:
            return jsonify({'success': False, 'error': '缺少搜索关键词'}), 400

        logger.info(f"搜索解析配置: {factory}/{system}, 关键词: {query}, 类型: {search_type}")

        results = parser_config_service.search(factory, system, query, search_type)
        return jsonify({'success': True, 'results': results, 'query': query})

    except Exception as e:
        logger.error(f"搜索解析配置失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


# 配置操作API
@app.route('/api/save-parser-config', methods=['POST'])
def save_parser_config():
    """保存解析配置 - 增强版本"""
    try:
        data = request.json
        factory = data.get('factory')
        system = data.get('system')
        config = data.get('config')

        if not factory or not system:
            return jsonify({'success': False, 'error': '缺少厂区或系统参数'}), 400

        if not config:
            return jsonify({'success': False, 'error': '缺少配置数据'}), 400

        logger.info(f"保存解析配置: {factory}/{system}")

        parser_config_service.save(factory, system, config)
        stats = parser_config_service.collect_stats(factory, system)
        logger.info(f"成功保存解析配置: {factory}/{system}")
        return jsonify({
            'success': True,
            'message': '配置保存成功',
            'stats': stats
        })

    except Exception as e:
        logger.error(f"保存解析配置失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/update-parser-config', methods=['POST'])
def update_parser_config():
    """更新解析配置（部分更新）"""
    try:
        data = request.json
        factory = data.get('factory')
        system = data.get('system')
        updates = data.get('updates', {})  # 增量更新数据

        if not factory or not system:
            return jsonify({'success': False, 'error': '缺少厂区或系统参数'}), 400

        logger.info(f"更新解析配置: {factory}/{system}")

        parser_config_service.update(factory, system, updates)
        logger.info(f"成功更新解析配置: {factory}/{system}")
        return jsonify({'success': True, 'message': '配置更新成功'})

    except Exception as e:
        logger.error(f"更新解析配置失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/add-field', methods=['POST'])
def add_field():
    """添加字段"""
    try:
        data = request.json
        factory = data.get('factory')
        system = data.get('system')
        message_type = data.get('message_type')
        version = data.get('version')
        field = data.get('field')
        start = data.get('start', 0)
        length = data.get('length', -1)

        if not all([factory, system, message_type, version, field]):
            return jsonify({'success': False, 'error': '缺少必要参数'}), 400

        logger.info(f"添加字段: {factory}/{system}/{message_type}/{version}/{field}")

        config = parser_config_manager.load_config(factory, system) or {}

        # 检查配置路径是否存在
        if (message_type not in config or
                'Versions' not in config[message_type] or
                version not in config[message_type]['Versions']):
            return jsonify({'success': False, 'error': '配置路径不存在'}), 404

        # 初始化Fields字典
        version_config = config[message_type]['Versions'][version]
        if 'Fields' not in version_config:
            version_config['Fields'] = {}

        # 检查字段是否已存在
        if field in version_config['Fields']:
            return jsonify({'success': False, 'error': '字段已存在'}), 400

        # 添加新字段
        version_config['Fields'][field] = {
            'Start': start,
            'Length': length if length != -1 else None,
            'Escapes': {}
        }

        # 保存配置
        success = parser_config_manager.save_config(factory, system, config)
        if success:
            logger.info(f"成功添加字段: {field}")
            try:
                esc = version_config['Fields'][field].get('Escapes') or {}
                _add_field_history(factory, system, field, start, (length if length != -1 else None), esc)
            except Exception as e:
                logger.warning(f"更新字段历史失败: {e}")
            return jsonify({'success': True, 'message': '字段添加成功'})
        else:
            return jsonify({'success': False, 'error': '添加字段失败'}), 500

    except Exception as e:
        logger.error(f"添加字段失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/clear-parser-config', methods=['POST'])
def clear_parser_config():
    """清空解析配置"""
    try:
        data = request.json
        factory = data.get('factory')
        system = data.get('system')

        if not factory or not system:
            return jsonify({'success': False, 'error': '缺少厂区或系统参数'}), 400

        # 获取配置文件路径
        config_path = parser_config_manager.get_config_path(factory, system)

        # 删除配置文件
        if os.path.exists(config_path):
            os.remove(config_path)
            logger.info(f"清空解析配置: {factory}/{system}")
            return jsonify({'success': True})
        else:
            return jsonify({'success': False, 'error': '配置文件不存在'})
    except Exception as e:
        logger.error(f"清空解析配置失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/downloaded-logs', methods=['GET'])
def get_downloaded_logs():
    """获取已下载的日志列表"""
    try:
        logs = analysis_service.list_downloaded_logs()
        # 添加锁定状态
        for log in logs:
            if 'path' in log:
                metadata = metadata_store.read(log['path'])
                log['is_locked'] = metadata.get('is_locked', False)
        return jsonify({'success': True, 'logs': logs})
    except Exception as e:
        logger.error(f"获取已下载日志失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/logs/toggle-lock', methods=['POST'])
def toggle_log_lock():
    """切换日志锁定状态"""
    try:
        data = request.json
        log_path = data.get('log_path')
        if not log_path:
            return jsonify({'success': False, 'error': '缺少日志路径'}), 400
        
        # 读取当前元数据
        metadata = metadata_store.read(log_path)
        current_lock = metadata.get('is_locked', False)
        new_lock = not current_lock
        
        # 更新元数据
        metadata['is_locked'] = new_lock
        metadata_store.write(log_path, metadata)
        
        return jsonify({
            'success': True,
            'log_path': log_path,
            'is_locked': new_lock
        })
    except Exception as e:
        logger.error(f"切换日志锁定状态失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/logs/cleanup', methods=['POST'])
def manual_cleanup():
    """手动触发清理任务"""
    try:
        result = cleanup_manager.cleanup_unlocked_files()
        return jsonify(result)
    except Exception as e:
        logger.error(f"手动清理失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/logs/cleanup-single', methods=['POST'])
def cleanup_single_log():
    """清理单个日志文件及其关联文件"""
    try:
        data = request.json
        log_path = data.get('log_path')
        if not log_path:
            return jsonify({'success': False, 'error': '缺少日志路径参数'}), 400
        
        result = cleanup_manager.cleanup_log(log_path)
        return jsonify(result)
    except Exception as e:
        logger.error(f"清理单个日志失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/analyze', methods=['POST'])
def analyze_logs():
    """分析日志文件"""
    try:
        data = request.json
        log_paths = data.get('logs')
        config_id = data.get('config')
        if not config_id:
            return jsonify({'success': False, 'error': '请选择解析配置'}), 400

        try:
            result = analysis_service.analyze_logs(
                log_paths,
                config_id,
                options={
                'generate_html': _get_bool(data or {}, 'generate_html', default=True),
                'generate_original_log': _get_bool(data or {}, 'generate_original_log', default=False),
                'generate_sorted_log': _get_bool(data or {}, 'generate_sorted_log', default=False),
            }
            )
        except ValueError as exc:
            return jsonify({'success': False, 'error': str(exc)}), 400

        return jsonify(result)

    except Exception as e:
        logger.error(f"分析日志失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/delete-log', methods=['POST'])
def delete_log():
    """删除日志文件"""
    try:
        data = request.json
        log_path = data.get('path')

        if not log_path:
            return jsonify({'success': False, 'error': '缺少日志路径'}), 400

        try:
            result = analysis_service.delete_log(log_path)
        except ValueError as exc:
            return jsonify({'success': False, 'error': str(exc)}), 400
        return jsonify(result)
    except Exception as e:
        logger.error(f"删除日志失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/generated-reports/<path:filename>')
def serve_report(filename):
    """提供生成的报告文件"""
    report_dir = HTML_LOGS_DIR
    return send_from_directory(report_dir, filename)


@app.route('/static/<path:filename>')
def serve_static(filename):
    """提供静态文件"""
    return send_from_directory(os.path.join(base_dir, 'web', 'static'), filename)


@app.route('/api/add-escape', methods=['POST'])
def add_escape():
    """添加转义值"""
    try:
        data = request.json
        factory = data.get('factory')
        system = data.get('system')
        message_type = data.get('message_type')
        version = data.get('version')
        field = data.get('field')
        escape_key = data.get('escape_key')
        escape_value = data.get('escape_value')

        if not all([factory, system, message_type, version, field, escape_key]):
            return jsonify({'success': False, 'error': '缺少必要参数'}), 400

        if escape_value is None:
            escape_value = ''

        logger.info(f"添加转义值: {factory}/{system}/{message_type}/{version}/{field}/{escape_key}")

        config = parser_config_manager.load_config(factory, system) or {}

        # 检查配置路径是否存在
        if (message_type not in config or
                'Versions' not in config[message_type] or
                version not in config[message_type]['Versions'] or
                'Fields' not in config[message_type]['Versions'][version] or
                field not in config[message_type]['Versions'][version]['Fields']):
            return jsonify({'success': False, 'error': '配置路径不存在'}), 404

        # 初始化Escapes字典
        field_config = config[message_type]['Versions'][version]['Fields'][field]
        if 'Escapes' not in field_config:
            field_config['Escapes'] = {}

        # 添加转义值
        field_config['Escapes'][escape_key] = escape_value

        # 保存配置
        success = parser_config_manager.save_config(factory, system, config)
        if success:
            logger.info(f"成功添加转义值: {escape_key} -> {escape_value}")
            return jsonify({'success': True, 'message': '转义值添加成功'})
        else:
            return jsonify({'success': False, 'error': '添加转义值失败'}), 500

    except Exception as e:
        logger.error(f"添加转义值失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


# 批量操作API
@app.route('/api/batch-delete-configs', methods=['POST'])
def batch_delete_configs():
    """批量删除配置项"""
    try:
        data = request.json
        factory = data.get('factory')
        system = data.get('system')
        items_to_delete = data.get('items', [])

        if not factory or not system:
            return jsonify({'success': False, 'error': '缺少厂区或系统参数'}), 400

        if not items_to_delete:
            return jsonify({'success': False, 'error': '没有要删除的项'}), 400

        logger.info(f"批量删除配置项: {factory}/{system}, 数量: {len(items_to_delete)}")

        config = parser_config_manager.load_config(factory, system)
        if not config:
            return jsonify({'success': False, 'error': '配置不存在'}), 404

        deleted_count = 0
        errors = []

        for item in items_to_delete:
            try:
                item_type = item.get('type')
                item_name = item.get('name')
                path_parts = item.get('path', '').split('/')

                if not all([item_type, item_name]):
                    errors.append(f"无效的项: {item}")
                    continue

                # 根据类型删除
                if item_type == 'message_type' and item_name in config:
                    del config[item_name]
                    deleted_count += 1
                elif item_type == 'version' and len(path_parts) >= 2:
                    msg_type = path_parts[1]
                    if (msg_type in config and 'Versions' in config[msg_type] and
                            item_name in config[msg_type]['Versions']):
                        del config[msg_type]['Versions'][item_name]
                        deleted_count += 1
                elif item_type == 'field' and len(path_parts) >= 4:
                    msg_type = path_parts[1]
                    version = path_parts[3]
                    if (msg_type in config and 'Versions' in config[msg_type] and
                            version in config[msg_type]['Versions'] and
                            'Fields' in config[msg_type]['Versions'][version] and
                            item_name in config[msg_type]['Versions'][version]['Fields']):
                        del config[msg_type]['Versions'][version]['Fields'][item_name]
                        deleted_count += 1

            except Exception as e:
                errors.append(f"删除 {item_name} 失败: {str(e)}")
                continue

        # 保存配置
        success = parser_config_manager.save_config(factory, system, config)
        if success:
            logger.info(f"批量删除完成，成功删除 {deleted_count} 个项")
            return jsonify({
                'success': True,
                'message': f'成功删除 {deleted_count} 个项',
                'deleted_count': deleted_count,
                'errors': errors
            })
        else:
            return jsonify({'success': False, 'error': '保存配置失败'}), 500

    except Exception as e:
        logger.error(f"批量删除配置项失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/export-parser-config', methods=['GET'])
def export_parser_config():
    """导出解析配置"""
    try:
        factory = request.args.get('factory')
        system = request.args.get('system')
        format_type = request.args.get('format', 'json')  # json, yaml

        if not factory or not system:
            return jsonify({'success': False, 'error': '缺少厂区或系统参数'}), 400

        logger.info(f"导出解析配置: {factory}/{system}, 格式: {format_type}")

        config = parser_config_manager.load_config(factory, system)
        if not config:
            return jsonify({'success': False, 'error': '配置不存在'}), 404

        if format_type == 'yaml':
            try:
                import yaml
                yaml_str = yaml.dump(config, allow_unicode=True, indent=2)
                return Response(
                    yaml_str,
                    mimetype='text/yaml',
                    headers={'Content-Disposition': f'attachment; filename=config_{factory}_{system}.yaml'}
                )
            except ImportError:
                return jsonify({'success': False, 'error': 'YAML导出需要安装PyYAML库'}), 500
        else:
            # 默认JSON格式
            return Response(
                json.dumps(config, indent=2, ensure_ascii=False),
                mimetype='application/json',
                headers={'Content-Disposition': f'attachment; filename=config_{factory}_{system}.json'}
            )

    except Exception as e:
        logger.error(f"导出解析配置失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/import-parser-config', methods=['POST'])
def import_parser_config():
    """导入解析配置（支持全覆盖与增量插入）"""
    try:
        factory = request.form.get('factory')
        system = request.form.get('system')
        mode = (request.form.get('mode', 'overwrite') or 'overwrite').lower()
        file = request.files.get('file')

        if not factory or not system or not file:
            return jsonify({'success': False, 'error': '缺少必要参数'}), 400

        if not file.filename:
            return jsonify({'success': False, 'error': '无效的文件'}), 400

        logger.info(f"导入解析配置: {factory}/{system}, 文件: {file.filename}, 模式: {mode}")

        filename = file.filename.lower()
        raw_bytes = file.stream.read()
        if not raw_bytes:
            return jsonify({'success': False, 'error': '上传文件为空'}), 400

        text = raw_bytes.decode('utf-8-sig', errors='ignore')

        if filename.endswith('.json'):
            try:
                config = json.loads(text)
            except json.JSONDecodeError as exc:
                try:
                    config = ast.literal_eval(text)
                except Exception:
                    return jsonify({'success': False, 'error': f'JSON解析失败: {exc}'}), 400
        elif filename.endswith('.yaml') or filename.endswith('.yml'):
            try:
                import yaml
                config = yaml.safe_load(text)
            except ImportError:
                return jsonify({'success': False, 'error': 'YAML导入需要安装PyYAML库'}), 500
            except yaml.YAMLError as exc:
                return jsonify({'success': False, 'error': f'YAML解析失败: {exc}'}), 400
        else:
            return jsonify({'success': False, 'error': '不支持的文件格式'}), 400

        if not isinstance(config, dict):
            return jsonify({'success': False, 'error': '解析配置必须是 JSON/YAML 对象'}), 400

        try:
            if mode == 'merge':
                parser_config_service.merge(factory, system, config)
            else:
                parser_config_service.save(factory, system, config)
        except ValueError as exc:
            return jsonify({'success': False, 'error': str(exc)}), 400

        logger.info(f"成功导入解析配置: {factory}/{system}")
        return jsonify({'success': True, 'message': '配置导入成功'})

    except Exception as e:
        logger.error(f"导入解析配置失败: {str(e)}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


# 添加检查报告状态的API
@app.route('/api/check-report', methods=['POST'])
def check_report():
    """检查日志文件是否有对应的报告"""
    try:
        data = request.json
        log_path = data.get('log_path')

        try:
            result = analysis_service.check_report(log_path)
        except ValueError as exc:
            return jsonify({'success': False, 'error': str(exc)}), 400

        return jsonify(result)

    except Exception as e:
        logger.error(f"检查报告状态失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)})


@app.route('/api/open-in-browser', methods=['POST'])
def open_in_browser():
    """在默认浏览器中打开URL或文件路径"""
    try:
        data = request.json
        url_or_path = data.get('url')

        if not url_or_path:
            return jsonify({'success': False, 'error': '缺少URL参数'}), 400

        logger.info(f"尝试在浏览器中打开: {url_or_path}")

        # 如果是文件路径，转换为文件URL
        if os.path.exists(url_or_path):
            # 转换为文件URL格式
            if platform.system() == 'Windows':
                # Windows系统使用file:///格式
                url = f"file:///{os.path.abspath(url_or_path).replace(os.sep, '/')}"
            else:
                # Unix-like系统
                url = f"file://{os.path.abspath(url_or_path)}"
        else:
            url = url_or_path

        # 使用webbrowser打开
        success = webbrowser.open(url)

        if success:
            logger.info(f"成功在浏览器中打开: {url}")
            return jsonify({'success': True, 'url': url})
        else:
            # 备用方案：使用命令行打开
            try:
                if platform.system() == 'Darwin':  # macOS
                    subprocess.call(['open', url])
                elif platform.system() == 'Windows':  # Windows
                    subprocess.call(['start', url], shell=True)
                else:  # Linux
                    subprocess.call(['xdg-open', url])

                logger.info(f"使用命令行打开成功: {url}")
                return jsonify({'success': True, 'url': url})
            except Exception as e:
                logger.error(f"命令行打开失败: {str(e)}")
                return jsonify({'success': False, 'error': f'无法打开URL: {str(e)}'}), 500

    except Exception as e:
        logger.error(f"在浏览器中打开失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/get-log-content', methods=['POST'])
def get_log_content():
    """获取日志文件内容"""
    try:
        data = request.json
        file_path = data.get('file_path')

        if not file_path:
            return jsonify({'success': False, 'error': '缺少文件路径参数'}), 400

        if not os.path.exists(file_path):
            return jsonify({'success': False, 'error': '文件不存在'}), 404

        logger.info(f"尝试获取文件内容: {file_path}")

        # 读取文件内容，使用utf-8编码，同时处理可能的编码问题
        with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()

        # 获取文件大小
        file_size = os.path.getsize(file_path)

        return jsonify({
            'success': True,
            'content': content,
            'file_name': os.path.basename(file_path),
            'file_size': file_size
        })
    except Exception as e:
        logger.error(f"获取文件内容失败: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/open-in-editor', methods=['POST'])
def open_in_editor():
    """在默认文本编辑器中打开文件"""
    try:
        data = request.json
        file_path = data.get('file_path')

        if not file_path:
            return jsonify({'success': False, 'error': '缺少文件路径参数'}), 400

        if not os.path.exists(file_path):
            return jsonify({'success': False, 'error': '文件不存在'}), 404

        logger.info(f"尝试在编辑器中打开文件: {file_path}")

        # 根据操作系统使用不同的命令
        system = platform.system()

        if system == 'Darwin':  # macOS
            # 使用open命令，-t表示用默认文本编辑器打开
            subprocess.call(['open', '-t', file_path])
        elif system == 'Windows':  # Windows
            # 使用start命令，用默认程序打开
            os.startfile(file_path)
        else:  # Linux和其他Unix-like系统
            # 尝试使用xdg-open（大多数Linux桌面环境）
            try:
                subprocess.call(['xdg-open', file_path])
            except FileNotFoundError:
                # 备用方案：使用其他编辑器
                for editor in ['gedit', 'kate', 'nano', 'vim']:
                    try:
                        subprocess.call([editor, file_path])
                        break
                    except FileNotFoundError:
                        continue
                else:
                    return jsonify({'success': False, 'error': '未找到可用的文本编辑器'}), 500

        logger.info(f"成功在编辑器中打开文件: {file_path}")
        return jsonify({'success': True, 'file_path': file_path})

    except Exception as e:
        logger.error(f"在编辑器中打开文件失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500




# 已移除客户端模式相关接口

@app.route('/api/exit', methods=['POST'])
def api_exit():
    try:
        def _exit_later():
            import time, os
            time.sleep(0.5)
            os._exit(0)
        threading = __import__('threading')
        t = threading.Thread(target=_exit_later, daemon=True)
        t.start()
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f"/api/exit 失败: {e}", exc_info=True)
        return jsonify({'success': False, 'error': '退出后台失败'}), 500

@app.route('/api/delete-config-item', methods=['POST'])
def delete_config_item():
    """删除配置项（报文类型/版本/字段）"""
    try:
        data = request.json
        factory = data.get('factory')
        system = data.get('system')
        type_ = data.get('type')  # message_type/version/field
        name1 = data.get('name1')  # 报文类型名
        name2 = data.get('name2')  # 版本号
        name3 = data.get('name3')  # 字段名

        if not all([factory, system, type_, name1]):
            return jsonify({'success': False, 'error': '缺少必要参数'}), 400

        config = parser_config_manager.load_config(factory, system)
        if not config:
            return jsonify({'success': False, 'error': '配置不存在'}), 404

        # 根据类型删除对应项
        if type_ == 'message_type':
            if name1 in config:
                del config[name1]
            else:
                return jsonify({'success': False, 'error': '报文类型不存在'}), 404
        elif type_ == 'version':
            if name1 in config and 'Versions' in config[name1] and name2 in config[name1]['Versions']:
                del config[name1]['Versions'][name2]
            else:
                return jsonify({'success': False, 'error': '版本不存在'}), 404
        elif type_ == 'field':
            if (name1 in config and 'Versions' in config[name1] and name2 in config[name1]['Versions'] and
                    'Fields' in config[name1]['Versions'][name2] and name3 in config[name1]['Versions'][name2]['Fields']):
                del config[name1]['Versions'][name2]['Fields'][name3]
            else:
                return jsonify({'success': False, 'error': '字段不存在'}), 404
        else:
            return jsonify({'success': False, 'error': '无效的配置类型'}), 400

        # 保存修改后的配置
        success = parser_config_manager.save_config(factory, system, config)
        if success:
            return jsonify({'success': True})
        else:
            return jsonify({'success': False, 'error': '删除失败'}), 500

    except Exception as e:
        logger.error(f"删除配置项失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500


# 报告管理API
@app.route('/api/reports-list', methods=['GET'])
def get_reports_list():
    """获取报告列表"""
    try:
        # 使用报告数据存储服务获取报告列表
        reports = analysis_service.get_report_list()
        return jsonify({'success': True, 'reports': reports})
    except Exception as e:
        logger.error(f"获取报告列表失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)})


@app.route('/api/report-details/<report_id>', methods=['GET'])
def get_report_details(report_id):
    """获取报告详情"""
    try:
        # 检查报告ID是否有效，处理'undefined'或其他无效值
        if not report_id or report_id.lower() == 'undefined' or report_id.lower() == 'null':
            return jsonify({'success': False, 'error': '缺少或无效的报告ID'}), 400
        
        # 使用报告数据存储服务获取报告详情
        report_data = analysis_service.get_report_details(report_id)
        if not report_data:
            return jsonify({'success': False, 'error': '报告不存在'}), 404
        
        return jsonify({'success': True, 'report_data': report_data})
    except Exception as e:
        logger.error(f"获取报告详情失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)})


@app.route('/api/delete-report', methods=['POST'])
def delete_report():
    """删除报告"""
    try:
        data = request.json
        report_id = data.get('report_id')
        
        if not report_id:
            return jsonify({'success': False, 'error': '缺少报告ID'}), 400
        
        # 使用报告数据存储服务删除报告
        success = analysis_service.delete_report(report_id)
        if success:
            logger.info(f"删除报告: {report_id}")
            return jsonify({'success': True})
        else:
            return jsonify({'success': False, 'error': '删除报告失败'}), 500
    except Exception as e:
        logger.error(f"删除报告失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)})


@app.route('/api/log-reports', methods=['POST'])
def get_log_reports():
    """获取特定日志的报告列表"""
    try:
        data = request.json
        log_path = data.get('log_path')
        
        if not log_path:
            return jsonify({'success': False, 'error': '缺少日志路径'}), 400
        
        # 使用分析服务获取日志的报告列表
        reports = analysis_service.get_log_reports(log_path)
        return jsonify({'success': True, 'reports': reports})
    except Exception as e:
        logger.error(f"获取日志报告列表失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)})


@app.route('/report/<report_id>', methods=['GET'])
def view_report(report_id):
    """报告查看页面"""
    try:
        return render_template('report_viewer.html', report_id=report_id)
    except Exception as e:
        logger.error(f"渲染报告查看页面失败: {str(e)}")
        return jsonify({'success': False, 'error': '报告查看页面渲染失败'}), 500


@app.route('/api/export-pure-report', methods=['POST'])
def export_pure_report():
    """导出纯净版报告"""
    try:
        data = request.json
        report_id = data.get('report_id')
        filtered_data = data.get('filtered_data')  # 接收筛选后的数据
        
        # 检查报告ID是否有效
        if not report_id or report_id.lower() in ('undefined', 'null'):
            return jsonify({'success': False, 'error': '缺少或无效的报告ID'}), 400
        
        # 获取报告数据
        if filtered_data:
            # 如果提供了筛选后的数据，直接使用
            report_data = filtered_data
            # 确保有一些基本字段，比如名称
            if 'name' not in report_data:
                original_report = analysis_service.get_report_details(report_id)
                if original_report:
                    report_data['name'] = f"{original_report.get('name', 'report')}_filtered"
        else:
            # 否则获取完整的报告数据
            report_data = analysis_service.get_report_details(report_id)
            
        if not report_data:
            return jsonify({'success': False, 'error': '报告数据为空或报告不存在'}), 404
        
        # 渲染纯净版报告HTML
        html_content = render_template('pure_report.html', report_data=report_data)
        
        # 设置响应头，返回HTML文件
        import urllib.parse
        report_name = report_data.get("name", "report")
        encoded_filename = urllib.parse.quote(f"{report_name}_pure.html")
        
        return Response(
            html_content,
            mimetype='text/html',
            headers={
                'Content-Disposition': f'attachment; filename="{encoded_filename}"; filename*=UTF-8''{encoded_filename}',
                'Content-Type': 'text/html; charset=utf-8'
            }
        )
    except Exception as e:
        logger.error(f"导出纯净版报告失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500

# --- server.py 里：Templates API（使用 core/template_manager.TemplateManager） ---
templates_bp = Blueprint("templates_api", __name__)
tm = region_template_manager

def _parse_nodes(nodes_or_text):
    """允许数组或逗号分隔字符串"""
    if isinstance(nodes_or_text, list):
        return [str(x).strip() for x in nodes_or_text if str(x).strip()]
    if isinstance(nodes_or_text, str):
        return [s.strip() for s in nodes_or_text.split(',') if s.strip()]
    return []

@templates_bp.route("/api/templates", methods=["GET"])
def list_templates():
    # 查询参数
    q = (request.args.get("q") or "").strip()
    factory = (request.args.get("factory") or "").strip()
    system = (request.args.get("system") or "").strip()
    try:
        page = int(request.args.get("page", "1"))
        page_size = int(request.args.get("page_size", "20"))
    except Exception:
        page, page_size = 1, 20

    # TemplateManager.list 返回 {"items":[...], "total":N}
    data = tm.list(factory=factory, system=system, q=q, page=page, page_size=page_size)
    return jsonify({
        "success": True,
        "items": data.get("items", []),
        "total": data.get("total", 0),
        "page": page,
        "page_size": page_size
    })

@templates_bp.route("/api/templates", methods=["POST"])
def create_template():
    body = request.get_json(force=True) or {}
    name = (body.get("name") or "").strip()

    # 支持 id + name 并存；前端传哪种都行
    factory_id = (body.get("factory_id") or "").strip() or None
    system_id  = (body.get("system_id") or "").strip() or None
    server_config_id = (body.get("server_config_id") or "").strip() or None

    factory = (body.get("factory") or body.get("factory_name") or "").strip()
    system  = (body.get("system")  or body.get("system_name")  or "").strip()
    nodes = _parse_nodes(body.get("nodes") or body.get("nodes_text") or "")

    if not name or not factory or not system:
        return jsonify({"success": False, "error": "name/factory/system 为必填"}), 400
    if not nodes:
        return jsonify({"success": False, "error": "请至少提供一个节点"}), 400

    item = tm.create(
        name=name,
        factory=factory,
        system=system,
        nodes=nodes,
        server_config_id=server_config_id,
        factory_id=factory_id,
        system_id=system_id,
    )
    return jsonify({"success": True, "item": item})

@templates_bp.route("/api/templates/<tid>", methods=["GET"])
def get_template(tid):
    item = tm.get(tid)
    if not item:
        return jsonify({"success": False, "error": "模板不存在"}), 404
    return jsonify({"success": True, "item": item})

@templates_bp.route("/api/templates/<tid>", methods=["PUT", "PATCH"])
def update_template(tid):
    patch = request.get_json(force=True) or {}
    # 节点可传 nodes 或 nodes_text
    if "nodes" in patch or "nodes_text" in patch:
        patch["nodes"] = _parse_nodes(patch.get("nodes") or patch.get("nodes_text") or [])
    item = tm.update(tid, patch)
    if not item:
        return jsonify({"success": False, "error": "模板不存在"}), 404
    return jsonify({"success": True, "item": item})

@templates_bp.route("/api/templates/<tid>", methods=["DELETE"])
def delete_template(tid):
    ok = tm.delete(tid)
    if not ok:
        return jsonify({"success": False, "error": "模板不存在"}), 404
    return jsonify({"success": True, "deleted": True})

# 注册蓝图
app.register_blueprint(templates_bp)

@app.route('/api/logs/search', methods=['POST'])
def api_logs_search():
    try:
        data = request.get_json(force=True) or {}

        logs = download_service.search(
            factory=data.get('factory') or '',
            system=data.get('system') or '',
            nodes=data.get('nodes'),
            node=data.get('node'),
            include_realtime=_get_bool(data, 'include_realtime', 'includeRealtime', default=True),
            include_archive=_get_bool(data, 'include_archive', 'includeArchive', default=False),
            date_start=data.get('date_start') or data.get('dateStart'),
            date_end=data.get('date_end') or data.get('dateEnd'),
        )

        return jsonify({"success": True, "logs": logs})
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    except Exception as exc:
        logger.error(f"/api/logs/search 失败: {exc}", exc_info=True)
        return jsonify({"success": False, "error": '搜索日志失败'}), 500


@app.route('/api/logs/search_strict', methods=['POST'])
def api_logs_search_strict():
    try:
        data = request.get_json(force=True) or {}
        template_id = data.get('template_id')
        if not template_id:
            return jsonify({"success": False, "error": "缺少模板ID"}), 400

        logs = download_service.search_with_template(
            template_id=template_id,
            include_realtime=_get_bool(data, 'include_realtime', 'includeRealtime', default=True),
            include_archive=_get_bool(data, 'include_archive', 'includeArchive', default=False),
            date_start=data.get('date_start') or data.get('dateStart'),
            date_end=data.get('date_end') or data.get('dateEnd'),
            strict_format=_get_bool(data, 'strict_format', 'strictFormat', default=True),
        )

        return jsonify({"success": True, "logs": logs})
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    except Exception as exc:
        logger.error(f"/api/logs/search_strict 失败: {exc}", exc_info=True)
        return jsonify({"success": False, "error": "搜索日志失败"}), 500


@app.route('/api/logs/download', methods=['POST'])
def api_logs_download():
    try:
        data = request.get_json(force=True) or {}
        files = data.get('files') or []
        downloaded = download_service.download(
            files=files,
            factory=data.get('factory') or '',
            system=data.get('system') or '',
            nodes=data.get('nodes'),
            node=data.get('node'),
        )
        return jsonify({'success': True, 'downloaded_files': downloaded})
    except ValueError as exc:
        return jsonify({'success': False, 'error': str(exc)}), 400
    except Exception as exc:
        logger.error(f"/api/logs/download 失败: {exc}", exc_info=True)
        return jsonify({'success': False, 'error': '下载日志失败'}), 500


@app.after_request
def _no_cache_for_dynamic(resp):
    try:
        p = request.path or ""
        if p in (
            "/api/factories",
            "/api/systems",
            "/api/parser-configs",
        ):
            resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            resp.headers["Pragma"] = "no-cache"
            resp.headers["Expires"] = "0"
    except Exception:
        pass
    return resp


@app.route('/api/cleanup/config', methods=['GET', 'POST'])
def handle_cleanup_config():
    """获取 or 更新清理配置"""
    if request.method == 'GET':
        return jsonify(cleanup_manager.get_config())
    else:
        try:
            config = request.json
            cleanup_manager.save_config(config)
            return jsonify({'success': True})
        except Exception as e:
            logger.error(f"Failed to update cleanup config: {e}")
            return jsonify({'error': str(e)}), 500


@app.route('/api/cleanup/logs', methods=['GET'])
def get_cleanup_logs():
    """获取所有日志及其锁定状态"""
    try:
        logs = cleanup_manager.get_all_logs_with_reports()
        return jsonify(logs)
    except Exception as e:
        logger.error(f"Failed to get cleanup logs: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/cleanup/lock', methods=['POST'])
def cleanup_toggle_log_lock():
    """切换日志锁定状态"""
    try:
        data = request.json
        log_path = data.get('log_path')
        locked = data.get('locked')
        if not log_path or locked is None:
            return jsonify({'error': 'Missing log_path or locked status'}), 400
            
        success = cleanup_manager.toggle_lock(log_path, locked)
        if success:
            return jsonify({'success': True})
        else:
            return jsonify({'error': 'Failed to update lock status'}), 500
    except Exception as e:
        logger.error(f"Failed to toggle lock: {e}")
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    # 初始化配置文件
    init_config_files()

    # 创建必要的目录
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    os.makedirs(HTML_LOGS_DIR, exist_ok=True)
    os.makedirs(MAPPING_CONFIG_DIR, exist_ok=True)

    # 启动应用
    print("启动日志分析系统...")
    print(f"配置文件路径: {CONFIG_DIR}")
    print(f"服务器配置文件: {SERVER_CONFIGS_FILE}")
    print(f"访问地址: http://127.0.0.1:5000")
    app.run(host='127.0.0.1', port=5000, debug=True)
# 字段历史存储
def _field_history_file(factory: str, system: str) -> str:
    cfg_path = parser_config_manager.get_config_path(factory, system)
    base_dirname = os.path.dirname(cfg_path)
    base_filename = os.path.splitext(os.path.basename(cfg_path))[0]
    return os.path.join(base_dirname, f"{base_filename}.fields_history.json")

def _read_field_history(factory: str, system: str) -> List[Dict[str, Any]]:
    path = _field_history_file(factory, system)
    if os.path.exists(path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, list):
                return data
        except Exception:
            pass
    return []

def _write_field_history(factory: str, system: str, items: List[Dict[str, Any]]) -> None:
    path = _field_history_file(factory, system)
    try:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
    except Exception as exc:
        logger.warning(f"写入字段历史失败: {exc}")

def _add_field_history(factory: str, system: str, name: str, start: int, length: Any, escapes: Dict[str, Any] = None):
    items = _read_field_history(factory, system)
    key = f"{name}|{start}|{length if length is not None else -1}"
    now = datetime.utcnow().isoformat() + 'Z'
    found = False
    for it in items:
        it_key = f"{it.get('name','')}|{int(it.get('start',0))}|{int(it.get('length',-1))}"
        if it_key == key:
            it['usageCount'] = int(it.get('usageCount', 0)) + 1
            it['lastUsed'] = now
            if escapes and isinstance(escapes, dict):
                # 合并Escapes但不覆盖已有键
                it.setdefault('escapes', {})
                for k, v in escapes.items():
                    if k not in it['escapes']:
                        it['escapes'][k] = v
            found = True
            break
    if not found:
        items.append({
            'name': name,
            'start': int(start),
            'length': int(length if length is not None else -1),
            'usageCount': 1,
            'lastUsed': now,
            'escapes': escapes or {}
        })
    _write_field_history(factory, system, items)
@app.route('/api/parser-field-history', methods=['GET'])
def get_parser_field_history():
    try:
        factory = request.args.get('factory')
        system = request.args.get('system')
        if not factory or not system:
            return jsonify({'success': False, 'error': '缺少厂区或系统参数'}), 400

        cfg = parser_config_manager.load_config(factory, system) or {}
        agg_map: Dict[str, Dict[str, Any]] = {}

        # 先聚合当前配置
        for mt, mt_obj in (cfg.items() if isinstance(cfg, dict) else []):
            versions = (mt_obj or {}).get('Versions') or {}
            for ver, ver_obj in versions.items():
                fields = (ver_obj or {}).get('Fields') or {}
                for name, f in fields.items():
                    start = int((f or {}).get('Start', 0))
                    length = (f or {}).get('Length')
                    length_val = -1 if length is None else int(length)
                    key = f"{name}|{start}|{length_val}"
                    esc = (f or {}).get('Escapes') or {}
                    if key not in agg_map:
                        agg_map[key] = {'name': name, 'start': start, 'length': length_val, 'usageCount': 1, 'escapes': esc}
                    else:
                        agg_map[key]['usageCount'] += 1

        # 再合并历史文件
        hist_items = _read_field_history(factory, system)
        for it in hist_items:
            name = it.get('name') or ''
            start = int(it.get('start', 0))
            length_val = int(it.get('length', -1))
            key = f"{name}|{start}|{length_val}"
            if key in agg_map:
                agg_map[key]['usageCount'] += int(it.get('usageCount', 1))
                # 合并Escapes但不覆盖已有键
                if isinstance(it.get('escapes'), dict):
                    agg_map[key].setdefault('escapes', {})
                    for k, v in it['escapes'].items():
                        if k not in agg_map[key]['escapes']:
                            agg_map[key]['escapes'][k] = v
            else:
                agg_map[key] = {
                    'name': name,
                    'start': start,
                    'length': length_val,
                    'usageCount': int(it.get('usageCount', 1)),
                    'escapes': it.get('escapes') or {}
                }

        items = list(agg_map.values())
        items.sort(key=lambda x: (-int(x.get('usageCount', 0)), x.get('name', '')))
        return jsonify({'success': True, 'items': items})
    except Exception as e:
        logger.error(f"获取历史字段失败: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500
