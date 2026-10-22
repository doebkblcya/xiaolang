# 小狼 xiaolang

个人定制、轻量克制、拟人化的 QQ 聊天机器人。使用 **TypeScript＋Cordis 4** 自行编写，通过独立接入插件连接 **QQ 官方机器人**。OneBot／NapCat 接入实现已移除。

基础聊天、记忆、工具、主动插话和配置后台已在飞牛 NAS 上运行，使用 QQ 官方 WebSocket **正式环境**。已支持定时提醒；人设与学习首版已在 NAS 启用。接下来按实际聊天调整体验；日常工程完善由助手负责。

## 文档入口

| 文档 | 看什么 |
| --- | --- |
| [总体链路与运行参数](Docs/总体链路与运行参数.md) | 当前完整能力、插件、模型档位，以及时间／条数／上限。 |
| [需求记录](Docs/需求记录.md) | 想做什么、哪些体验一起讨论、哪些工程事项由助手负责。 |
| [主链路](Docs/主链路.md) | 一条消息怎样变成回复，各插件负责什么。 |
| [实现进度](Docs/实现进度.md) | 已经能做什么、接下来做什么、在哪里使用。 |
| [初期调研](Docs/初期调研/) | AstrBot、MaiBot、LangBot、Koishi／Cordis 与 NapCat 的历史调研；不作为当前实施计划。 |

想快速掌握现状先看总体链路；其余文档按需要查阅。README 保留运行和扩展示例。

## 已实现

- QQ 私聊和群聊文字回复；支持 @ 和句中触发词，能结合本会话最近的聊天。
- 统一工具调用与管理员鉴权；时间、计算、DeepSeek 网页搜索与阅读，以及 MCP／Skills 接入。
- 群聊主动插话：活跃时及时判断，旁观时合批判断；有独立开关和群黑名单。
- 普通／流式输出可配置；私聊使用原生流式，群聊逐句发送，最多五条。
- 聊天记录持久保存，过程日志和 QQ 故障提示可查看。
- 管理面板可以查看运行情况，修改模型、QQ 和触发配置。
- 主链路由内置插件组成；内置和外挂都列在面板中，外挂支持按依赖启停和编辑已声明的配置。

聊天与记忆插件已加入：记录全部已接收聊天，支持近期原文、较早摘要、全局人物与经历记忆、关键词＋向量混合检索、图片理解和后台编辑。工具基础包括网页搜索与阅读、MCP 工具桥接和 Skills 按需加载，管理员设置在“工具与行动”页面。定时提醒支持一次性、每天和每周；人设与学习插件提供固定身份、简短 QQ 风格和独立的后台表达学习，表情包暂时搁置。详细状态见 [实现进度](Docs/实现进度.md)。

## 开发验证

Node.js 22.23.2，依赖使用锁文件。当前持久化使用 Node 内置 `node:sqlite` 和 `sqlite-vec` 扩展，在此 Node 版本仍显示实验性提示。

```sh
npm ci --ignore-scripts
npm run check
npm test
```

测试使用模拟模型、内存传输和临时数据库，不启动机器人、不连接 QQ 或调用真实模型。Mac 仅用于编译及这种离线验证；正式入口在非 Linux 系统会拒绝运行。

配置格式可单独检查，不打开数据库或网络连接：

```sh
XIAOLANG_CONFIG=config.example.json node dist/src/main.js --check-config
```

## Docker 运行

当前部署环境为飞牛 NAS Docker，已完成 QQ 正式连接与真实消息收发；Mac 仅用于开发，不运行机器人。VPS 仅属历史验证环境，已清理。

