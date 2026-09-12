# Zenith Tabletop 3D 素材来源

本仓库附带的美术资源约 64 MB，克隆后可直接使用。模型来自 KayKit 和 [Poly Haven](https://polyhaven.com)，贴图和环境图来自 Poly Haven，均按 CC0 发布，可用于修改、再分发及商业项目。下载原文件保留在 `public/assets/`；`tools/assets.manifest.json` 记录下载规格，`public/assets/manifest.json` 列出逐项来源。

| 模型 | 场景用途 | 来源与许可 |
| --- | --- | --- |
| KayKit Rogue / Mage | 玩家与 AI 棋手，骨骼重定向到坐姿和交互动作 | [Kay Lousberg · CC0](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0/tree/672074b73ba276876a19e8816ecdc5241817ab47) |
| Chinese Armchair | 棋室后侧的木扶手椅 | [Poly Haven · CC0](https://polyhaven.com/a/chinese_armchair) |
| Book Encyclopedia Set 01 | 棋案左侧的三本旧书，选取前三本并平放 | [Poly Haven · CC0](https://polyhaven.com/a/book_encyclopedia_set_01) |
| Chinese Stool | 两侧棋手坐凳 | [Poly Haven · CC0](https://polyhaven.com/a/chinese_stool) |
| Chinese Tea Table | 右侧茶几 | [Poly Haven · CC0](https://polyhaven.com/a/chinese_tea_table) |
| Tea Set 01 | 茶几上的青花茶具 | [Poly Haven · CC0](https://polyhaven.com/a/tea_set_01) |
| Antique Ceramic Vase 01 | 棋室青花落地瓶 | [Poly Haven · CC0](https://polyhaven.com/a/antique_ceramic_vase_01) |
| Potted Plant 01 | 棋室盆栽 | [Poly Haven · CC0](https://polyhaven.com/a/potted_plant_01) |

木纹、皮革、天鹅绒、地板、麻布、灰泥及 Pine Attic / Fireplace 环境图同样采用 Poly Haven CC0 资源。模型使用 1K 贴图，棋盘与桌面使用 2K 贴图。书册仅实例化三本以控制绘制开销。

KayKit 人物取自官方 Adventurers Character Pack 1.0，固定版本 `672074b73ba276876a19e8816ecdc5241817ab47`。GLB 内含贴图；原始许可保存在 `public/assets/models/kaykit/LICENSE.txt`。程序在运行时调整头身和四肢比例、坐姿及手部目标，隐藏武器、高帽等冒险附件，保留衣服和披风；原模型文件未经修改。第一人称隐藏自身头身和腿部，手臂保持可见。

马善政体（Ma Shan Zheng）和志莽行书（Zhi Mang Xing）来自 [Google Fonts](https://github.com/google/fonts)，采用 SIL Open Font License 1.1。完整许可分别保存在 `public/assets/fonts/*-OFL.txt`。

`npm run assets` 可补齐缺失资源；`npm run assets -- --force` 可重新下载。模型加载及骨骼校验成功后才隐藏对应的程序化道具或人物，下载失败时保留原有布景。交互棋盘、时钟、沙漏、棋谱、印章和动作系统由项目代码生成。
