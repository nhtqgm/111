# 人工预测走势对比

这是一个用于 A 股 K 线人工预测和均线反推的桌面/网页工具。当前默认股票示例为申万宏源 `000166`，支持日K、周K、月K，用户输入预测 MA 值后，系统反推出预测收盘价，并继续计算预测 MA5 / MA10 / MA20 / MA40 / MA60，用来和真实 K 线走势做对比。

> 说明：本项目只用于个人分析和预测复盘辅助，不构成任何投资建议。

## 当前稳定版能力

- 支持日K、周K、月K切换。
- 支持股票代码查询，默认 `000166`。
- 支持联网更新历史 K 线，也支持离线读取本地缓存。
- 行情数据源带自动兜底：
  - 腾讯不复权
  - 腾讯前复权
  - 腾讯后复权
  - 东方财富不复权
  - 东方财富前复权
  - 东方财富后复权
- 自动过滤未完成的 K 线周期：
  - 日K：当天 15:10 后才算完成。
  - 周K：周五 15:10 后或周末才算完成。
  - 月K：当月最后一个交易日 15:10 后才算完成。
- 预测起点自动使用最新已完成周期，避免把未完成的当天、本周、本月错误纳入计算。
- 支持选择输入预测 MA5 / MA10 / MA20 / MA40 / MA60。
- 根据输入的预测 MA 自动反推预测收盘价。
- 自动计算预测 MA5 / MA10 / MA20 / MA40 / MA60。
- 图表可选择显示哪些预测均线。
- 可切换是否显示真实 K 线和真实均线；只看预测线时会隐藏真实 K 线。
- 预测收盘价以醒目的黄色点显示，不连线。
- 每行支持打开“计算明细”，查看反推收盘价和各 MA 的计算过程。
- 预测数据自动保存在本机缓存中。
- 支持手动保存，并每 30 秒自动保存一次。
- 支持导入/导出 JSON 预测方案。
- 支持 GitHub Pages 网页版、Windows EXE、Android APK 云端打包。

## 核心计算逻辑

用户输入的是某一个窗口的预测 MA，例如预测 MA40。系统先反推当前周期的预测收盘价：

```text
反推收盘价 = 预测MA40 × 40 - 前39个周期收盘价之和
```

如果输入的是 MA20，则公式对应变成：

```text
反推收盘价 = 预测MA20 × 20 - 前19个周期收盘价之和
```

得到当前反推收盘价后，系统再计算其他均线：

```text
MA5  = (当前反推收盘价 + 前4个周期收盘价之和) / 5
MA10 = (当前反推收盘价 + 前9个周期收盘价之和) / 10
MA20 = (当前反推收盘价 + 前19个周期收盘价之和) / 20
MA40 = (当前反推收盘价 + 前39个周期收盘价之和) / 40
MA60 = (当前反推收盘价 + 前59个周期收盘价之和) / 60
```

历史段只使用真实收盘价；预测段会使用已经反推出的预测收盘价继续滚动计算。图上的预测均线会从最后一个真实均线点接上。

## 计算明细

右侧预测表每一行都有“明细”按钮。打开后可以查看：

- 当前输入的预测 MA。
- 前 N-1 个周期参与反推的收盘价。
- 反推收盘价公式。
- MA5 / MA10 / MA20 / MA40 / MA60 的逐项计算。
- 每个参与值的来源：真实或预测。

这个功能用于核对“先加完再除”的均线计算过程，避免公式变成黑箱。

## 数据保存

预测数据会自动保存到当前电脑的浏览器/Electron 本地缓存。刷新页面、关闭软件、重启电脑后，通常会自动恢复上次工作状态。

缓存内容包括：

```text
股票代码
日K / 周K / 月K
当前预测输入窗口
未来目标周期
预测 MA 输入值
备注
本地历史 K 线缓存
上次工作区
```

每台电脑的缓存互相独立。把 EXE 发给别人后，对方录入的数据会保存在对方自己的电脑上。

如果需要迁移预测方案，可以使用右侧预测面板的：

```text
导出
导入
```

## 数据更新方式

点击“联网更新”时，系统会重新拉取最近历史 K 线，并保存到本地缓存。

如果联网失败：

- 已有本地缓存时，继续使用本地缓存。
- 没有本地缓存时，页面会提示需要联网更新。

