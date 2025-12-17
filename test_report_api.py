#!/usr/bin/env python3
"""
测试报告管理API功能
"""
import requests
import json

BASE_URL = "http://127.0.0.1:5000"

def test_get_reports_list():
    """测试获取报告列表"""
    print("测试获取报告列表...")
    response = requests.get(f"{BASE_URL}/api/reports-list")
    if response.status_code == 200:
        data = response.json()
        print(f"✅ 成功获取报告列表，共 {len(data.get('reports', []))} 个报告")
        return data.get('reports', [])
    else:
        print(f"❌ 获取报告列表失败: {response.status_code}")
        return []

def test_get_report_details(report_id):
    """测试获取报告详情"""
    print(f"\n测试获取报告详情 {report_id}...")
    response = requests.get(f"{BASE_URL}/api/report-details/{report_id}")
    if response.status_code == 200:
        data = response.json()
        print(f"✅ 成功获取报告详情")
        print(f"   报告名称: {data.get('report_data', {}).get('name', '未知')}")
        print(f"   日志条目数: {len(data.get('report_data', {}).get('log_entries', []))}")
        print(f"   异常项数: {len(data.get('report_data', {}).get('abnormal_items', []))}")
        return True
    else:
        print(f"❌ 获取报告详情失败: {response.status_code}")
        return False

def test_view_report_page(report_id):
    """测试访问报告查看页面"""
    print(f"\n测试访问报告查看页面 {report_id}...")
    response = requests.get(f"{BASE_URL}/report/{report_id}")
    if response.status_code == 200:
        print(f"✅ 成功访问报告查看页面")
        return True
    else:
        print(f"❌ 访问报告查看页面失败: {response.status_code}")
        return False

if __name__ == "__main__":
    print("=== TCP LogTool 报告管理API测试 ===")
    
    # 测试获取报告列表
    reports = test_get_reports_list()
    
    # 如果有报告，测试获取详情和访问页面
    if reports:
        # 测试第一个报告
        # 检查报告结构，使用正确的标识符
        test_report = reports[0]
        # 尝试使用id或其他唯一标识符
        test_report_id = test_report.get('id') or test_report.get('report_id') or test_report.get('name')
        if test_report_id:
            test_get_report_details(test_report_id)
            test_view_report_page(test_report_id)
        else:
            print(f"\n⚠️  报告缺少标识符，跳过详情测试: {test_report}")
    else:
        print("\n⚠️  没有报告数据，跳过详情测试")
    
    print("\n=== 测试完成 ===")
