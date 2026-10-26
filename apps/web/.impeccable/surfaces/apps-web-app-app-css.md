---
version: 1
slug: "apps-web-app-app-css"
primary_target: "apps/web/app/app.css"
related_targets: ["modules/studio/web/layout.tsx","modules/studio/web/studio.css","site/brand/Logo.tsx"]
---

# FL品牌与界面方向

frontend-design主导设计，impeccable检查和完成后打磨。沿已批准二期要求直接实现，用户已授权自主布局，不再追加方向选择或另做三套主题。

## Direction contract

THESIS：这是给AI影视创作者阅读情报和完成稿件的工具。沿用已有导航和任务分区，品牌识别集中在FL组合标与暖纸侧栏，不把操作页排成海报。

OWN-WORLD：FL红#ed4236、胶片黄#f5c64d、暖纸#f3ead8、深炭#1c1e22、暖白#f6f1e7、青绿状态色#26745e。内容深浅主题共用语义tokens；侧栏固定暖纸，用胶片边缘小圆孔和网点品牌底纹作为单一识别细节。英文标采用本地Barlow Condensed Bold Italic，中文正文保留系统中文无衬线；数字用tabular-nums。

STORY：公开读者先看到精选和来源，可访问热点、日报与独立影视榜；创作者从既有五入口收集、选题和写稿。真实内容与状态沿用，不编造数据填空。

FIRST VIEWPORT：公开桌面固定200px暖纸导航，顶部FL图标与可完整读出的FastLaneNEWS字标，分组链接居中段，外观切换和登录在底部；工作台实际侧栏212px。右侧深炭灰阅读/操作区，现有筛选与标题先行。公开站961px起显示桌面侧栏，手机沿原底部导航；工作台760px及以下转横向五入口。正文不横溢，编辑与引用保持独立滚动。

FORM：用户指定的FL工作室衍生视觉，沿既有Operate/Read结构，code-led；seed: none (user-pinned)。不改正文事实、页面权限、现有操作或历史快照。

FINISH：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## 设计前自检

保留FL原图的斜红牌/黄底/白字，避免通用青绿圆点字标；侧栏暖纸与深炭内容形成明确区域。强装饰只在品牌和导航边缘，正文无网点、无阴影卡片套层；普通控件保持熟悉。字体本地供给，无CDN；默认深色，已有浅色选择继续有效。

## Surface modes and built facts

公开精选、动态、热点、日报、收藏和影视榜采用Read；内部五页及写稿编辑采用Operate。模式只按这些surface记录，不将全产品设为Persuade。

当前源码深色重点为胶片黄，浅色与暖纸导航重点为砖红；具体值和圆角、间距、组件见根DESIGN.md及.impeccable/design.json。公开胶囊控件与工作台8px控件共存。写稿在1100px及以下收紧导航与引用列，760px及以下纵排且正文／引用继续独立滚动。

本次仅同步已建成事实，不新增页面策略。最新public／writing的1440／1024／390深浅截图供既有finish审核使用；最后ship复核限三项修复resolved，不代表新一轮全站审核。关于／日志管理及二维码公开接线仍在任务12，不在本surface记录为完成。
