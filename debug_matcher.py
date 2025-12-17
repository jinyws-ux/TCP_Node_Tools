import sys
import os
import logging

# Add project root to path
sys.path.append(os.getcwd())

from core.parser_config_manager import ParserConfigManager
from core.log_parser import LogParser
from core.log_matcher import LogMatcher

# Setup logging
logging.basicConfig(level=logging.INFO)

def debug_matching():
    factory = "DaDong"
    system = "OSM" # Assuming this based on filename/user context
    # Wait, user said DaDong/400. System might be OSM based on previous context.
    # Let's check the config file name again or just try loading.
    # Config file was DaDong_OSM.json. So system is "OSM".
    
    config_dir = r"c:\Users\Administrator\Desktop\新建文件夹\configs\parser_configs"
    manager = ParserConfigManager(config_dir)
    config = manager.load_config(factory, system)
    
    if not config:
        print("Error: Could not load config")
        return

    with open('debug_output.txt', 'w', encoding='utf-8') as out:
        out.write(f"Loaded config with {len(config)} message types\n")
        
        log_path = r"c:\Users\Administrator\Desktop\新建文件夹\downloads\DaDong\400\tcp_trace.400"
        if not os.path.exists(log_path):
            out.write(f"Error: Log file not found: {log_path}\n")
            return

        with open(log_path, 'r', encoding='utf-8', errors='ignore') as f:
            lines = f.readlines()
            
        out.write(f"Read {len(lines)} lines from log\n")

        parser = LogParser(config)
        entries = parser.parse_log_lines(lines)
        out.write(f"Parsed {len(entries)} entries\n")

        matcher = LogMatcher(config)
        
        out.write("\n--- Debugging Entries ---\n")
        for i, entry in enumerate(entries):
            msg_type = matcher._get_msg_type(entry)
            trans_id = matcher._extract_trans_id(entry)
            original_line2 = entry.get('original_line2', '').strip()
            
            out.write(f"Entry {i}: Type={msg_type}, TransID={trans_id}\n")
            out.write(f"  Line2 (len={len(original_line2)}): {repr(original_line2[:100])}...\n")
            
            if msg_type in matcher.req_to_resp_map:
                out.write(f"  -> Is Request (Expects {matcher.req_to_resp_map[msg_type]})\n")
            if msg_type in matcher.resp_to_req_map:
                out.write(f"  -> Is Response (For {matcher.resp_to_req_map[msg_type]})\n")

if __name__ == "__main__":
    debug_matching()
