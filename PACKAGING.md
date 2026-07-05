# Windows EXE 打包说明

本项目已经接入 Electron，可以打包成不依赖 Node.js、npm、Vite 或浏览器环境的 Windows 程序。

## 生成 exe

在项目目录运行：

```bash
npm run dist:win
```

输出目录：

```text
F:\codexCache\outputs\gupiao-release-win7
```

主要文件：

```text
F:\codexCache\outputs\gupiao-release-win7\人工预测走势对比-0.2.0-win7-x64.exe
F:\codexCache\outputs\gupiao-release-win7\人工预测走势对比-0.2.0-win7-ia32.exe
```

这个是 portable 单文件版，可以直接发送给别人。对方电脑不需要安装 Node.js、npm 或浏览器开发环境。

如果对方是 Windows 7 32 位系统，发送 `win7-ia32.exe`。
如果对方是 Windows 7 64 位系统，发送 `win7-x64.exe`。

## 目录版

同时也会生成目录版：

```text
F:\codexCache\outputs\gupiao-release-win7\win-unpacked\人工预测走势对比.exe
F:\codexCache\outputs\gupiao-release-win7\win-ia32-unpacked\人工预测走势对比.exe
```

目录版运行时必须保留整个 `win-unpacked` 文件夹，不能只单独复制里面的 exe。

## 运行要求

- Windows 7/10/11。
- Windows 7 需要使用 Electron 22 构建的 `win7` 版本。
- 电脑需要能联网访问腾讯/东方财富行情接口，否则无法加载最新 K 线数据。
- 本软件未做代码签名，首次运行时 Windows SmartScreen 可能提示风险，需要手动允许。

## 技术说明

- 前端仍然使用 React + Vite 构建。
- 打包后由 Electron 主进程请求腾讯/东方财富行情接口，不再依赖 Vite 本地代理。
- 用户录入的预测数据仍然自动保存在当前电脑本地缓存中。
- 0.2.0 开始，打包后的 exe 会优先检查 `https://nhtqgm.github.io/111/version.json`。如果 GitHub Pages 上有可用网页版本，就加载远程网页；如果远程不可用，则自动回退到 exe 内置网页。
- 后续只修改界面、MA40 计算逻辑、表格显示等前端功能时，推送到 GitHub 并完成 Pages 部署即可，不需要重新发送 exe。
- 如果修改 Electron 主进程能力，例如行情接口、Win7 兼容层、文件系统能力，仍然需要重新打包并发送 exe。
