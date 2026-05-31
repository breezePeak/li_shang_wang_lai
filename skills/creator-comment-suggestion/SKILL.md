---

name: creator-comment-suggestion
description: Generate exactly one safe, natural Chinese comment suggestion for creator interaction scenarios based only on provided work context. Use this skill whenever another agent, workflow, or execution skill needs a comment draft before replying, returning a visit, or interacting with a creator's work.
---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

# Creator Comment Suggestion

This skill generates one safe, natural Chinese comment suggestion for creator interaction scenarios.

It is designed to be used by humans, agents, or other skills. It only produces comment text. It does not open pages, scan notifications, like works, post comments, approve actions, operate browsers, or execute platform actions.

## Primary goal

Generate exactly one short Chinese comment that feels like a real person left it after viewing the creator's work.

The comment should be:

* natural
* restrained
* safe
* short
* relevant when context is available
* not promotional
* not exaggerated
* not like mutual-follow wording
* not like a batch comment
* not like an automated reply

## When to use this skill

Use this skill when the caller needs:

* a return-visit comment suggestion
* a short comment for another creator's work
* a natural creator interaction comment
* a comment draft before an execution workflow
* a safer rewrite of a planned comment
* a comment that avoids mutual-follow, return-visit, spam, or automation traces

Example user or agent intents:

* “根据这个作品内容生成一条评论”
* “帮我生成一条回访评论”
* “生成一条自然点的评论”
* “这个执行流程需要评论文本”
* “帮我把这条评论改得不像机器人”
* “根据作品上下文给一个可发布评论”

## When not to use this skill

Do not use this skill for:

* clicking like
* posting the comment
* opening profile pages
* scanning notifications
* approving or confirming actions
* bypassing login, captcha, sliders, rate limits, or platform risk controls
* generating spam
* generating aggressive growth-hacking comments
* generating advertising, solicitation, harassment, or abusive comments
* generating long social media posts
* generating multiple comment candidates

## Input contract

The caller should provide as much of the following context as available.

```json
{
  "authorName": "",
  "workTitle": "",
  "captionText": "",
  "hashtags": [],
  "visibleTextSample": "",
  "referenceComments": [],
  "sourceCommentText": "",
  "agentDisplayName": ""
}
```

Field meaning:

* `authorName`: creator nickname, optional.
* `workTitle`: title of the target work, optional.
* `captionText`: work caption, subtitle, description, or extracted text, optional.
* `hashtags`: visible topics or tags, optional.
* `visibleTextSample`: visible page text sample, optional.
* `referenceComments`: existing comments under the work, optional.
* `sourceCommentText`: the other person's previous comment to the user, optional.
* `agentDisplayName`: optional public-facing persona name configured by the user.

Only use the information provided by the caller.

Do not invent unseen people, places, products, events, emotions, actions, viewing experiences, purchase experiences, test results, or personal behavior.

If context is weak, generate a safe generic comment rather than fabricating specifics.

## Output contract

Return exactly one Chinese comment text.

Do not return:

* JSON
* markdown
* explanations
* titles
* labels
* numbering
* multiple candidates
* quotation marks around the comment
* safety analysis
* execution instructions
* claims that any action has already been performed

The output must be directly usable as a comment.

## Persona name rule

`agentDisplayName` is optional and user-configurable.

If `agentDisplayName` is provided:

* The comment may naturally include it.
* Use it as a light public-facing persona name.
* Do not mention internal relationships such as “主人”.
* Do not make the persona sound like a bot, tool, worker, or automation system.

Good examples:

* `{agentDisplayName}觉得这个思路挺清楚`
* `{agentDisplayName}看着感觉挺实在`
* `{agentDisplayName}觉得细节挺到位`

Bad examples:

* `{agentDisplayName}替主人来回访`
* `{agentDisplayName}自动生成一条评论`
* `{agentDisplayName}已赞已评`
* `{agentDisplayName}来支持一下`
* `{agentDisplayName}根据上下文觉得不错`

If `agentDisplayName` is not provided:

* Do not invent a persona name.
* Generate a normal natural comment.

## Length rules

If the comment includes `agentDisplayName`:

* Prefer 14 to 36 Chinese characters.

If the comment does not include `agentDisplayName`:

* Prefer 8 to 30 Chinese characters.

Avoid long comments. A good creator interaction comment should feel like a real short comment, not a paragraph.

## Forbidden words and phrases

The comment must not contain:

```text
回访
互关
互赞
已赞
已评
求关注
来看看你
支持一下
路过
打卡
三连
求回
已关注
关注我
私信
加微信
加V
广告
推广
引流
带货
返现
刷粉
刷赞
系统生成
自动回复
机器人
AI生成
任务
采集
根据上下文
主人
账号主人
我主人
```

Also avoid strong hype words:

```text
炸裂
封神
绝了
无敌
顶级
天花板
太牛了
狠狠学到了
受益匪浅
```

## Behavior claim rule

Do not claim the user did something unless the input explicitly supports it.

Avoid fabricated behavior such as:

```text
收藏了
转发了
试过了
买了
去了
用过了
学会了
马上安排
已经关注
已经点赞
已三连
```

Good:

```text
这个方法挺有参考
这个思路挺清楚
这个场景挺实用
```

Bad:

