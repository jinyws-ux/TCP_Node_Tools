### 问题分析
经过仔细检查，我找到了report_viewer.html中导致JavaScript报错的具体问题：

### 1. 前50行的错误
**问题1**：第26行 - URL路径处理不当
- 当URL路径以斜杠结尾时（如 `/reports/123/`），`split('/')`会产生空字符串作为最后一个元素
- 这会导致`reportId`被赋值为空字符串，从而触发"缺少报告ID"错误

**问题2**：第29行和第34行 - 模板语法处理错误
- `reportId === '{{ report_id }}'` 是Jinja2模板语法，在浏览器中会被视为普通字符串比较
- 这会导致报告ID被错误地判断为无效，因为浏览器会将`{{ report_id }}`视为字面字符串

### 2. exportPureReport方法的错误
**问题3**：第587行 - 可选链操作符兼容性问题
- 使用了可选链操作符 `?.` （`a.download = `${reportData?.name || '报告'}_pure.html``）
- 这在一些旧浏览器中不支持，会导致JavaScript语法错误

### 修复方案

**修复1**：改进URL路径处理逻辑
```javascript
// 从URL路径中获取报告ID
const pathParts = window.location.pathname.split('/').filter(Boolean); // 过滤空字符串
reportId = pathParts[pathParts.length - 1];
```

**修复2**：移除错误的模板语法比较
```javascript
// 如果URL路径中没有报告ID，尝试从URL查询参数获取
if (!reportId || reportId === '') {
    const params = new URLSearchParams(window.location.search || '');
    reportId = params.get('report_id') || params.get('id');
}

if (!reportId || reportId === '') {
    showError('缺少报告ID');
    return;
}
```

**修复3**：替换可选链操作符为传统的空值检查
```javascript
a.download = `${reportData && reportData.name ? reportData.name : '报告'}_pure.html`;
```

### 修复效果
- 消除所有JavaScript语法错误和运行时错误
- 提高代码的浏览器兼容性
- 确保报告ID能正确从URL中提取
- 确保导出功能在所有浏览器中都能正常工作

### 修复范围
仅修改 `web/templates/report_viewer.html` 文件，不涉及其他文件。