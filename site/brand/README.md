# FastLaneNEWS网页品牌资源

- `fl-mark.png`：独立FL透明标，256px。用户原图保持不变；由built-in image_gen作网页衍生，精确提示词和来源见`fl-mark.png.json`。生成源1254px实际有alpha，透明通道范围0–255，未把棋盘格当背景。
- `Logo.tsx`：页面组合标，FL＋FastLaneNEWS；读屏完整名称由SITE.name提供。字标使用本地Barlow Condensed Bold Italic，不依赖外部字体请求。
- `wordmark.svg` / `wordmark-dark.svg`：透明浅底/深底组合标，文字由上述字体转轮廓，图形嵌入FL标；分享图沿原OG读取机制自动复用。不是两个不同品牌。
- `icon.png`(512)、`icon-192.png`、`apple-icon.png`(180)、`favicon.ico`(48)：对image_gen结果的常规Sharp缩放/PNG ICO封装。未重新生成FL字形。
- `logo.svg`：包裹透明FL位图的标准网站图标出口。`nameplates/`原日报等框架资源保留，本期只启用日报。

原图：`C:/Users/15504/Desktop/漫剧/6c3af046202316d52117f343bb8fd75b.png`，SHA256 `D64B273E356DAAA9AD18F348A2DEF76FD184581B1490C9753CA3CAC6B7EBBDFA`。

字体来源：[Google Fonts / Barlow Condensed](https://github.com/google/fonts/tree/main/ofl/barlowcondensed)，2026-10-24下载原`BarlowCondensed-BoldItalic.ttf`与OFL，字体SHA256 `D8694F65CD70C3E5E600EAD37657AAB0ADB5F63B275D0C1F6F4A7046DE222145`。作者The Barlow Project Authors，SIL Open Font License 1.1全文在`fonts/OFL.txt`，未改字体文件。

主题、组合标和控件的实际代码在app.css、Studio布局/CSS，布局方向见docs/development/PHASE2-BRAND-DIRECTION。原图和生成源均不依赖运行服务器桌面路径；生产只用本目录已纳入版本管理的资源。
