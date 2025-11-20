# web/server.py
import ast
import json
import logging
import os
import platform
import subprocess
import threading
from typing import Any, Dict, List
import webbrowser

from flask import Blueprint, Flask, render_template, request, jsonify, send_from_directory, Response

from core.analysis_service import AnalysisService
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
DOWNLOAD_DIR = paths_cfg['DOWNLOAD_DIR']
HTML_LOGS_DIR = paths_cfg['HTML_LOGS_DIR']
REPORT_MAPPING_FILE = paths_cfg['REPORT_MAPPING_FILE'] or os.path.join(HTML_LOGS_DIR, 'report_mappings.json')

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 服务占位符（延迟初始化以提升启动速度）
config_manager = None
parser_config_manager = None
metadata_store = None
log_downloader = None
log_analyzer = None
region_template_manager = None
download_service = None
report_mapping_store = None
parser_config_service = None
server_config_service = None
analysis_service = None

_init_lock = threading.Lock()
_services_ready = False


def _ensure_services():
    global config_manager, parser_config_manager, metadata_store
    global log_downloader, log_analyzer, region_template_manager
    global download_service, report_mapping_store, parser_config_service
    global server_config_service, analysis_service, _services_ready

    if _services_ready:
        return
    with _init_lock:
        if _services_ready:
            return

        os.makedirs(CONFIG_DIR, exist_ok=True)
        os.makedirs(DOWNLOAD_DIR, exist_ok=True)
        os.makedirs(HTML_LOGS_DIR, exist_ok=True)
        os.makedirs(PARSER_CONFIGS_DIR, exist_ok=True)
        os.makedirs(REGION_TEMPLATES_DIR, exist_ok=True)
        os.makedirs(MAPPING_CONFIG_DIR, exist_ok=True)

        config_manager = ConfigManager(CONFIG_DIR)
        parser_config_manager = ParserConfigManager(PARSER_CONFIGS_DIR)
        metadata_store = LogMetadataStore(DOWNLOAD_DIR, MAPPING_CONFIG_DIR)
        log_downloader = LogDownloader(
            DOWNLOAD_DIR,
            config_manager,
            metadata_store=metadata_store,
        )
        log_analyzer = LogAnalyzer(
            HTML_LOGS_DIR,
            config_manager,
            parser_config_manager,
            metadata_store=metadata_store,
        )

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

        app.config['HTML_LOGS_DIR'] = HTML_LOGS_DIR
        _services_ready = True
        logger.info("服务初始化完成，工作目录已准备好")


@app.before_request
def _prepare_services():
    _ensure_services()


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
            'Versions': {}
        }

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
        return jsonify({'success': True, 'logs': logs})
    except Exception as e:
        logger.error(f"获取已下载日志失败: {str(e)}")
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
                    'generate_original_log': _get_bool(data or {}, 'generate_original_log', default=True),
                    'generate_sorted_log': _get_bool(data or {}, 'generate_sorted_log', default=True),
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


@app.route('/report/<path:filename>')
def serve_report(filename):
    """提供生成的报告文件"""
    report_dir = os.path.join(HTML_LOGS_DIR, 'html_logs')
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


@app.route('/api/exit', methods=['POST'])
def api_exit():
    """退出后台进程（网页模式右上角按钮触发）。"""
    try:
        def _exit_later():
            import time
            time.sleep(0.5)
            os._exit(0)

        t = threading.Thread(target=_exit_later, daemon=True)
        t.start()
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f"/api/exit 失败: {e}", exc_info=True)
        return jsonify({'success': False, 'error': '退出后台失败'}), 500


@app.route('/api/open-reports-directory', methods=['POST'])
def open_reports_directory():
    """打开报告目录"""
    try:
        # 获取报告目录
        reports_dir = analysis_service.get_reports_directory() or app.config['HTML_LOGS_DIR']

        if not os.path.exists(reports_dir):
            logger.error(f"报告目录不存在: {reports_dir}")
            return jsonify({'success': False, 'error': '报告目录不存在'}), 404

        logger.info(f"尝试打开报告目录: {reports_dir}")

        # 使用系统命令打开目录
        system = platform.system()
        if system == 'Windows':
            os.startfile(reports_dir)
        elif system == 'Darwin':  # macOS
            subprocess.call(['open', reports_dir])
        else:  # Linux
            subprocess.call(['xdg-open', reports_dir])

        logger.info("成功打开报告目录")
        return jsonify({'success': True, 'directory': reports_dir})

    except Exception as e:
        logger.error(f"打开报告目录失败: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500

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
        )

        return jsonify({"success": True, "logs": logs})
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    except Exception as exc:
        logger.error(f"/api/logs/search_strict 失败: {exc}", exc_info=True)
        return jsonify({"success": False, "error": '搜索日志失败'}), 500


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
