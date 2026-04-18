# Tears in Rain

> "All those moments will be lost in time, like tears in rain."  
> — Roy Batty, *Blade Runner* (1982)

一扇永远在下雨的起雾窗户。  
一台没有记忆的打字机。

---

## 创作理念

有些话，说出来太重，憋着又太闷。  
**Tears in Rain** 给它们一个出口：写在玻璃上，然后被雨带走。

你用指尖在窗玻璃上划字。雾气让背景模糊，字迹清晰可见。  
停下来片刻，雾气重新悄悄爬回来，从笔画的边缘开始，一点一点把字迹盖住——  
就像那些说不出口的事情，最终还是消失在雨里。  
然后，一句旧电影的台词从黑暗里浮出来，像某个陌生人刚好说了你想听的话。

没有存档。没有记录。只有这一次。

---

## 体验流程

```
进入 → 键盘打字（中英文均可）→ 停止 4 秒 / 按 Esc → 文字被雾气覆盖 → 电影台词浮现 → 循环
```

- **打字**：直接键盘输入，支持中文 IME
- **手动触发消散**：按 `Esc`
- **跳过台词**：消散后任意按键
- **调整氛围**：右下角控制面板（雨量、玻璃模糊、雾气亮度、折射等）
- **换背景**：拖入任意图片或视频，或在控制面板上传

---

## 本地运行

无需构建，纯静态页面。

**方式一：直接打开**

```bash
open index.html
```

> 部分浏览器对 `file://` 协议有字体跨域限制，若字体显示异常请用方式二。

**方式二：本地静态服务器（推荐）**

```bash
# Python 3
python3 -m http.server 8080

# 或 Node.js
npx serve .
```

然后访问 `http://localhost:8080`。

**运行环境要求**

- 支持 WebGL 2 的浏览器（Chrome / Edge / Firefox / Safari 16+）
- 建议使用耳机，雨声是体验的一部分

---

## 技术说明

| 层 | 技术 |
|---|---|
| 渲染 | WebGL 2 + 自定义 GLSL 片元着色器 |
| 雨滴物理 | 改编自 [Heartfelt by BigWings](https://www.shadertoy.com/view/ltffzl)（Martijn Steinrucken，CC BY-NC-SA 3.0） |
| 文字系统 | Canvas 2D 离屏渲染，作为 mask 纹理输入 shader |
| 雾气效果 | Shader 内凝结层 + 焦距混合（textMask → focus=0 揭示清晰背景） |
| 消散过程 | `reclaim` 变量驱动：雾气从笔画边缘向内填回，模拟玻璃重新起雾 |
| 音频 | Web Audio API，雨声循环 + 消散时弦乐膨胀 |
| 字体 | Caveat（英文手写）/ Ma Shan Zheng（中文毛笔） |

---

## 文件结构

```
index.html   页面结构与控制面板
style.css    排版与 UI
shader.js    WebGL 渲染器（雨、雾、文字 mask）
fog.js       Canvas 文字 mask 生成
app.js       状态机与交互逻辑
audio.js     雨声与音效
quotes.js    电影台词库
i18n.js      中英文本地化
```

---

## 致谢

- **Heartfelt** shader — Martijn Steinrucken (BigWings)，[Shadertoy ltffzl](https://www.shadertoy.com/view/ltffzl)，CC BY-NC-SA 3.0
- 灵感来源：Roy Batty 的最后独白，以及所有说不出口却真实存在过的话
