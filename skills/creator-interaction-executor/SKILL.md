---

name: creator-interaction-executor
description: Execute creator interaction workflows after explicit user confirmation, such as scanning interactions, preparing return visits, liking works, posting approved comments, and recording results. When a comment draft is needed, this skill must load and use creator-comment-suggestion from ../creator-comment-suggestion/SKILL.md.
-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

# Creator Interaction Executor

This skill handles creator interaction workflows.

It may help inspect interactions, prepare return visits, open target works, check page state, like works, post approved comments, and record results.

This skill controls workflow and execution. It must not freely generate comment text. When a comment is needed, it must load and use the companion skill:

```text
../creator-comment-suggestion/SKILL.md
```

## Required companion skill

Comment generation is delegated to:

```text
creator-comment-suggestion
```

Location in this skill pack:

```text
../creator-comment-suggestion/SKILL.md
```

When this skill needs a comment draft, it must:

1. Extract or receive work context.
2. Read or invoke `creator-comment-suggestion`.
3. Pass the available work context to it.
4. Receive exactly one comment suggestion.
5. Validate the returned comment locally.
6. Show the target and comment to the user when required.
7. Execute only after explicit confirmation if a real platform action is involved.

Do not generate comment text freely inside this skill.

Do not duplicate or override the full comment-generation rules here. The source of truth for comment wording is `creator-comment-suggestion`.

## Core responsibility

This skill may help with:

* checking interaction notifications
* summarizing pending comments or likes
* identifying candidate creators for return visits
* opening a target profile or work
* extracting work context
* preparing a return visit
* checking like state
* liking a work after confirmation
* posting an approved comment after confirmation
* recording success, skipped, blocked, failed, or unverified results

The goal is to keep creator interaction operations safe, explicit, auditable, and controlled.

## Host capability rule

This skill can only use tools and commands that are actually available in the current runtime.

If the host project or agent environment does not provide a required operation, report that the operation is unsupported instead of pretending it exists.

Examples:

* If there is no tool to open a specific profile URL, do not claim that a single-person return visit can be performed.
* If there is no command to execute a selected task, do not claim the task was executed.
* If only preparation is supported, prepare and report the next required step.
* If only scanning is supported, scan and summarize.

Never fabricate tool results.

## When to use this skill

Use this skill for requests such as:

* “看看谁给我点赞了”
* “看看谁评论我了”
* “帮我整理互动通知”
* “帮我准备回访”
* “生成待回访任务”
* “执行待回访任务”
* “检查执行结果”
* “哪些互动还没处理”
* “继续处理待回访”
* “打开这个作品准备评论”
* “给这个作品点个赞并评论”
* “把这条评论发出去”

Use this skill for “帮我回访这个人” only if the host environment provides a concrete target such as:

* current opened profile
* profile URL
* user ID
* existing task ID
* target work URL
* supported command for single-target preparation or execution

If no such target or capability exists, explain that the current environment does not support direct single-person return visit and offer the available preparation/scanning path.

## When not to use this skill

Do not use this skill for:

* general writing unrelated to creator interaction
* image generation
* unrelated social media copywriting
* bulk spam
* aggressive growth-hacking operations
* evading platform restrictions
* scraping private data
* bypassing login, captcha, slider, or risk controls
* executing actions without confirmation
* unattended loops
* generating comments directly without `creator-comment-suggestion`

## Hard safety rules

### 1. Default to preview

Unless the user explicitly asks to execute, send, or confirm, only preview.

Allowed preview actions include:

* scan
* summarize
* prepare
* draft
* validate
* dry-run
* show candidate
* ask for confirmation

Preview mode must not:

* click like
* submit comments
* follow users
* repeat interactions
* mark real actions as completed

### 2. Explicit confirmation is required

Real platform actions require explicit confirmation.

Valid confirmation examples:

```text
确认执行
执行
发送
就发这条
可以，发
确认发送
```

Invalid confirmation examples:

```text
看看
准备一下
生成一下
感觉还行
再优化下
先放着
试试看
```

Ambiguous messages are not confirmation.

### 3. Show the user what will happen

Before executing a real action, show:

* target user
* target work title or URL
* planned action
* comment text, if a comment will be sent
* known risks or blocked states

Do not execute if the user has not seen the comment text, unless the host environment explicitly treats a previously stored approved comment as already reviewed and approved.

### 4. Stop on unknown state

If any critical state is unknown, stop.

Critical states include:

* login state
* captcha or platform risk state
* target profile identity
* target work identity
* like state
* comment input state
* duplicate execution state
* comment validation state

Unknown means blocked, not “try anyway”.

### 5. No unattended batch execution

Do not run unattended batch liking, commenting, following, or return visiting.

Each real action must be traceable to a clear user request, stored task, allowed workflow, or explicit confirmation.

### 6. Do not bypass platform protections

If login, captcha, slider, rate limit, risk control, or suspicious activity warning appears:

* stop immediately
* report the issue
* do not attempt bypass
* do not suggest evasion

## Comment generation flow

Whenever a comment is required, use this flow:

```text
extract work context
  ↓
load ../creator-comment-suggestion/SKILL.md
  ↓
send context to creator-comment-suggestion
  ↓
receive exactly one comment text
  ↓
validate comment locally
  ↓
continue preparation or ask for confirmation
```

The context sent to `creator-comment-suggestion` should use this structure:

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

Only pass real collected or user-provided fields.

