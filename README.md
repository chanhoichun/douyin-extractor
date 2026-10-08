# 抖音视频提取工具

本地运行的抖音视频提取（无水印下载）网站。**双击 `启动网站.bat` 即可使用**，浏览器会自动打开页面，无需手动输入网址。

## 快速开始

| 操作 | 方法 |
| --- | --- |
| 🚀 打开网站 | 双击 `启动网站.bat`（自动启动服务并打开浏览器） |
| 📄 直接打开页面 | 双击 `public\index.html`（需先启动过本地服务） |
| ⏹ 停止服务 | 双击 `停止服务.bat` |

手动方式：在项目目录运行 `node server.js`，然后访问 <http://127.0.0.1:3000/index.html>。

## 功能

- 粘贴抖音分享链接或整段分享文案，自动识别其中的链接
- 支持 `v.douyin.com` 短链、`www.douyin.com/video/xxx`、`www.iesdouyin.com/share/video/xxx` 等格式
- 解析视频标题、作者、封面、点赞/评论/收藏等数据
- 在线预览 + 一键下载无水印视频

## 实现原理

抖音接口需要 `a_bogus`/secsdk 等动态签名，直接请求会被 403。本工具使用**本机 Edge/Chrome 无头浏览器**打开抖音分享页，让抖音自己的脚本完成签名后拦截数据接口，因此无需维护任何签名算法，抗风控能力最强。备用通道还包括 `iteminfo` 接口（X-Bogus 签名）与分享页 HTML 解析。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/ping` | 服务健康检查 |
| POST | `/api/extract` | 请求体 `{"url": "链接或文案"}`，返回视频信息 JSON |
| GET | `/api/video?url=...` | 视频流代理（页面预览用） |
| GET | `/api/download?url=...&name=...` | 触发浏览器下载 |

## 命令行测试

```bash
node test-extract.js "8.88 复制打开抖音，看看… https://v.douyin.com/xxxxxx/"
```

## 说明与限制

- 仅供个人学习交流使用，请尊重原创作者版权，勿用于商业用途。
- 视频直链有时效性，提取后请尽快下载。
- 暂不支持图文（图集）类分享内容。
- 如遇安全验证拦截：用浏览器手动打开一次 douyin.com 完成验证后再试。
- 首次提取需要启动浏览器，约 5~10 秒；之后会快一些。
- 代理下载仅允许抖音官方 CDN 域名。

## 文件结构

```
douyin-extractor/
├── 启动网站.bat       # 双击启动（推荐）
├── 停止服务.bat       # 双击停止
├── server.js          # 零依赖 HTTP 服务器（静态页面 + API + 视频代理）
├── extract.js         # 链接解析与多通道提取核心逻辑
├── browser-worker.js  # 无头浏览器提取通道（Edge/Chrome）
├── xbogus.js          # X-Bogus 签名（备用接口通道，Apache-2.0）
├── test-extract.js    # 命令行测试脚本
├── public/
│   ├── index.html     # 页面（可单独双击打开）
│   ├── style.css
│   └── app.js
└── browser-profile/   # 浏览器会话数据（自动生成）
```
