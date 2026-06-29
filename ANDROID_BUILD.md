# Android APK 云端打包说明

本项目已经接入 Capacitor，可以通过 GitHub Actions 在云端打包 Android APK。你的本机不需要安装 Android Studio 或 Android SDK。

## 使用方式

1. 把当前项目推送到 GitHub 仓库。
2. 打开仓库页面的 `Actions`。
3. 选择 `Build Android APK`。
4. 点击 `Run workflow`。
5. 等待任务完成后，在页面底部的 `Artifacts` 下载：

```text
gupiao-android-debug-apk
```

下载后里面会有：

```text
app-debug.apk
```

把这个 APK 发给安卓手机安装即可。

## 注意

- 这是 debug APK，适合测试和内部使用。
- 安卓手机安装时可能需要允许“安装未知来源应用”。
- 手机需要联网访问东方财富接口，否则无法加载 K 线数据。
- Android 版使用 Capacitor 原生 HTTP 请求东方财富接口，不依赖电脑上的 Vite 代理。

## 本地生成 Android 工程

已经生成了：

```text
android/
```

本机没有 Android 环境也没关系，GitHub Actions 会在云端执行：

```bash
npm ci
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
```
