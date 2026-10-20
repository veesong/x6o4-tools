# x6o4 命令行说明

`x6o4` 是本仓库提供的小工具。平时由 AI 助手替你调用；你也可以自己在终端使用。安装：`npm install -g x6o4-tools`（需要 Node.js 18 或更高版本），装好后直接输入 `x6o4`。

## 它连接哪里、东西存在哪里

固定连接 RSS Cloud 官方服务 `https://rss-cloud.x6o4.com`，不需要你配置。

你的凭证和个人设置保存在**你自己电脑**的用户目录下 `.x6o4-tools` 文件夹里：

| 文件 | 是什么 | 要手工改吗 |
|---|---|---|
| `config.json` | 你的配置 | 可以（见下表） |
| `export-state.json` | 工具自己记的「哪些文章已存进笔记」 | 不要 |
| `skip-state.json` | 工具自己记的「哪些文章 30 天内不再筛选」 | 不要 |

## 配置文件（config.json）字段

| 字段 | 作用 | 默认值 |
|---|---|---|
| `base_url` | 服务地址 | 官方地址（一般不要改） |
| `token` | 登录得到的长期令牌 | 空（`login` 自动写入） |
| `kindle_email` | 你的 Kindle 接收邮箱 | 空 |
| `mail_transport` | 发信方式：`smtp` 或 `agently` | `smtp` |
| `smtp` | 发件邮箱：`preset` / `host` / `port` / `secure` / `user` / `pass`（仅 `smtp` 方式需要） | 空 |
| `obsidian` | 笔记库：`vault_dir`（必填）、`subdir`、`assets_subdir`、`download_images` | `RSS`、`RSS/assets`、`true` |
| `epub` | 电子书生成参数：`image_max_width` / `image_jpeg_quality` / `image_grayscale` / `max_total_mb` / `max_articles_per_book` | `1200` / `70` / `true` / `20` / `50` |
| `unread` | 单次推送篇数上限 `max_articles_per_run` | `20` |

`smtp.preset` 可选 `qq` / `163` / `gmail` / `outlook` / `icloud`：选好后服务器参数自动填上，你只需再填 `user`（邮箱账号）和 `pass`（**授权码**，不是登录密码；获取方法见 README）。

`mail_transport` 填 `agently` 时改用 agent mail（腾讯的独立 Agent 邮箱产品，非 QQ 邮箱）的官方命令行工具 [agently-cli](https://agent.qq.com/doc/cli-setup.md) 发信（先 `npm install -g @tencent-qqmail/agently-cli`，再在终端运行 `agently-cli auth login` 完成一次浏览器授权），此时不需要填 `smtp` 的任何字段、也不需要授权码。

## 子命令一览

### `x6o4 login [--name 名] [--scope read|readwrite]`

终端里输入 RSS Cloud 邮箱和密码（密码不回显），自动换取长期令牌并保存。默认创建**读写**令牌——推送到 Kindle 后要把文章标记已读，需要写权限；只打算用「收藏转笔记」的可以加 `--scope read`。你的令牌数量达到上限时，它会列出你现有的令牌让你选择吊销哪一个。

### `x6o4 status`

显示账号、订阅状态、未读总数、收藏总数、令牌前缀（只显示前缀，不显示完整令牌）。

### `x6o4 tokens list` / `x6o4 tokens revoke <编号>`

查看与吊销你的长期令牌。吊销后，对应电脑需要重新 `login`。

### `x6o4 feeds`

列出你的订阅源和每个源的未读数。

### `x6o4 entries [参数]`

拉取文章列表。常用参数：

| 参数 | 作用 |
|---|---|
| `--status unread` 或 `read` | 只看未读 / 已读 |
| `--starred` | 只看收藏 |
| `--feed-id N` / `--category-id N` | 只看某个订阅源 / 分类 |
| `--limit N`（最多 100）/ `--offset N` | 分页 |
| `--min-reading-time N` | 只留阅读时长不少于 N 分钟的 |
| `--excerpt N` | 同时给出每篇的摘要（默认 160 字） |
| `--out 文件` | 把完整数据写入文件（**正文只在文件里**，不会显示在屏幕上） |
| `--print` | 在屏幕上显示元数据和摘要（不显示正文） |
| `--no-skip-state` | 不按「跳过记录」过滤（默认会过滤） |

### `x6o4 build-epub --ids 编号1,编号2 --from entries文件.json --title 书名 --out 文件`

把指定文章做成 epub 电子书，正文取自 `entries` 命令写出的文件。篇数或图片体积超过单册上限时自动分成多册。

### `x6o4 send-kindle --file 文件1[,文件2...] [--subject 标题]`

把电子书发到你的 Kindle 邮箱。多册合并成一封邮件；总大小接近上限时自动打包成 zip（亚马逊会自动解压）。按配置 `mail_transport` 决定走 SMTP 还是 agently-cli。

### `x6o4 mark-read --ids 编号1,编号2`

把指定文章标记为已读（单次最多 500 篇）。

### `x6o4 export-md --from entries文件.json [--since 日期]`

把文章转成 Markdown 存进笔记库。已经存过的自动跳过，重复执行是安全的。

### `x6o4 skip add --ids ...` / `skip list` / `skip clear`

维护「跳过记录」：被标记的文章 30 天内不会出现在未读筛选里。

### `x6o4 config path` / `config check`

显示配置文件的位置 / 检查配置是否完整。

### `x6o4 skills install`

把仓库的三个 AI 技能安装到用户目录的 `.agents/skills` 文件夹（这是各家 AI 助手约定共同扫描的位置）。安装方式是「链接」：技能文件实际存放在 npm 安装包里，所以执行 `npm update -g x6o4-tools` 升级时技能内容自动跟着更新，不需要重新安装。若同名文件夹已存在且不是本工具创建的链接，会跳过而不覆盖。

## 常见错误与处理

| 错误提示里出现 | 意思 | 处理 |
|---|---|---|
| 令牌无效或已吊销 | 改过 RSS Cloud 密码，或账号状态变化 | 重新 `x6o4 login` |
| 只读权限，无法标记已读 | 当前令牌是只读的 | 重新 `x6o4 login`（默认读写） |
| 权益不足（SUBSCRIPTION_ 开头） | RSS Cloud 订阅到期 | 续订后继续 |
| 请求过于频繁 | 操作太密集了 | 等一分钟再试 |
| RSS 上游暂时不可用 | 服务暂时繁忙 | 稍后再试 |
| 未找到 agently-cli 命令 | 用的 agently 发信方式，但电脑上还没装这个工具 | `npm install -g @tencent-qqmail/agently-cli` |
| agently-cli 尚未登录 | 装了但没授权，或授权过期 | 终端运行 `agently-cli auth login` |
