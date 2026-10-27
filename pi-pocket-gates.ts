/**
 * Pi Pocket Gates: the mechanical gates that keep one session honest, in one extension.
 *
 * Four rules, none of them advice:
 * 1. Requirements. Nothing outside specs/ is written while a needed requirement dimension is unanswered. spec_ask asks
 *    the owner in a panel beside the conversation; the answers land in the interview document; spec_doc writes REQ.md.
 * 2. Stages. Nothing outside specs/ may be written while no stage is open. stage_begin declares the intent, the files,
 *    and how they will be verified; stage_end requires a command and its exit code; every stage appends to TRACE.md,
 *    and handoff writes HANDOFF.md so another model can take over. A file outside the open stage's range needs a logged
 *    stage_amend first. A requirement dimension is waived only after the owner confirms it in the panel.
 * 3. Bash shape. The model may not call bash directly, in any conversation. Shell work goes through codemode, where it
 *    is one batched script rather than one step per call. A bash call made from inside a codemode script is allowed.
 * 4. Tests. No test command before test_plan; an identical test command does not run twice inside the window (the
 *    earlier exit code and output tail come back instead); a whole-suite command runs only as often as the plan allows
 *    unless test_rerun is approved; test_done closes the step only when its evidence matches recorded runs.
 *
 * The file gates wrap write, edit, codemode, and the vendored ops_write and ops_edit, so a write cannot slip past by
 * switching tools. This module uses only its own Durable documents, the session folder, and public Pocket APIs.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, wrapTool } from "@earendil-works/pi-durable";

type Host = { notice(level: "info" | "warning" | "error", message: string): void };
type Web = {
    readonly api: number;
    readonly module: string;
    route(
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: string,
        handle: (request: any) => unknown,
        options?: { access?: "owner" | "steer" | "view" },
    ): void;
    conversationRoute(
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: string,
        handle: (request: any) => unknown,
        options: { conversation: string; access?: "owner" | "steer" | "view" },
    ): void;
    client(entry: string, options?: { access?: "owner" | "steer" | "view" }): void;
    send(event: string, data?: unknown, options?: { to?: string }): void;
    error(status: number, message: string): Error;
    onDispose(dispose: () => unknown): void;
};

/** The dimensions a requirements document has to settle before code is written. */
const WINDOW_MS = Number(process.env.PI_POCKET_TEST_WINDOW_MS ?? 10 * 60_000);
const MAX_FULL = Number(process.env.PI_POCKET_TEST_MAX_FULL ?? 1);
const MAX_EXTRA = 3;

/** A codemode result above this many bytes goes to disk instead of into the conversation. */
const OUTPUT_BYTES = Number(process.env.PI_POCKET_OUTPUT_BYTES ?? 4000);
const OUTPUT_HEAD = 2600;
const OUTPUT_TAIL = 1000;

/**
 * Keep the head and the tail of an oversized result and say how much was dropped. The whole text still exists on disk,
 * so a reader that needs the middle can go and get it; nothing is silently lost.
 */
export function shrinkText(full: string, limit = OUTPUT_BYTES): { text: string; truncated: boolean; bytes: number } {
    const bytes = Buffer.byteLength(full, "utf8");
    if (bytes <= limit) {
        return { text: full, truncated: false, bytes };
    }
    const dropped = Math.max(0, full.length - OUTPUT_HEAD - OUTPUT_TAIL);
    return {
        // The note goes first: a downstream compressor folds repeated lines, and a tail marker it folds is a marker
        // the model never sees.
        text:
            "[输出过长，已截断：原文 " +
            bytes +
            " 字节，中间省略 " +
            dropped +
            " 个字符。下面是开头和结尾，全文另存为文件。]\n\n" +
            full.slice(0, OUTPUT_HEAD) +
            "\n\n…[中间省略]…\n\n" +
            full.slice(-OUTPUT_TAIL),
        truncated: true,
        bytes,
    };
}

/** A command that runs a test suite: the expensive loop that grows without a plan. */
const SUITE_RE = /\b(pytest|py\.test|vitest|jest|mocha|playwright|node --test|go test|cargo test|ctest|npm (?:run )?test|npm run check|bun (?:run )?test|yarn test|pnpm test)\b/u;

/**
 * A type-check or lint sweep. Cheap, single-target, and never worth a declared plan: a session that has to open a test
 * plan before it may run tsc just learns to avoid tsc. These are deduplicated like a test run and nothing more.
 */
const CHECK_RE = /\b(tsc|eslint|prettier|ruff|mypy|black|golangci-lint|cargo clippy)\b/u;

/** Any command the budget tracks, test suite or check. */
const TEST_RE = new RegExp("(?:" + SUITE_RE.source + ")|(?:" + CHECK_RE.source + ")", "u");

/** A command that runs the whole suite rather than one target. */
const FULL_RE = /(npm (?:run )?test\b|npm run check\b|bun (?:run )?test\b|yarn test\b|pnpm test\b|\btsc\b(?!\s+-p\s)|go test \.\/\.\.\.|cargo test\s*$|pytest\s*$|vitest run\s*$|node --test\s*$)/u;

export type Verdict = { action: "allow" } | { action: "block"; message: string };

export type Seen = { at: number; exitCode: number | null; tail: string; mutation: number };

/** One evidence item after test_done checked it: declared exit code vs. the exit code the plugin itself got. */
export type EvidenceRun = {
    command: string;
    declared: number;
    /** null when the plugin skipped the rerun (slow: true) or could not start it. */
    actual: number | null;
    /** Output tail the plugin captured itself; empty when skipped. */
    tail: string;
    skipped: boolean;
};

export type BudgetState = {
    seen: Map<string, Seen>;
    /** Bumped on every successful file write. A run recorded before the last write is stale, so the same command runs again. */
    mutations: number;
    /** Whole-suite runs already started. */
    full: number;
    /** Extra whole-suite runs the owner or the model asked for, with reasons. */
    extra: { reason: string; at: number }[];
    /** The command the session declared as its target test, once it says which one matters. */
    target: string;
    /** What this step says it will verify, and how many whole-suite runs that plan allows. */
    plan?: TestPlan;
    /** Evidence checked at test_done, with the plugin's own rerun result. */
    evidence?: EvidenceRun[];
    done: boolean;
};

export type TestPlan = { goal: string; checks: string[]; fullLimit: number; at: number };

export const emptyState = (): BudgetState => ({
    seen: new Map(),
    mutations: 0,
    full: 0,
    extra: [],
    target: "",
    plan: undefined,
    done: false,
});

/** Collapse a command to the part that decides whether it is the same run: whitespace, redirects, and output tails. */
export function normalizeCommand(command: string): string {
    return command
        .replace(/\s+/gu, " ")
        // "cd repo && npm test" and "npm test" are the same run; the folder is already the conversation's.
        .replace(/^\s*cd\s+[^&|;]+?&&\s*/iu, "")
        .replace(/^\s*timeout\s+\d+s\s+/u, "")
        .replace(/\s*2>&1/gu, "")
        .replace(/\s*>>?\s*[^\s|;&]+/gu, "")
        .replace(/\s*\|\s*(?:tail|head)\s+(?:-n\s*)?-?\d+\s*$/u, "")
        .replace(/\s*\|\s*(?:grep|echo)\b.*$/u, (match) => match)
        .trim()
        .toLowerCase();
}

export const fingerprint = (command: string): string => normalizeCommand(command);
export const isTestCommand = (command: string): boolean => TEST_RE.test(command);
export const isSuiteCommand = (command: string): boolean => SUITE_RE.test(command);
export const isFullCommand = (command: string): boolean => FULL_RE.test(command);

