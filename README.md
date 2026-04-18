# Tears in Rain

> "All those moments will be lost in time, like tears in rain."
> — Roy Batty, *Blade Runner* (1982)

一扇永远在下雨的起雾窗户。
一台没有记忆的打字机。

---

## 创作理念

王家卫《花样年华》里的树洞。

有些话，说出来太重，憋着又太闷。
**Tears in Rain** 给它们一个出口：写在玻璃上，然后被雨带走。

你在玻璃上写字——雾气顺着笔画慢慢凝起来，留下一串水珠；停下来片刻，笔画边缘的水汽悄悄合拢，字迹一点一点被雾盖住。就像那些说不出口的事情，最终还是消失在雨里。然后，一句旧电影的台词从黑暗里浮出来，像某个陌生人刚好说了你想听的话。

没有存档。没有记录。只有这一次。

---

## 体验流程

```
进入 → 打字（中英文均可）→ 停止 4 秒 / 按 Esc → 字迹被雾气覆盖 → 电影台词浮现 → 循环
```

- **打字**：直接键盘输入，支持中文 IME
- **手动触发消散**：按 `Esc`
- **跳过台词**：消散后任意按键
- **调整氛围**：右下角控制面板（雨量、玻璃模糊、雾气亮度、折射等）
- **换背景**：拖入任意图片或视频，或在控制面板上传

---

## 本地运行

需要 Node 18+。

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # 产物在 dist/
npm run preview   # 预览构建结果
```

**运行环境要求**

- 支持 WebGL 2 + `EXT_color_buffer_float`（或 `_half_float`）的浏览器：Chrome / Edge / Firefox / Safari 16+
- 建议使用耳机，雨声是体验的一部分

---

## 技术说明

与早期版本不同，v0.2 把雾气和湿迹抽成**两个每帧演化的持久状态场**，由 GPU 自己推进，而不是由一个动画进度条控制。消散不再是一个"播放动画"的动作，而是一个相变：一旦停止写入，雾自然回填、湿迹自然风干。

| 层 | 技术 |
|---|---|
| 渲染管线 | WebGL 2，三个 pass ping-pong：`fogUpdate` → `wetnessUpdate` → `composite` |
| 持久状态 | 两张 RGBA16F FBO（雾气场 + 湿润场），每帧按物理规则增减 |
| 写入输入 | Canvas 2D 把当前文字栅格化成 mask 纹理，作为"擦拭压力"信号 |
| 雨滴 | 改编自 [Heartfelt by BigWings](https://www.shadertoy.com/view/ltffzl)（Martijn Steinrucken，CC BY-NC-SA 3.0） |
| 水珠 | 在湿润场 > 阈值的区域采样高频晶格 + voronoi 法线做折射与高光 |
| 焦距 | 背景按 `fog × user-blur` 模糊，湿迹处焦距下降还原清晰 |
| 音频 | Web Audio API，雨声循环 + 消散时弦乐膨胀 |
| 字体 | Caveat（英文手写）/ Ma Shan Zheng（中文毛笔） |
| 构建 | Vite（ES modules，GLSL 以 `?raw` 直接内联） |

### 物理模型（简化）

```
fog(x, t+dt)  = fog + (1 - fog) · regrowth · dt  −  wipe · wipeForce · dt
wet(x, t+dt)  = wet + wipe · accumRate · dt      −  decayRate · dt
```

`wipe` 是当前帧的文字 mask，`wipeActive` 控制是否还继续喂入。写字阶段 `wipeActive = 1`，按 Esc / 停顿触发消散时切到 `0` —— 两个场各自按自己的速率回到静息态，过渡因此是连续而不是阶梯式的。

---

## 文件结构

```
index.html                      页面结构与控制面板
style.css                       排版与 UI
vite.config.js / package.json   构建
src/
  main.js                       状态机与交互
  renderer.js                   WebGL2 多 pass 调度 + FBO 状态
  textMask.js                   Canvas 文字栅格化（纯 stamping）
  audio.js                      雨声与音效
  quotes.js                     电影台词库
  i18n.js                       中英文本地化
  shaders/
    quad.vert.glsl              全屏三角形
    fogUpdate.frag.glsl         雾气场演化
    wetnessUpdate.frag.glsl     湿润场演化
    composite.frag.glsl         背景 + 雨 + 雾 + 水珠合成
```

---

## 致谢

- **Heartfelt** shader — Martijn Steinrucken (BigWings)，[Shadertoy ltffzl](https://www.shadertoy.com/view/ltffzl)，CC BY-NC-SA 3.0
- 灵感来源：Roy Batty 的最后独白，以及所有说不出口却真实存在过的话
