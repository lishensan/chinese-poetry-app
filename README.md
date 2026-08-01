# 诗词学习 (chinese-poetry-app)

> 完全离线的 Android 古诗词学习 App，9 万首 + 译文/字词注释，古风排版，零网络依赖。

基于 [chinese-poetry](https://github.com/chinese-poetry/chinese-poetry) 9 万首诗词和 [byj233/ChinesePoetryLibrary](https://github.com/byj233/ChinesePoetryLibrary) 注释数据，通过 [Capacitor](https://capacitorjs.com/) 打包为 Android APK。

---

## ✨ 功能特性

- **完全离线**：所有数据内嵌到 APK，零网络请求
- **9 万首诗词**：覆盖全唐诗 / 宋词 / 诗经 / 楚辞 / 元曲 / 纳兰性德 等
- **译文 / 字词注释**：按需加载的逐首注释
- **古风排版**：米黄底色、宋体楷体、暖棕色译文
- **黑暗模式**：跟随系统
- **收藏 / 历史 / 搜索 / 切换字体大小**
- **物理返回键 / 手势返回兼容**：基于 WebView history + popstate

---

## 📂 目录结构

```
poetry-app-pkg/
├── www/                          # 前端 (HTML/CSS/JS + 离线数据)
│   ├── index.html                # 单页应用入口
│   ├── css/app.css               # 古风主题样式
│   ├── js/app.js                 # 主应用逻辑 (加载/导航/注释)
│   └── data/                     # 离线数据 (构建时生成)
│       ├── index.js              # 索引: 90302 首诗 + 10 分类 + 12368 作者
│       ├── authors.js            # 作者详情
│       ├── lite/                 # 列表分片 (按 source 切分, 单文件 ≤ 1MB)
│       │   ├── 全唐诗_p0.js ~ _p9.js
│       │   ├── 宋词_p0.js ~ _p3.js
│       │   └── ...
│       ├── full/                 # 详情数据 (单 source 完整)
│       │   ├── 全唐诗.js
│       │   └── ...
│       ├── notes/                # 注释分片 (按需加载, 单 source 切成多片)
│       │   ├── 全唐诗_p0.js ~ _p17.js
│       │   └── ...
│       ├── notes_index.js        # 注释 source 索引
│       └── notes_part_index.js   # 注释分片 ID 定位表
├── android/                      # Capacitor 生成的 Android 工程
│   └── app/src/main/
│       ├── java/com/poetry/learn/MainActivity.java
│       ├── assets/public/        # cap sync 同步 www 内容 (自动生成)
│       └── AndroidManifest.xml
├── capacitor.config.json         # Capacitor 配置 (appId=com.poetry.learn)
├── package.json                  # Node 依赖 (@capacitor/core, android, cli 6.2.1)
└── .gitignore
```

---

## 📊 数据资源

### 来源
| 数据集 | 来源 | 用途 |
|---|---|---|
| 诗词原文 | [chinese-poetry/chinese-poetry](https://github.com/chinese-poetry/chinese-poetry) | 9 万首 |
| 注释 (译文/字词) | [byj233/ChinesePoetryLibrary](https://github.com/byj233/ChinesePoetryLibrary) | tang + songci |

### 分类与规模
| 分类 (source) | 诗数 | 注释匹配 | 注释分片 |
|---|---:|---:|---:|
| 全唐诗 | 45,060 | ✓ | 18 (p0~p17) |
| 宋词 | 17,250 | ✓ | 4 (p0~p3) |
| 诗经 | 305 | – | 1 |
| 楚辞 | 66 | – | 1 |
| 元曲 | 4,389 | – | 1 |
| 唐诗三百首 | 313 | – | 1 |
| 唐诗补录 | 9,376 | – | 1 |
| 宋词三百首 | 218 | – | 1 |
| 曹操诗集 | 26 | – | 1 |
| 纳兰性德 | 304 | – | 1 |
| **合计** | **90,302** | **51,940 首 (57.5%)** | – |

### 简化字处理
原始数据繁体，通过 OpenCC (`t2s.json`) 全量转简体。已使用本地缓存 (`/tmp/opencc_cache.pkl`) 加速二次运行。

---

## 🔨 构建流程

### 前置依赖
- **Node.js 16+** 和 npm
- **Java 17** (Capacitor 6 要求)
- **Android SDK** (compileSdk 34, minSdk 22)
- **Gradle 8.2.1** (项目自带 wrapper)
- **OpenCC** (仅首次生成数据时需要): `brew install opencc`

### 一、生成离线数据 (可选, 已生成可直接使用)
数据已包含在 `www/data/`，**如需重新生成**：

```bash
cd /Users/shenshan/myworkspace/workspace/poetry-build
python3 build_data.py     # 从 chinese-poetry + cpl 生成 index/authors/lite/full
python3 split_notes.py    # 拆 full + 注释为分片
```

源数据需放在：
- `/Users/shenshan/myworkspace/workspace/poetry-data/chinese-poetry`
- `/Users/shenshan/myworkspace/workspace/poetry-data/cpl`

### 二、构建前端 (无需 npm 编译)
`www/` 是纯静态资源，可直接用。

### 三、打包 Android APK

```bash
# 1. 同步 www 到 android 工程
rsync -a --delete /path/to/poetry-app/www/ poetry-app-pkg/www/

# 2. cap sync (将 www 复制到 android/app/src/main/assets/public)
cd poetry-app-pkg
npx cap sync android

# 3. Gradle 打包
cd android
./gradlew assembleDebug

# 4. 产物
ls -lh app/build/outputs/apk/debug/app-debug.apk
```

### 四、安装到 Android 设备
```bash
adb install app/build/outputs/apk/debug/app-debug.apk
```

---

## 🚀 使用说明

### 启动后
- **首页**：每日一诗 + 10 大分类入口
- **分类**：进入列表 (如"全唐诗") → 点击诗 → 详情
- **详情**：支持 译文 / 字词 注释开关，遮罩背诵，收藏
- **底部 Tab**：首页 / 诗库 / 诗人 / 收藏 / 历史

### 返回手势
- 详情页按返回 → 回到上一列表
- 列表按返回 → 回到首页
- 首页按返回 → 退出 App (走系统默认)

实现：`MainActivity.onBackPressed` 拦截 → `webView.canGoBack()` → `webView.goBack()` → JS `popstate` 监听器切回对应页。

### 数据加载策略 (核心)
**离线优先，三级回退**：
1. `window.POEM_*` 同步变量 (由 `index.html` 预注入的 `index.js` / `authors.js` 提供)
2. 动态注入 `<script>` 加载 `.js` (lite 分片 / full 数据 / 注释分片)
3. `fetch()` 兜底 (HTTP 环境下使用)

**容错**：
- 并发去重: `Loader.dedup()` 同 key 多次请求只发一次
- 超时: script 12s, fetch 15s
- 重试: 失败最多重试 2 次
- 错误隔离: 单个分片失败不影响其他分片

---

## 🔧 关键文件说明

| 文件 | 作用 |
|---|---|
| [www/js/app.js](www/js/app.js) | 主应用逻辑 (加载/导航/注释/收藏/历史) |
| [www/index.html](www/index.html) | 单页入口, 同步注入 POEM_* 同步变量 |
| [www/css/app.css](www/css/app.css) | 古风主题样式 + 注释区样式 |
| [android/app/src/main/java/com/poetry/learn/MainActivity.java](android/app/src/main/java/com/poetry/learn/MainActivity.java) | 接管 Android 返回键 |
| [android/app/src/main/AndroidManifest.xml](android/app/src/main/AndroidManifest.xml) | 应用配置 |

---

## 📦 依赖

```json
{
  "@capacitor/core": "^6.2.1",
  "@capacitor/android": "^6.2.1",
  "@capacitor/cli": "^6.2.1"
}
```

Gradle / AndroidX / Material Components 由 Capacitor 自动管理。

---

## 📄 许可

诗词原文与注释数据遵循各自原始项目许可：
- [chinese-poetry](https://github.com/chinese-poetry/chinese-poetry) - MIT
- [ChinesePoetryLibrary](https://github.com/byj233/ChinesePoetryLibrary) - 见原仓库

App 本身代码可自由使用。

---

## 🙏 致谢

- [chinese-poetry](https://github.com/chinese-poetry/chinese-poetry) 整理的 9 万首诗词
- [byj233](https://github.com/byj233/ChinesePoetryLibrary) 整理的注释数据
- [二十四史离线版](https://github.com) 项目提供的 UI 参考
- [Capacitor](https://capacitorjs.com/) 提供的 Web → Native 桥接