Missing fields should be empty. Do not invent missing context.

## Comment local validation

After receiving a comment from `creator-comment-suggestion`, validate it again before use.

Reject the comment if it:

* is empty
* is not mainly Chinese
* contains 回访、互关、互赞、已赞、已评、求关注、来看看你、支持一下、路过、打卡
* contains 私信、加微信、加V、广告、推广、引流
* contains 系统生成、自动回复、任务、采集、根据上下文
* contains 主人、账号主人、我主人
* contains emoji, emoticons, exclamation marks, or repeated punctuation
* directly copies an existing reference comment
* directly repeats the work title
* fabricates behavior such as 收藏了、转发了、试过了、买了、去了
* comments on appearance, body, age, income, location, or private details
* makes medical, legal, financial, political, or other high-risk claims

If validation fails:

* do not execute
* ask `creator-comment-suggestion` for another safer comment if possible
* or ask the user to edit manually
* or mark the item as blocked / needs manual review, depending on host capability

## Return visit meaning

In this skill, a return visit means:

```text
open target work
check like state
like if not already liked
post an approved comment
verify result
record final status
```

A return visit is complete only when:

```text
likeStatus is liked or already_liked
and
commentStatus is posted or confirmed
```

Already liked does not mean return visit is complete.

If the work is already liked, continue to the approved comment step unless duplicate-comment protection blocks it.

## Standard return visit workflow

Use this workflow when the user asks to prepare or execute a return visit and the host environment supports the required steps.

```text
receive user request
  ↓
identify candidate interaction or target profile/work
  ↓
open target profile or work
  ↓
extract work context
  ↓
load creator-comment-suggestion
  ↓
generate exactly one comment
  ↓
validate returned comment
  ↓
store or show prepared task
  ↓
wait for explicit confirmation if required
  ↓
open or re-check target work
  ↓
check like state
  ↓
like if not already liked
  ↓
locate comment input
  ↓
post approved comment
  ↓
verify result
  ↓
record final status
  ↓
report result to user
```

If the host environment only supports preparation, stop after generating and validating the comment, then report the prepared result.

If the host environment only supports executing stored tasks, do not attempt ad-hoc profile return visits.

## Standard comment reply workflow

Use this workflow when replying to a comment on the user's own work.

```text
receive user request
  ↓
identify source comment
  ↓
extract source comment and work context
  ↓
generate or receive reply text
  ↓
validate reply text
  ↓
show target comment and reply to user
  ↓
wait for explicit confirmation
  ↓
open correct comment location
  ↓
send approved reply
  ↓
verify result
  ↓
record final status
  ↓
report result to user
```

If a reply requires a natural comment draft, use `creator-comment-suggestion` with the available context.

## Duplicate protection

Before executing, check whether the same or equivalent action already succeeded.

Block or skip if:

* the same event was already processed successfully
* the same work already has a recorded successful return visit
* the same comment text was already posted
* the platform visibly shows an existing comment by the same account and the workflow cannot safely distinguish it

Do not post repeated comments to the same work without a new explicit user instruction.

## Page interaction rules

Before clicking like:

* confirm the current page is the target work
* confirm the like button has been identified
* confirm current like state
* do not click if state is unknown

Before posting a comment:

* confirm the comment input belongs to the work comment area
* avoid global search input
* avoid unrelated text boxes
* reject inputs whose placeholder, id, class, or surrounding container indicates search
* do not use a generic input selector without comment-area constraints

## Blocking conditions

Stop and report blocked if:

* login is required
* captcha appears
* slider appears
* risk control appears
* target profile cannot be opened
* target work cannot be confirmed
* target work URL is missing
* like state is unknown
* like button cannot be confirmed
* comment input cannot be confirmed
* comment text is empty
* comment text fails validation
* duplicate successful action exists
* user has not explicitly confirmed
* network or page error prevents safe verification
* host capability for the requested operation is missing

## Result states

Use these final statuses:

```text
done
skipped
blocked
failed
sent_unverified
unsupported
```

Use `done` only when the action was confirmed successful.

Use `sent_unverified` when a comment appears submitted but cannot be confirmed.

Use `unsupported` when the host environment lacks the required tool or command.

Do not report `done` if verification failed.

## Result report

After execution or preparation, report clearly:

* final status
* target user
* target work
* like status
* comment status
* comment text
* failure step if any
* reason if any

Example success report:

```text
已完成回访：
目标用户：xxx
目标作品：xxx
点赞状态：已点赞
评论状态：已发布
评论内容：xxx
```

Example blocked report:

```text
已阻断，未执行：
原因：点赞状态无法确认
当前步骤：check-like-state
```

Example unsupported report:

```text
当前环境不支持直接回访指定用户：
缺少 profileUrl / taskId / 当前目标页 或对应执行工具。
可以先执行互动扫描，生成待回访任务后再处理。
```

Example unverified report:

```text
评论已尝试发送，但未确认成功：
点赞状态：已点赞
评论状态：未确认
建议人工检查当前作品页
```

## Reporting style

Be direct and concise.

Do not exaggerate success.

Do not say an action was completed unless it was verified.

Do not hide skipped, blocked, unsupported, or failed results.

Do not encourage aggressive growth tactics.

## Skill boundary summary

This skill controls interaction workflow and execution.

`creator-comment-suggestion` controls comment wording.

When in doubt:

* do not execute
* do not send
* do not click
* report blocked or unsupported
* ask for explicit confirmation when required
