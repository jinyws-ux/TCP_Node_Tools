# core/log_matcher.py
import logging
from typing import List, Dict, Any, Optional, Set, Tuple

logger = logging.getLogger(__name__)


class Transaction:
    """表示一个完整的请求-回复事务（包含重试）"""
    def __init__(self, node_id: str, trans_id: str):
        self.node_id = node_id
        self.trans_id = trans_id
        self.requests: List[Dict[str, Any]] = []
        self.response: Optional[Dict[str, Any]] = None

    @property
    def latest_request(self) -> Optional[Dict[str, Any]]:
        return self.requests[-1] if self.requests else None

    @property
    def start_time(self):
        if self.requests:
            return self.requests[0].get('timestamp')
        return None


class LogMatcher:
    def __init__(self, parser_config: Dict[str, Any]):
        self.parser_config = parser_config
        self.logger = logging.getLogger(__name__)
        # 预处理：构建 RequestType -> ResponseType 的映射
        self.req_to_resp_map = {}
        # 预处理：构建 ResponseType -> RequestType 的映射 (反向查找)
        self.resp_to_req_map = {}
        
        for msg_type, config in self.parser_config.items():
            resp_type = config.get('ResponseType')
            if resp_type:
                self.req_to_resp_map[msg_type] = resp_type
                # 注意：可能有多个请求类型对应同一个回复类型（虽然少见），这里简单反向映射
                self.resp_to_req_map[resp_type] = msg_type

    def match_logs(self, log_entries: List[Dict[str, Any]]) -> List[Any]:
        """
        执行双重遍历分组法 (Two-Pass Grouping)
        返回列表可能包含 Dict (普通日志) 或 Transaction 对象
        """
        if not log_entries:
            return []

        # Pass 1: Grouping
        # Key: (node_id, trans_id) -> Transaction
        trans_map: Dict[Tuple[str, str], Transaction] = {}
        
        # 辅助：记录哪些 entry 已经被归入 Transaction，用于 Pass 2 快速判断
        processed_indices: Set[int] = set()

        for idx, entry in enumerate(log_entries):
            # 1. 提取基础信息
            node_id = self._get_node_id(entry)
            msg_type = self._get_msg_type(entry)
            
            # 2. 判断是否为 PID 或无关报文
            if self._is_pid(entry) or not msg_type:
                continue

            # 3. 提取 TRANSID
            # 只有配置了 ResponseType 的请求，或者被 ResponseType 指向的回复，才需要提取
            is_request = msg_type in self.req_to_resp_map
            is_response = msg_type in self.resp_to_req_map
            
            if not (is_request or is_response):
                continue

            trans_id = self._extract_trans_id(entry)
            if not trans_id:
                continue

            key = (node_id, trans_id)
            
            if key not in trans_map:
                trans_map[key] = Transaction(node_id, trans_id)

            transaction = trans_map[key]

            if is_request:
                transaction.requests.append(entry)
                # 标记该 entry 为已处理（属于某个事务）
                # 注意：我们在 Pass 2 会用到这个标记来决定是否跳过
                # 但为了 Pass 2 的顺序性，我们其实不需要在这里物理移除
                # 只需要知道它属于哪个 Transaction 即可
                entry['_transaction_ref'] = transaction
                
            elif is_response:
                # 如果已经有回复了怎么办？
                # 策略：覆盖？或者忽略？通常一个事务只有一个回复。
                # 如果日志里有重复回复，我们保留第一个，或者覆盖。这里选择保留第一个。
                if transaction.response is None:
                    transaction.response = entry
                    entry['_transaction_ref'] = transaction
                else:
                    # 这是一个重复的回复，或者 TRANSID 冲突？
                    # 暂时作为普通日志处理，不归入事务（或者归入但不作为主回复）
                    pass

        # Pass 2: Rendering / Flattening
        final_list = []
        
        # 用于防止重复添加 Transaction
        # 当遇到 Transaction 的任何一个成员时，我们检查是否已经添加过该 Transaction
        added_transactions: Set[Transaction] = set()

        for entry in log_entries:
            transaction = entry.get('_transaction_ref')
            
            if not transaction:
                # 普通日志，直接添加
                final_list.append(entry)
                continue
            
            # 如果属于某个事务
            if transaction in added_transactions:
                # 事务已经添加过了，当前 entry 是该事务的旧请求或已匹配回复，跳过
                continue
            
            # 事务还没添加过
            # 检查当前 entry 是否是触发添加的“锚点”
            
            # 锚点逻辑：
            # 我们希望在“最后一次请求”的位置展示事务。
            # 如果没有请求（孤立回复），则在“回复”的位置展示。
            
            if transaction.requests:
                # 有请求，锚点是最后一次请求
                if entry is transaction.latest_request:
                    final_list.append(transaction)
                    added_transactions.add(transaction)
                else:
                    # 是旧请求，跳过
                    pass
            else:
                # 无请求（孤立回复），锚点是回复本身
                if entry is transaction.response:
                    # 孤立回复，其实可以作为普通日志展示，或者作为特殊的 Transaction 展示
                    # 这里选择作为普通日志展示，因为没有请求需要折叠
                    # 但为了保持类型一致性，或者如果 UI 能处理孤立回复，也可以传 Transaction
                    # 鉴于 UI 设计是“折叠请求”，没有请求就没必要用 Transaction 结构
                    # 所以这里我们把孤立回复当做普通日志
                    final_list.append(entry)
                    added_transactions.add(transaction) # 标记已处理
                else:
                    # 理论上不会走到这里，除非一个事务有多个回复且无请求
                    pass

        # 清理临时标记
        for entry in log_entries:
            if '_transaction_ref' in entry:
                del entry['_transaction_ref']

        return final_list

    def _get_node_id(self, entry: Dict[str, Any]) -> str:
        for seg in entry.get('segments', []):
            if seg.get('kind') == 'node':
                return seg.get('text', '0')
        return '0'

    def _get_msg_type(self, entry: Dict[str, Any]) -> str:
        for seg in entry.get('segments', []):
            if seg.get('kind') == 'msg_type':
                return seg.get('text', '')
        return ''

    def _is_pid(self, entry: Dict[str, Any]) -> bool:
        for seg in entry.get('segments', []):
            if seg.get('kind') == 'pid':
                return True
        return False

    def _extract_trans_id(self, entry: Dict[str, Any]) -> Optional[str]:
        # 需要先进行与 LogParser 一致的清洗逻辑
        line = entry.get('original_line2', '')
        direction = self._get_direction(entry)
        
        # 1. Output 方向去除前 7 位 (模拟 LogParser 逻辑)
        if direction == "Output" and len(line) >= 7:
            line = line[7:]
            
        # 2. 去除噪声前缀
        line = self._strip_noise_prefix(line)
        
        # 3. 确定提取位置配置
        msg_type = self._get_msg_type(entry)
        target_type = msg_type
        
        # 如果是回复报文，使用对应请求报文的配置
        if msg_type in self.resp_to_req_map:
            target_type = self.resp_to_req_map[msg_type]
            
        # 获取配置 (默认 32, 12)
        start = 32
        length = 12
        
        if target_type in self.parser_config:
            cfg = self.parser_config[target_type]
            pos_str = cfg.get('TransIdPosition', '')
            if pos_str:
                try:
                    parts = pos_str.split(',')
                    if len(parts) == 2:
                        s = int(parts[0].strip())
                        l = int(parts[1].strip())
                        if s >= 0 and l > 0:
                            start = s
                            length = l
                except Exception:
                    pass # 保持默认

        # 4. 提取 TransID
        if len(line) >= start + length:
            return line[start : start + length]
        return None

    def _get_direction(self, entry: Dict[str, Any]) -> str:
        for seg in entry.get('segments', []):
            if seg.get('kind') == 'dir':
                return seg.get('text', '')
        return ''

    def _strip_noise_prefix(self, content: str) -> str:
        import re
        try:
            s = content or ""
            s = s.lstrip()
            # 匹配非字母数字的噪声前缀 (5-12位)
            m = re.match(r'^[^A-Za-z0-9]{5,12}', s)
            if m:
                s = s[m.end():]
            return s.lstrip()
        except Exception:
            return content