Windows EXE 中的行情请求由 Electron 主进程发起；网页版和 Android 版会直接使用前端/Capacitor 请求。

## 网页版部署

正式网页地址：

```text
https://nhtqgm.github.io/111/
```

`main` 分支推送后，会通过 `.github/workflows/pages.yml` 自动构建并部署到 GitHub Pages。

当前还有一个隔离预览分支：

```text
codex-replay-review-v1
```

该分支用于验证“预测复盘”功能，不属于当前稳定版 main。预览部署计划放在：

```text
https://nhtqgm.github.io/111/preview/codex-replay-review-v1/
```

注意：GitHub Pages 的 `github-pages` 环境需要允许 `codex-replay-review-v1` 分支部署，否则该分支的预览 workflow 会被环境保护规则拒绝。

## Windows EXE

项目已经接入 Electron，可以打包成 portable 单文件 EXE。对方电脑不需要安装 Node.js、npm、Vite 或浏览器开发环境。

打包命令：

```bash
npm run dist:win
```

输出目录：

```text
F:\codexCache\outputs\gupiao-release-win7
```

主要产物：

```text
人工预测走势对比-0.2.6-win7-x64.exe
人工预测走势对比-0.2.6-win7-ia32.exe
```

发送建议：

- 64 位 Windows：发送 `win7-x64.exe`。
- 32 位 Windows / 老机器：发送 `win7-ia32.exe`。

EXE 启动逻辑：

1. 先检查 `https://nhtqgm.github.io/111/version.json`。
2. 如果线上网页可用，则加载 GitHub Pages 最新网页版。
3. 如果没网或线上不可用，则回退到 EXE 内置页面。

因此，只修改前端页面、样式、计算展示等内容时，部署 GitHub Pages 后，旧 EXE 在有网络的情况下通常会加载到最新页面。  
但如果修改 Electron 主进程、Win7 兼容、窗口能力、文件系统能力或打包配置，仍然需要重新打包 EXE 再发送。

## Android APK

项目已经接入 Capacitor，可以用 GitHub Actions 云端打包 Android APK，本机不需要 Android Studio。

使用方式：

1. 打开 GitHub 仓库的 `Actions`。
2. 选择 `Build Android APK`。
3. 点击 `Run workflow`。
4. 完成后在 `Artifacts` 下载 `gupiao-android-debug-apk`。
5. 解压后得到 `app-debug.apk`。

这是 debug APK，适合测试和内部使用。手机安装时可能需要允许“安装未知来源应用”。

## 本地开发

Windows 上可以直接双击：

```text
start-gupiao.cmd
```

也可以手动运行：

```bash
npm install
npm run dev
```

打开：

```text
http://localhost:5173/
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Vite 开发服务器 |
| `npm run build` | TypeScript 检查并构建网页产物 |
| `npm run verify:ma` | 验证 K 线周期过滤和 MA 反推计算 |
| `npm run preview` | 预览生产构建 |
| `npm run electron:dev` | 构建后用 Electron 本地运行 |
| `npm run dist:win` | 打包 Windows portable EXE |
| `npm run android:sync` | 构建网页并同步 Capacitor Android 工程 |

## 项目结构

```text
src/
  App.tsx                    主界面、输入表、保存、图表组合
  components/KLineChart.tsx  ECharts K线和均线图
  services/eastmoney.ts      网页/安卓端行情数据请求与多数据源兜底
  utils/movingAverage.ts     MA反推、预测收盘价、预测均线计算
  utils/completedPeriods.ts  日/周/月K完成周期过滤
  utils/predictions.ts       预测数据、本地缓存、导入导出
  utils/metrics.ts           当前预测误差统计
electron/
  main.cjs                   Electron 主进程、远程网页加载、行情请求兜底
  preload.cjs                Electron 安全桥接
.github/workflows/
  pages.yml                  GitHub Pages 部署
  android-apk.yml            Android APK 云端打包
```

## 当前分支说明

- `main`：稳定版，GitHub Pages 正式站点来源。
- `codex-replay-review-v1`：预测复盘实验分支，已隔离开发，不影响 `main`。

复盘分支的目标是：保存预测快照，在未来真实 K 线出来后自动比较预测收盘价、真实收盘价、MA5/10/20/40/60 误差和方向命中率。该功能尚未合并到稳定版。
