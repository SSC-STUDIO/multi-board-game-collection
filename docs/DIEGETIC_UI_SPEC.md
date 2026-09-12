# 《Zenith-Tabletop-3D》实体化 3D UI 规格与物理动效白皮书

> **文档标识**：`SPEC-DIEGETIC-UI-V1`  
> **设计目标**：对 3D 空间内所有拟真交互道具的几何构型、材质参数、动态纹理生成管线以及物理动效曲线进行严密的形式化规范。

---

## 1. 实体一：双面机械对局钟 (Dual Mechanical Chess Clock)

### 1.1 几何体与材质构成
- **箱体外壳**：倾斜 15° 的倒角立方体（Beveled Box），采用老红木（Rosewood）高精 PBR 贴图，粗糙度 $0.35$，金属度 $0.05$。
- **表盘双视窗**：两个内嵌圆形凹槽，直径各为 $1.2$ 单位，间距 $1.4$ 单位。外框镶嵌拉丝黄铜圆环（Brushed Brass，粗糙度 $0.25$，金属度 $0.95$）。
- **顶部机械翘板杠杆**：金属杠杆连接中轴，黑白双方各自对应一侧。倾角范围为 $[-8^\circ, +8^\circ]$。
- **侧边黄铜机械制动扳手**：突出箱体侧边 $0.4$ 单位的黄铜曲柄，按下位移为沿 Y 轴向下 $0.15$ 单位。

### 1.2 动态 Canvas 贴图渲染管线 (Dynamic Texture Pipeline)
```javascript
// 表盘纹理尺寸：512x512 离屏画布
class ClockDialTexture {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 512;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.anisotropy = 8;
  }

  update(secondsRemaining, isActive) {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, 512, 512);

    // 1. 绘制复古刻度盘与罗马/阿拉伯数字
    this.drawDialFace(ctx);

    // 2. 绘制分针与秒针（根据毫秒级平滑转动）
    const angleSec = (secondsRemaining % 60) * (Math.PI / 30);
    this.drawHand(ctx, angleSec, 180, 4, '#1a1a1a');

    // 3. 标记纹理需要更新
    this.texture.needsUpdate = true;
  }
}
```

### 1.3 交互状态机与物理反馈
1. **未激活 (Idle)**：钟摆停止，秒针静止。
2. **走时中 (Ticking)**：当前执子方秒针以 60 FPS 连续阻尼转动；每秒通过 Web Audio 播放一次微弱的机械摆轮滴答声。
3. **点击侧边扳手 (Pause Triggered)**：
   - 扳手在 60ms 内物理弹起，发出清脆的机械脱扣声（`clock_latch.wav`）；
   - 秒针瞬间定格；
   - 相机在 650ms 内平滑切入 `CLOCK_FOCUS` 特写视点；
   - 场景全域环境光色温由 4500K 降至 3000K，微尘粒子静止，渲染“时空定格”氛围。
4. **再次点击扳手 (Resume Triggered)**：
   - 扳手按下，秒针继续走动，相机拉回 `MAIN_PLAY` 视角。

---

## 2. 实体二：回溯黄铜沙漏 (Rewinding Sandglass)

### 2.1 物理建模与材质
- **支架**：黄铜双立柱雕花转轴支架，轴心位于 $(x=7.2, y=1.5, z=2.0)$。
- **球体**：双锥形相连的高透物理玻璃材质（Physical Glass Material，`transmission = 0.95`, `roughness = 0.05`, `ior = 1.52`）。
- **内部金沙**：由顶点着色器驱动的金沙粒子群，上室沙丘逐渐塌陷，下室沙堆逐渐隆起。

### 2.2 悔棋动画时序表 (Undo Animation Sequence)
```text
T = 0ms    玩家点击沙漏 (Raycast Hit)
           沙漏开始沿 Z 轴自旋 180° (Cubic Ease-In-Out, 持续 450ms)
           沙漏翻转声效 (wood_brass_swivel.wav)
T = 150ms  下室沙粒向上回冲倒流粒子激活 (Reverse Particle Flow)
T = 200ms  棋盘最后落下的棋子表面升起淡金色风尘光晕
           棋子脱离棋盘垂直升空 3.5 单位 (持续 200ms)
T = 400ms  棋子在空中划出二次贝塞尔曲线飞向原木棋罐 (持续 350ms)
T = 750ms  棋子落入棋罐，发出清脆的玉石撞击轻音 (stone_bowl_clink.wav)
           核心逻辑完成 undoMove()，棋局状态无缝回滚
```

---

## 3. 实体三：线装宣纸古籍与悬空墨笔 (Strategy Manual)

### 3.1 视觉呈现与动态水墨技术
- **古籍实体**：左侧桌案平铺的宣纸装订书册，尺寸 $3.2 \times 4.5 \times 0.3$ 单位。
- **水墨渲染原理**：利用 Canvas 2D 模拟行草书水墨扩散算法：
  - 笔锋动态插值绘制文字线条；
  - 半透明边缘做径向模糊扩散（Gaussian Ink Bleed）；
  - 自动绘制坐标图徽（如以太极阴阳水墨符号标记核心天元位）。

### 3.2 导师启发式批注规范
古籍每页展示三大核心板块：
1. **【正着推敲】**：用行楷毛笔字清晰注明推荐坐标，如：“*宜着天元·H8*”。
2. **【弈理短评】**：“*断其连珠，固守中央；彼退我进，大势已成。*”
3. **【气势折线】**：宣纸下端以淡墨渐变山水折线展现双方气势走势图（黑方占据 68% 攻势）。

---

## 4. 实体四：皮质记谱册 (The Leather Score Ledger)

### 4.1 书写与翻页动效
- **自动书写**：每落一子，悬空的复古钢笔在册页上快速游走，留下深蓝墨水笔迹；
- **历史残影投射 (Ghost Stones)**：
  - 玩家翻动记谱册时，若鼠标悬停在第 $N$ 步，棋盘上自第 $N+1$ 步起落下的棋子自动转为 $30\%$ 透明度幽灵状态，直观展现历史局面复盘，无需任何额外复盘界面。

---

## 5. 实体五：朱砂青田石印章 (The Victory Stamp)

### 5.1 胜负终局结算规格
- **石印实体**：青田冻石料，顶部精雕兽钮，印面刻有朱文“大捷”。
- **终局触发流程**：
  1. 胜负已定，暂停一切棋盘落子交互；
  2. 相机拉至高空俯视，印章平滑浮空旋转至宣纸上方 $4.0$ 单位；
  3. 重力加速度急速下坠（Gravity Slam，耗时 180ms）；
  4. 触碰宣纸瞬间触发**相机微震动（振幅 0.25，衰减 200ms）**与沉重朱砂盖印声（`stamp_impact_heavy.wav`）；
  5. 卷轴上留下鲜红欲滴的朱砂印记，获胜五子连线棋子周围放射出 40 颗微型金色符文粒子。
