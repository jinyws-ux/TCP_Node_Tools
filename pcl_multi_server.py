import streamlit as st
import paramiko
import os
import subprocess
import time
from stat import S_ISDIR

# ================= 1. 全局配置区域 =================

# 本地 GhostPCL 路径 (请修改这里)
GHOSTPCL_PATH = r"C:\path\to\gpcl6win64.exe" 
# 本地临时下载目录
LOCAL_TEMP_DIR = "temp_downloads"

# === 服务器列表配置 ===
# 你可以在这里添加任意多个服务器
# 建议: 密码留空 ("")，这样在网页上会提示输入，更安全。
# 如果是内网安全环境，也可以直接把密码写进去。
SERVER_CONFIG = {
    "生产环境 (Prod)": {
        "host": "192.168.1.100",
        "port": 22,
        "user": "root",
        "password": "",  # 留空则在界面输入
        "path": "/var/log/pcl_output/"
    },
    "测试环境 (Test)": {
        "host": "192.168.1.101",
        "port": 22,
        "user": "op_user",
        "password": "", 
        "path": "/home/op_user/pcl_test/"
    },
    "灾备环境 (DR)": {
        "host": "192.168.1.200",
        "port": 22,
        "user": "root",
        "password": "SafePassword123", # 不推荐直接写明文
        "path": "/data/pcl/"
    }
}

# ================= 2. 工具函数 =================

def get_remote_files(host, port, user, pwd, path):
    """连接 SSH 获取按时间排序的文件列表"""
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(host, int(port), user, pwd, timeout=5)
        sftp = ssh.open_sftp()
        
        # 获取文件属性
        try:
            files = sftp.listdir_attr(path)
        except FileNotFoundError:
            return [], f"路径不存在: {path}"
            
        # 过滤掉文件夹，只留文件
        files = [f for f in files if not S_ISDIR(f.st_mode)]
        # 按修改时间降序排序 (从新到旧)
        files.sort(key=lambda x: x.st_mtime, reverse=True)
        
        # 提取文件名
        file_names = [f.filename for f in files if f.filename.lower().endswith(('.pcl', '.prn'))]
        
        sftp.close()
        ssh.close()
        return file_names, None
    except Exception as e:
        return [], str(e)

def convert_pcl_to_pdf(pcl_file, pdf_file):
    """调用本地 GhostPCL 转换"""
    if not os.path.exists(GHOSTPCL_PATH):
        return False, f"找不到 GhostPCL 工具，请检查路径: {GHOSTPCL_PATH}"

    cmd = [
        GHOSTPCL_PATH,
        "-dNOPAUSE", "-dBATCH", "-sDEVICE=pdfwrite",
        f"-sOutputFile={pdf_file}",
        pcl_file
    ]
    try:
        # Windows下隐藏CMD弹窗
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        
        subprocess.run(cmd, check=True, startupinfo=startupinfo)
        return True, None
    except subprocess.CalledProcessError as e:
        return False, "转换过程出错，可能是 PCL 文件损坏或格式不兼容。"
    except Exception as e:
        return False, str(e)

# ================= 3. 界面逻辑 =================

st.set_page_config(page_title="多环境 PCL 转换器", layout="wide", page_icon="🖨️")

st.title("🖨️ 多服务器 PCL 下载转换助手")

# 初始化 Session State
if "file_list" not in st.session_state:
    st.session_state.file_list = []
if "current_server_key" not in st.session_state:
    st.session_state.current_server_key = None

# --- 侧边栏：选择服务器 ---
with st.sidebar:
    st.header("1. 选择服务器")
    
    # 下拉选择服务器
    server_names = list(SERVER_CONFIG.keys())
    selected_server_name = st.selectbox("目标环境", server_names)
    
    # 获取当前选中的配置
    current_config = SERVER_CONFIG[selected_server_name]
    
    # 简单的状态重置逻辑：如果换了服务器，清空列表
    if st.session_state.current_server_key != selected_server_name:
        st.session_state.file_list = []
        st.session_state.current_server_key = selected_server_name
    
    # 展示只读信息
    st.info(f"Host: `{current_config['host']}`\n\nUser: `{current_config['user']}`\n\nPath: `{current_config['path']}`")
    
    # 密码处理逻辑
    password = current_config.get("password", "")
    if not password:
        password = st.text_input("请输入密码", type="password", key="pwd_input")
    
    connect_btn = st.button("🔄 连接并刷新列表", type="primary")

