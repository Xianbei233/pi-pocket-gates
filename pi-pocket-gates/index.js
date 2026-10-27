/** The 需求追问 panel: the questions spec_ask asked, answered with options or text, and posted back. */
export const pocketApi = 1;

const blank = () => ({
    loading: true,
    title: "",
    round: 0,
    questions: [],
    answers: {},
    pendingWaive: {},
    missing: [],
    stage: null,
});

/** 维度键 → 中文短名；面板只显示中文，数据里仍是英文键。 */
const DIM_LABEL = {
    goal: "目标",
    behavior: "行为",
    data: "数据",
    failures: "失败",
    security: "安全",
    acceptance: "验收",
    nongoals: "不做",
};
const dimOf = (key) => DIM_LABEL[key] ?? key;

/** @param {import("../_pocket.d.ts").Pocket} pocket */
export default function setup(pocket) {
    const { html, useState, useEffect, useCallback } = pocket;

    // The single entry point: a top-bar button showing how many conversations are waiting, from any session.
    const topbar = pocket.topbar({
        id: "interview-inbox",
        title: "需求追问",
        badge: null,
        onClick: () => pocket.openPanel("interview"),
    });

    function Interview() {
        const [view, setView] = useState(blank());
        const [picks, setPicks] = useState({});
        const [texts, setTexts] = useState({});
        const [error, setError] = useState("");
        const [sending, setSending] = useState(false);
        const [showAnswered, setShowAnswered] = useState(false);
        const [inbox, setInbox] = useState([]);
        const id = pocket.conversationId();

        const load = useCallback(async () => {
            if (id === null) {
                setView({ ...blank(), loading: false });
                return;
            }
            try {
                const next = await pocket.api("interview/" + id);
                setView({ ...blank(), ...next, loading: false });
                setPicks((current) => {
                    const merged = {};
                    for (const question of next.questions ?? []) {
                        merged[question.id] = current[question.id] ?? next.answers?.[question.id] ?? [];
                    }
                    return merged;
                });
                setError("");
            } catch (failure) {
                setError(failure instanceof Error ? failure.message : "读取追问失败");
                setView({ ...blank(), loading: false });
            }
        }, [id]);

        useEffect(() => {
            load();
        }, [load]);

        useEffect(
            () =>
                pocket.on("interview", () => {
                    load();
                    pocket.openPanel("interview");
                }),
            [load],
        );

        useEffect(
            () =>
                pocket.on("interview-waive", () => {
                    load();
                    pocket.openPanel("interview");
                }),
            [load],
        );

        const pick = (question, label) => {
            const multi = question.kind === "multi";
            setPicks((current) => {
                const chosen = current[question.id] ?? [];
                const next = multi
                    ? chosen.includes(label)
                        ? chosen.filter((each) => each !== label)
                        : [...chosen, label]
                    : [label];
                return { ...current, [question.id]: next };
            });
        };

        const submit = async () => {
            if (id === null) {
                return;
            }
            const answers = (view.questions ?? []).map((question) => {
                const chosen = [...(picks[question.id] ?? [])];
                const typed = (texts[question.id] ?? "").trim();
                if (typed !== "") {
                    chosen.push(typed);
                }
                return { id: question.id, values: chosen };
            });
            const empty = answers.filter((each) => each.values.length === 0);
            if (empty.length > 0) {
                setError("还有 " + empty.length + " 个问题没答：" + empty.map((each) => each.id).join(", "));
                return;
            }
            setSending(true);
            try {
                const result = await pocket.api("interview/" + id, { answers });
                pocket.notify("info", "答案已提交" + (result?.missing?.length ? "，仍缺 " + result.missing.join(", ") : ""));
                pocket.closePanel();
            } catch (failure) {
                setError(failure instanceof Error ? failure.message : "提交失败");
            } finally {
                setSending(false);
            }
        };

        const confirmWaive = async (dimension, approve) => {
            if (id === null) {
                return;
            }
            try {
                const result = await pocket.api("waive/" + id, { dimension, approve });
                pocket.notify("info", approve ? "已豁免 " + dimension : "已拒绝豁免 " + dimension);
                if (result?.missing) {
                    setView((current) => ({ ...current, missing: result.missing }));
                }
                load();
            } catch (failure) {
                setError(failure instanceof Error ? failure.message : "豁免操作失败");
            }
        };

        if (view.loading) {
            return html`<p class="spec-hint">读取追问…</p>`;
        }
        if (id === null) {
            return html`<div class="spec-panel">
                <p class="spec-hint">先打开一个会话，这个面板要在会话里才能读到问题。</p>
            </div>`;
        }

        useEffect(() => {
            let alive = true;
            const refresh = async () => {
                try {
                    const state = await pocket.api("inbox");
                    if (!alive) {
                        return;
                    }
                    const items = state?.items ?? [];
                    setInbox(items);
                    topbar.update({ badge: items.length > 0 ? String(items.length) : null });
                } catch {
                    // The inbox is a convenience: a failed poll leaves the screen as it was.
                }
            };
            void refresh();
            const timer = setInterval(() => void refresh(), 20000);
            return () => {
                alive = false;
                clearInterval(timer);
            };
        }, []);

        const pending = Object.entries(view.pendingWaive ?? {}).filter(
            (entry) => entry[1] !== null && typeof entry[1] === "object",
        );
        const hasQuestions = (view.questions ?? []).length > 0;
        const others = (inbox ?? []).filter((each) => String(each.conversationId) !== String(id));
        const answered = view.answered ?? [];

        return html`<div class="spec-panel">
            <header class="spec-head">
                <strong>${view.title || "需求追问"}</strong>
                <span class="spec-meta"
                    >${"第 " +
                    view.round +
                    " 轮" +
                    (view.stage ? " · 进行中 S" + view.stage.n : " · 无进行中阶段")}</span
                >
            </header>

            ${pending.length > 0
                ? html`<div class="spec-waivers">
                      ${pending.map(
                          ([dimension, request]) => html`<div class="spec-waiver" key=${dimension}>
                              <p>${"模型申请豁免「" + dimOf(dimension) + "」：" + (request.reason || "")}</p>
                              <div class="spec-waiver-actions">
                                  <button class="button primary small" onClick=${() => void confirmWaive(dimension, true)}>同意豁免</button>
                                  <button
                                      class="button ghost small"
                                      onClick=${() => void confirmWaive(dimension, false)}
                                  >
                                      拒绝
                                  </button>
                              </div>
                          </div>`,
                      )}
                  </div>`
                : null}

            ${others.length > 0
                ? html`<div class="spec-inbox">
                      <div class="spec-inbox-head">${"其他会话在等你（" + others.length + "）"}</div>
                      ${others.map(
                          (item) => html`<div class="spec-inbox-row" key=${String(item.conversationId)}>
                              <div class="spec-inbox-text">
                                  <b>${item.label || "会话 " + item.conversationId}</b>
                                  <em>${item.count + " 个问题 · " + (item.first || "")}</em>
                              </div>
                              <button
                                  class="button ghost small"
                                  onClick=${() => pocket.openConversation(item.conversationId)}
                              >
                                  去回答
                              </button>
                          </div>`,
                      )}
                  </div>`
                : null}

            ${hasQuestions
                ? html`<div class="spec-list">
                      ${(view.questions ?? []).map((question) => {
                          const answered = (view.answers?.[question.id] ?? []).length > 0;
                          return html`<section class=${"spec-q" + (answered ? " is-answered" : "")} key=${question.id}>
                              <div class="spec-q-head">
                                  <span class="spec-dim">${dimOf(question.dimension)}</span>
                                  ${answered ? html`<span class="spec-done">已答</span>` : null}
                              </div>
                              <p class="spec-question">${question.question}</p>
                              ${(question.options ?? []).length > 0
                                  ? html`<div class="spec-options">
                                        ${(question.options ?? []).map(
                                            (option) => html`<label class="spec-option" key=${option.label}>
                                                <input
                                                    type=${question.kind === "multi" ? "checkbox" : "radio"}
                                                    name=${question.id}
                                                    checked=${(picks[question.id] ?? []).includes(option.label)}
                                                    onChange=${() => pick(question, option.label)}
                                                />
                                                <span>
                                                    <b>${option.label}</b>
                                                    ${option.description
                                                        ? html`<em>${option.description}</em>`
                                                        : null}
                                                </span>
                                            </label>`,
                                        )}
                                    </div>`
                                  : null}
                              ${question.allowText !== false
                                  ? html`<input
                                        class="spec-text"
                                        type="text"
                                        placeholder="补充或直接写答案（可留空）"
                                        value=${texts[question.id] ?? ""}
                                        onInput=${(event) => {
                                            const value = event.currentTarget.value;
                                            setTexts((current) => ({ ...current, [question.id]: value }));
                                        }}
                                    />`
                                  : null}
                          </section>`;
                      })}
                  </div>`
                : html`<p class="spec-hint">这个会话还没有提问。</p>`}

            ${answered.length > 0
                ? html`<div class="spec-answered">
                      <button class="spec-answered-toggle" onClick=${() => setShowAnswered(!showAnswered)}>
                          ${"已答 " + answered.length + " 题" + (showAnswered ? "（收起）" : "（展开）")}
                      </button>
                      ${showAnswered
                          ? html`<div class="spec-answered-list">
                                ${answered.map(
                                    (item) => html`<div class="spec-answered-row" key=${item.id}>
                                        <span class="spec-dim">${dimOf(item.dimension)}</span>
                                        <p>${item.question}</p>
                                        <em>${(item.values ?? []).join("、")}</em>
                                    </div>`,
                                )}
                            </div>`
                          : null}
                  </div>`
                : null}

            ${error ? html`<p class="spec-error">${error}</p>` : null}

            <footer class="spec-foot">
                <button class="button primary spec-submit" disabled=${sending || !hasQuestions} onClick=${() => void submit()}>
                    ${sending ? "提交中…" : "提交答案"}
                </button>
                ${(view.missing ?? []).length > 0
                    ? html`<span class="spec-meta">${"仍缺：" + view.missing.map(dimOf).join("、")}</span>`
                    : null}
            </footer>
        </div>`;
    }

    pocket.style("style.css");
    pocket.panel({ id: "interview", title: "需求追问", component: Interview });

    pocket.on("interview-answered", () => {
        pocket.notify("info", "需求回答已记录，模型继续。");
    });
}