export function inspect(state: BudgetState, command: string, now = Date.now()): Verdict {
    if (state.done) {
        return {
            action: "block",
            message:
                "测试预算：这个会话已经声明测试完成（test_done）。不要再跑测试命令；把结论交给主规划，或者让主规划开新阶段。",
        };
    }
    if (!isTestCommand(command)) {
        return { action: "allow" };
    }
    const suite = isSuiteCommand(command);
    if (suite && state.plan === undefined) {
        return {
            action: "block",
            message:
                "测试预算：这个会话还没声明测试计划。先调 test_plan({goal, checks}) 写清这一步要验什么、跑哪几条命令、" +
                "全量给几次，再跑测试（tsc/eslint 这类单文件检查不受这条限制）。没有计划的测试只会越跑越多。",
        };
    }
    const key = fingerprint(command);
    const before = state.seen.get(key);
    // A run recorded before the last file change is stale evidence: the code it measured is gone.
    if (before !== undefined && before.mutation === state.mutations && now - before.at < WINDOW_MS) {
        const minutes = Math.round((now - before.at) / 60_000);
        return {
            action: "block",
            message:
                "测试预算：这条命令 " +
                (minutes <= 0 ? "刚刚" : minutes + " 分钟前") +
                " 跑过，退出码 " +
                (before.exitCode === null ? "未取得" : String(before.exitCode)) +
                "。重复跑不会给出新信息，先看上次的输出尾部：\n\n" +
                (before.tail || "（没有记录到输出）") +
                "\n\n重复跑同一条命令不会产生新信息。真要再跑一次全量，用 test_rerun 写清理由，" +
                "负责人点同意才会放行；也不要为了绕过而改写命令。",
        };
    }
    if (suite && isFullCommand(command) && state.plan !== undefined) {
        const limit = state.plan.fullLimit + state.extra.length;
        const allowed = limit;
        if (state.full >= allowed) {
            return {
                action: "block",
                message:
                    "测试预算：全量命令已经跑过 " +
                    state.full +
                    " 次（测试计划给的上限 " +
                    state.plan.fullLimit +
                    "）。要再跑一次，先调 test_rerun 说清楚上次为什么失败、这次改了什么；" +
                    "只是想再看一眼结果的话，直接用上次的退出码和输出。",
            };
        }
    }
    return { action: "allow" };
}

/** A refusal from this module or from another gate: nothing ran, so it must not count as a run. */
const REFUSAL_RE = /^\s*(?:tool gate blocked|batch-guard[：:]|门禁[：:]|测试预算[：:]|pi-pocket-spec[：:])/mu;

export const isRefusal = (text: string): boolean => REFUSAL_RE.test(text);

/**
 * Run one evidence command ourselves. The model can claim any exit code; only an execution here is an external fact.
 */
export function rerunCommand(
    cwd: string,
    command: string,
    timeoutMs = 180_000,
): Promise<{ exitCode: number | null; tail: string }> {
    return new Promise((settle) => {
        let output = "";
        const take = (chunk: Buffer): void => {
            output += chunk.toString("utf8");
            if (output.length > 200_000) {
                output = output.slice(-100_000);
            }
        };
        const child = spawn("/bin/bash", ["-c", command], { cwd, timeout: timeoutMs, env: process.env });
        child.stdout?.on("data", take);
        child.stderr?.on("data", take);
        child.on("error", () => settle({ exitCode: null, tail: "无法启动这条命令" }));
        child.on("close", (code) => settle({ exitCode: code, tail: output.trim().slice(-600) }));
    });
}

export function record(state: BudgetState, command: string, result: unknown, now = Date.now(), streamed = ""): void {
    if (!isTestCommand(command)) {
        return;
    }
    // A codemode run streams its output through the api and only fills result.output after the tool returns, so the
    // streamed text is often the only copy of what the command printed.
    const text = textOf(result) || streamed;
    if (isRefusal(text)) {
        return;
    }
    if (isSuiteCommand(command) && isFullCommand(command)) {
        state.full += 1;
    }
    state.seen.set(fingerprint(command), {
        at: now,
        exitCode: exitCodeOf(result, text),
        tail: text.slice(-700),
        mutation: state.mutations,
    });
}