```text
收藏了回头试试
我也买了同款
已经按你说的做了
已赞已关注
```

## Reference comment rule

Use `referenceComments` only to understand the tone of the comment area.

Do not copy any reference comment verbatim.

Do not generate a comment that is only a minor rewrite of an existing comment.

If many reference comments say the same thing, choose a different natural angle.

## Title repetition rule

Do not simply repeat `workTitle`.

Good:

```text
这个拆解思路挺清楚
```

Bad:

```text
剪映三步做字幕教程真不错
```

## Punctuation and symbol rules

Do not use:

* emoji
* emoticons
* exclamation marks
* repeated punctuation
* decorative symbols
* excessive commas

Avoid:

```text
！！
~~
哈哈哈哈
👏
👍
😂
```

Use simple punctuation or no punctuation.

## Sensitive content rule

If the content involves any of the following, do not generate a confident or advisory comment:

* medical diagnosis or treatment
* financial investment advice
* legal advice
* politics or public controversy
* personal privacy
* crime or illegal behavior
* insults or attacks
* minors in risky contexts
* tragedy, disaster, self-harm, or violence
* sexual or vulgar content

For sensitive content, output a neutral safe comment only when appropriate.

Safe examples:

```text
这个表达挺克制的
内容看着挺认真
```

If no safe comment can be made, output:

```text
需要人工判断
```

## Content strategy

Classify the work context loosely and choose the safest matching style.

### Tutorial, method, tips, learning content

Use themes like:

* clear
* practical
* useful
* detailed
* easy to follow

Examples without persona:

```text
这个步骤拆得挺清楚
这个方法挺有参考
细节讲得挺到位
```

Examples with persona:

```text
{agentDisplayName}觉得步骤挺清楚
{agentDisplayName}觉得方法挺落地
{agentDisplayName}觉得细节挺到位
```

### Opinion, review, thinking, analysis

Use themes like:

* angle
* clarity
* useful perspective
* thinking

Examples without persona:

```text
这个角度挺有启发
这段分析挺清楚
这个观点挺有意思
```

Examples with persona:

```text
{agentDisplayName}觉得这个角度不错
{agentDisplayName}看完觉得挺有启发
```

### Life, daily, vlog, personal sharing

Use themes like:

* natural
* real
* relatable
* comfortable rhythm

Examples without persona:

```text
表达挺自然的
这条看着挺真实
节奏看着挺舒服
```

Examples with persona:

```text
{agentDisplayName}觉得表达挺自然
{agentDisplayName}看着感觉挺真实
```

### Tools, software, AI, productivity

Use themes like:

* practical scenario
* clear use case
* problem-solving
* workflow

Examples without persona:

```text
这个场景确实挺实用
这个思路挺能解决问题
工具用法讲得挺清楚
```

Examples with persona:

```text
{agentDisplayName}觉得这个场景挺实用
{agentDisplayName}觉得工具思路挺清楚
```

### Technology, code, development

Use themes like:

* clear logic
* solid details
* implementation value
* engineering thinking

Examples without persona:

```text
这个思路挺清晰
细节处理得挺扎实
这个方案挺有实践价值
```

Examples with persona:

```text
{agentDisplayName}觉得代码思路挺清楚
{agentDisplayName}觉得细节挺扎实
```

### Weak or unclear context

When context is weak, do not invent details.

Use safe generic comments.

Examples without persona:

```text
内容挺有参考
这条看着挺用心
表达挺自然的
这个分享挺实在
```

Examples with persona:

```text
{agentDisplayName}觉得内容挺有参考
{agentDisplayName}觉得这条挺用心
{agentDisplayName}看着感觉挺自然
{agentDisplayName}觉得这个分享挺实在
```

Do not use:

```text
支持一下
内容不错
挺好的
```

These sound too generic and too much like batch interaction.

## Quality checklist

Before returning the final comment, silently verify:

1. Is it exactly one comment?
2. Is it Chinese?
3. Is it short enough?
4. Does it avoid all forbidden words?
5. Does it avoid automation traces?
6. Does it avoid mutual-support traces?
7. Does it avoid fabricated actions?
8. Does it avoid direct title repetition?
9. Does it avoid copying reference comments?
10. Does it sound like a real person?
11. Is it safe to publish directly?

If any check fails, revise before output.

## Examples

Input:

```json
{
  "workTitle": "剪映教程：三步做字幕",
  "captionText": "这条视频讲了字幕样式和关键帧设置，适合新手直接上手。",
  "hashtags": ["剪映", "教程"],
  "referenceComments": ["讲得好细", "收藏了"],
  "agentDisplayName": "小猿"
}
```

Output:

```text
小猿觉得步骤拆得挺清楚
```

Input:

```json
{
  "workTitle": "技术复盘：接口慢查询定位",
  "captionText": "从日志和链路追踪入手，定位慢查询并优化索引。",
  "hashtags": ["开发", "后端"],
  "referenceComments": ["这个角度挺有启发"],
  "agentDisplayName": ""
}
```

Output:

```text
这个思路挺清晰
```

Input:

```json
{
  "workTitle": "",
  "captionText": "",
  "hashtags": [],
  "visibleTextSample": "作品详情 评论 分享",
  "referenceComments": [],
  "agentDisplayName": "小助理"
}
```

Output:

```text
小助理觉得这条挺用心
```
