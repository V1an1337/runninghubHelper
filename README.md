# runninghubHelper

本项目是一个 RunningHub 的本地辅助工具集合，包含：

- `runninghub.js`：Tampermonkey 脚本（RunningHub 页面内抓包/模板/资源库增强）
- `webapp/`：本地 Web 应用（模板库、cookies profile 管理、资源上传、并发生成、任务队列、下载与解压、预览）

## 安装插件（用于获取模板）

### 一键安装（推荐）

- 安装链接：[runninghub.user.js](https://github.com/V1an1337/runninghubHelper/raw/refs/heads/main/runninghub.user.js)

## 快速开始（本地 Web）

### 1) 安装依赖 并 启动

建议使用虚拟环境：

```powershell
cd e:\V1an\Visual Studio\Project\runninghubHelper
python -m venv .venv
.\.venv\Scripts\pip install -r requirements-webapp.txt
.\.venv\Scripts\python .\run_webapp.py
```

或直接：

```powershell
pip install -r requirements-webapp.txt
python .\run_webapp.py
```

启动后访问：

- http://127.0.0.1:8787

## 功能说明

### 模板（Templates）

- 导入/导出/编辑 create payload
- `inputs[]` 支持可视化表格渲染与编辑

### Cookies（Profiles）

- 导入 `cookies.txt`（单条）或 `multicookies.txt`（多条）格式
- 每条 cookies 支持刷新 `totalCoin`（余额/积分），用于生成页下拉框展示

### 资源库（Resources）

- 通过 RunningHub `upload/image` 接口上传任意文件
- 记录返回的 `name`，用于在生成时替换上传字段
- 服务器端会在 `webapp/resource_files/` 额外保存一份上传文件，方便 Web 页面内嵌预览

### 生成（Generate）

- 选择模板 + cookies profile，编辑本次 payload 后一键生成
- 生成不阻塞主进程，可并发多个任务
- 若 cookies 正被运行/排队任务占用，会在下拉框中隐藏

### 任务（Jobs）

- 展示任务状态、日志
- 若产出为 `.zip` 会自动解压

### 下载（Downloads）

- 列出 `webapp/downloads/` 下所有文件
- 图片/音频/视频直接在表格内嵌预览

### 设置（Settings）

- 任务超时（默认 10 分钟）、history 轮询间隔、单次请求超时等

## 目录结构

- `run_webapp.py`：启动 FastAPI/uvicorn
- `webapp/app.py`：后端 API（templates/cookies/resources/jobs/downloads/settings 等）
- `webapp/static/`：前端页面
- `webapp/data/`：本地持久化数据（通常被 `.gitignore` 忽略）
- `webapp/downloads/`：下载产物（通常被 `.gitignore` 忽略）
- `webapp/resource_files/`：上传文件的本地副本（通常被 `.gitignore` 忽略）

## 安全提示

- cookies/localStorage 中包含敏感信息（token、登录态）。请勿分享给不可信的人。

## 常见问题

- 启动提示缺少依赖：按 README 的 `pip install -r requirements-webapp.txt` 安装即可。
- 端口被占用：修改 `run_webapp.py` 里的 `port=8787`。