export function textOf(result: unknown): string {
    if (typeof result === "string") {
        return result;
    }
    if (result === null || typeof result !== "object") {
        return "";
    }
    const shaped = result as any;
    // A bash result carries the retained output as data; codemode's nested result also has the streamed copy in output.
    const retained = shaped?.structuredOutput?.output ?? shaped?.details?.structuredOutput?.output;
    if (typeof retained === "string" && retained !== "") {
        return retained;
    }
    const parts = Array.isArray(shaped.output) ? shaped.output : Array.isArray(shaped.content) ? shaped.content : [];
    const joined = parts
        .map((part: any) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
        .join("");
    if (joined !== "") {
        return joined;
    }
    for (const key of ["text", "result", "stdout"]) {
        if (typeof shaped[key] === "string") {
            return shaped[key];
        }
    }
    return "";
}

/** A tool result may carry its exit code as data; the text is the fallback. */
export function exitCodeOf(result: unknown, text: string): number | null {
    const shaped = result as any;
    for (const candidate of [
        shaped?.exitCode,
        shaped?.details?.exitCode,
        shaped?.code,
        shaped?.structuredOutput?.exitCode,
        shaped?.details?.structuredOutput?.exitCode,
    ]) {
        if (typeof candidate === "number" && Number.isFinite(candidate)) {
            return candidate;
        }
    }
    return exitCodeInText(text);
}

export function exitCodeInText(text: string): number | null {
    const patterns = [/exit(?:=|\scode[:\s]+)(-?\d+)/iu, /退出码[：:\s]*(-?\d+)/u, /exited with (?:code )?(-?\d+)/iu];
    for (const pattern of patterns) {
        const found = pattern.exec(text);
        if (found !== null) {
            const value = Number(found[1]);
            if (Number.isFinite(value)) {
                return value;
            }
        }
    }
    return null;
}


/** 面板显示用的短名；维度键仍是英文，数据不动。 */
export const DIMENSION_SHORT: Readonly<Record<string, string>> = {
    goal: "目标",
    behavior: "行为",
    data: "数据",
    failures: "失败",
    security: "安全",
    acceptance: "验收",
    nongoals: "不做",
};
/** 面板是中文的：模型用英文写的问题与选项，Owner 读不懂，也不该在这里读英文。 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const SPEC_LANG = process.env.PI_POCKET_SPEC_LANG ?? "zh";
const needsChinese = SPEC_LANG === "zh";
const looksChinese = (text: string): boolean => CJK_RE.test(text);
/** 单个词条的选项（v0.25.0、npm test、c65cf99）不算英文散文，放它过去。 */
const proseOption = (label: string): boolean => !looksChinese(label) && /\s/u.test(label.trim());

const DIMENSIONS: ReadonlyArray<readonly [string, string]> = [
    ["goal", "目标、谁用、成功标准"],
    ["behavior", "具体行为与交互"],
    ["data", "输入输出、存哪、生命周期"],
    ["failures", "失败、边界、回滚"],
    ["security", "权限与安全、兼容与迁移"],
    ["acceptance", "可执行的验收方式"],
    ["nongoals", "明确不做"],
];
const LABELS = new Map(DIMENSIONS);
export const DIMENSION_KEYS = DIMENSIONS.map(([key]) => key);

/** 合并前的维度名。旧会话的问答、豁免和模型沿用旧名时，都要落到新的那一格上。 */
const OLD_KEYS: Readonly<Record<string, readonly string[]>> = {
    goal: ["users"],
    data: ["storage"],
    failures: ["rollout"],
    security: ["compat"],
};

/** 任意写法的维度名 → 现在的规范名；认不出来返回 undefined。 */
export const dimensionOf = (key: string): string | undefined => {
    const trimmed = key.trim();
    if (DIMENSION_KEYS.includes(trimmed)) {
        return trimmed;
    }
    for (const [canonical, olds] of Object.entries(OLD_KEYS)) {
        if (olds.includes(trimmed)) {
            return canonical;
        }
    }
    return undefined;
};
const MAX_QUESTIONS = 12;
const MAX_ROUNDS = 40;
const WAIT_MS = Number(process.env.PI_POCKET_SPEC_WAIT_MS ?? 15 * 60_000);

type Question = {
    id: string;
    header: string;
    question: string;
    kind: "single" | "multi" | "text";
    dimension: string;
    options: Array<{ label: string; description?: string }>;
    allowText: boolean;
};

type Waiver = { reason: string; at: number };

type Interview = {
    revision: number;
    round: number;
    title: string;
    status: "idle" | "asking" | "answered";
    questions: Question[];
    answers: Record<string, string[]>;
    waived: Record<string, Waiver>;
    pendingWaive: Record<string, Waiver>;
    askedAt: number;
    answeredAt: number;
};

type Amendment = { reason: string; files: string[]; at: number };

type Stage = {
    n: number;
    title: string;
    intent: string;
    files: string[];
    verify: string;
    open: boolean;
    startedAt: number;
    endedAt?: number;
    result?: string;
    exitCode?: number;
    notes?: string;
    next?: string;
    /** 开工/扩范围时每个声明文件的指纹，收口时逐个对比。 */
    digest?: Record<string, string>;
    /** 收口时算出的改动证据，写进 TRACE.md。 */
    evidence?: Array<{ path: string; before: string; after: string }>;
    amendments: Amendment[];
};

type Ledger = { revision: number; counter: number; stages: Stage[] };

const emptyInterview = (): Interview => ({
    revision: 0,
    round: 0,
    title: "",
    status: "idle",
    questions: [],
    answers: {},
    waived: {},
    pendingWaive: {},
    askedAt: 0,
    answeredAt: 0,
});

const emptyLedger = (): Ledger => ({ revision: 0, counter: 0, stages: [] });

// Stored contracts: do not rename or change scope/history/fork after installation.
const InterviewDoc = defineDoc<Interview>({
    kind: "x.pi-pocket-spec.interview",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: emptyInterview,
});

const LedgerDoc = defineDoc<Ledger>({
    kind: "x.pi-pocket-spec.ledger",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: emptyLedger,
});

const openStage = (ledger: Ledger): Stage | undefined => ledger.stages.find((stage) => stage.open);

/** Every dimension a person answered or a person confirmed as deliberately unchecked. */
const settled = (doc: Interview): Set<string> => {
    const done = new Set<string>();
    for (const question of doc.questions) {
        const answer = doc.answers[question.id];
        const key = dimensionOf(question.dimension);
        if (key !== undefined && answer !== undefined && answer.some((each) => each.trim() !== "")) {
            done.add(key);
        }
    }
    for (const [raw, waiver] of Object.entries(doc.waived)) {
        const key = dimensionOf(raw);
        if (key !== undefined && waiver !== undefined && waiver.reason.trim() !== "") {
            done.add(key);
        }
    }
    return done;
};

const missing = (doc: Interview): string[] => DIMENSION_KEYS.filter((key) => !settled(doc).has(key));

const said = (doc: Interview): string =>
    missing(doc)
        .map((key) => key + "（" + (LABELS.get(key) ?? key) + "）")
        .join("、") || "无";

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
const oneLine = (value: string): string => value.replace(/\s+/gu, " ").trim();
const clampText = (value: unknown, max: number): string =>
    typeof value === "string" ? value.slice(0, max).trim() : "";
const answerText = (values: string[] | undefined): string =>
    values === undefined ? "" : values.map((each) => oneLine(each)).filter(Boolean).join("；");

function requirementsMarkdown(doc: Interview, cwd: string): string {
    const done = settled(doc);
    const lines: string[] = [
        "# 需求：" + (doc.title || "未命名"),
        "",
        "- 会话文件夹：\`" + cwd + "\`",
        "- 轮次：" + doc.round,
        "- 更新时间：" + new Date(doc.answeredAt || Date.now()).toISOString(),
        "",
        "## 问答",
        "",
    ];
    if (doc.questions.length === 0) {
        lines.push("（还没有提问）", "");
    }
    for (const question of doc.questions) {
        lines.push(
            "### " + (question.header || question.id) + " · " + (LABELS.get(question.dimension) ?? question.dimension),
            "",
            question.question,
            "",
        );
        if (question.options.length > 0) {
            lines.push(
                "选项：" +
                    question.options
                        .map((option) => option.label + (option.description ? "（" + option.description + "）" : ""))
                        .join(" / "),
                "",
            );
        }
        lines.push("**回答**：" + (answerText(doc.answers[question.id]) || "（未回答）"), "");
    }
    lines.push("## 覆盖", "", "| 维度 | 状态 |", "| --- | --- |");
    for (const [key, label] of DIMENSIONS) {
        const waiver = doc.waived[key];
        const pending = doc.pendingWaive[key];
        const state = waiver
            ? "豁免（已确认）：" + oneLine(waiver.reason)
            : done.has(key)
              ? "已答"
              : pending
                ? "**缺**（豁免待确认：" + oneLine(pending.reason) + "）"
                : "**缺**";
        lines.push("| " + label + "（" + key + "） | " + state + " |");
    }
    lines.push("");
    return lines.join("\n");
}

function traceBegin(stage: Stage): string {
    return [
        "",
        "## S" + stage.n + " · " + stage.title,
        "",
        "- 开始：" + new Date(stage.startedAt).toISOString(),
        "- 意图：" + oneLine(stage.intent),
        "- 预期改动：" + (stage.files.length === 0 ? "（未声明）" : stage.files.join(", ")),
        "- 验证命令：" + (stage.verify || "（未声明）"),
        "",
    ].join("\n");
}

function traceAmend(stage: Stage, amendment: Amendment): string {
    return [
        "- 扩范围 " + new Date(amendment.at).toISOString() + "：" + oneLine(amendment.reason),
        "  - 新增：" + amendment.files.join(", "),
        "",
    ].join("\n");
}

function traceEnd(stage: Stage): string {
    return [
        "- 结束：" + new Date(stage.endedAt ?? Date.now()).toISOString(),
        "- 结果：" + oneLine(stage.result ?? ""),
        "- 验证：\`" + (stage.verify || "未运行") + "\` → 退出码 " + (stage.exitCode === undefined ? "未取得" : String(stage.exitCode)),
        ...((stage.evidence ?? []).length === 0
            ? []
            : ["- 文件证据：", ...(stage.evidence ?? []).map((each) => "  - " + each.path + "：" + each.before + " → " + each.after)]),
        "- 遗留：" + (oneLine(stage.notes ?? "") || "无"),
        "- 下一步：" + (oneLine(stage.next ?? "") || "未指定"),
        "",
    ].join("\n");
}

function handoffMarkdown(doc: Interview, ledger: Ledger, cwd: string): string {
    const stage = openStage(ledger);
    const lines = [
        "# 接手说明",
        "",
        "- 文件夹：\`" + cwd + "\`",
        "- 生成时间：" + new Date().toISOString(),
        "- 当前阶段：" + (stage ? "S" + stage.n + " " + stage.title + "（未收口）" : "无（上一阶段已收口）"),
        "",
        "## 需求状态",
        "",
        "- 已确认轮次：" + doc.round,
        "- 未收口维度：" + said(doc),
        "",
        "## 阶段",
        "",
    ];
    if (ledger.stages.length === 0) {
        lines.push("（还没有阶段）");
    }
    for (const each of ledger.stages) {
        lines.push(
            "- S" + each.n + " " + each.title + "：" + (each.open ? "进行中" : oneLine(each.result ?? "已收口")) +
                (each.verify ? "；验证 " + each.verify + " 退出码 " + (each.exitCode ?? "未取得") : "") +
                (each.amendments.length > 0 ? "；扩范围 " + each.amendments.length + " 次" : ""),
        );
    }
    const next = ledger.stages.map((each) => oneLine(each.next ?? "")).filter(Boolean).pop();
    lines.push("", "## 下一步", "", next || (stage ? "继续 S" + stage.n + "：" + oneLine(stage.intent) : "待定"), "");
    lines.push("## 需求原文", "", requirementsMarkdown(doc, cwd));
    return lines.join("\n");
}

async function writeSpecFile(cwd: string, name: string, body: string): Promise<string> {
    const folder = join(cwd, "specs");
    await mkdir(folder, { recursive: true });
    const path = join(folder, name);
    await writeFile(path, body, "utf8");
    return path;
}

async function appendSpecFile(cwd: string, name: string, body: string): Promise<string> {
    const folder = join(cwd, "specs");
    await mkdir(folder, { recursive: true });
    const path = join(folder, name);
    await appendFile(path, body, "utf8");
    return path;
}

/** Whether a path the model is about to write lies under specs/, where the documents themselves live. */
function insideSpecs(path: string, cwd: string): boolean {
    if (path === "" || path.includes("\u0000")) {
        return false;
    }
    const absolute = path.startsWith("/") ? normalize(path) : normalize(join(cwd, path));
    const root = normalize(join(cwd, "specs"));
    return absolute === root || absolute.startsWith(root + sep);
}

function pathOf(args: unknown): string {
    if (typeof args !== "object" || args === null) {
        return "";
    }
    const record = args as Record<string, unknown>;
    for (const key of ["path", "file_path", "file", "filename"]) {
        const value = record[key];
        if (typeof value === "string" && value !== "") {
            return value;
        }
    }
    return "";
}

/** 文件当前内容指纹；不存在就是 "-"。收口时拿它和开工时比，模型说什么都不算数。 */
async function digestOf(cwd: string, relative: string): Promise<string> {
    try {
        const bytes = await readFile(resolveIn(cwd, relative));
        return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    } catch {
        return "-";
    }
}

/**
 * 声明了却没动的文件。开工时没记过指纹的（老阶段、通配符）不算，空口豁免也不算。
 */
export function untouchedFiles(
    declared: string[],
    before: Record<string, string>,
    after: Record<string, string>,
    excused: string[],
): string[] {
    return declared.filter(
        (path) => path !== "*" && before[path] !== undefined && before[path] === after[path] && !excused.includes(path),
    );
}

function resolveIn(cwd: string, path: string): string {
    return path.startsWith("/") ? normalize(path) : normalize(join(cwd, path));
}

function within(target: string, listed: string, cwd: string): boolean {
    const root = resolveIn(cwd, listed);
    return target === root || target.startsWith(root + sep);
}

const NESTED_WRITE = /tools\.(?:edit|write|write_file|ops_write|ops_edit)\s*\(/u;
const CALL_SITE = /tools\.[A-Za-z_][A-Za-z0-9_]*\s*\(/gu;

/** 脚本里真正发起工具调用的处数。一个脚本只发一次调用，就是把轮次乘以每轮重付的上下文。 */
export function callSites(code: string): number {
    return (code.match(CALL_SITE) ?? []).length;
}

/** 循环或 Promise.all 里一次调用会跑很多次，也算批量，不能拿「源码里只有一处」就拦它。 */
/* 只有真的会重复执行才算批量：Promise.allSettled([a, b]) 是写死的两处，交给 distinctProbes 判。 */
const BATCHED = /(?:\bfor\s*\(|\bwhile\s*\(|\.map\s*\(\s*async)/u;
export const batched = (code: string): boolean => BATCHED.test(code);
const COMMAND_ARG = /command\s*:\s*(["'`])([^"'`]*)\1/gu;
const PATH_ARG = /path\s*:\s*(["'`])([^"'`]*)\1/gu;
/** 这些命令什么新信息都没有，凑数时最先被拿出来，所以不计数。 */
const FILLER = /^(?:pwd|echo|printf|whoami|id|date|true|false|uname|hostname|:)\b/u;
const normalizeProbe = (command: string): string => command.replace(/\s+/gu, " ").trim();

/**
 * 脚本真正带来的不同信息有几条：不同命令 + 不同路径（填充命令不算）。
 * 数调用处会被「pwd 加 ls」这种凑数骗过去，数这个不行。
 */
export function distinctProbes(code: string): number {
    const found = new Set<string>();
    for (const match of code.matchAll(COMMAND_ARG)) {
        const command = normalizeProbe(match[2] ?? "");
        if (command !== "" && !FILLER.test(command)) {
            found.add("cmd:" + command);
        }
    }
    for (const match of code.matchAll(PATH_ARG)) {
        const path = (match[2] ?? "").trim();
        if (path !== "") {
            found.add("path:" + path);
        }
    }
    return found.size;
}
export const needsMoreCalls = (code: string): boolean =>
    code !== "" && !NESTED_WRITE.test(code) && distinctProbes(code) < 2 && !BATCHED.test(code);

// 提交返回的是 overlay 代理：事务一结算就读不了（Cannot use a settled overlay），所以回一份纯数据。
const copyOf = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;


export default function createGates(host: Host, web: Web) {
    const states = new Map<string, BudgetState>();
    const stateOf = (id: unknown): BudgetState => {
        const key = String(id);
        let state = states.get(key);
        if (state === undefined) {
            state = emptyState();
            states.set(key, state);
        }
        return state;
    };

    const rerun = defineTool({
        name: "test_rerun",
        description:
            "Ask to run the whole suite or check sweep one more time, with the reason it must run again: what failed last time and what changed since. The reason is recorded and shown to the owner.",
        parameters: Type.Object({
            reason: Type.String({ minLength: 5, maxLength: 400 }),
        }),
        execute: async ({ reason }, api, context) => {
            const state = stateOf(api.conversationId);
            if (state.extra.length >= MAX_EXTRA) {
                return reply("测试预算：这次会话已经为全量运行申请过 " + MAX_EXTRA + " 次额外次数，不再放行。请把结论交给主规划，由它决定是否开新阶段。");
            }
            const asked = {
                id: "test-rerun:" + String(api.conversationId),
                conversationId: api.conversationId,
                taskId: (api as any).taskId,
                tool: "test_rerun",
                subject: reason.trim().slice(0, 400),
                reason: "全量测试已经跑过 " + state.full + " 次（上限 " + MAX_FULL + "），模型要求再跑一次。",
                createdAt: Date.now(),
            };
            const answer = await Promise.race([
                host.approvals.request(asked as any, context),
                new Promise<{ allow: boolean; by: string }>((resolve) =>
                    setTimeout(() => resolve({ allow: false, by: "超过 10 分钟没人答复" }), 10 * 60_000),
                ),
            ]);
            if (!answer.allow) {
                return reply("测试预算：没有放行这次全量重跑（" + answer.by + "）。用上一次的退出码和输出下结论，不要靠再跑一遍找安全感。");
            }
            state.extra.push({ reason: reason.trim(), at: Date.now() });
            state.seen.clear();
            return reply("负责人 " + answer.by + " 批准了 1 次全量重跑，同指纹命令的冷却已清空。");
        },
    });

    const plan = defineTool({
        name: "test_plan",
        description:
            "Declare what this step verifies before running any test or check: the goal, the commands that count as evidence, and how many whole-suite runs the step may spend. Required once per step; test commands are blocked until it is declared.",
        parameters: Type.Object({
            goal: Type.String({ minLength: 5, maxLength: 400 }),
            checks: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 12 })),
            fullLimit: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
        }),
        execute: async ({ goal, checks, fullLimit }, api) => {
            const state = stateOf(api.conversationId);
            if (state.done) {
                return reply("测试预算：这个会话已经声明测试完成。要验新东西，让主规划开新阶段，不要在收口后继续跑测试。");
            }
            state.plan = {
                goal: goal.trim(),
                checks: (checks ?? []).map((item) => item.trim()).filter((item) => item !== ""),
                fullLimit: typeof fullLimit === "number" ? Math.floor(fullLimit) : MAX_FULL,
                at: Date.now(),
            };
            state.full = 0;
            state.extra.length = 0;
            state.seen.clear();
            return reply(
                [
                    "测试计划已登记：" + state.plan.goal.slice(0, 200),
                    "全量上限：" + state.plan.fullLimit + " 次",
                    ...(state.plan.checks.length === 0 ? [] : ["证据命令：" + state.plan.checks.join("；")]),
                ].join("\n"),
            );
        },
    });

    const done = defineTool({
        name: "test_done",
        description:
            "Declare this step's testing finished, quoting the evidence: each command that ran and its exit code. Every evidence command must match a run this session actually recorded, and the plugin then re-runs each one itself to see whether the exit code you wrote is real. Mark a command slow: true only when re-running it costs minutes. After this, test commands are blocked.",
        parameters: Type.Object({
            evidence: Type.Array(
                Type.Object({
                    command: Type.String({ minLength: 3, maxLength: 300 }),
                    exitCode: Type.Number(),
                    slow: Type.Optional(Type.Boolean()),
                }),
                { minItems: 1, maxItems: 10 },
            ),
        }),
        execute: async ({ evidence }, api, context) => {
            const state = stateOf(api.conversationId);
            const missing: string[] = [];
            for (const item of evidence) {
                const before = state.seen.get(fingerprint(item.command));
                if (before === undefined) {
                    missing.push("没跑过：" + item.command.slice(0, 120));
                } else if (before.exitCode !== item.exitCode) {
                    missing.push(
                        "退出码不符：记录是 " + String(before.exitCode) + "，你写的是 " + String(item.exitCode) + " · " + item.command.slice(0, 100),
                    );
                }
            }
            if (missing.length > 0) {
                return reply("测试预算：证据对不上，不能声明完成。\n" + missing.join("\n") + "\n只有真跑过的命令才有记录，编的退出码不算证据。");
            }
            const cwd = await folderOf(api, context);
            const checked: EvidenceRun[] = [];
            const wrong: string[] = [];
            for (const item of evidence) {
                if (item.slow === true) {
                    checked.push({ command: item.command, declared: item.exitCode, actual: null, tail: "", skipped: true });
                    continue;
                }
                const again = await rerunCommand(cwd, item.command);
                checked.push({
                    command: item.command,
                    declared: item.exitCode,
                    actual: again.exitCode,
                    tail: again.tail,
                    skipped: false,
                });
                if (again.exitCode !== item.exitCode) {
                    wrong.push(
                        "重跑得到退出码 " + (again.exitCode === null ? "启动失败" : String(again.exitCode)) +
                            "，你写的是 " + String(item.exitCode) + " · " + item.command.slice(0, 100) +
                            (again.tail === "" ? "" : "\n  输出尾部：" + again.tail.slice(-200)),
                    );
                }
            }
            if (wrong.length > 0) {
                return reply("测试预算：我自己重跑了一遍，和你的证据对不上，不能声明完成。\n" + wrong.join("\n"));
            }
            state.evidence = checked;
            state.done = true;
            const skipped = checked.filter((each) => each.skipped).length;
            return reply(
                "已声明测试完成：" + checked.length + " 条证据，" +
                    (checked.length - skipped) + " 条我亲自重跑过，退出码一致" +
                    (skipped === 0 ? "" : "，" + skipped + " 条标了 slow 只核对记录") +
                    "。测试命令现在被禁用，把结论交给主规划。",
            );
        },
    });

    const budget = defineTool({
        name: "test_budget",
        description:
            "Show how many whole-suite runs this conversation used, the recent test commands with their exit codes, and whether the session already declared itself done. Read-only.",
        parameters: Type.Object({}),
        annotations: { readOnlyHint: true },
        execute: async (_args, api) => {
            const state = stateOf(api.conversationId);
            const recent = [...state.seen.entries()]
                .sort((a, b) => b[1].at - a[1].at)
                .slice(0, 6)
                .map(([key, seen]) => "- " + (seen.exitCode === null ? "?" : String(seen.exitCode)) + " · " + key.slice(0, 110));
            return reply(
                [
                    "测试计划：" + (state.plan === undefined ? "未声明（测试命令已被拦）" : state.plan.goal.slice(0, 140)),
                    "全量运行：" + state.full + " 次（上限 " + (state.plan?.fullLimit ?? MAX_FULL) + "，另申请 " + state.extra.length + " 次）",
                    "已声明完成：" + (state.done ? "是（测试命令已禁用）" : "否"),
                    "",
                    "最近的测试命令：",
                    ...(recent.length === 0 ? ["（还没有）"] : recent),
                    "",
                    "收口证据：",
                    ...((state.evidence ?? []).length === 0
                        ? ["（还没核对过）"]
                        : (state.evidence ?? []).map(
                              (each) =>
                                  "- " + (each.skipped ? "跳过重跑" : "重跑 " + String(each.actual)) +
                                  " / 声明 " + String(each.declared) + " · " + each.command.slice(0, 100),
                          )),
                ].join("\n"),
            );
        },
    });

    /** Question rounds waiting for the panel, by conversation. */
    const waiting = new Map<string, { settle: (answers: Record<string, string[]>) => void; forget: () => void }>();

    const readInterview = async (api: any, context: any): Promise<Interview> =>
        (await api.snapshot(InterviewDoc, api.conversationId, context)) ?? emptyInterview();

    const readLedger = async (api: any, context: any): Promise<Ledger> =>
        (await api.snapshot(LedgerDoc, api.conversationId, context)) ?? emptyLedger();

    const folderOf = async (api: any, context: any): Promise<string> => {
        const agent = await api.agent(context);
        return typeof agent?.cwd === "string" && agent.cwd !== "" ? agent.cwd : ".";
    };

    const patchInterview = async (api: any, context: any, change: (doc: Interview) => void): Promise<Interview> =>
        api.commit(async (tx: any) => {
            const doc = (await tx.doc(InterviewDoc, api.conversationId)) ?? emptyInterview();
            change(doc);
            doc.revision += 1;
            return copyOf(doc);
        }, context);

    const patchLedger = async (api: any, context: any, change: (doc: Ledger) => void): Promise<Ledger> =>
        api.commit(async (tx: any) => {
            const doc = (await tx.doc(LedgerDoc, api.conversationId)) ?? emptyLedger();
            change(doc);
            doc.revision += 1;
            return copyOf(doc);
        }, context);

    // ─── Requirements ────────────────────────────────────────────────────────

    const ask = defineTool({
        name: "spec_ask",
        description:
            "Ask one round of requirements questions and wait for the person to answer them in the 需求追问 panel beside the conversation. Give each question a dimension so coverage can be checked: " +
            DIMENSION_KEYS.join(", ") +
            ". Ask everything you cannot settle yourself, all of it in one call (one round is cheap; five rounds are not): small concrete choices with options beat open prose. " +
            "用简体中文写标题、问题和每个选项（面板是中文字体，英文会被直接拒收），除非 Owner 明确用英文交流。",
        parameters: Type.Object({
            title: Type.Optional(Type.String({ maxLength: 200 })),
            questions: Type.Array(
                Type.Object({
                    id: Type.String({ minLength: 1, maxLength: 40 }),
                    header: Type.Optional(Type.String({ maxLength: 40 })),
                    question: Type.String({ minLength: 1, maxLength: 500 }),
                    dimension: Type.String({ maxLength: 40 }),
                    kind: Type.Optional(Type.Union([Type.Literal("single"), Type.Literal("multi"), Type.Literal("text")])),
                    options: Type.Optional(
                        Type.Array(
                            Type.Object({
                                label: Type.String({ maxLength: 80 }),
                                description: Type.Optional(Type.String({ maxLength: 300 })),
                            }),
                            { maxItems: 6 },
                        ),
                    ),
                    allowText: Type.Optional(Type.Boolean()),
                }),
                { minItems: 1, maxItems: MAX_QUESTIONS },
            ),
        }),
        execute: async ({ title, questions }, api, context) => {
            const current = await readInterview(api, context);
            if (current.round >= MAX_ROUNDS) {
                return reply("追问已到 " + MAX_ROUNDS + " 轮上限，先写需求文档，或请 Owner 在面板上确认豁免。");
            }
            const normalized: Question[] = questions.map((question, index) => ({
                id: clampText(question.id, 40) || "q" + (current.round + 1) + "-" + (index + 1),
                header: clampText(question.header ?? "", 40),
                question: clampText(question.question, 500),
                dimension: dimensionOf(clampText(question.dimension, 40)) ?? "goal",
                kind: question.kind ?? "single",
                options: (question.options ?? []).map((option) => ({
                    label: clampText(option.label, 80),
                    ...(option.description === undefined ? {} : { description: clampText(option.description, 300) }),
                })),
                allowText: question.allowText ?? true,
            }));
            if (needsChinese) {
                const foreign = normalized.filter(
                    (question) =>
                        !looksChinese(question.question) ||
                        (question.options ?? []).some((option) => proseOption(option.label)),
                );
                if (foreign.length > 0) {
                    return reply(
                        "面板是中文的：问题、选项和说明都必须用简体中文写，否则 Owner 读不懂。请把这几题改成中文后重发同一批问题：" +
                            foreign.map((question) => question.id).join("、"),
                    );
                }
            }
            const key = String(api.conversationId);
            await patchInterview(api, context, (doc) => {
                doc.round += 1;
                doc.title = clampText(title ?? doc.title, 200) || doc.title || "未命名";
                doc.status = "asking";
                doc.questions = [...doc.questions, ...normalized];
                doc.askedAt = Date.now();
                doc.answeredAt = 0;
            });
            web.send("interview", { conversationId: api.conversationId, round: current.round + 1 });

            const answered = await new Promise<Record<string, string[]> | undefined>((resolve) => {
                const timer = setTimeout(() => {
                    waiting.delete(key);
                    resolve(undefined);
                }, WAIT_MS);
                const settle = (answers: Record<string, string[]>) => {
                    clearTimeout(timer);
                    waiting.delete(key);
                    resolve(answers);
                };
                const forget = () => {
                    clearTimeout(timer);
                    waiting.delete(key);
                    resolve(undefined);
                };
                waiting.set(key, { settle, forget });
                const signal: AbortSignal | undefined = context?.abortSignal;
                signal?.addEventListener("abort", forget, { once: true });
            });

            if (answered === undefined) {
                return reply(
                    "已把第 " + (current.round + 1) + " 轮问题发到「需求追问」面板，但还没有收到回答。" +
                        "不要据此猜需求：这一轮停下等 Owner 提交，或让 Owner 直接在对话里回答后用 spec_answer 记录。",
                );
            }

            const lines = normalized.map((question) => {
                const picked = answered[question.id] ?? [];
                const dimension = LABELS.get(question.dimension) ?? question.dimension;
                return "- [" + dimension + "] " + oneLine(question.question) + "\n  → " + (answerText(picked) || "（空）");
            });
            const doc = await readInterview(api, context);
            return reply(
                "第 " + (current.round + 1) + " 轮回答（已记入需求文档）：\n\n" + lines.join("\n") +
                    "\n\n仍未收口：" + said(doc) + "。继续 spec_ask 补齐，或调 spec_doc 写出 specs/REQ.md。",
            );
        },
    });

    const answer = defineTool({
        name: "spec_answer",
        description:
            "Record answers the owner typed in the chat, for questions spec_ask asked (by question id). Use it when the panel could not be used.",
        parameters: Type.Object({
            answers: Type.Array(
                Type.Object({
                    id: Type.String({ minLength: 1, maxLength: 40 }),
                    values: Type.Array(Type.String({ maxLength: 500 }), { minItems: 1, maxItems: 12 }),
                }),
                { minItems: 1, maxItems: MAX_QUESTIONS },
            ),
        }),
        execute: async ({ answers }, api, context) => {
            const doc = await patchInterview(api, context, (next) => {
                for (const each of answers) {
                    next.answers[each.id] = each.values.map((value) => clampText(value, 500));
                }
                next.status = "answered";
                next.answeredAt = Date.now();
            });
            return reply("已记录 " + answers.length + " 条回答。仍未收口：" + said(doc) + "。");
        },
    });

    const status = defineTool({
        name: "spec_status",
        description:
            "Show which requirement dimensions are settled, which are missing, pending waiver requests, and whether a stage is open. Read-only.",
        parameters: Type.Object({}),
        annotations: { readOnlyHint: true },
        execute: async (_args, api, context) => {
            const doc = await readInterview(api, context);
            const ledger = await readLedger(api, context);
            const done = settled(doc);
            const rows = DIMENSIONS.map(([key, label]) => {
                const waiver = doc.waived[key];
                const pending = doc.pendingWaive[key];
                return "- " + (done.has(key) ? "✅" : "❌") + " " + label + "（" + key + "）" +
                    (waiver ? " — 豁免已确认：" + oneLine(waiver.reason) : "") +
                    (pending ? " — 豁免待 Owner 确认：" + oneLine(pending.reason) : "");
            });
            const stage = openStage(ledger);
            return reply(
                [
                    "需求轮次：" + doc.round + "；未收口：" + said(doc),
                    "",
                    ...rows,
                    "",
                    stage
                        ? "当前阶段：S" + stage.n + " " + stage.title + "（" + (stage.files.join(", ") || "未声明文件") + "）"
                        : "当前阶段：无（改文件前先 stage_begin）",
                ].join("\n"),
            );
        },
    });

    const waive = defineTool({
        name: "spec_waive",
        description:
            "Ask the owner to leave one requirement dimension deliberately unsettled, with the reason. It takes effect only after the owner confirms it in the panel; until then the gate still asks for it.",
        parameters: Type.Object({
            dimension: Type.String({ maxLength: 40 }),
            reason: Type.String({ minLength: 3, maxLength: 300 }),
        }),
        execute: async ({ dimension, reason }, api, context) => {
            const key = dimensionOf(clampText(dimension, 40));
            if (key === undefined) {
                return reply("未知维度 " + clampText(dimension, 40) + "。可选：" + DIMENSION_KEYS.join(", ") + "。");
            }
            await patchInterview(api, context, (next) => {
                next.pendingWaive[key] = { reason: clampText(reason, 300), at: Date.now() };
            });
            web.send("interview-waive", { conversationId: api.conversationId, dimension: key });
            return reply(
                "已向 Owner 申请豁免 " + key + "（" + oneLine(reason) + "），还没生效。" +
                    "解释给 Owner 听，等他在「需求追问」面板上确认；确认前这条仍然算缺。",
            );
        },
    });

    const document = defineTool({
        name: "spec_doc",
        description: "Write the requirements document (specs/REQ.md) in the session folder from the interview so far, and return its path.",
        parameters: Type.Object({}),
        execute: async (_args, api, context) => {
            const cwd = await folderOf(api, context);
            const doc = await readInterview(api, context);
            const path = await writeSpecFile(cwd, "REQ.md", requirementsMarkdown(doc, cwd));
            return reply("已写 " + path + "。仍未收口：" + said(doc) + "。");
        },
    });

    // ─── Stages ──────────────────────────────────────────────────────────────

    const begin = defineTool({
        name: "stage_begin",
        description:
            "Open one stage of work before changing files: what it is for, which files it expects to touch (paths, or * for any), and the command that will verify it. Refused while requirements are unsettled or another stage is open.",
        parameters: Type.Object({
            title: Type.String({ minLength: 1, maxLength: 120 }),
            intent: Type.String({ minLength: 3, maxLength: 600 }),
            files: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 40 })),
            verify: Type.Optional(Type.String({ maxLength: 400 })),
        }),
        execute: async ({ title, intent, files, verify }, api, context) => {
            const doc = await readInterview(api, context);
            if (missing(doc).length > 0) {
                return reply("需求还没收口：" + said(doc) + "。先用 spec_ask 补齐（或申请 spec_waive 并经 Owner 确认），再开阶段。");
            }
            const ledger = await readLedger(api, context);
            const open = openStage(ledger);
            if (open !== undefined) {
                return reply("S" + open.n + " " + open.title + " 还没收口。先 stage_end 留下证据，再开新阶段——这就是「一阶段一痕迹」。");
            }
            const cwd = await folderOf(api, context);
            const stage: Stage = {
                n: ledger.counter + 1,
                title: clampText(title, 120),
                intent: clampText(intent, 600),
                files: (files ?? []).map((each) => clampText(each, 200)).filter(Boolean),
                verify: clampText(verify ?? "", 400),
                open: true,
                startedAt: Date.now(),
                amendments: [],
            };
            stage.digest = {};
            for (const relative of stage.files) {
                if (relative !== "*") {
                    stage.digest[relative] = await digestOf(cwd, relative);
                }
            }
            await patchLedger(api, context, (next) => {
                next.counter += 1;
                next.stages.push(stage);
            });
            const path = await appendSpecFile(cwd, "TRACE.md", traceBegin(stage));
            return reply(
                "已开 S" + stage.n + " " + stage.title + "，痕迹追加到 " + path + "。预期改动的文件：" +
                    (stage.files.length === 0 ? "（未声明，任何文件）" : stage.files.join(", ")) +
                    "。要改这之外的文件，先调 stage_amend 说明理由。",
            );
        },
    });

    const amend = defineTool({
        name: "stage_amend",
        description:
            "Widen the open stage's file range with a stated reason, before touching a file outside it. The reason and the new files are written to specs/TRACE.md, so the owner can see exactly when scope grew.",
        parameters: Type.Object({
            reason: Type.String({ minLength: 3, maxLength: 400 }),
            files: Type.Array(Type.String({ maxLength: 200 }), { minItems: 1, maxItems: 20 }),
        }),
        execute: async ({ reason, files }, api, context) => {
            const ledger = await readLedger(api, context);
            const open = openStage(ledger);
            if (open === undefined) {
                return reply("没有进行中的阶段。改文件前先 stage_begin。");
            }
            const cwd = await folderOf(api, context);
            const amendment: Amendment = {
                reason: clampText(reason, 400),
                files: files.map((each) => clampText(each, 200)).filter(Boolean),
                at: Date.now(),
            };
            // 扩进来的文件同样从现在开始算指纹，收口时要交代。
            const added: Record<string, string> = {};
            for (const relative of amendment.files) {
                if (relative !== "*") {
                    added[relative] = await digestOf(cwd, relative);
                }
            }
            await patchLedger(api, context, (doc) => {
                doc.stages = doc.stages.map((each) =>
                    each.n === open.n
                        ? {
                              ...each,
                              files: [...each.files, ...amendment.files],
                              digest: { ...(each.digest ?? {}), ...added },
                              amendments: [...each.amendments, amendment],
                          }
                        : each,
                );
            });
            const path = await appendSpecFile(cwd, "TRACE.md", traceAmend(open, amendment));
            return reply("已扩范围并留痕（" + path + "）：" + oneLine(reason) + " → 新增 " + amendment.files.join(", ") + "。");
        },
    });

    const end = defineTool({
        name: "stage_end",
        description:
            "Close the open stage with the result and with paired verification evidence: the command AND its exit code, both required. Refused when no stage is open or the pair is incomplete.",
        parameters: Type.Object({
            result: Type.String({ minLength: 3, maxLength: 600 }),
            verify: Type.Optional(Type.String({ maxLength: 400 })),
            exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
            notes: Type.Optional(Type.String({ maxLength: 600 })),
            next: Type.Optional(Type.String({ maxLength: 400 })),
            untouched: Type.Optional(
                Type.Array(
                    Type.Object({
                        path: Type.String({ maxLength: 200 }),
                        reason: Type.String({ minLength: 1, maxLength: 300 }),
                    }),
                    { maxItems: 40 },
                ),
            ),
        }),
        execute: async ({ result, verify, exitCode, notes, next, untouched }, api, context) => {
            const ledger = await readLedger(api, context);
            const open = openStage(ledger);
            if (open === undefined) {
                return reply("没有进行中的阶段。改文件前先 stage_begin。");
            }
            const command = clampText(verify ?? open.verify, 400);
            if (command === "") {
                return reply("stage_end 需要验证命令：告诉接手的人跑哪条命令能证明这一步做完了（stage_begin 时声明过就直接带上退出码）。");
            }
            if (typeof exitCode !== "number") {
                return reply("stage_end 需要退出码，和验证命令成对：「" + command + "」跑完是什么退出码？没跑就说没跑，别只写结论。");
            }
            const cwd = await folderOf(api, context);
            // 声明过的文件必须真的变了：指纹是外部事实，模型写的「已完成」不算证据。
            const before = open.digest ?? {};
            const after: Record<string, string> = {};
            for (const relative of Object.keys(before)) {
                after[relative] = await digestOf(cwd, relative);
            }
            const idle = untouchedFiles(open.files, before, after, (untouched ?? []).map((each) => each.path));
            if (idle.length > 0) {
                return reply(
                    "S" + open.n + " 声明了 " + open.files.length + " 个文件，这些没有任何改动：" + idle.join("、") +
                        "。确实不用动就放进 untouched 写理由；要动就先改完再收口。空口说「都做了」在这里不成立。",
                );
            }
            const evidence = Object.keys(before).map((relative) => ({
                path: relative,
                before: before[relative] ?? "-",
                after: after[relative] ?? "-",
            }));
            const closed: Stage = {
                ...open,
                evidence,
                open: false,
                endedAt: Date.now(),
                result: clampText(result, 600),
                verify: command,
                exitCode,
                notes: clampText(notes ?? "", 600),
                next: clampText(next ?? "", 400),
            };
            await patchLedger(api, context, (doc) => {
                doc.stages = doc.stages.map((each) => (each.n === closed.n ? closed : each));
            });
            const path = await appendSpecFile(cwd, "TRACE.md", traceEnd(closed));
            const doc = await readInterview(api, context);
            await writeSpecFile(cwd, "REQ.md", requirementsMarkdown(doc, cwd));
            return reply(
                "已收口 S" + closed.n + " " + closed.title + "，痕迹追加到 " + path + "。验证：" + command + " → 退出码 " + exitCode + "。",
            );
        },
    });

    const handoff = defineTool({
        name: "handoff",
        description:
            "Write specs/HANDOFF.md: everything another model needs to take this work over now — requirements, stages, what is open, what to do next.",
        parameters: Type.Object({}),
        execute: async (_args, api, context) => {
            const cwd = await folderOf(api, context);
            const doc = await readInterview(api, context);
            const ledger = await readLedger(api, context);
            const path = await writeSpecFile(cwd, "HANDOFF.md", handoffMarkdown(doc, ledger, cwd));
            const stage = openStage(ledger);
            return reply("已写 " + path + "。" + (stage ? "S" + stage.n + " 仍未收口，接手的人从这里继续。" : "没有未收口的阶段。"));
        },
    });

    // ─── Gate ────────────────────────────────────────────────────────────────

    const refusal = async (api: any, context: any): Promise<string | undefined> => {
        const doc = await readInterview(api, context);
        if (missing(doc).length > 0) {
            return (
                "spec 门禁：需求还没收口（缺 " + said(doc) + "）。改文件之前先用 spec_ask 追问 Owner，" +
                "把答案记进需求文档；这不是建议，是硬门禁。"
            );
        }
        const ledger = await readLedger(api, context);
        if (openStage(ledger) === undefined) {
            return (
                "spec 门禁：没有进行中的阶段。先 stage_begin 声明这一步要干什么、预期动哪些文件、怎么验证；" +
                "做完 stage_end 留下证据。这就是「一阶段一痕迹」。"
            );
        }
        return undefined;
    };


    // ─── Gate ────────────────────────────────────────────────────────────────

    /** Every path a write tool names: one path, or a batch of files. */
    const pathsOf = (args: unknown): string[] => {
        const single = pathOf(args);
        if (single !== "") {
            return [single];
        }
        const files = (args as any)?.files;
        if (!Array.isArray(files)) {
            return [];
        }
        const out: string[] = [];
        for (const file of files) {
            const path = (file as any)?.path;
            if (typeof path === "string" && path !== "") {
                out.push(path);
            }
        }
        return out;
    };

    const fileGate = async (args: unknown, api: any, context: any): Promise<string | undefined> => {
        const cwd = await folderOf(api, context);
        const paths = pathsOf(args);
        const outside = paths.filter((path) => !insideSpecs(path, cwd));
        if (paths.length > 0 && outside.length === 0) {
            return undefined;
        }
        const blocked = await refusal(api, context);
        if (blocked !== undefined) {
            return blocked;
        }
        if (outside.length === 0) {
            return undefined;
        }
        const ledger = await readLedger(api, context);
        const open = openStage(ledger);
        if (open === undefined || open.files.length === 0 || open.files.includes("*")) {
            return undefined;
        }
        for (const path of outside) {
            const target = resolveIn(cwd, path);
            if (!open.files.some((each) => within(target, each, cwd))) {
                return (
                    "spec 门禁：S" + open.n + " 声明的范围是 " + open.files.join(", ") + "，" + path + " 不在其中。" +
                    "要改它，先调 stage_amend 说明理由（会写进 specs/TRACE.md 让 Owner 看见），再改。"
                );
            }
        }
        return undefined;
    };

    // ─── Wraps ───────────────────────────────────────────────────────────────

    const DIRECT_BASH =
        "门禁：不许直接调 bash。看文件、找文本不用绕 shell：读多个文件用 ops_batch / ops_read，找内容用 ops_search（一次就覆盖多个文件）。" +
        "真要执行命令才写 codemode 脚本，把这一轮要查的东西合并进同一个脚本（多个独立探测用 Promise.allSettled 并行），" +
        "脚本内部过滤后只返回摘要。一步一条 bash 会把轮次和账单一起放大。";

    const probes = new Map<string, ReturnType<typeof defineTool>>();
    for (const name of ["write", "edit", "codemode", "bash", "ops_write", "ops_edit"]) {
        probes.set(
            name,
            defineTool({
                name,
                description: "Tool probe.",
                parameters: Type.Object({}, { additionalProperties: true }),
                execute: async () => ({}),
            }),
        );
    }

    /** Set while a codemode script runs, so a shell call from inside that script is not a direct call. */
    const nested = new AsyncLocalStorage<true>();

    const guard = (name: string) =>
        wrapTool(probes.get(name)!, (tool) => ({
            ...tool,
            execute: async (args: any, api: any, context: any) => {
                const blocked = await fileGate(args, api, context);
                if (blocked !== undefined) {
                    return reply(blocked);
                }
                const result = await tool.execute(args, api, context);
                // The file changed, so every test run recorded before this moment is measuring code that no longer exists.
                stateOf(api.conversationId).mutations += 1;
                return result;
            },
        }));

    /** Oversized script output is the biggest single token cost in a conversation, so it is capped here. */
    const shrinkResult = async (result: any, api: any): Promise<any> => {
        const content = Array.isArray(result?.content) ? result.content : undefined;
        if (content === undefined) {
            return result;
        }
        const text = content
            .filter((part: any) => part?.type === "text" && typeof part.text === "string")
            .map((part: any) => part.text as string)
            .join("\n");
        if (text === "") {
            return result;
        }
        const shrunk = shrinkText(text);
        if (!shrunk.truncated) {
            return result;
        }
        const folder = join(host.dataDir, "tool-output");
        await mkdir(folder, { recursive: true });
        const path = join(folder, String(api?.conversationId ?? "unknown") + "-" + Date.now() + ".txt");
        await writeFile(path, text, "utf8");
        const replaced = content.map((part: any) =>
            part?.type === "text" && typeof part.text === "string"
                ? {
                      ...part,
                      text:
                          shrunk.text +
                          "\n\n（完整输出 " +
                          shrunk.bytes +
                          " 字节已存到 " +
                          path +
                          "，需要中间那段用 read 带 offset/limit 取。）",
                  }
                : part,
        );
        return { ...result, content: replaced };
    };

    const codemodeWrap = wrapTool(probes.get("codemode")!, (tool) => ({
        ...tool,
        execute: async (args: any, api: any, context: any) => {
            const code = typeof args?.code === "string" ? args.code : "";
            // 只写一处（改文件）放行；只查一处不肯，那正是把一步拆成一轮的写法。
            if (needsMoreCalls(code)) {
                return reply(
                    "门禁：这个脚本只有 1 个 tools.* 调用。一步一个调用会把「轮次 × 每轮重付的上下文」一起放大，账单就是这么来的。" +
                        "把这次要查的东西一次性放进同一个脚本（Promise.allSettled 并发 2 个以上），脚本内部过滤后只贴摘要。" +
                        "如果这一轮只是读文件或搜文本，ops_batch 更省：一次可放 2–8 个 ops_read/ops_search，不用起脚本。",
                );
            }
            if (NESTED_WRITE.test(code)) {
                const blocked = await fileGate(args, api, context);
                if (blocked !== undefined) {
                    return reply(blocked);
                }
            }
            const result = await nested.run(true, () => tool.execute(args, api, context));
            return shrinkResult(result, api);
        },
    }));

    const bashWrap = wrapTool(probes.get("bash")!, (tool) => ({
        ...tool,
        execute: async (args: any, api: any, context: any) => {
            if (nested.getStore() === undefined) {
                return reply(DIRECT_BASH);
            }
            const command = typeof args?.command === "string" ? args.command : "";
            if (command === "") {
                return tool.execute(args, api, context);
            }
            const state = stateOf(api.conversationId);
            const verdict = inspect(state, command);
            if (verdict.action === "block") {
                return reply(verdict.message);
            }
            let streamed = "";
            const originalOutput = (api as any)?.output;
            if (typeof originalOutput === "function") {
                (api as any).output = (chunk: any) => {
                    try {
                        streamed += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
                    } catch {
                        // A chunk we cannot decode adds nothing; the result text stays the source of truth.
                    }
                    originalOutput(chunk);
                };
            }
            const result = await tool.execute(args, api, context);
            record(state, command, result, Date.now(), streamed);
            return result;
        },
    }));

    const wraps = [
        guard("write"),
        guard("edit"),
        guard("ops_write"),
        guard("ops_edit"),
        codemodeWrap,
        bashWrap,
    ];
    // ─── Panel routes ────────────────────────────────────────────────────────

    const view = (doc: Interview, ledger: Ledger) => {
        const stage = openStage(ledger);
        return {
            protocol: 1,
            title: doc.title,
            round: doc.round,
            status: doc.status,
            questions: doc.questions ?? [],
            answers: doc.answers ?? {},
            waived: doc.waived ?? {},
            pendingWaive: doc.pendingWaive ?? {},
            missing: missing(doc),
            stage: stage === undefined ? null : { n: stage.n, title: stage.title, files: stage.files },
        };
    };

    web.client("pi-pocket-gates", { access: "owner" });
    web.conversationRoute(
        "GET",
        "interview/:source",
        async (request: any) => {
            const doc = (await request.snapshot(InterviewDoc, request.conversation.id, request.context)) ?? emptyInterview();
            const ledger = (await request.snapshot(LedgerDoc, request.conversation.id, request.context)) ?? emptyLedger();
            return view(doc, ledger);
        },
        { conversation: "source", access: "owner" },
    );
    web.conversationRoute(
        "POST",
        "interview/:source",
        async (request: any) => {
            const body = request.body ?? {};
            const raw = Array.isArray(body.answers) ? body.answers : [];
            const arriving: Record<string, string[]> = {};
            for (const each of raw) {
                const id = clampText(each?.id, 40);
                const values = Array.isArray(each?.values) ? each.values.map((value: unknown) => clampText(value, 500)).filter(Boolean) : [];
                if (id !== "" && values.length > 0) {
                    arriving[id] = values;
                }
            }
            if (Object.keys(arriving).length === 0) {
                throw web.error(400, "No answers to record.");
            }
            const doc = await request.commit(async (tx: any) => {
                const next = (await tx.doc(InterviewDoc, request.conversation.id)) ?? emptyInterview();
                for (const [id, values] of Object.entries(arriving)) {
                    next.answers[id] = values;
                }
                next.status = "answered";
                next.answeredAt = Date.now();
                next.revision += 1;
                return copyOf(next);
            });
            waiting.get(String(request.conversation.id))?.settle(arriving);
            web.send("interview-answered", { conversationId: request.conversation.id });
            return { ok: true, missing: missing(doc) };
        },
        { conversation: "source", access: "owner" },
    );
    web.conversationRoute(
        "POST",
        "waive/:source",
        async (request: any) => {
            const body = request.body ?? {};
            const dimension = dimensionOf(clampText(body.dimension, 40));
            if (dimension === undefined) {
                throw web.error(400, "Unknown dimension.");
            }
            const approve = body.approve === true;
            const doc = await request.commit(async (tx: any) => {
                const next = (await tx.doc(InterviewDoc, request.conversation.id)) ?? emptyInterview();
                const asked = next.pendingWaive[dimension];
                if (asked === undefined) {
                    throw web.error(409, "No waiver request for that dimension.");
                }
                if (approve) {
                    next.waived[dimension] = asked;
                }
                delete next.pendingWaive[dimension];
                next.revision += 1;
                return copyOf(next);
            });
            web.send("interview-waive-done", { conversationId: request.conversation.id, dimension, approve });
            return { ok: true, waived: approve, missing: missing(doc) };
        },
        { conversation: "source", access: "owner" },
    );

    web.onDispose(() => {
        for (const pending of waiting.values()) {
            pending.forget();
        }
        waiting.clear();
    });

    void readFile;
    void host;


    void readFile;

    return defineExtension({
        name: "pi-pocket-gates",
        tools: [ask, answer, status, waive, document, begin, amend, end, handoff, rerun, plan, done, budget],
        wraps,
    });
}
