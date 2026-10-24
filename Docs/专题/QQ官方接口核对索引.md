# QQ 官方接口核对索引

接口核对日期：2026-10-23；实现状态整理：2026-10-24。用于对应[能力核对与修复清单](QQ官方接口能力核对与修复清单.md)。

R01～R15 已实现。表中 R 编号对应的接入应与[修复清单第 7 节](QQ官方接口能力核对与修复清单.md#7-本轮实现状态2026-10-24-复核)一起阅读；其他“未接”仍表示可选扩展，不表示已取得账号权限。

本索引列出核对时官方导航中已读取的生成接口／事件入口，以及频道扩展文档。仅表示文档与代码静态核对，不表示用当前 AppID 实际调用成功；同类旧版／新版入口可能并存，不能把页面数量当能力数量。

## HTTP 接口

| 官方接口 | 小狼现状／本轮归属 |
| --- | --- |
| [删除子频道](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/channels_channel_id.delete.html) | 未接；频道场景扩展 |
| [获取子频道详情](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/channels_channel_id.get.html) | 未接；频道场景扩展 |
| [修改子频道](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/channels_channel_id.patch.html) | 未接；频道场景扩展 |
| [获取通用 WSS 接入点](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/gateway.get.html) | 由 SDK 使用 |
| [获取频道详情](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/guilds_guild_id.get.html) | 未接；频道场景扩展 |
| [获取子频道列表](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/guilds_guild_id_channels.get.html) | 未接；频道场景扩展 |
| [创建子频道](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/guilds_guild_id_channels.post.html) | 未接；频道场景扩展 |
| [互动事件响应](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/interactions_interaction_id.put.html) | 未接；可选扩展 |
| [获取机器人详情](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/users_me.get.html) | 未接；可选扩展 |
| [获取机器人频道列表](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/users_me_guilds.get.html) | 未接；频道场景扩展 |
| [生成分享链接](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_generate_url_link.post.html) | 未接；可选扩展 |
| [群聊分片上传完成](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_id_upload_part_finish.post.html) | 未接；可选扩展 |
| [群聊富媒体预上传](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_id_upload_prepare.post.html) | 未接；可选扩展 |
| [入群申请审批](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_approval_join_request_member_openid.post.html) | 未接；可选扩展 |
| [群成员批量移除](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_batch_remove_members.post.html) | 未接；可选扩展 |
| [获取机器人群内状态](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_bot_state.get.html) | 已接可选缓存查询；R11，仍受白名单权限限制 |
| [群聊富媒体上传](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_files.post.html) | 未接；可选扩展 |
| [获取群基本信息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_info.get.html) | 已接群名缓存；其他字段未提供 |
| [入群申请列表拉取](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_join_request_list.get.html) | 未接；可选扩展 |
| [群黑名单查询](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_member_blacklist.get.html) | 未接；可选扩展 |
| [群黑名单操作](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_member_blacklist.post.html) | 未接；可选扩展 |
| [获取群成员列表](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_members.get.html) | 未接；可选扩展 |
| [获取群成员信息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_members_member_openid.get.html) | 未接；可选扩展 |
| [发送群聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html) | 已接；R01、R08、R10 |
| [撤回群聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages_message_id.delete.html) | 未接；可选扩展 |
| [查询群禁言状态](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_restrict_chat_setting.get.html) | 未接；可选扩展 |
| [设置群成员禁言](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_restrict_chat_setting.post.html) | 未接；可选扩展 |
| [查询入群自动审批策略列表](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_join_approval_strategy.get.html) | 未接；可选扩展 |
| [创建入群自动审批策略](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_join_approval_strategy.post.html) | 未接；可选扩展 |
| [删除入群自动审批策略](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_join_approval_strategy_strategy_id.delete.html) | 未接；可选扩展 |
| [修改入群自动审批策略](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_join_approval_strategy_strategy_id.patch.html) | 未接；可选扩展 |
| [执行入群自动审批策略](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_join_approval_strategy_strategy_id_execute.post.html) | 未接；可选扩展 |
| [修改入群自动审批策略的白名单号码](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_join_approval_strategy_strategy_id_whitelist_users.post.html) | 未接；可选扩展 |
| [查询全局自定义菜单](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_menu.get.html) | 未接；可选扩展 |
| [修改全局自定义菜单](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_menu.put.html) | 未接；可选扩展 |
| [查询指令面板列表](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_panels.get.html) | 未接；可选扩展 |
| [创建指令面板](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_panels.post.html) | 未接；可选扩展 |
| [删除指令面板](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_panels_panel_id.delete.html) | 未接；可选扩展 |
| [查询指令面板详情](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_panels_panel_id.get.html) | 未接；可选扩展 |
| [修改指令面板](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_panels_panel_id.put.html) | 未接；可选扩展 |
| [修改指令面板关联对象](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_panels_panel_id_target.put.html) | 未接；可选扩展 |
| [单聊分片上传完成](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_id_upload_part_finish.post.html) | 未接；可选扩展 |
| [单聊富媒体预上传](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_id_upload_prepare.post.html) | 未接；可选扩展 |
| [单聊富媒体上传](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_files.post.html) | 未接；可选扩展 |
| [发送单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html) | 已接；R01、R08、R10 |
| [撤回单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages_message_id.delete.html) | 未接；可选扩展 |
| [流式发送单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html) | 已接；R01、R08～R10 |

## 事件

| 官方事件 | 小狼现状／本轮归属 |
| --- | --- |
| [单聊消息事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html) | 已接；R01～R07 |
| [单聊消息接收开启](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_msg_receive.html) | 未接业务处理；R11 |
| [单聊消息接收关闭](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_msg_reject.html) | 未接业务处理；R11 |
| [子频道创建](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/channel_create.html) | 未接；频道场景扩展 |
| [子频道删除](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/channel_delete.html) | 未接；频道场景扩展 |
| [子频道更新](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/channel_update.html) | 未接；频道场景扩展 |
| [用户添加好友](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/friend_add.html) | 未接业务处理；R11 |
| [用户删除好友](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/friend_del.html) | 未接业务处理；R11 |
| [机器人加入群聊](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_add_robot.html) | 未接业务处理；R11 |
| [群@机器人消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html) | 已接；R01～R07 |
| [机器人退出群聊](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_del_robot.html) | 未接业务处理；R11 |
| [用户申请加群事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_join_request.html) | 未接；可选扩展 |
| [群成员加入](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_member_add.html) | 未接；可选扩展 |
| [群成员退出](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_member_remove.html) | 未接；可选扩展 |
| [群消息（全量模式）](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html) | 已有接收路径；R01～R07，实际推送范围受平台设置影响 |
| [群聊消息接收开启](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_msg_receive.html) | 未接业务处理；R11 |
| [群聊消息接收关闭](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_msg_reject.html) | 未接业务处理；R11 |
| [频道创建](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/guild_create.html) | 未接；频道场景扩展 |
| [频道解散](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/guild_delete.html) | 未接；频道场景扩展 |
| [频道更新](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/guild_update.html) | 未接；频道场景扩展 |
| [互动事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/interaction_create.html) | 未接；可选扩展 |
| [订阅消息授权状态变更](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/subscribe_message_status.html) | 未接；可选扩展 |

## 频道与通用旧版参考

当前小狼 QQ 适配器不接受频道／频道私信消息。以下业务能力作为频道扩展清单，模型对象／通用协议页面用于核对字段；已标废弃的接口不建议新增接入。通用 WSS 能力由现有 SDK 负责，不属于频道功能缺失。

- [频道模块](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/index.html)
- [频道消息事件](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/message/event.html)
- [表情对象](https://bot.q.qq.com/wiki/develop/api-v2/openapi/emoji/model.html)
- [业务报错返回的数据信息(Data)](https://bot.q.qq.com/wiki/develop/api-v2/openapi/error/data/model.html)
- [错误与调试](https://bot.q.qq.com/wiki/develop/api-v2/openapi/error/error.html)
- [删除频道成员](https://bot.q.qq.com/wiki/develop/api-v2/openapi/member/delete_member.html)
- [获取成员详情](https://bot.q.qq.com/wiki/develop/api-v2/openapi/member/get_member.html)
- [获取频道成员列表](https://bot.q.qq.com/wiki/develop/api-v2/openapi/member/get_members.html)
- [成员对象(Member)](https://bot.q.qq.com/wiki/develop/api-v2/openapi/member/model.html)
- [表情表态对象](https://bot.q.qq.com/wiki/develop/api-v2/openapi/reaction/model.html)
- [获取用户频道列表](https://bot.q.qq.com/wiki/develop/api-v2/openapi/user/guilds.html)
- [获取用户详情](https://bot.q.qq.com/wiki/develop/api-v2/openapi/user/me.html)
- [用户对象(User)](https://bot.q.qq.com/wiki/develop/api-v2/openapi/user/model.html)
- [获取带分片 WSS 接入点](https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/shard_url_get.html)
- [获取通用 WSS 接入点](https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/url_get.html)
- [获取机器人在频道可用权限列表](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/api_permissions/get_guild_api_permission.html)
- [接口权限对象](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/api_permissions/model.html)
- [发送机器人在频道接口权限的授权链接](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/api_permissions/post_api_permission_demand.html)
- [删除子频道公告（2022年3月15日后废弃）](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/announces/delete_channel_announces.html)
- [删除频道公告](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/announces/delete_guild_announces.html)
- [公告对象(Announces)](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/announces/model.html)
- [创建子频道公告（2022年3月15日后废弃）](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/announces/post_channel_announces.html)
- [创建频道公告](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/announces/post_guild_announces.html)
- [音频控制](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/audio/audio_control.html)
- [机器人下麦](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/audio/delete_mic.html)
- [语音对象](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/audio/model.html)
- [机器人上麦](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/audio/put_mic.html)
- [删除帖子](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/forum/delete_thread.html)
- [论坛事件对象(ForumEvent)](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/forum/forum.html)
- [获取帖子详情](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/forum/get_thread.html)
- [获取帖子列表](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/forum/get_threads_list.html)
- [论坛对象(forum)](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/forum/model.html)
- [开放论坛事件对象(OpenForumEvent)](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/forum/open_forum.html)
- [发表帖子](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/forum/put_thread.html)
- [删除精华消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/pins/delete_pins_message.html)
- [获取精华消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/pins/get_pins_message.html)
- [精华消息对象(PinsMessage)](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/pins/model.html)
- [添加精华消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/pins/put_pins_message.html)
- [删除日程](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/schedule/delete_schedule.html)
- [获取日程详情](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/schedule/get_schedule.html)
- [获取频道日程列表](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/schedule/get_schedules.html)
- [日程对象(Schedule)](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/schedule/model.html)
- [修改日程](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/schedule/patch_schedule.html)
- [创建日程](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/schedule/post_schedule.html)
- [子频道对象(Channel)](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/manage/channel/model.html)
- [频道对象(Guild)](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/manage/guild/model.html)
- [用户对象(User)](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/manage/user/model.html)
- [频道私信](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/message/dms.html)
- [内嵌格式](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/message/format.html)
- [撤回子频道消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/message/recall.html)
- [发送子频道消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/message/send.html)
- [获取频道和当前人信息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/miniapp/interface.html)
- [开放数据域加密](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/miniapp/opendata.html)
- [获取子频道用户权限](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/channel_permissions/get_channel_permissions.html)
- [获取子频道身份组权限](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/channel_permissions/get_channel_roles_permissions.html)
- [子频道权限对象(ChannelPermissions)](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/channel_permissions/model.html)
- [修改子频道用户权限](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/channel_permissions/put_channel_permissions.html)
- [修改子频道身份组权限](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/channel_permissions/put_channel_roles_permissions.html)
- [删除频道身份组成员](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/delete_guild_member_role.html)
- [删除频道身份组](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/delete_guild_role.html)
- [获取频道身份组列表](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/get_guild_roles.html)
- [修改频道身份组](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/patch_guild_role.html)
- [创建频道身份组](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/post_guild_role.html)
- [创建频道身份组成员](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/put_guild_member_role.html)
- [音视频/直播子频道成员进出事件](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role/audio_or_live_channel_member.html)
- [获取子频道在线成员数](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role/get_online_nums.html)
- [频道成员事件](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role/guild_member.html)
- [删除频道成员](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role/member/delete_member.html)
- [获取频道成员详情](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role/member/get_member.html)
- [获取频道成员列表](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role/member/get_members.html)
- [获取频道身份组成员列表](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role/member/get_role_members.html)
- [成员对象(Member)](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role/member/model.html)
- [频道身份组对象(Role)](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role/member/role_model.html)
- [频道指定成员禁言](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/speak/patch_guild_member_mute.html)
- [频道全员禁言](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/speak/patch_guild_mute.html)
- [频道批量成员禁言](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/speak/patch_guild_mute_multi_member.html)
- [获取频道消息频率的设置详情](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/speak/setting/message_setting.html)
- [频道消息频率设置对象 (MessageSetting)](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/speak/setting/model.html)

## 协议、消息类型和交互参考

- [群管理](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/group/manage/index.html)
- [自定义菜单与指令面板](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/menu-panel/index.html)
- [API 调用指南](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html)
- [事件](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/user/manage/event.html)
- [通用数据结构](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html)
- [Webhook 方式](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html)
- [WebSocket 方式](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html)
- [素材管理](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/material-management.html)
- [消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)
- [富媒体消息概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html)
- [消息对象(Message)](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/template/model.html)
- [表情表态](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/emoji.html)
- [消息按钮](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/msg-btn.html)
- [消息交互概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/overview.html)
- [文本交互](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/text-chain.html)
- [结构化卡片消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/ark.html)
- [Embed 消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/embed.html)
- [Markdown 消息](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html)
- [消息类型](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/overview.html)