1. 当前 NAS 目录为 `/vol1/1000/sys/docker/xiaolang`，Compose 配置为 `compose.yml`，项目及容器名为 `xiaolang`。现有 AstrBot／NapCat 不改动。
2. 将 `config.example.json` 复制为 `config.local.json`，填写 `adapter.config.appId`。仓库示例与当前项目均使用 `environment: "production"`。沙箱按后台配置测试成员和群，两种环境的历史命名空间隔离。
3. 将 `.env.example` 复制为 `.env`，填入 `DEEPSEEK_API_KEY` 和 `QQBOT_APP_SECRET`；真实密钥不进入 Git、镜像或普通日志。
4. `groupIds` 填 QQ 官方事件中的群 OpenID，不是普通 QQ 群号；空列表表示所有平台允许接收的群。`groupMessages` 是能力声明，不会替平台授予权限。用户已反馈非 @ 群消息可收到，示例使用 `"all"`；现有实例可以在 QQ 接入页修改此声明。
5. 当前插件使用 WebSocket，由容器向 QQ 官方网关发起连接，不需要 NapCat 或公网回调端口。当前应用已在 NAS 正式环境成功鉴权并就绪；具体事件权限按实际收包确认。没有实现 Webhook 服务。
6. `main` 每次推送通过全部检查后，Actions 导出 `linux/amd64` 镜像和 SHA-256 校验文件，保存为保留 7 天的 Artifact，不创建 Release 或发布到镜像仓库。镜像标签为 `xiaolang:<完整提交 SHA>`；导入目标 Docker 后在 `.env` 的 `XIAOLANG_IMAGE` 填写该标签。将 `compose.example.yml` 作为项目的 Compose 配置使用，无需在目标服务器重新构建。
7. 宿主机 `data/` 挂载在 `/app/data`，`plugins/` 挂载在 `/app/plugins`，配置只读挂载；目录须允许容器用户 UID/GID 1000 读写，同一数据库只运行一个应用实例。容器内存上限 512 MiB，日志最多 3 个 10 MiB 文件。NAS 面板仅绑定内网 IP `192.168.31.97:18080:18080`，QQ 接入没有入站端口。若自行在 Linux 构建镜像，可使用 `docker build -t xiaolang:local .`。

当前运行镜像、环境、验证边界和未完成项统一以 [实现进度](Docs/实现进度.md) 为准，避免在多处记录不同状态。

人设在“人设与学习”插件里配置，自动学习不能改写固定人设；保留 FIFO 排队。近期原文默认最多 100 条，总上下文上限为 100,000 Token。模型思考模式、重试和超时可配置。主动插话已开启，当前群黑名单为空；活跃期 60 秒，旁观期 60 秒或 20 条新消息。

## 私有后台面板与配置

页面和 Node.js 内置 HTTP 服务位于外挂的 `examples/plugins/panel/`。面板采用奶白、巧克力棕与焦糖色，小狼透明立绘用于首页、头像和访问验证页，功能页面保持清晰阅读。复制整个目录到运行目录的 `plugins/panel/`，在 `plugins.entries` 添加：

```json
{ "id": "panel", "module": "./panel/index.mjs", "config": { "host": "0.0.0.0", "port": 18080 } }
```

这里的 `0.0.0.0` 是容器内部监听地址。当前 NAS 的 Compose 绑定 `192.168.31.97:18080:18080`，该端口已启用 HTTPS，具体域名和鉴权配置见下文。默认只允许本机 Host；`allowedHosts` 按实际域名与端口精确放行，不使用通配符。

当前 NAS 面板已启用 HTTPS 和单个长 Key 鉴权，不设账户或用户系统。未验证时只展示 Key 输入页，聊天、配置、日志等接口均不可读取；验证后使用有效期 7 天的 HttpOnly／Secure／SameSite Cookie，支持退出，重启后需重新验证。服务端只保存 Key 的 SHA-256 摘要，原 Key 不写入网址、网页存储或日志。仍限制允许的 Host 与同源请求，配置写入继续检查页面令牌和 JSON 请求体。

模型、QQ、触发规则及声明过的外挂插件配置可编辑；内置与外挂都可启停，显示停用影响，依赖缺失的插件等待服务。页面全部使用本地静态资源，无前端框架或第三方 CDN。每 2 秒刷新运行状态与日志；聊天按轮次分页，支持异常筛选、分段回执和关联过程日志。所有实际接收的消息都可按群聊／私聊查看，未触发消息不生成回复轮次。密钥可以替换但不回显，留空保留原值；不提供任意 SQL 或命令执行接口。

NAS 继续使用已有 DDNS 域名 `nas.doebkblcya.com`。小狼在容器内直接提供 HTTPS，NAS 端口仍为 `18080`，原 HTTP 入口停用；公网 `48393` 已映射到 NAS 的 `18080`，访问 `https://nas.doebkblcya.com:48393/`，飞牛原有 `48392` 入口不变。外网验证记录见 [实现进度](Docs/实现进度.md)。证书只读挂载已有域名目录，飞牛继续负责申请和续期，小狼每分钟检查并加载最新有效证书；证书与私钥不匹配或新证书尚未写完时保留原证书，不重启聊天。

HTTPS／Key 为面板插件的部署配置，例如当前 NAS：

```json
{
  "host": "0.0.0.0", "port": 18080,
  "allowedHosts": ["nas.doebkblcya.com:48393", "nas.doebkblcya.com:18080", "192.168.31.97:18080"],
  "auth": { "keyHashFile": "/app/data/panel-auth.json", "sessionHours": 168 },
  "tls": { "directory": "/app/panel-certificates", "domain": "nas.doebkblcya.com" }
}
```

