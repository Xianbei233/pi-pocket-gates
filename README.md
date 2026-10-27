# Pi Pocket 需求追问插件（pi-pocket-gates）

给 Pi Pocket 用的一个扩展：模型要写代码之前，先在会话旁边弹一个中文面板问你需求；你答完它才能动手，而且每一步都要留痕，换成别的模型也能接上。

## 它解决什么

模型最常见的两种烂活：

1. **猜需求**。你说「做个 X」，它自己脑补 30 个细节，最后成品和你想的差很远。
2. **想一步做一步**。一次只发一个工具调用，轮次翻几倍，账单跟着翻几倍。

这个插件把这两件事变成机械门禁：需求没问清，不许写文件；没有开工声明，不许写文件；每一步收口必须给出验证命令和退出码。

## 面板在哪

会话右侧的面板按钮里叫「需求追问」。模型调 `spec_ask` 时它会自动弹开。

## 怎么用

1. 模型调 `spec_ask`，一次把 7 个维度的问题问完（目标、行为、数据、失败、安全、验收、不做）。
2. 你在面板里点选项或者写字，提交。
3. 缺口全部补齐后，模型才能改 `specs/` 之外的文件。
4. 模型用 `stage_begin` 声明这一步要改哪些文件、怎么验证；改完用 `stage_end` 收口，必须带上验证命令和真实退出码。
5. 每一步都追加到 `specs/TRACE.md`；`handoff` 生成 `specs/HANDOFF.md`，别的模型读它就能接手。

## 工具

| 工具 | 作用 |
|---|---|
| `spec_ask` | 一次问一批需求问题，阻塞等你在面板回答 |
| `spec_answer` | 你在面板作答（模型一般不用调） |
| `spec_status` | 看还缺哪些维度 |
| `spec_waive` | 某个维度确实不重要，申请跳过（要你在面板点同意） |
| `spec_doc` | 把需求写成 `specs/REQ.md` |
| `stage_begin` | 声明本阶段意图、要改的文件、验证方式 |
| `stage_amend` | 中途要改声明之外的文件，先说明理由（写进 TRACE） |
| `stage_end` | 收口：验证命令 + 退出码 + 文件指纹证据 |
| `handoff` | 生成交接文档 |
| `test_plan` / `test_rerun` / `test_done` / `test_budget` | 测试预算：先声明计划，重复命令不重复跑，收口时自己重跑核对 |

## 安装

```bash
git clone https://github.com/Xianbei233/pi-pocket-interview.git
cd pi-pocket-interview
./install.sh
```

`install.sh` 会把文件拷到 `~/.pi-pocket/extensions/`（已有的先备份）。然后在 Pocket 的扩展页面启用 `pi-pocket-gates.ts`，或者重启 pocket 服务。

## 已知限制

- 只有 owner 能看这个面板（`access: "owner"`）。
- `spec_ask` 会等最多 15 分钟；超时返回「未回答」，模型不许猜。
- 数据存在 Pocket 自己的文档里（kind `x.pi-pocket-spec.interview` / `.ledger`），不依赖外部数据库。
- 门禁只管 `write` / `edit` / `codemode` / `ops_write` / `ops_edit`；绕过工具（比如自写脚本写文件）不在拦截范围。
- 当前面板只显示**当前会话**的问题。跨会话统一收件箱在改。

## 许可

MIT
