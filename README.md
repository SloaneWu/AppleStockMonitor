# Apple 香港门店库存监控

在 Windows 上运行的 Apple 香港门店库存监控程序，当前版本 **v4.0.1**。完整解压免安装包后双击 `AppleStockMonitor.exe`，无需安装浏览器扩展。项目沿用 GPL-3.0 许可证，与 Apple 官方无隶属关系。

**已知问题：用户反馈连续监控约两小时后再次出现 HTTP 541，具体在用版本与设置待确认，根因尚未确认。** v4.0.1 改善了首次连接流程和诊断，未根治长时间运行后官网拒绝查询的问题。离线测试通过不能代表 Apple 实时服务或连续运行已通过验收，详见 [已知问题与排查](docs/KNOWN_ISSUES.md)。

[下载 Windows v4.0.1 免安装版（预发布）](https://github.com/SloaneWu/AppleStockMonitor/releases/tag/v4.0.1)

## 功能

- 按商品规格及香港门店设置任务，同款所选门店合并查询。
- 保存库存状态、检查历史及库存变化，支持 CSV 导出。
- 独立官网窗口、系统托盘和后台调度；启动默认暂停，默认每 60 秒检查。
- 遇到 541 等拒绝响应时持久暂停；官网恢复后可手动进行单次验证。
- 可选 Bark 到货通知和单件加入购物袋准备，默认关闭。

程序不会自动登录、处理验证码、付款或最终下单。Apple 页面和门店接口可能变化；所附商品目录为历史核验快照，不保证一直有效。

## 安装与升级

适用 Windows 10 / 11 x64。源码仓库本身不包含 EXE 或 Electron 运行时；使用已经发布的免安装包，或按下文自行构建。

1. 将免安装 ZIP 完整解压到可写文件夹，双击 `AppleStockMonitor.exe`。请保留 EXE 旁所有文件。
2. 添加商品和门店，在程序中点击“打开 Apple 官网”，在该窗口查询一次附近门店。
3. 返回点击“连接官网，单次验证”；获得有效结果后，再点击“开始监控”。

升级时先完全退出旧程序，把旧 EXE 旁整个 `Data` 文件夹复制到新 EXE 旁，保留旧目录备份，再启动新版。不要同时运行两个版本。普通 Chrome / Edge 与本程序不共享官网会话。

`Data` 含本机任务、历史和官网会话，也可能含 Bark 密钥，请勿提交仓库或放入共享安装包。完整使用说明见 [Windows 使用说明](Windows使用说明.md)。

## 开发与测试

需要 Node.js 24+、PowerShell，以及下载测试依赖和 Electron 官方运行时所需的网络。成品用户无需安装这些开发工具。

在仓库根目录运行桌面模块测试；监控模块的测试依赖在 `extension` 中安装：

```powershell
node --test tests/*.test.cjs
Set-Location extension
npm install
npm test
npm run check
Set-Location ..
```

下载并校验官方 Windows x64 运行时，再创建免安装目录：

```powershell
node scripts/download-runtime.cjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-portable.ps1
```

运行时默认缓存于 `.cache/electron-runtime`，可用环境变量 `APPLE_STOCK_RUNTIME_CACHE` 指定其他缓存目录。构建产物位于 `dist/AppleStockMonitor-Windows-v<版本号>-portable`，版本号取自 `package.json`；脚本拒绝覆盖已有产物。测试、下载和构建均不需要 Apple 账号或 Bark 密钥。

### EXE 离线自检

在构建出的目录中运行下列命令，将示例测试目录换成一个新的空目录，不能指向真实 `Data`：

```powershell
.\AppleStockMonitor.exe --self-test --self-test-data-dir="C:\Temp\AppleStockMonitor-self-test"
```

自检使用隐藏窗口和模拟响应，禁止访问 Apple / Bark 外部服务，验证窗口隔离、IPC、IndexedDB、库存处理和 541 暂停保护；完成后自动退出，在测试目录保存结果和截图。

[v4.0.1 验收记录](桌面版验收记录-2026-09-26.md) 记录了当时的 183 项模块测试及 11 项 EXE 离线检查。这些是指定版本的历史结果，不是每个后续提交的自动验收证明。真实官网库存、连续监控、Bark 手机收件及购买页面兼容性仍需现场验证。

## 目录结构

| 目录 | 用途 |
| --- | --- |
| `desktop/` | Electron 窗口、权限边界、连接观察、本机存储和桌面接口 |
| `extension/` | 共用库存解析、调度、界面、历史和通知模块及测试 |
| `tests/` | 桌面模块测试 |
| `scripts/` | 官方运行时下载校验和 Windows 便携包构建 |
| `catalog-provenance/` | 商品目录来源、核验记录及核验脚本 |
| `preview/` | 使用模拟数据的界面预览适配器 |
| `docs/` | 已知问题和维护记录 |

桌面壳使用 Electron 44.4.5。官网窗口没有 Node.js 或本机存储接口，查询沿用官网页面会话。连接观察只记录有限的响应元数据，不主动探测，不修改 Cookie，也不会清除已触发的 541 暂停保护。

## 反馈问题

请先阅读 [已知问题](docs/KNOWN_ISSUES.md)。报告故障时说明程序版本、运行时间、商品数量，以及程序内官网能否手动查询门店。可附程序“导出诊断”生成的 JSON；发布前请确认附件中没有个人信息。不要上传 `Data`、Cookie、登录信息或真实通知密钥。

## 许可证与来源

代码使用 [GNU GPL v3](LICENSE)，项目包声明为 `GPL-3.0-only`。本项目衍生自 [Sunbelife/apple-store-helper-15](https://github.com/Sunbelife/apple-store-helper-15) 的浏览器扩展目录；该上游源自 `hteen/apple-store-helper`。上游版本、修改记录和原有图标来源见 [NOTICE](extension/NOTICE.md)。原始许可证保留在 `extension/LICENSE`。

Electron / Chromium 的各自许可证保留在构建出的运行时目录。分发本项目修改版时请一并提供对应源代码并保留相关许可证和声明。
