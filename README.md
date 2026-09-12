# Zenith Tabletop 3D · 巅峰棋道

在一间温暖的木质棋室里与 AI 对弈。棋盘、棋罐、机械钟、沙漏、古籍和记谱册都是真正可操作的 3D 道具；桌边铭牌提供鼠标与触屏共用的入口。

**仓库：[SSC-STUDIO/Zenith-Tabletop-3D](https://github.com/SSC-STUDIO/Zenith-Tabletop-3D)**

## 快速开始

需要 Node.js 22.12 或更高版本，以及支持 WebGL 的现代浏览器。

```sh
npm ci
npm run dev
```

访问 http://localhost:5173。仓库已包含约 64 MB 的精选模型、材质和字体，运行时不必在线下载。

```sh
npm run serve          # 无打包静态开发服务，默认 8080
npm run build          # 输出 dist/
npm run preview        # 预览生产构建
npm test               # 规则、AI、镜头、动作、识图与存局测试
npm run smoke          # 完整对局与道具流程，Chrome/Edge 无头浏览器
npm run test:features  # 鼠标/触屏、复盘、旧动画取消、手机菜单和刷新续局
npm run test:production # 仓库子路径下的生产包及 AI Worker 验证
```

浏览器验证脚本使用 Node 原生 WebSocket，可通过 `BROWSER_PATH` 指定 Chrome 或 Edge。截图保存在被 Git 忽略的 `_tmp_*` 目录。

## 已实现的对局功能

- 标准五子棋与连珠禁手规则；黑白选边，人机对弈，AI 搜索深度 2–5。
- 不计时、5 / 10 / 20 分钟对局；暂停、恢复、超时、认输、胜负仪式与再战。
- 沙漏悔棋，连带收回 AI 应手；毛笔书写本地战术提示，可选接入远程导师。
- 人物取子、落子、记谱、沉思和终局行礼；空间音效、棋子弹跳与获胜连线。
- 可逐手前后查看的复盘：起始局面、上一手、下一手、末手，保留初始摆子，后续着法显示为淡子。进入时暂停 AI 和计时，离开后按原状态恢复。
- 自动存局：保存规则、执子、初始局面、完整着法、剩余用时及不计时局的已用时；重新打开后可继续上次棋局，离线期间不扣时。切到后台会暂停。
- 导出 JSON 棋谱；从图片、JSON 或 15 行文本复原可继续的局面，支持网格角点校正、逐点修正和旋转。
- 首次入座导览；鼠标拖动环视、滚轮缩放，触屏单指环绕与双指缩放。

## 桌案操作

| 操作 | 3D 入口 | 键盘 |
| --- | --- | --- |
| 选边 / 再战 | 黑白棋罐，或铭牌「执黑」「执白」 | — |
| 落子 | 棋盘交点；「俯览」可切到更清楚的棋盘视角 | — |
| 暂停 / 恢复 | 对局钟侧边扳手，或铭牌 | 空格 |
| 悔棋 | 沙漏，或铭牌「悔棋」 | Z |
| 提示 | 古籍，或铭牌「请教」 | H |
| 复盘 | 铭牌「棋谱」；记谱册点某一手可定位 | ← / → / Home / End |
| 退出复盘 / 视角回正 | 铭牌「返回对局」或空白桌面 | 复盘中 Esc |
| 设置、存谱、复原、认输、新局 | 铭牌「设置」 | Esc |

主视角会完整呈现棋盘和操作铭牌，靠近人物头部时隐藏挡住镜头的头身网格；竖屏使用俯视布局。对弈时 DOM 只保留 WebGL 画布；导览、复原提示、终局提示及设置页按需显示。

## 画面与模型

Three.js 渲染棋室和动态道具。双方棋手使用 Kay Lousberg 的 KayKit Rogue / Mage 骨骼人物模型，按棋手比例调整坐姿，实时跟随取子、落子、记谱、沉思和行礼动作，移除武器与高帽。木扶手椅、旧书、坐凳、茶几、青花茶具、花瓶、盆栽来自 Poly Haven；PBR 木纹、皮革、织物和 HDRI 同源。模型均采用 CC0 许可；马善政体和志莽行书使用 OFL 许可。来源及修改说明见 [素材清单](docs/ASSET_CREDITS.md)，原始许可随资源保留。

模型加载成功后才隐藏相应的程序化道具。旧书只使用三本模型，避免整套 20 本书带来的额外绘制。可执行 `npm run assets` 补齐缺失资源；加 `-- --force` 可重新下载。

支持自动、精致、流畅三档画质。包含软阴影、IBL、抗锯齿、可选泛光、动态分辨率和空闲降频。AI 搜索放在 Worker 中，已落定棋子采用实例化绘制。`?debug=1` 显示帧率、绘制次数、分辨率与 GPU；`npm run perf` 生成本机性能数据。

## 构建与发布

`dist/` 是完整的静态站点，可部署在域名根路径或 `/Zenith-Tabletop-3D/` 这样的仓库子路径。模型、字体、纹理和 AI Worker 都按部署路径加载。

GitHub Actions 在推送及 PR 时执行测试、构建和浏览器验证。另提供手动的 `Publish Zenith to Pages` 工作流：在仓库 Settings → Pages 中选择 GitHub Actions 后，可手动运行它发布 `dist/`。

## 可选远程导师

默认提示与图像识别均在本机执行。部署者可在加载入口脚本前设置：

```js
window.ZENITH_CONFIG = {
  llm: { endpoint: '/your-proxy/chat/completions', model: 'your-model', visionModel: 'your-vision-model' }
};
```

推荐点仍由本地搜索产生，远程服务用于评语或可选云端识图。通过服务端代理保管密钥；网络失败时回退本地短评。

## 工程结构

- `src/core/`：无 DOM / Three.js 的规则、不可变状态机和 AI。
- `src/spatial/`：棋室、人物、交互道具、拾取、镜头与光照。
- `src/services/`：AI Worker、音频、资源、识图、导师与本地存局。
- `src/ui/`：开始页、导览、设置和局面导入。
- `tests/`、`tools/`：单元测试、浏览器验证与资源下载工具。

[开发状态与验证范围](docs/DEVELOPMENT_PLAN.md) · [道具动效设计](docs/DIEGETIC_UI_SPEC.md)