# --- 主界面：文件列表与操作 ---

# 只有点击了连接按钮，或者列表已经存在时才显示
if connect_btn:
    if not password:
        st.error("❌ 请输入密码！")
    else:
        with st.spinner(f"正在连接 {selected_server_name} ..."):
            files, error = get_remote_files(
                current_config['host'], 
                current_config['port'], 
                current_config['user'], 
                password, 
                current_config['path']
            )
            
            if error:
                st.error(f"连接失败: {error}")
                st.session_state.file_list = []
            else:
                if not files:
                    st.warning("连接成功，但该目录下没有找到 PCL 文件。")
                else:
                    st.toast(f"成功加载 {len(files)} 个文件", icon="✅")
                st.session_state.file_list = files

# --- 文件操作区 ---
st.divider()

if st.session_state.file_list:
    st.header("2. 选择文件进行处理")
    
    col1, col2 = st.columns([3, 1])
    with col1:
        # 下拉框选择文件
        target_file = st.selectbox("请选择文件 (按时间倒序)", st.session_state.file_list)
    with col2:
        st.write("") # 占位
        st.write("") 
        # 转换按钮
        process_btn = st.button("🚀 下载并转为 PDF", use_container_width=True)

    if process_btn:
        # 准备路径
        if not os.path.exists(LOCAL_TEMP_DIR):
            os.makedirs(LOCAL_TEMP_DIR)
            
        local_pcl = os.path.join(LOCAL_TEMP_DIR, target_file)
        local_pdf = os.path.join(LOCAL_TEMP_DIR, target_file + ".pdf")
        
        status_box = st.status("正在处理任务...", expanded=True)
        
        # 步骤 1: 下载
        try:
            status_box.write("📥 正在从服务器下载文件...")
            # 为了下载，需要重新建立连接（或者复用连接，这里为了无状态简单化，重新连接）
            # 注意：实际生产中可以使用 session 保持 ssh 连接，但 Streamlit 的运行机制下，短连接更稳定
            t_ssh = paramiko.SSHClient()
            t_ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            # 如果配置里没密码，就用刚才输入的
            pwd_to_use = current_config.get("password") or st.session_state.get("pwd_input")
            
            t_ssh.connect(current_config['host'], current_config['port'], current_config['user'], pwd_to_use)
            t_sftp = t_ssh.open_sftp()
            remote_full_path = current_config['path'].rstrip('/') + '/' + target_file
            t_sftp.get(remote_full_path, local_pcl)
            t_sftp.close()
            t_ssh.close()
            status_box.write("✅ 下载完成")
        except Exception as e:
            status_box.update(label="❌ 下载失败", state="error")
            st.error(str(e))
            st.stop()

        # 步骤 2: 转换
        try:
            status_box.write("⚙️ 正在调用 GhostPCL 转换...")
            success, msg = convert_pcl_to_pdf(local_pcl, local_pdf)
            if success:
                status_box.update(label="✅ 全部完成!", state="complete", expanded=False)
                
                # 步骤 3: 展示下载
                st.success(f"转换成功！文件已生成: {target_file}.pdf")
                with open(local_pdf, "rb") as f:
                    st.download_button(
                        label="📄 点击保存 PDF 到本地",
                        data=f,
                        file_name=target_file + ".pdf",
                        mime="application/pdf",
                        type="primary"
                    )
            else:
                status_box.update(label="❌ 转换失败", state="error")
                st.error(msg)
        except Exception as e:
             st.error(f"系统错误: {e}")

else:
    st.info("👈 请先在左侧选择服务器并连接")