# Android APK

Zenith Tabletop 3D 的 Android 版将生产网页、人物、家具、纹理、字体和 AI Worker 全部装入 APK。正常对弈、提示、复盘、存局和图片局面导入均可离线使用，无须登录。未内置远程 AI 服务或密钥。

## 安装与使用

支持 Android 7.0（API 24）及以上，设备需要 OpenGL ES 3.0 和较新的 Android System WebView。建议使用 Android 10 及以上，保持系统 WebView 更新。自动画质在触屏设备选择“流畅”，可在设置中调整；实际帧率取决于设备 GPU。

下载本项目 GitHub Releases 中的 APK，在手机上打开并允许当前下载应用安装它。包名为 `com.sscstudio.zenithtabletop3d`。更新时直接安装同签名的新版，避免卸载造成存局丢失。

- 横竖屏随系统旋转，画面避开状态栏、刘海和系统导航区域。
- 轻点棋罐选色、棋盘落子；单指拖动环视，双指缩放。
- 系统返回键：退出导入/复盘/教程、打开或关闭对局菜单；在开始页按返回退出应用。
- 切后台保存并暂停；返回后点“继续对弈”，离开期间不扣时。
- 菜单“保存棋谱”打开 Android 系统分享面板，将 JSON 文件保存到支持接收文件的应用，再从局面导入选择该文件。
- 棋局和设置保存在应用私有存储，未启用系统云备份；卸载或清除数据会删除存局。重要棋谱请导出。

## 本地构建

需要 Node.js 22.12+、JDK 21、Android SDK（platforms;android-36、build-tools;36.0.0、platform-tools），并接受 Android SDK 许可。设置 `JAVA_HOME`、`ANDROID_HOME`。

```sh
npm ci
npm test
npm run android:apk
```

构建脚本依次执行生产构建、Capacitor 同步、`assembleRelease`、`lintRelease`、APK 签名校验及 SHA-256 校验文件生成。输出：

```text
artifacts/android/Zenith-Tabletop-3D-0.1.0.apk
artifacts/android/Zenith-Tabletop-3D-0.1.0.apk.sha256
```

也可用 `npm run android:open` 打开 Android Studio。已有图标随源码提供，无须重新生成；改品牌图标后可执行 `node tools/android/icons.mjs`（需要 Chrome 或 Edge）。

本机独立工具安装于 `~/.cache/zenith-android/`，构建脚本可自动发现其中的 JDK 和 SDK，不改系统 Java 配置。

部分 Windows Insider 版本会在 Java 的 Unix-domain loopback 连接处报 `Invalid argument: connect`。本机通过给构建进程设置 `JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=<一个不存在的目录>`，让 JDK 回退到 TCP loopback 后完成构建；不要创建该目录。下载代理也只需为当前 Java 构建进程设置，无须修改项目仓库地址或系统网络。

## 发布签名与更新

首次本地发布构建会创建专用 RSA 3072 位签名，在后续构建中复用。密钥和凭据存放在 **`~/.local/share/zenith-tabletop-3d/signing/`**，不会提交到 Git；请备份整个目录，丢失签名将无法覆盖升级已安装版本。不要把密钥或 `release.json` 放进公开附件。

已有签名或 CI 可设置以下环境变量，覆盖本地签名配置：

```text
ZENITH_STORE_FILE
ZENITH_STORE_PASSWORD
ZENITH_KEY_ALIAS
ZENITH_KEY_PASSWORD
```

发布时更新 `package.json` 的版本号，并递增 `android/app/build.gradle` 的 `versionCode`。发布 APK 禁用 WebView 调试，不使用开发服务器或外部网页地址。Debug 包带 `.debug` 后缀，可与发布版并存。

GitHub 的 Android 工作流生成仅用于测试的 Debug APK；正式发布必须使用同一发布密钥构建。网页和移动端共享游戏代码。

## 验证

2026-09-12：194 项单元测试及网页生产包验证通过；Android 15 模拟器 / WebView 124 已实际验证离线启动、触屏落子与 AI 应手、返回键、系统棋谱分享、后台暂停、横竖屏和重启续局。发布 APK 通过签名检查，包含全部生产资源且未开启调试。Android 应用 Lint 为 0 错误、2 项提示（Gradle 可更新及 Capacitor 动态读取的生成配置资源）。

```sh
npm test
npm run test:production
cd android
./gradlew :app:assembleDebug :app:lintDebug
cd ..
node tools/android/verify-device.mjs
```

设备验证工具默认只连接 `emulator-5556`，安装 Debug 包并清除该测试包数据。可设置 `ZENITH_ANDROID_SERIAL` 指定其他专用模拟器。它检查离线冷启动、下载模型、触屏落子和 AI、返回键、后台暂停、系统分享、存局重启和旋转，将截图与报告写入 `artifacts/android/`。真实手机的兼容性和性能仍需按机型测试。