`panel-auth.json` 仅含 `keyHash`（64 位小写 SHA-256 十六进制摘要），权限 `0600`；原 Key 使用加密随机数生成，至少 32 字节。当前 Compose 额外挂载 `/usr/trim/var/trim_connect/ssls/nas.doebkblcya.com:/app/panel-certificates:ro`，只让小狼读取这个域名的证书目录，不改系统证书或证书权限。自备证书也可用 `tls.certFile`／`tls.keyFile` 和可选 `tls.chainFile` 指定绝对路径。配置了鉴权却没有 HTTPS、摘要文件无效或启动时无法读取有效证书，面板会拒绝启动。未配置这两项的示例仍用于本机／可信内网，不应直接映射到公网。

面板依赖主链路的 `inspection` 只读服务；不直接操作 SQLite。聊天来自持久化记录，日志仅缓存本次启动的最近 500 条。重启后页面会自动重连，日志缓存重新开始。改变页面或 HTTP 展示逻辑后更新外挂文件并重启即可；改变主链路查询能力才需要更新镜像。Mac 的离线测试不会启动 HTTP 监听；实际 HTTP 验证在 Linux 容器和运行宿主机执行。

模型页支持 API 地址、模型、API Key、思考开关／强度、温度、Top P、输出 Token、请求超时、重试和停止词；QQ 页支持 AppID、AppSecret、正式／沙箱环境、群接收能力声明、连接超时和群 OpenID 范围，连接方式固定 WebSocket。参数范围按 [DeepSeek 官方文档](https://api-docs.deepseek.com/api/create-chat-completion/) 核对：温度仅非思考模式生效，Top P 与思考强度仅思考模式生效；已弃用的频率／存在惩罚不暴露。

修改分为“保存”和“应用配置并重启”。有排队或处理中的轮次时不允许应用；应用后页面自动重连。QQ 新配置导致启动失败时自动恢复上一份配置；模型凭证是否可调用仍需真实请求确认。

后台管理的模型／QQ／触发／外挂插件覆盖配置与密钥统一保存到数据库同目录的 `data/settings.json`（权限 `0600`），包含当前有效值与待应用值；启动时覆盖基础 `config.local.json` 的对应设置，其余配置不变。该文件随现有 `data/` 挂载持久化，不写回只读挂载文件或 `.env`。不要将它加入 Git 或镜像；手动改基础文件后，已通过后台管理的区域仍优先使用后台保存值。

## 故障反馈与触发

触发逻辑在 `src/trigger.ts`，主动插话判断在 `src/proactive.ts`，共同提供 `trigger` 服务。后台在“插件列表 → 消息触发”配置私聊默认回复、群 @、群触发词及主动插话；词在句中任何位置出现即触发，多条件只产生一次默认任务。主动插话有独立开关和群黑名单，仍关联真实入站消息作被动回复；定时提醒和重复任务尚未实现。`plugins.trigger` 可选外部提供者替换默认插件，不能与默认实现并行。

故障反馈为独立 `src/fault-feedback.ts` 插件，模型/API、处理超时、预算等导致本轮无法回复时，发送固定中文原因、错误码与短轮次编号。未知插件错误使用通用说明，不发送原始异常、堆栈或凭证。已有正常发送意图、部分回复或发送结果未知时不追加提示；退出取消也不提示。每轮在发送记录中以保留段号 `-1` 原子占位，最多尝试一次，不重试、不进入模型上下文，也不把失败轮次改成成功。后台详情区分正常回复与故障提示；`failureFeedback.enabled: false` 可在基础配置中停用该可选能力，管理页不提供内置启停按钮。

## 过程日志

在飞牛 Docker 面板中打开 `xiaolang` 容器的运行日志，或在小狼管理面板查看“过程日志”。过程事件包括收到消息、忽略原因、触发、排队与等待时间、模型调用与耗时、工具名称与状态、回复短预览、逐段发送回执和整轮结果。日志中的时间为 UTC；`turn` 关联同一轮次，`message` 关联入站、忽略和触发事件。平台回执表示 QQ 接受发送，不代替客户端可见性确认；结果未知不会记录为成功，也不会自动重发。

本体在处理边界发出结构化事件，由独立的日志处理插件筛选字段、脱敏、限制预览长度，再发布 `xiaolang/logged` 事件。默认预览 200 个 Unicode 字符；`logging.content: false` 可关闭所有正文预览。提示词、历史、思考内容、工具参数和工具结果不作为日志字段输出。已知环境密钥及常见凭证形式会脱敏，这不等于对任意个人信息自动匿名化。

终端中文格式由外挂的 `examples/plugins/console-logger/index.mjs` 提供。复制到运行目录的 `plugins/console-logger/index.mjs`，并将下面条目加入 `plugins.entries`：

```json
{ "id": "console-logger", "module": "./console-logger/index.mjs", "config": { "format": "text" } }
```

插件提供 `logOutput.write(entry)` 服务，接收脱敏后的事件；`format: "json"` 可改为结构化输出。未启用展示插件时，正式入口回退到 JSON 输出。修改外挂展示文件或它的配置后重启即可；增加本体观测点或修改脱敏边界仍需更新镜像。日志输出异常不会改变消息处理结果。现有后台订阅同一套脱敏事件，并通过只读服务读取聊天记录，不需要解析终端文字。

## 扩展

外部插件通过官方 `@cordisjs/plugin-loader@1.0.0-rc.7` 加载，不需要重新构建小狼镜像。当前通过**重启小狼进程／容器**读取更新，不做热更新、自动安装或插件市场。

例如，将 `examples/plugins/hello` 复制到持久化的 `plugins/hello`，在 `config.local.json` 中配置：

```json
"plugins": {
  "directory": "plugins",
  "entries": [
    { "id": "hello", "module": "./hello/index.mjs", "enabled": true, "config": { "greeting": "你好" } }
  ]
}
```

然后重启小狼；模型会获得此插件注册的 `greet` 工具。更新插件文件或配置后再次重启即可。`enabled: false` 不激活插件；若插件声明数据清理接口，仍加载其清理模块，供彻底删除关联数据。没有 `plugins` 配置的旧配置继续加载默认官方功能。

当前交付为 12 个内置运行插件、13 个官方外挂插件，显示真实生命周期状态、依赖和提供服务。内置／外挂是当前部署位置，不是固定身份；不把普通代码文件或尚未实现的能力伪装成插件。

外挂插件可在入口旁提供 `xiaolang.plugin.json`，注册 `configSchema`（JSON Schema 对象）；启用插件也可导出 `xiaolangConfig`。后台按声明生成表单并校验后保存，支持标量、枚举和字符串数组。`writeOnly: true` 字段不回显，留空保留已有值；未声明的配置不直接暴露。侧车声明让停用的文件插件也能编辑配置，而不激活能力。示例见 `examples/plugins/console-logger/` 和 `examples/plugins/hello/`。配置和启停先保存再应用，两类插件均可停用；不删除代码或用户数据，不实现在线安装／卸载。

插件导出标准 Cordis 的函数、对象或模块形式，声明 `inject` 服务依赖，用 `ctx.effect()` 管理清理函数。文件入口使用 `.mjs`、`.cjs` 或可运行的 `.js`；TypeScript 插件先编译为 JavaScript。可选导出 `xiaolangApiVersion = 1`，声明其他版本会被拒绝。启用插件缺少服务依赖时显示等待，宿主继续运行；文件缺失、导出无效或激活失败仍报告错误并触发配置回退。

`module` 也支持已安装的 npm 包名：将其 `package.json`、锁文件与 `node_modules` 保存在插件工作目录，先安装，再配置包名加载。依赖在 Linux 运行环境准备，插件的 `cordis` 使用 peer dependency 复用宿主版本。官方 Loader 可能在该工作区写入 `.cordis` 解析缓存，因此 npm 工作区需可写。这里只支持加载，不自动下载或升级依赖。

要替换主链路，在 `plugins.chat` 填入某个已启用的插件 ID；它必须提供包含 `idle()` 和 `stop()` 的 `chat` 服务。默认主链路不会同时加载；`chatEnabled: false` 也会停用所选外部主链路。

`adapter.module` 保留旧接入配置；`builtin:qq-official` 现在映射到外挂 `xiaolang-adapter`。也可在插件列表停用 QQ，再安装提供相同 `adapter` 服务的其他平台插件。也支持插件目录中的相对入口或已安装 npm 包，与其他外部插件共用官方 Loader。接入插件必须提供 `adapter` 服务：平台／账号身份、接收能力、文字上限、`start(receive)`、`stop()` 和 `reply(message, text, part, signal)`。它只向 `receive` 交付小狼标准消息；鉴权、OpenID、平台事件和发送格式都留在插件内。替换接入插件不修改聊天编排，也不要求 QQ 凭证。接入插件卸载时应通过 `ctx.effect()` 停止连接。当前通过重启替换，不支持在线热切换。

`reply` 返回平台回执 ID；明确拒绝与结果未知要分开报告。主链路保存分段发送意图和回执，不自动重发未知结果。QQ 插件默认只发关联入站消息的被动回复，采用 5 分钟回复窗口及最多 5 段的保守默认限制；过期不降级为主动推送。

`src/contracts.ts` 定义能力接口；`src/app.ts` 组合提供者；`src/chat.ts` 负责默认聊天流程；`src/plugins.ts` 对接官方 Loader 并检查启动状态。新增工具通过 `ctx.tools.register()` 注册并把返回的清理函数交给插件生命周期。工具默认按有副作用处理，只读工具需显式声明 `effect: 'read'`。更改小狼本体或系统依赖时仍需要更新镜像。

实现参考：[腾讯 QQ 官方 Node.js SDK](https://github.com/tencent-connect/qqbot-nodejs)、[Cordis 官方 Loader](https://github.com/cordiverse/cordis/tree/main/packages/loader)、[Koishi 插件配置](https://koishi.chat/zh-CN/manual/usage/market)。直接依赖上游 Loader，没有复制或另建插件内核。

框架固定为上游 `cordis@4.0.0-rc.10`，不是 Harness 定制版本。Koishi／ChatLuna／Harness 插件不能直接互装；现有项目用于机制参考，没有复制其业务源码。项目自身许可证尚未选择，不以底层库的 MIT 许可证代替项目许可决定。

## 聊天与记忆

在插件列表打开“聊天与记忆”，开启功能并填写百炼对应业务空间／地域的 OpenAI 兼容地址和 API Key。默认向量模型 `text-embedding-v4`，1024 维；密钥留空保留已有值，保存后应用配置生效。可用环境变量 `BAILIAN_API_KEY` 提供密钥。未启用时保持原来的文字历史逻辑；缺少向量凭证或服务故障时使用关键词检索，面板明确显示状态。

“聊天与记忆”页面可搜索、添加、纠正、删除、置顶，并查看原文来源。聊天详情可看该轮使用的记忆和摘要。聊天原文、记忆文本、摘要及来源都保存在现有 SQLite 中，向量只作检索索引；更换模型、维度或地址后自动重新索引，不改变记忆文本。后台每批提炼记忆，未触发回复的消息也参与；已确认的机器人回复只作对话背景，不作为用户事实。

近期原文按当前聊天顺序读取，人物资料和经历全局召回，不按群／私聊限制记忆访问。提示词附当前北京时间、发言人和来源。删除或纠正会移除旧索引、失效相关摘要，并抑制旧来源重新提炼；原文仍可在后台追溯。普通记忆随时间降低召回权重，重要或置顶记忆不随时间淡化，明确到期的记忆不自动召回。

当前消息的图片直接作为多模态输入交给回复模型；收到图片后立即排队生成短描述，后续历史及摘要只带逐张图片编号、描述和来源。需要评价或核实历史图片时使用 `inspect_chat_image(imageId, question)` 取回指定原图，直接交给本轮回复模型；不再由工具额外调用模型转成答案。QQ 原图链接及所属消息构成查图依据，不自动附带上一张原图。原图由 QQ 托管，不在 NAS 落盘，不保留跨请求的原图缓存；图片文字描述持久保存并复用。当前支持 QQ 图片地址，原图不压缩，每张最多 8 MiB、单轮默认最多 3 张；图片暂时无法读取时明确标注，不假装已识别。没有额外部署视觉服务或向量数据库容器。

### 官方外挂交付

`npm run build` 同时生成 `dist/host/src/` 宿主运行代码和 `dist/plugins/` 独立插件包。镜像仅复制宿主，QQ、DeepSeek、触发、记忆、人设及具体工具的业务实现不在镜像内。CI 分别产出 `xiaolang-linux-amd64.tar.gz` 与 `xiaolang-plugins.tar.gz`，并附校验和；后者部署到 NAS 的 `plugins/` 挂载目录。后续 CI 另上传 `xiaolang-plugins-<提交号>` 独立 Artifact，普通外挂更新无需下载完整镜像。

普通外挂更新替换对应目录后重启即可；变更宿主公共 API、Node 或镜像依赖才需新镜像。`src/plugin-api.ts` 是 v1 公共接口，宿主生成 `_runtime.mjs` 供外挂复用类型身份和用量统计上下文。外挂通过 Cordis `inject` 等待服务，通过 `ctx.effect()` 释放资源。侧车可声明 `cleanup` 相对模块，导出 `cleanup` 对象，在宿主删除事务内清理自己拥有的数据；这个接口在插件停用时仍保留。
