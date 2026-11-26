# 包装审查工作台（v0.5.0）

面向**普通食品（GB 7718）**与**宠物饲料（农业农村部标签规定）**的本地包装审查辅助工作台。在高清完整展开稿上完成本机 OCR、受约束视觉 Agent 预审、配料/饲料目录查证、配方活菌数及成分对照与专利核对，再由审查员逐条编辑、确认、排除或手动画框，导出**直接带标注编号和底部意见的完整回稿 PNG**及**人工修改清单 Markdown**。

## 快速开始

1. 安装 **Node.js 24+**。源码运行请先执行 `npm ci`，再执行 `npm start`（或 Windows 直接双击 `start.cmd`）。
2. 打开 `http://127.0.0.1:8774/`（可用 `node server.mjs 8800` 指定端口）。界面自带虚构样稿；可导入 `sample.jpg` 并关联 `sample-formula.xlsx` 体验配方与正背面品名比对。
3. 支持 **PNG / JPG / PDF**（导入 PDF 需系统 PATH 中具备 Poppler 的 `pdfinfo` 和 `pdftoppm`，可通过 `PACKAGING_MAX_PDF_PAGES` 调整页数上限，默认 8 页、最高 32 页）。
4. 增强 OCR：Windows 默认可直接使用系统简体中文 OCR；运行 `install-ocr.cmd` 可在本机安装 **PP-OCRv6 medium（RapidOCR + OpenVINO）**。服务端采用**常驻工作进程**复用已加载的 OCR 模型（闲置 5 分钟自动释放内存），避免重复冷启动。非 Windows 系统可通过 `PACKAGING_OCR_PYTHON` 指定已安装 `rapidocr` 的 Python 路径。

## 模型配置（支持 MS_LLM 及任意 OpenAI 兼容多模态模型）

将 `模型配置.example.json` 复制为 `模型配置.json`（或通过环境变量 `PACKAGING_MODEL_CONFIG` 指定路径），重启工作台即可生效：

- **单一多模态模型（含内网 `MS_LLM`、本地 Qwen-VL / Ollama、或远程 HTTPS 多模态 API）**：填写 `文本模型` 即可。`模型名称` 为 `MS_LLM` 时默认开启多模态视觉与专用兼容参数；其他多模态模型只需添加 `"支持视觉": true`。
- **文本模型 + 视觉模型分离配置**：同时填写 `文本模型` 与 `视觉模型` 区块，视觉预审/字形确认/原图小字复读自动走 `视觉模型`。
- **安全与隐私护栏**：本机及 RFC1918 内网私有地址支持 HTTP 直连；公网远程地址强制要求 HTTPS，并在提交 OCR 文字或压缩原图前由浏览器弹出目标主机确认框。
- 可选配置项：`"兼容模式": "auto" | "ms_llm" | "standard"`、`"最大输出Token": 8000`（范围 256–32768）。

## 多稿件管理与跨设备备份

- 每次导入新稿件都会在浏览器 IndexedDB 中**新建独立项目**，不再覆盖旧稿；旧版草稿自动无损迁移。
- 点击顶部「稿件」可切换历史稿件、重命名、删除，或将当前稿件（含原图、OCR、人工批注与 Agent 轨迹）导出为 `.workbench.json` 工程备份文件，在任意电脑或端口重新导入继续审查。
- 顶部支持按稿件切换品类：**自动识别 / 普通食品 / 宠物饲料**，同步切换 GB 7718 与宠物饲料基础标识交接清单及本地名称目录。

## 本地目录与专利台账

- **普通食品目录**：随包内置新食品原料（含适用人群与食用量提示）、可食用菌种与 GB 2760 / GB 14880 添加剂名称索引。
- **宠物饲料目录**：随包内置《饲料原料目录》与《饲料添加剂品种目录》（2026-05 版）索引，以及带公开目录引证的通用规范化规则与类别名称识别。
- **本地专利台账**：默认为空。将 `patent-register.example.json` 复制为 `patent-register.local.json`，在 `patents` 数组中维护本单位 `no`、`strains` 与 `certificate` 记录即可启用自动对照。

## 目录结构与测试

- 后端与工具：`server.mjs`、`ai.mjs`、`model-config.mjs`、`ocr-worker.mjs`、`ocr_paddle.py`、`ocr.ps1`、`formula.mjs`、`read-formula.mjs`、`cfu.mjs`、`food-catalog.mjs`、`pet-catalog.mjs`
- 领域规则与编排（Node 与浏览器共享）：`rules.mjs`、`review.mjs`、`agent.mjs`、`patents.mjs`、`preflight-engine.mjs`
- 前端模块（原生 ESM，零构建）：`index.html`、`style.css`、`app.mjs`、`web/utils.mjs`、`web/storage.mjs`、`web/viewer.mjs`
- 运行完整自动化测试：`npm test`（或 `node --test`）。
