# Windows EXE 打包说明

本项目已经接入 Electron，可以打包成不依赖 Node.js、npm、Vite 或浏览器环境的 Windows 程序。

## 生成 exe

在项目目录运行：

```bash
npm run dist:win
```

输出目录：

```text
F:\codexCache\outputs\gupiao-release
```

主要文件：

```text
F:\codexCache\outputs\gupiao-release\人工预测走势对比-0.1.0-x64.exe
```

这个是 portable 单文件版，可以直接发送给别人。对方电脑不需要安装 Node.js、npm 或浏览器开发环境。

## 目录版

同时也会生成目录版：

```text
F:\codexCache\outputs\gupiao-release\win-unpacked\人工预测走势对比.exe
```

目录版运行时必须保留整个 `win-unpacked` 文件夹，不能只单独复制里面的 exe。

## 运行要求

- Windows x64 系统。
- 电脑需要能联网访问东方财富接口，否则无法加载最新 K 线数据。
- 本软件未做代码签名，首次运行时 Windows SmartScreen 可能提示风险，需要手动允许。

## 技术说明

- 前端仍然使用 React + Vite 构建。
- 打包后由 Electron 主进程请求东方财富接口，不再依赖 Vite 本地代理。
- 用户录入的预测数据仍然自动保存在当前电脑本地缓存中。
