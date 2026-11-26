# 包装审查工作台

在完整展开稿上做 OCR、核对配料和配方、标记修改意见，再导出带批注的整版 PNG 和修改清单。审查员可以确认、排除或重画标框，也可以直接添加批注。

## Windows 快速试用

1. 从 GitHub Releases 下载并解压 Windows ZIP，安装 Node.js 24 后双击 `start.cmd`。从源码运行时，先执行 `npm ci`，再执行 `npm start`。
2. 打开 `http://127.0.0.1:8774/`。界面自带一张虚构样稿。若要试配方比对，先用「导入完整稿」导入 `sample.jpg`，再关联 `sample-formula.xlsx`。样稿有一处正背面品名差异和一处活菌数与配方差异，可对照原图查看结果。
3. 点击疑点定位原稿，直接编辑意见并确认，或在画布上新增标注。完成后点击「导出完整回稿」。稿件和意见保存在当前浏览器。

Windows 简体中文 OCR 可直接使用。增强识别可运行 `install-ocr.cmd` 安装 PP-OCRv6 运行环境，需要 Python 和网络下载。导入 PDF 需要把 Poppler 的 `pdfinfo`、`pdftoppm` 加入 `PATH`。

## 配置模型和资料

- 将 `模型配置.example.json` 复制为 `模型配置.json`，填写自己的接口地址、模型名及所需密钥，重启工作台。视觉预审需要可访问的 `MS_LLM` 兼容接口，图片和 OCR 会发送到配置的模型地址。工作台的模型输出上限为 8000 token。
- 名称查证使用随包提供的食品和饲料目录名称索引。用法和适用范围请核对原始目录及项目材料，查询命中只提供名称证据。
- 专利台账可在本机配置。将 `patent-register.example.json` 复制为 `patent-register.local.json`，在 `patents` 数组中为每条填入 `no`、`strains`（字符串数组）和 `certificate`，其余证据由审查员补核。默认台账为空。

发布包提供虚构演示素材、目录名称索引、配置模板及可运行的工作台。`npm test` 可运行源码测试。
