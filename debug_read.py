import json
import os

log_path = r"c:\Users\Administrator\Desktop\新建文件夹\downloads\DaDong\400\tcp_trace.400"
config_path = r"c:\Users\Administrator\Desktop\新建文件夹\configs\parser_configs\DaDong_OSM.json"

print(f"--- Reading Log File: {log_path} ---")
try:
    with open(log_path, 'r', encoding='utf-8', errors='replace') as f:
        lines = f.readlines()
        print(f"Total lines: {len(lines)}")
        for i, line in enumerate(lines[:20]):
            print(f"Line {i}: {repr(line)}")
except Exception as e:
    print(f"Error reading log: {e}")

print(f"\n--- Reading Config File: {config_path} ---")
try:
    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)
        print(json.dumps(config, indent=2, ensure_ascii=False))
except Exception as e:
    print(f"Error reading config: {e}")
