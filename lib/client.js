window.__ModuleLoader__.load({
	id: "dsh-model-fusion",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region src/client/i18n.ts
		let source;
		const listeners$1 = /* @__PURE__ */ new Set();
		const notify = () => {
			for (const listener of listeners$1) listener();
		};
		/** Called from the client entry when DSH's locale service is available; follows the user's language setting. */
		function bindLocale(next) {
			source = next;
			notify();
			const unsubscribe = next.subscribe(notify);
			return () => {
				unsubscribe();
				if (source === next) {
					source = void 0;
					notify();
				}
			};
		}
		const current = () => {
			return (source?.getSnapshot().active ?? (typeof navigator === "undefined" ? "en" : navigator.language)).toLowerCase().startsWith("zh") ? "zh" : "en";
		};
		/** The UI language: Chinese for any zh locale, English otherwise (DSH's own fallback). */
		function useLang() {
			return (0, react.useSyncExternalStore)((listener) => {
				listeners$1.add(listener);
				return () => {
					listeners$1.delete(listener);
				};
			}, current, () => "en");
		}
		/** Pick the text for the active language. */
		const tr = (lang, zh, en) => lang === "zh" ? zh : en;
		//#endregion
		//#region src/client/FusionHistory.tsx
		const takeoverReason = (lang, reason) => ({
			"checks-still-failing": tr(lang, "返工后检查仍失败", "checks still failing after rework"),
			"worker-step-limit": tr(lang, "Sidekick 步数用尽", "Sidekick step limit"),
			"worker-stalled": tr(lang, "Sidekick 反复停滞", "Sidekick stalled repeatedly")
		})[reason] ?? reason;
		const tokens$1 = (lang, field, calls) => !calls ? "—" : !field.reported ? tr(lang, "未提供", "not reported") : `${field.known.toLocaleString()}${field.reported < calls ? tr(lang, `（${field.reported}/${calls} 次有报告）`, ` (${field.reported}/${calls} reported)`) : ""}`;
		const purpose = (lang, value) => ({
			conversation: tr(lang, "任务", "task"),
			compaction: tr(lang, "压缩", "compaction"),
			"cache-keepalive": tr(lang, "保活", "keepalive"),
			"session-title": tr(lang, "标题", "title")
		})[value] ?? value;
		function FusionHistory() {
			const lang = useLang();
			const [page, setPage] = (0, react.useState)();
			const [cursor, setCursor] = (0, react.useState)("");
			const [error, setError] = (0, react.useState)("");
			const [refresh, setRefresh] = (0, react.useState)(0);
			const [loading, setLoading] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				const abort = new AbortController();
				setLoading(true);
				setError("");
				fetch(`/api/model-fusion?view=history&cursor=${encodeURIComponent(cursor)}`, {
					credentials: "same-origin",
					cache: "no-store",
					signal: abort.signal
				}).then(async (response) => {
					if (!response.ok) throw new Error(tr(lang, "历史记录暂时无法读取", "History is unavailable right now"));
					return response.json();
				}).then(setPage).catch((error) => {
					if (!abort.signal.aborted) setError(String(error));
				}).finally(() => {
					if (!abort.signal.aborted) setLoading(false);
				});
				return () => abort.abort();
			}, [
				cursor,
				refresh,
				lang
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "fusion-history",
				"aria-label": tr(lang, "Fusion 历史与统计", "Fusion history and statistics"),
				"data-ud-check": "fusion-history",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: tr(lang, "历史与统计", "History and statistics") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: tr(lang, "按实际模型请求汇总，包含任务、压缩、保活及已有标题请求。未报告的用量不算作 0；金额与节省率尚无可靠数据。", "Totals of actual model requests: tasks, compaction, keepalive and title requests. Unreported usage is not counted as 0; no reliable billed amount or saving rate is available.") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						disabled: loading,
						onClick: () => setRefresh((value) => value + 1),
						children: tr(lang, "刷新记录", "Refresh")
					}),
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "alert",
						children: error
					}),
					loading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "status",
						children: tr(lang, "正在读取记录…", "Loading…")
					}),
					page && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: tr(lang, `${page.totalTasks} 项任务 · ${page.totals.calls} 次原生请求 · ${page.totals.final} 次用量定稿 · ${page.totals.provisional} 次暂报 · ${page.totals.unreported} 次未提供`, `${page.totalTasks} tasks · ${page.totals.calls} native requests · ${page.totals.final} final usage · ${page.totals.provisional} provisional · ${page.totals.unreported} unreported`) }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
							tr(lang, "未缓存输入", "Uncached input"),
							" ",
							tokens$1(lang, page.totals.input, page.totals.calls),
							" · ",
							tr(lang, "缓存读取", "cache read"),
							" ",
							tokens$1(lang, page.totals.cacheRead, page.totals.calls),
							" · ",
							tr(lang, "输出", "output"),
							" ",
							tokens$1(lang, page.totals.output, page.totals.calls),
							" Token"
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
							tr(lang, `Lead 接手改代码 ${page.takeovers?.total ?? 0} 次（${page.takeovers?.tasks ?? 0} 项任务）`, `Lead takeovers: ${page.takeovers?.total ?? 0} (${page.takeovers?.tasks ?? 0} tasks)`),
							page.takeovers?.total ? `: ${Object.entries(page.takeovers.reasons).map(([reason, count]) => `${takeoverReason(lang, reason)} ${count}`).join(", ")}` : "",
							tr(lang, "。只有 Sidekick 确实完成不了时，程序才会解锁接手。", ". The Host unlocks a takeover only when the Sidekick demonstrably cannot finish.")
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: { overflowX: "auto" },
							tabIndex: 0,
							"aria-label": tr(lang, "按实际模型统计", "By actual model"),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("caption", { children: tr(lang, "按角色、实际模型和请求用途", "By role, actual model and purpose") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
										scope: "col",
										children: tr(lang, "角色 / 模型", "Role / model")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
										scope: "col",
										children: tr(lang, "用途", "Purpose")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
										scope: "col",
										children: tr(lang, "请求", "Requests")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
										scope: "col",
										children: tr(lang, "输出 Token", "Output tokens")
									})
								] }) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: page.groups.map((group) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("th", {
										scope: "row",
										children: [
											group.role === "lead" ? "Lead" : "Sidekick",
											" · ",
											group.model,
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: group.provider })
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: purpose(lang, group.purpose) }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: group.calls }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: tokens$1(lang, group.output, group.calls) })
								] }, JSON.stringify([
									group.role,
									group.provider,
									group.model,
									group.purpose
								]))) })
							] })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: tr(lang, "任务记录", "Tasks") }),
						!page.tasks.length && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: tr(lang, "还没有 Fusion 任务。", "No Fusion tasks yet.") }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", { children: page.tasks.map((task) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: task.title }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
								new Date(task.createdAt).toLocaleString(),
								" · ",
								task.mode === "completed" ? tr(lang, "已结束", "finished") : task.phase,
								" · ",
								tr(lang, `${task.usage.calls} 次请求`, `${task.usage.calls} requests`),
								task.takeovers ? tr(lang, ` · Lead 接手 ${task.takeovers} 次`, ` · ${task.takeovers} Lead takeovers`) : ""
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: tr(lang, "记录详情", "Details") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
									tr(lang, "任务", "Task"),
									": ",
									task.id
								] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
									tr(lang, "会话", "Session"),
									": ",
									task.sessionId
								] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: tr(lang, `验证状态：${task.verification}。历史运行状态不代表当前仍在执行。`, `Verification: ${task.verification}. A recorded state does not mean it is still running.`) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
									tr(lang, "输入", "Input"),
									" ",
									tokens$1(lang, task.usage.input, task.usage.calls),
									" · ",
									tr(lang, "缓存读取", "cache read"),
									" ",
									tokens$1(lang, task.usage.cacheRead, task.usage.calls),
									" · ",
									tr(lang, "输出", "output"),
									" ",
									tokens$1(lang, task.usage.output, task.usage.calls),
									" Token"
								] })
							] })
						] }, task.id)) }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "fusion-actions",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								disabled: loading || !cursor,
								onClick: () => setCursor(""),
								children: tr(lang, "最新记录", "Newest")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								disabled: loading || !page.nextCursor,
								onClick: () => setCursor(page.nextCursor),
								children: tr(lang, "更早记录", "Older")
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: tr(lang, `更新于 ${new Date(page.observedAt).toLocaleString()}。供应商内部重试次数未知。`, `Updated ${new Date(page.observedAt).toLocaleString()}. Provider-internal retries are unknown.`) })
					] })
				]
			});
		}
		//#endregion
		//#region src/client/FusionCache.tsx
		const tokens = (value) => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(value);
		const minutes = (seconds) => seconds % 60 ? `${(seconds / 60).toFixed(1)} min` : `${seconds / 60} min`;
		const modeName = (lang, mode) => ({
			auto: tr(lang, "自动", "Auto"),
			on: tr(lang, "开启", "On"),
			off: tr(lang, "关闭", "Off")
		})[mode];
		function modeSource(lang, row) {
			switch (row.modeSource) {
				case "user": return tr(lang, "你的设置", "your setting");
				case "pair": return tr(lang, "旧版组合设置", "older pair setting");
				case "role": return tr(lang, "Sidekick 默认关闭（它很少长时间等待）", "Sidekick default off (it rarely waits long)");
				case "route": return `${row.defaults.route.label}: ${lang === "zh" ? row.defaults.route.reason.zh : row.defaults.route.reason.en}`;
				case "family": return tr(lang, `${row.defaults.family.label} 官方默认`, `${row.defaults.family.label} documented default`);
				default: return tr(lang, "通用默认", "generic default");
			}
		}
		function intervalSource(lang, row) {
			if (row.intervalSource === "user") return tr(lang, "你的设置", "your setting");
			if (row.intervalSource === "learned") return tr(lang, "自动学习：保活多次未命中，已缩短", "learned: pings kept missing, shortened");
			return tr(lang, "默认", "default");
		}
		function ModelCard({ row, onSaved }) {
			const lang = useLang();
			const [interval, setInterval] = (0, react.useState)(String(row.setting.intervalSeconds ? row.setting.intervalSeconds / 60 : ""));
			const [busy, setBusy] = (0, react.useState)(false), [error, setError] = (0, react.useState)();
			const save = async (body) => {
				setBusy(true);
				setError(void 0);
				try {
					const response = await fetch("/api/model-fusion", {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							action: "cache-setting",
							provider: row.provider,
							model: row.model,
							...body
						})
					});
					const result = await response.json();
					if (!response.ok) throw new Error(result.error ?? tr(lang, "保存失败", "Save failed"));
					onSaved();
				} catch (reason) {
					setError(reason instanceof Error ? reason.message : String(reason));
				} finally {
					setBusy(false);
				}
			};
			const t = row.totals;
			const family = row.defaults.family;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fusion-cache-model",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [row.model, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [row.provider, row.role ? ` · ${row.role === "lead" ? "Lead" : "Sidekick"}` : ""] })] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
						tr(lang, "现在", "Now"),
						": ",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: modeName(lang, row.mode) }),
						row.mode !== "off" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							tr(lang, "，每 ", ", every "),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: minutes(row.intervalSeconds) }),
							tr(lang, " 续一次", "")
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
							tr(lang, "开关来源", "Mode"),
							": ",
							modeSource(lang, row),
							" · ",
							tr(lang, "间隔来源", "Interval"),
							": ",
							intervalSource(lang, row)
						] })
					] }),
					family && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
						tr(lang, "官方文档", "Documented"),
						": ",
						lang === "zh" ? family.lifetime.zh : family.lifetime.en,
						"；",
						tr(lang, "缓存价约为全价", "cached price ≈"),
						" ",
						family.discount,
						" · ",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
							href: family.docs,
							target: "_blank",
							rel: "noreferrer",
							children: tr(lang, "来源", "source")
						})
					] }) }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fusion-cache-controls",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [tr(lang, "保活", "Keepalive"), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								"aria-label": `${row.model} keepalive`,
								disabled: busy,
								value: row.setting.mode ?? "",
								onChange: (event) => {
									save({
										mode: event.target.value || null,
										intervalSeconds: row.setting.intervalSeconds ?? null
									});
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "",
										children: tr(lang, `默认（${modeName(lang, row.defaults.mode)}）`, `Default (${modeName(lang, row.defaults.mode)})`)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "auto",
										children: tr(lang, "自动：该模型返回过缓存命中后才开启", "Auto: only after this model reports cache hits")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "on",
										children: tr(lang, "开启", "On")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "off",
										children: tr(lang, "关闭（按请求次数计费的套餐选这个）", "Off (choose for plans billed per request)")
									})
								]
							})] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [tr(lang, "间隔（分钟）", "Interval (min)"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "number",
								min: "1",
								max: "59",
								step: "0.5",
								disabled: busy,
								value: interval,
								placeholder: String(+(row.intervalSeconds / 60).toFixed(2)),
								onChange: (event) => setInterval(event.target.value),
								onBlur: () => {
									if (interval !== String(row.setting.intervalSeconds ? row.setting.intervalSeconds / 60 : "")) save({
										mode: row.setting.mode ?? null,
										intervalSeconds: interval ? Math.round(Number(interval) * 60) : null
									});
								}
							})] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: busy || !row.setting.mode && !row.setting.intervalSeconds,
								onClick: () => {
									setInterval("");
									save({ reset: true });
								},
								children: tr(lang, "恢复默认", "Reset")
							})
						]
					}),
					row.suggestion && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "status",
						children: tr(lang, `观察到等待 ${minutes(row.suggestion)} 以上缓存仍然命中，可以把间隔放宽到 ${minutes(row.suggestion)}（不会自动修改）。`, `Cache still hit after waits over ${minutes(row.suggestion)}; you can lengthen the interval to ${minutes(row.suggestion)} (not changed automatically).`)
					}),
					t ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
						tr(lang, "效果", "Effect"),
						": ",
						tr(lang, `等待后命中 ${t.waitHits}/${t.waits} 次`, `hit after ${t.waitHits}/${t.waits} waits`),
						t.waits ? ` (${Math.round(100 * t.waitHits / t.waits)}%)` : "",
						"；",
						tr(lang, ` 保活 ${t.pings} 次（${t.pingHits} 次命中，读取 ${tokens(t.pingTokens)} token，多为缓存价${t.pingOutputTokens != null ? `，输出 ${tokens(t.pingOutputTokens)} token` : ""}）；`, ` ${t.pings} pings (${t.pingHits} hit, ${tokens(t.pingTokens)} tokens read, mostly at cache price${t.pingOutputTokens != null ? `, ${tokens(t.pingOutputTokens)} output` : ""}); `),
						tr(lang, ` 等待后仍从缓存读取 ${tokens(t.keptWarmTokens)} token，按全价重发 ${tokens(t.resentTokens)} token。`, ` after waits ${tokens(t.keptWarmTokens)} tokens served from cache, ${tokens(t.resentTokens)} resent at full price.`),
						t.pings >= 5 && t.pingHits / t.pings < .5 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: tr(lang, " 保活大多没命中，建议关闭或缩短间隔。", " Most pings missed: turn it off or shorten the interval.") })
					] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: tr(lang, "还没有数据：Lead 等待 Sidekick 之后才会产生记录。", "No data yet: records appear after the Lead waits for the Sidekick.") }),
					!!row.recent.length && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
						tr(lang, "最近", "Recent"),
						": ",
						row.recent.map((item, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
							item.ping ? "↻" : "",
							minutes(item.gapSeconds),
							item.hit ? " ✓" : " ✗",
							i < row.recent.length - 1 ? " · " : ""
						] }, i))
					] }) }),
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "alert",
						children: error
					})
				]
			});
		}
		/** Per-model cache keepalive: what applies and why, the documented default, and what was observed. */
		function FusionCache({ refresh }) {
			const lang = useLang();
			const [rows, setRows] = (0, react.useState)(), [checked, setChecked] = (0, react.useState)(), [error, setError] = (0, react.useState)();
			const [reload, setReload] = (0, react.useState)(0);
			(0, react.useEffect)(() => {
				const abort = new AbortController();
				fetch("/api/model-fusion?view=cache", {
					credentials: "same-origin",
					cache: "no-store",
					signal: abort.signal
				}).then(async (response) => {
					if (!response.ok) throw new Error(tr(lang, "无法读取缓存设置", "Cannot read cache settings"));
					return response.json();
				}).then((value) => {
					setRows(value.models);
					setChecked(value.checked);
				}).catch((reason) => {
					if (!abort.signal.aborted) setError(String(reason));
				});
				return () => abort.abort();
			}, [
				refresh,
				reload,
				lang
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "fusion-cache",
				"aria-label": tr(lang, "缓存保活", "Cache keepalive"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: tr(lang, "缓存保活", "Cache keepalive") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: tr(lang, "Lead 等 Sidekick 干活时可能要等几分钟，模型的输入缓存过期后，下一次请求会按全价重读整段对话。保活在等待期间定时把 Lead 上一次的请求原样再发一遍，末尾只加一句“Reply OK”，模型只回一个 OK，缓存就不会过期。默认值来自各家官方文档，每个模型都可以单独调整。", "While the Lead waits for the Sidekick, the model's prompt cache can expire and the next request re-reads the whole conversation at full price. Keepalive resends the Lead's previous request at intervals with only “Reply OK” appended; the model answers OK and the cache stays warm. Defaults come from each provider's documentation; every model can be adjusted.") }),
					checked && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: tr(lang, `官方默认值核对日期：${checked}。`, `Documented defaults checked on ${checked}.`) }) }),
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "alert",
						children: error
					}),
					rows?.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelCard, {
						row,
						onSaved: () => setReload((value) => value + 1)
					}, `${row.provider}/${row.model}/${row.setting.mode ?? ""}/${row.setting.intervalSeconds ?? ""}`))
				]
			});
		}
		//#endregion
		//#region src/client/settings-events.ts
		const listeners = /* @__PURE__ */ new Set();
		const onSettingsChanged = (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		};
		const settingsChanged = () => {
			for (const listener of listeners) listener();
		};
		//#endregion
		//#region src/client/FusionSettings.tsx
		const styles$1 = `
.fusion-settings{max-width:680px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:18px}
.fusion-settings h2{margin:0;font-size:22px;line-height:30px;font-weight:600}
.fusion-settings p{margin:0;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary)}
.fusion-settings header{display:flex;flex-direction:column;gap:8px}
.fusion-settings .fusion-card{padding:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;display:flex;flex-direction:column;gap:20px;background:var(--dsw-alias-bg-module-platform)}
.fusion-settings fieldset{padding:0;margin:0;border:0;min-inline-size:0;display:flex;flex-direction:column;gap:10px}
.fusion-settings legend{font-size:15px;font-weight:600;padding:0 0 4px}
.fusion-settings label{display:grid;grid-template-columns:85px minmax(0,1fr);align-items:center;gap:12px;font-size:13px}
.fusion-settings select{box-sizing:border-box;min-width:0;width:100%;min-height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 9px;background:var(--dsw-alias-bg-page-primary);color:inherit;font:inherit}
.fusion-settings .fusion-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.fusion-settings button{border:1px solid var(--dsw-alias-border-l2);border-radius:18px;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,#fff);padding:7px 18px;font:inherit;font-size:13px;cursor:pointer}
.fusion-settings button:disabled{opacity:.5;cursor:default}
.fusion-settings :is(button,select):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.fusion-settings [role=alert]{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.fusion-settings details{font-size:13px;line-height:21px}
.fusion-settings summary{cursor:pointer;font-weight:500}
.fusion-settings .fusion-limits{display:flex;flex-direction:column;gap:12px;padding-top:14px}
.fusion-settings input[type=number]{min-width:0;width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-page-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:8px;color:inherit;font:inherit}
.fusion-settings .fusion-consent{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px}
.fusion-cache{display:flex;flex-direction:column;gap:12px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:20px}.fusion-cache h3{margin:0}.fusion-cache-model{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}.fusion-cache-model small{display:block;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.fusion-cache-controls{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr) auto;gap:10px;align-items:end}.fusion-cache-controls label{grid-template-columns:1fr;gap:4px}.fusion-cache a{color:var(--dsw-alias-brand-primary)}
@media(max-width:560px){.fusion-cache-controls{grid-template-columns:1fr}}
.fusion-history{display:flex;flex-direction:column;gap:12px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:20px}.fusion-history table{width:100%;border-collapse:collapse;font-size:12px;text-align:left}.fusion-history :is(th,td){padding:8px;border-bottom:1px solid var(--dsw-alias-border-l2);font-weight:400;vertical-align:top}.fusion-history caption{text-align:left;font-size:13px;margin-bottom:8px}.fusion-history small{display:block;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.fusion-history ol{padding-left:20px;margin:0}.fusion-history li{padding:10px 0}.fusion-history h3{margin:8px 0 0}.fusion-history p{overflow-wrap:anywhere}
@media(max-width:480px){.fusion-settings label{grid-template-columns:1fr;gap:6px}.fusion-settings .fusion-card{padding:16px}}
`;
		const key = (route) => route ? JSON.stringify([route.provider, route.model]) : "";
		function ModelChoice({ role, route, catalog, onChange }) {
			const lang = useLang();
			const name = role === "compactor" ? tr(lang, "压缩", "Compaction") : role;
			const model = catalog.groups.find((group) => group.id === route?.provider)?.models.find((model) => model.id === route?.model);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", { children: name }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: role === "Lead" ? tr(lang, "回答问题、制定方案并审查结果。", "Answers, plans and reviews.") : role === "Sidekick" ? tr(lang, "执行命令和修改，接收反馈后继续。", "Runs commands and makes changes, then continues with feedback.") : tr(lang, "整理较早的上下文，供 Lead 或 Worker 继续工作。", "Summarises older context so the Lead or Sidekick can continue.") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [tr(lang, "模型", "Model"), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
					"aria-label": tr(lang, `${name} 模型`, `${name} model`),
					value: key(route),
					onChange: (event) => {
						if (!event.target.value) {
							onChange(void 0);
							return;
						}
						const [provider, model] = JSON.parse(event.target.value);
						onChange({
							provider,
							model
						});
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: "",
						disabled: role !== "compactor",
						children: role === "compactor" ? tr(lang, "使用当前角色模型", "Use the role's own model") : tr(lang, "选择已连接的模型", "Choose a connected model")
					}), catalog.groups.map((group) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("optgroup", {
						label: group.name,
						children: group.models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: key({
								provider: group.id,
								model: model.id
							}),
							children: model.name
						}, model.id))
					}, group.id))]
				})] }),
				model?.reasoning && route && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [tr(lang, "推理强度", "Reasoning"), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
					"aria-label": tr(lang, `${name} 推理强度`, `${name} reasoning`),
					value: route.reasoningEffort ?? "",
					onChange: (event) => {
						const { reasoningEffort: _old, ...physical } = route;
						onChange({
							...physical,
							...event.target.value ? { reasoningEffort: event.target.value } : {}
						});
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
						value: "",
						children: [tr(lang, "模型默认", "Model default"), model.reasoning.defaultEffort ? ` · ${model.reasoning.defaultEffort}` : ""]
					}), model.reasoning.efforts.map((effort) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: effort.id,
						children: effort.name
					}, effort.id))]
				})] })
			] });
		}
		function FusionSettings() {
			const lang = useLang();
			const [state, setState] = (0, react.useState)();
			const [draft, setDraft] = (0, react.useState)({});
			const [error, setError] = (0, react.useState)();
			const [notice, setNotice] = (0, react.useState)();
			const [saving, setSaving] = (0, react.useState)(false);
			const chooseModel = (role, route) => setDraft((value) => ({
				...value,
				[role]: route,
				...value.cacheKeepalive ? { cacheKeepalive: {
					...value.cacheKeepalive,
					[role]: role === "lead" ? "auto" : false
				} } : {}
			}));
			(0, react.useEffect)(() => {
				const abort = new AbortController();
				fetch("/api/model-fusion?view=settings", {
					credentials: "same-origin",
					cache: "no-store",
					signal: abort.signal
				}).then(async (response) => {
					if (!response.ok) throw new Error(tr(lang, "无法读取 Fusion 设置", "Cannot read Fusion settings"));
					return response.json();
				}).then((value) => {
					setState(value);
					setDraft(value.pair ?? {});
				}).catch((error) => {
					if (!abort.signal.aborted) setError(String(error));
				});
				return () => abort.abort();
			}, []);
			const save = async () => {
				if (!state || !draft.lead || !draft.worker) return;
				setSaving(true);
				setError(void 0);
				setNotice(void 0);
				try {
					const { outputTokens, ...rest } = draft;
					const limits = Object.fromEntries(Object.entries(outputTokens ?? {}).filter(([, tokens]) => Number.isSafeInteger(tokens) && Number(tokens) > 0));
					const pair = {
						...rest,
						...Object.keys(limits).length ? { outputTokens: limits } : {}
					};
					const response = await fetch("/api/model-fusion", {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							action: "configure",
							revision: state.revision,
							pair
						})
					});
					const result = await response.json();
					if (!response.ok) throw new Error(result.error ?? tr(lang, "保存失败，请刷新后重试", "Save failed; refresh and try again"));
					const current = await fetch("/api/model-fusion?view=settings", {
						credentials: "same-origin",
						cache: "no-store"
					});
					if (!current.ok) throw new Error(tr(lang, "配置已提交，但暂时无法确认，请刷新", "Saved, but not confirmed yet; refresh"));
					const confirmed = await current.json();
					setState(confirmed);
					setDraft(confirmed.pair ?? {});
					settingsChanged();
					setNotice(tr(lang, "组合已保存并启用。可以在模型菜单中选择 Fusion · 自动。", "Pair saved and enabled. Choose Fusion · auto in the model menu."));
				} catch (error) {
					setError(error instanceof Error ? error.message : String(error));
				} finally {
					setSaving(false);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fusion-settings",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: styles$1 }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "Fusion" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: tr(lang, "选择 Lead 和 Sidekick。Lead 处理日常请求、安排工作并审查结果；Sidekick 执行委派的任务。", "Choose a Lead and a Sidekick. The Lead handles requests, plans and reviews; the Sidekick does the delegated work.") }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: tr(lang, "搭配建议", "Pairing tip") }),
							": ",
							tr(lang, "Fusion 省钱靠的是 Sidekick 比 Lead 便宜得多。选一个强的前沿模型当 Lead，再选一个价格低很多（最好 5 倍以上）的模型当 Sidekick；两者价格越接近，越省不了钱。", "Fusion saves money because the Sidekick is much cheaper than the Lead. Pick a strong frontier Lead and a Sidekick that costs far less (ideally 5× or more); the closer their prices, the smaller the saving.")
						] })
					] }),
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "alert",
						children: error
					}),
					!state && !error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "status",
						children: tr(lang, "正在读取模型…", "Loading models…")
					}),
					state && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
							className: "fusion-card",
							disabled: saving,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelChoice, {
									role: "Lead",
									route: draft.lead,
									catalog: state.catalog,
									onChange: (route) => {
										if (route) chooseModel("lead", route);
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelChoice, {
									role: "Sidekick",
									route: draft.worker,
									catalog: state.catalog,
									onChange: (route) => {
										if (route) chooseModel("worker", route);
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: tr(lang, "上下文压缩模型 · 可选", "Compaction model · optional") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "fusion-limits",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: tr(lang, "默认由当前角色模型压缩。也可以单独选择已连接的模型；请求由所选账号计费。", "By default each role compacts with its own model. You can pick another connected model; its account is billed.") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelChoice, {
											role: "compactor",
											route: draft.compactor?.route,
											catalog: state.catalog,
											onChange: (route) => setDraft((value) => {
												const { compactor, ...rest } = value;
												return route ? {
													...rest,
													compactor: {
														route,
														maxOutputTokens: compactor?.maxOutputTokens ?? 8192
													}
												} : rest;
											})
										}),
										draft.compactor && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [tr(lang, "输出 Token 上限", "Output token limit"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											"aria-label": tr(lang, "压缩输出 Token 上限", "Compaction output token limit"),
											type: "number",
											min: "1",
											max: "128000",
											value: draft.compactor.maxOutputTokens,
											onChange: (event) => {
												const maxOutputTokens = Number(event.target.value);
												setDraft((value) => value.compactor ? {
													...value,
													compactor: {
														...value.compactor,
														maxOutputTokens
													}
												} : value);
											}
										})] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: tr(lang, "已选中的会话仍使用原配置。", "Conversations already using Fusion keep their setup.") })
									]
								})] })
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "fusion-actions",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: tr(lang, "已选中的会话保留原组合；新选择使用新组合。", "Conversations already using Fusion keep their pair; new selections use the new one.") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								disabled: saving || !draft.lead || !draft.worker || JSON.stringify(draft) === JSON.stringify(state.pair),
								onClick: () => {
									save();
								},
								children: saving ? tr(lang, "正在保存…", "Saving…") : tr(lang, "保存组合", "Save pair")
							})]
						}),
						notice && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							role: "status",
							children: notice
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: tr(lang, "输出参数跟随原生模型设置，Fusion 不额外限制请求次数或任务轮数。", "Output settings follow the native model settings; Fusion adds no request or round limits.") }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: tr(lang, "保存即表示允许 Fusion 使用所选模型的现有账号；费用由这些账号计入，当前未提供可靠的实际账单金额。", "Saving lets Fusion use the chosen models' existing accounts; they are billed there, and no reliable billed amount is available here.") }),
						state.pair && !state.authorized && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							role: "status",
							children: [tr(lang, "组合需要重新保存后才能使用", "Save the pair again before use"), state.reason ? `: ${state.reason}` : ""]
						}),
						state.managedAuthorization && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: tr(lang, "运行额度由外部授权配置管理。", "Run limits are managed by an external authorization file.") })
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FusionCache, { refresh: state?.revision ?? 0 }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FusionHistory, {})
				]
			});
		}
		//#endregion
		//#region src/client/FusionRecovery.tsx
		function FusionRecovery({ sessionId, task }) {
			const lang = useLang();
			const control = task.modelControl;
			const [role, setRole] = (0, react.useState)("lead");
			const [route, setRoute] = (0, react.useState)();
			const [catalog, setCatalog] = (0, react.useState)();
			const [dueAt, setDueAt] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [notice, setNotice] = (0, react.useState)("");
			const [error, setError] = (0, react.useState)("");
			const action = async (name) => {
				setBusy(true);
				setError("");
				setNotice("");
				try {
					const response = await fetch("/api/model-fusion", {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							action: name,
							sessionId,
							taskId: task.id,
							revision: control.revision,
							role,
							route,
							...dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}
						})
					});
					const result = await response.json();
					if (!response.ok) throw new Error(result.error ?? tr(lang, "操作未完成，请刷新状态", "Not completed; refresh the status"));
					setNotice(name === "schedule" ? tr(lang, "已设置一次定时继续。Host 需要运行；新消息会取消安排。", "One scheduled continuation is set. The Host must be running; a new message cancels it.") : name === "cancel-schedule" ? tr(lang, "已取消定时继续。", "Scheduled continuation cancelled.") : tr(lang, "已提交继续操作，状态将自动更新。", "Continuation submitted; the status updates automatically."));
				} catch (error) {
					setError(error instanceof Error ? error.message : String(error));
				} finally {
					setBusy(false);
				}
			};
			const loadCatalog = async () => {
				setError("");
				try {
					const response = await fetch("/api/model-fusion?view=catalog", {
						credentials: "same-origin",
						cache: "no-store"
					});
					if (!response.ok) throw new Error(tr(lang, "无法读取模型列表", "Cannot read the model list"));
					const value = await response.json();
					setCatalog({
						...value,
						groups: value.groups.filter((group) => group.id !== "dsh-model-fusion")
					});
				} catch (error) {
					setError(String(error));
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "fusion-recovery",
				"aria-label": tr(lang, "Fusion 恢复操作", "Fusion recovery"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: tr(lang, "继续当前任务", "Continue this task") }),
					Object.entries(control.waits).filter(([, wait]) => wait?.taskId === task.id).map(([key, wait]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
						key === "lead" ? "Lead" : "Sidekick",
						" · ",
						wait.code,
						" · ",
						wait.code === "NO_PROGRESS" ? tr(lang, "重复操作没有进展，请调整做法", "Repeated steps made no progress; change the approach") : wait.code === "WORKFLOW_INCOMPLETE" ? tr(lang, "报告、委派或审查尚未完成，请检查任务后继续", "A report, handoff or review is unfinished; check the task, then continue") : wait.code.includes("QUOTA") ? tr(lang, "额度重置时间未知", "Quota reset time unknown") : tr(lang, "需要处理模型错误", "A model error needs attention"),
						wait.retryNotBefore && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
							tr(lang, "服务商建议重试时间", "Provider retry hint"),
							": ",
							new Date(wait.retryNotBefore).toLocaleString(),
							" ",
							tr(lang, "（不代表额度重置）", "(not a quota reset)")
						] })
					] }, key)),
					control.schedule && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						role: "status",
						children: [
							tr(lang, "定时继续", "Scheduled continuation"),
							": ",
							new Date(control.schedule.dueAt).toLocaleString(),
							" · ",
							{
								scheduled: tr(lang, "已安排", "scheduled"),
								cancelled: tr(lang, "已取消", "cancelled"),
								fired: tr(lang, "已执行一次", "ran once"),
								failed: tr(lang, "未能执行", "failed")
							}[control.schedule.state],
							control.schedule.reason ? ` · ${control.schedule.reason}` : ""
						]
					}),
					control.operation && ["prepared", "dispatching"].includes(control.operation.state) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "alert",
						children: tr(lang, "上次继续操作的投递结果尚未确认。请检查会话；系统不会自动重发。", "Delivery of the last continuation is unconfirmed. Check the conversation; nothing is resent automatically.")
					}),
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "alert",
						children: error
					}),
					notice && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						role: "status",
						children: notice
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
						disabled: busy || task.unsettledTools > 0 || task.pendingApprovals > 0,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								onClick: () => {
									action("continue");
								},
								children: tr(lang, "继续一次", "Continue once")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", {
									onClick: () => {
										if (!catalog) loadCatalog();
									},
									children: tr(lang, "更换角色模型并继续", "Switch a role model and continue")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
									tr(lang, "角色", "Role"),
									" ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										value: role,
										onChange: (event) => {
											setRole(event.target.value);
											setRoute(void 0);
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "lead",
											children: "Lead"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "worker",
											children: "Sidekick"
										})]
									})
								] }),
								catalog && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelChoice, {
									role: role === "lead" ? "Lead" : "Sidekick",
									route,
									catalog,
									onChange: setRoute
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: tr(lang, "仅更换当前会话的角色模型，保留任务与 Sidekick 会话。后续请求使用新模型的账号。", "Changes this conversation's role model only; the task and the Sidekick session are kept. Later requests use the new model's account.") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									disabled: !route,
									onClick: () => {
										action("switch-role");
									},
									children: tr(lang, "更换并继续一次", "Switch and continue once")
								})
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: tr(lang, "定时继续一次", "Continue once at a time") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
									tr(lang, "本地时间", "Local time"),
									" ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										"aria-label": tr(lang, "定时继续时间", "Continuation time"),
										type: "datetime-local",
										value: dueAt,
										onChange: (event) => setDueAt(event.target.value)
									})
								] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: tr(lang, "按你选择的时间尝试一次；再次遇到额度错误会停止。此时间不代表服务商承诺的恢复时间。", "Tries once at the time you choose and stops on another quota error. It is not a provider-promised reset time.") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									disabled: !dueAt,
									onClick: () => {
										action("schedule");
									},
									children: tr(lang, "设置时间", "Set time")
								}),
								control.schedule?.state === "scheduled" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									onClick: () => {
										action("cancel-schedule");
									},
									children: tr(lang, "取消安排", "Cancel")
								})
							] })
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/FusionStatus.tsx
		const styles = `
.fusion-status{margin:8px 12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;overflow-wrap:anywhere}
.fusion-status>summary{cursor:pointer;min-height:44px;display:flex;align-items:center;gap:12px;list-style:none;border-top:1px solid var(--dsw-alias-border-l2);outline-offset:2px}
.fusion-status>summary::before{content:'›';font-size:18px;flex:none}.fusion-status[open]>summary::before{content:'⌄'}
.fusion-status>summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary)}
.fusion-status .fusion-status-label{font-weight:600}.fusion-status .fusion-status-count{margin-left:auto;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.fusion-status .fusion-status-detail{max-height:320px;overflow:auto;padding:4px 4px 12px 0;scrollbar-gutter:stable}
.fusion-status .fusion-recovery fieldset{border:0;padding:0;display:flex;flex-direction:column;gap:10px}.fusion-recovery :is(button,select,input){font:inherit;color:inherit;background:var(--dsw-alias-bg-page-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:7px;max-width:100%}.fusion-recovery button{cursor:pointer}.fusion-recovery :is(button,input,select):focus-visible{outline:2px solid var(--dsw-alias-brand-primary)}.fusion-recovery [role=alert]{color:var(--dsw-alias-state-error-primary)}
.fusion-status:has(.fusion-recovery) .fusion-status-detail{max-height:min(65vh,640px)}.fusion-recovery details>summary{padding:8px 0;cursor:pointer}
.fusion-status p{margin:4px 0 12px}.fusion-status h3{font-size:13px;margin:16px 0 4px;font-weight:600}
.fusion-status dl{margin:0;display:grid;grid-template-columns:minmax(72px,auto) minmax(0,1fr);gap:4px 12px}
.fusion-status dt{color:var(--dsw-alias-label-secondary)}.fusion-status dd{margin:0;min-width:0}
.fusion-status ul{list-style:none;margin:0;padding:0}.fusion-status li{padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.fusion-status small{display:block;color:var(--dsw-alias-label-secondary);font-size:12px}
@media(max-width:400px){.fusion-status>summary{gap:8px}.fusion-status .fusion-status-detail{max-height:280px}}
`;
		const role = (value) => value === "lead" ? "Lead" : "Sidekick";
		const purposeOf = (lang, value) => ({
			conversation: tr(lang, "任务", "task"),
			compaction: tr(lang, "压缩", "compaction"),
			"cache-keepalive": tr(lang, "保活", "keepalive"),
			"session-title": tr(lang, "标题", "title")
		})[value] ?? value;
		const outcomeOf = (lang, value) => ({
			entered: tr(lang, "请求中", "in progress"),
			stop: tr(lang, "已返回", "returned"),
			"tool-calls": tr(lang, "调用工具", "tool calls"),
			"max-tokens": tr(lang, "输出截断", "output truncated"),
			aborted: tr(lang, "已中断", "aborted"),
			error: tr(lang, "请求失败", "failed"),
			unknown: tr(lang, "结束状态未知", "unknown end")
		})[value] ?? value;
		const toolStateOf = (lang, value) => ({
			"dispatch-started": tr(lang, "执行未收尾", "unfinished"),
			returned: tr(lang, "已返回", "returned"),
			"outcome-unknown": tr(lang, "结果未知", "outcome unknown"),
			inspected: tr(lang, "已人工检查", "inspected")
		})[value] ?? value;
		const countOf = (lang, value) => value.totalRequests === 0 ? "—" : value.reportedRequests === 0 ? tr(lang, "未提供", "not reported") : `${value.knownTokens.toLocaleString()}${value.reportedRequests < value.totalRequests ? tr(lang, `（${value.reportedRequests}/${value.totalRequests} 次有报告）`, ` (${value.reportedRequests}/${value.totalRequests} reported)`) : ""}`;
		const noteStyle = {
			margin: "8px 12px",
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 12,
			lineHeight: 1.5
		};
		/** Visible-session polling reads the plugin ledger; it never sends a chat message. */
		function FusionStatus({ sessionId, attentionOnly = false }) {
			const lang = useLang();
			const purpose = (value) => purposeOf(lang, value), outcome = (value) => outcomeOf(lang, value);
			const toolState = (value) => toolStateOf(lang, value), count = (value) => countOf(lang, value);
			const [snapshot, setSnapshot] = (0, react.useState)();
			(0, react.useEffect)(() => {
				let active = true, busy = false, timer;
				let abort;
				const visible = () => document.visibilityState !== "hidden";
				const refresh = async () => {
					if (!active || busy || !visible()) return;
					if (timer) clearTimeout(timer);
					busy = true;
					abort = new AbortController();
					const deadline = setTimeout(() => {
						if (active && visible()) setSnapshot({
							sessionId,
							failed: true
						});
						abort?.abort();
					}, 1e4);
					try {
						const response = await fetch(`/api/model-fusion?view=status&sessionId=${encodeURIComponent(sessionId)}`, {
							credentials: "same-origin",
							cache: "no-store",
							signal: abort.signal
						});
						if (!response.ok) throw new Error("unavailable");
						const status = await response.json();
						if (status.schemaVersion !== 1 || status.sessionId !== sessionId) throw new Error("mismatched status");
						if (active && !abort.signal.aborted) setSnapshot({
							sessionId,
							status,
							failed: false
						});
					} catch {
						if (active && !abort.signal.aborted) setSnapshot({
							sessionId,
							failed: true
						});
					} finally {
						clearTimeout(deadline);
						busy = false;
						if (active && visible()) timer = setTimeout(() => {
							refresh();
						}, 2e3);
					}
				};
				const visibility = () => {
					if (timer) clearTimeout(timer);
					if (!visible()) abort?.abort();
					else refresh();
				};
				refresh();
				document.addEventListener("visibilitychange", visibility);
				return () => {
					active = false;
					abort?.abort();
					if (timer) clearTimeout(timer);
					document.removeEventListener("visibilitychange", visibility);
				};
			}, [sessionId]);
			if (!snapshot || snapshot.sessionId !== sessionId) return attentionOnly ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: noteStyle,
				role: "status",
				children: tr(lang, "正在读取 Fusion 状态…", "Loading Fusion status…")
			});
			if (snapshot.failed) return attentionOnly ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: noteStyle,
				role: "status",
				children: tr(lang, "Fusion 状态暂时无法更新，恢复连接后会重试。可用 /fusion status 查看。", "Fusion status cannot update right now; it retries when reconnected. Use /fusion status.")
			});
			const task = snapshot.status?.task;
			if (!snapshot.status?.selected || !task) return null;
			if (attentionOnly && !task.attention) return null;
			const { usage } = task;
			const verification = task.automatedChecks === 0 && task.verification === "verified" ? tr(lang, "仅经 Lead 审查（未运行自动检查）", "Lead review only (no automated checks ran)") : {
				verified: tr(lang, "验证通过", "verified"),
				partial: tr(lang, "部分验证", "partly verified"),
				unverified: tr(lang, "尚未验证", "unverified")
			}[task.verification];
			const stage = lang === "en" ? task.stageEn ?? task.stage : task.stage, detail = lang === "en" && task.detailEn !== void 0 ? task.detailEn : task.detail;
			const share = (role) => {
				const total = usage.byRole.lead.output.knownTokens + usage.byRole.worker.output.knownTokens;
				return total ? tr(lang, ` · 输出占 ${Math.round(usage.byRole[role].output.knownTokens / total * 100)}%`, ` · ${Math.round(usage.byRole[role].output.knownTokens / total * 100)}% of output`) : "";
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
				className: "fusion-status",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: styles }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", {
						"aria-label": tr(lang, `Fusion · ${stage}，任务详情`, `Fusion · ${stage}, task details`),
						"data-ud-check": "fusion-status-summary",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "fusion-status-label",
								role: "status",
								children: ["Fusion · ", stage]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "fusion-status-count",
								children: tr(lang, `${usage.calls} 次请求`, `${usage.calls} requests`)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: tr(lang, "详情", "Details") })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "fusion-status-detail",
						tabIndex: 0,
						"aria-label": tr(lang, "Fusion 任务详情", "Fusion task details"),
						"data-ud-check": "fusion-status-detail",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: detail ?? (task.stage === "完成" ? tr(lang, `本轮任务已结束 · ${verification}`, `This task has finished · ${verification}`) : tr(lang, `本轮任务 · ${verification}`, `This task · ${verification}`)) }),
							task.modelControl && task.stage !== "完成" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FusionRecovery, {
								sessionId,
								task
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "Lead" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [task.models.lead.model, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: task.models.lead.provider })] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: "Sidekick" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [task.models.worker.model, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [task.models.worker.provider, task.workerId ? tr(lang, " · 已建立持续会话", " · persistent session") : tr(lang, " · 尚未委派", " · not delegated yet")] })] }),
								task.models.compactor && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: tr(lang, "压缩模型", "Compaction") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [task.models.compactor.model, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: task.models.compactor.provider })] })] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: tr(lang, "待确认", "Pending approvals") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: task.pendingApprovals }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: tr(lang, "未收尾工具", "Unsettled tools") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: task.unsettledTools })
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: tr(lang, "本轮用量", "Usage this task") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: tr(lang, "模型请求", "Model requests") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [usage.calls, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: tr(lang, `含压缩 ${usage.compactionCalls} 次、保活 ${usage.keepaliveCalls} 次`, `incl. ${usage.compactionCalls} compaction, ${usage.keepaliveCalls} keepalive`) })] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: tr(lang, "用量报告", "Usage reports") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: tr(lang, `${usage.finalCalls} 次已定稿 · ${usage.provisionalCalls} 次暂报 · ${usage.unreportedCalls} 次未提供`, `${usage.finalCalls} final · ${usage.provisionalCalls} provisional · ${usage.unreportedCalls} unreported`) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: tr(lang, "输入 Token", "Input tokens") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [count(usage.input), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: tr(lang, "已报告的未缓存输入", "reported uncached input") })] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: tr(lang, "缓存读取", "Cache read") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: count(usage.cacheRead) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: tr(lang, "输出 Token", "Output tokens") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: count(usage.output) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: tr(lang, "实际费用", "Actual cost") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [tr(lang, "未知", "unknown"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: tr(lang, "当前账号未提供可靠账单金额", "the account reports no reliable billed amount") })] })
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: tr(lang, "按角色", "By role") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dl", { children: ["lead", "worker"].map((role) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: role === "lead" ? "Lead" : "Sidekick" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dd", { children: [
								tr(lang, `${usage.byRole[role].calls} 次`, `${usage.byRole[role].calls} requests`),
								" · ",
								tr(lang, "输出", "output"),
								" ",
								count(usage.byRole[role].output),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
									tr(lang, "输入", "input"),
									" ",
									count(usage.byRole[role].input),
									" · ",
									tr(lang, "缓存读取", "cache read"),
									" ",
									count(usage.byRole[role].cacheRead),
									share(role)
								] })
							] })] }, role)) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: tr(lang, "Token 数包含暂报数据；缺失字段不计为 0。请求数来自 DSH，供应商内部重试次数未知。", "Token counts include provisional data; missing fields are not counted as 0. Request counts come from DSH; provider-internal retries are unknown.") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: tr(lang, "最近上下文检查", "Recent context checks") }),
							task.contexts.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", { children: task.contexts.map((context) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
								role(context.role),
								" · ",
								purpose(context.purpose),
								" · ",
								context.admitted ? tr(lang, "可发送", "admitted") : tr(lang, "超出预算", "over budget"),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
									context.inputTokens.toLocaleString(),
									" / ",
									context.budget.toLocaleString(),
									" Token · ",
									context.quality === "exact" ? tr(lang, "精确计数", "exact") : tr(lang, "估算", "estimated")
								] })
							] }, context.role)) }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: tr(lang, "尚无上下文检查记录。", "No context checks yet.") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: tr(lang, "最近模型请求", "Recent model requests") }),
							task.requests.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", { children: task.requests.map((request) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
								role(request.role),
								" · ",
								purpose(request.purpose),
								" · ",
								outcome(request.outcome),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
									request.model,
									" · ",
									request.provider,
									" · ",
									request.authority === "final" ? tr(lang, "用量已定稿", "usage final") : request.authority === "provisional" ? tr(lang, "用量暂报", "usage provisional") : tr(lang, "用量未提供", "usage not reported")
								] })
							] }, request.id)) }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: tr(lang, "尚未发出模型请求。", "No model requests yet.") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: tr(lang, "最近命令与写入", "Recent commands and writes") }),
							task.tools.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", { children: task.tools.map((tool) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
								role(tool.role),
								" · ",
								tool.name,
								" · ",
								tool.failed ? tr(lang, "返回错误", "error") : toolState(tool.state)
							] }, tool.id)) }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: tr(lang, "尚无工具执行记录。", "No tool runs yet.") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: tr(lang, "显示最近 12 次请求、8 项命令或写入操作；用量汇总覆盖本轮全部请求。读取操作仍可在会话中查看。", "Shows the last 12 requests and 8 commands or writes; usage totals cover all requests of this task. Reads remain visible in the conversation.") })
						]
					})
				]
			}, task.id);
		}
		//#endregion
		//#region src/client/FusionHint.tsx
		/** Additive composer hint. The original selector and its selection state stay native. */
		function FusionHint({ sessionId, directory, load }) {
			const selected = (0, react.useSyncExternalStore)(directory.subscribe, directory.getSnapshot).current;
			const fusion = selected?.provider === "dsh-model-fusion" && selected.model === "auto";
			const lang = useLang();
			const [message, setMessage] = (0, react.useState)();
			(0, react.useEffect)(() => {
				load();
			}, [load]);
			(0, react.useEffect)(() => {
				if (!fusion) {
					setMessage(void 0);
					return;
				}
				let active = true;
				const abort = new AbortController();
				const refresh = () => {
					fetch("/api/model-fusion?view=settings", {
						credentials: "same-origin",
						cache: "no-store",
						signal: abort.signal
					}).then(async (response) => {
						if (!response.ok) throw new Error("unavailable");
						return response.json();
					}).then((state) => {
						if (active) setMessage(!state.pair ? tr(lang, "Fusion 尚未配置模型，请前往设置 → Fusion 选择 Lead 和 Sidekick。", "Fusion has no models yet: open Settings → Fusion and choose a Lead and a Sidekick.") : !state.authorized ? tr(lang, "Fusion 当前配置未就绪，请前往设置 → Fusion 查看。", "The Fusion setup is not ready: see Settings → Fusion.") : void 0);
					}).catch(() => {
						if (active) setMessage(tr(lang, "暂时无法确认 Fusion 配置，请前往设置 → Fusion 查看。", "Cannot confirm the Fusion setup right now: see Settings → Fusion."));
					});
				};
				refresh();
				const off = onSettingsChanged(refresh);
				return () => {
					active = false;
					abort.abort();
					off();
				};
			}, [fusion, lang]);
			if (!fusion) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [message && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				role: "status",
				style: {
					margin: "8px 12px",
					color: "var(--dsw-alias-label-secondary)",
					fontSize: 12,
					lineHeight: "18px"
				},
				children: message
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FusionStatus, {
				sessionId,
				attentionOnly: true
			})] });
		}
		//#endregion
		//#region src/activity.ts
		/** Namespaced display identity; the unchanged native identity remains in source. */
		function activityCallId(activity) {
			const event = activity.source;
			const id = event.type === "tool/call" ? event.data.callId : event.data.message.source.callId;
			return `fusion:${activity.childSessionId}:${id}`;
		}
		//#endregion
		//#region src/client/activity-model.ts
		function activityRows(events) {
			const rows = /* @__PURE__ */ new Map();
			for (const event of events) {
				const id = activityCallId(event);
				if (event.source.type === "tool/call") rows.set(id, {
					id,
					call: event.source
				});
				else {
					const row = rows.get(id);
					if (row) rows.set(id, {
						...row,
						result: event.source
					});
				}
			}
			return [...rows.values()];
		}
		/** Only actual result-time metadata is labelled an applied diff. */
		function activityDiffs(row) {
			if (!row.result || row.result.data.message.isError) return [];
			const meta = row.result.data.meta;
			if (!Array.isArray(meta?.diffs)) return [];
			return meta.diffs.filter((hunk) => hunk && typeof hunk === "object" && typeof hunk.path === "string" && (typeof hunk.oldText === "string" || hunk.oldText === null) && typeof hunk.newText === "string");
		}
		//#endregion
		//#region src/client/ActivityRows.tsx
		const labelsFor = (lang) => ({
			codeLabel: tr(lang, "代码", "Code"),
			wrapLabel: tr(lang, "自动换行", "Wrap"),
			unwrapLabel: tr(lang, "取消自动换行", "No wrap"),
			copy: tr(lang, "复制", "Copy"),
			copied: tr(lang, "已复制", "Copied"),
			collapseAria: tr(lang, "收起内容", "Collapse"),
			collapse: tr(lang, "收起", "Collapse"),
			expandAria: (n) => tr(lang, `展开其余 ${n} 行`, `Show ${n} more lines`),
			expand: (n) => tr(lang, `展开其余 ${n} 行`, `Show ${n} more lines`)
		});
		const terminalLabelsFor = (lang) => ({
			...labelsFor(lang),
			signal: (s) => tr(lang, `信号 ${s}`, `signal ${s}`),
			exitCode: (n) => tr(lang, `退出码 ${n}`, `exit code ${n}`),
			running: tr(lang, "执行中", "Running"),
			failed: tr(lang, "执行失败", "Failed"),
			done: tr(lang, "已返回", "Done"),
			noOutput: tr(lang, "无输出", "No output"),
			noExitCode: tr(lang, "未记录退出码", "No exit code")
		});
		const titleFor = (lang) => ({
			bash: tr(lang, "终端", "Terminal"),
			pwsh: tr(lang, "终端", "Terminal"),
			read: tr(lang, "读取", "Read"),
			write: tr(lang, "写入", "Write"),
			edit: tr(lang, "编辑", "Edit"),
			glob: tr(lang, "查找文件", "Find files"),
			grep: tr(lang, "搜索", "Search"),
			job_output: tr(lang, "命令输出", "Command output"),
			job_kill: tr(lang, "停止命令", "Stop command"),
			str_replace_editor: tr(lang, "编辑", "Edit")
		});
		function ActivityCard({ row, done, cwd, openFile }) {
			const lang = useLang();
			const [open, setOpen] = (0, react.useState)(false);
			let args = {};
			try {
				const parsed = JSON.parse(row.call.data.arguments);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
			} catch {}
			const result = row.result?.data.message;
			const output = result?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") ?? "";
			const path = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : void 0;
			const command = typeof args.command === "string" ? args.command : void 0;
			const exit = /\n\[exit code: (\d+)\]\s*$/.exec(output);
			const failed = result?.isError || exit && Number(exit[1]) !== 0;
			const diffs = activityDiffs(row);
			const label = titleFor(lang)[row.call.data.name] ?? row.call.data.name;
			const summary = path ?? (typeof args.description === "string" ? args.description : command) ?? (typeof args.pattern === "string" ? args.pattern : label);
			const status = failed ? tr(lang, "失败", "Failed") : !row.result ? done ? tr(lang, "结果未记录", "No result recorded") : tr(lang, "执行中", "Running") : "";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "fusion-activity-row",
				"data-fusion-tool": row.call.data.name,
				"data-fusion-call": row.id,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					"aria-expanded": open,
					onClick: () => setOpen(!open),
					className: "fusion-activity-toggle",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"aria-hidden": true,
							children: open ? "⌄" : "›"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "fusion-activity-summary",
							children: summary
						}),
						status && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", {
							role: "status",
							"data-failed": Boolean(failed),
							children: status
						})
					]
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "fusion-activity-body",
					children: [path && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: "fusion-activity-file",
						onClick: () => openFile(path),
						children: [
							tr(lang, "打开", "Open"),
							" ",
							path
						]
					}), diffs.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DiffBlock, {
						diffs,
						labels: labelsFor(lang),
						maxLines: 16
					}) : (row.call.data.name === "bash" || row.call.data.name === "pwsh") && command ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.TerminalBlock, {
						command,
						cwd,
						output,
						running: !row.result && !done,
						exitCode: exit ? Number(exit[1]) : void 0,
						labels: terminalLabelsFor(lang)
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", { children: output || (row.result ? tr(lang, "已返回，无文本输出。", "Returned without text output.") : row.call.data.arguments) })]
				})]
			});
		}
		const activityStyles = `
.fusion-activity-row{font-size:13px;line-height:1.5;margin:4px 0;min-width:0;color:var(--dsw-alias-label-secondary)}
.fusion-activity-toggle{display:flex;align-items:center;gap:8px;width:100%;padding:6px 0;background:none;border:0;color:inherit;text-align:left;cursor:pointer;font:inherit}
.fusion-activity-toggle:focus-visible,.fusion-activity-file:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.fusion-activity-summary{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.fusion-activity-toggle small{white-space:nowrap}.fusion-activity-toggle small[data-failed=true]{color:var(--dsw-alias-danger-primary,#c43131)}
.fusion-activity-body{padding:4px 0 10px;overflow:hidden}.fusion-activity-body pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;font-size:12px}
.fusion-activity-file{font:inherit;border:0;background:none;color:var(--dsw-alias-brand-primary);padding:0 0 6px;cursor:pointer}
`;
		//#endregion
		//#region src/client/FusionTool.tsx
		const fusionControlTools = [
			"fusion_read_state",
			"fusion_delegate_text",
			"fusion_explore",
			"fusion_delegate",
			"fusion_rework",
			"fusion_wait",
			"fusion_review_result",
			"fusion_submit_result",
			"fusion_takeover",
			"fusion_finish_direct",
			"fusion_read_evidence"
		];
		/** Keep internal coordination out of the normal conversation. Errors remain visible. */
		function FusionTool({ block, sessionId, callId, toolName, cwd, openFile }) {
			const lang = useLang();
			const settled = "kind" in block;
			const tracksActivity = toolName === "fusion_delegate_text" || toolName === "fusion_explore" || toolName === "fusion_delegate" || toolName === "fusion_rework";
			const [snapshot, setSnapshot] = (0, react.useState)();
			const key = `${sessionId}:${callId}`;
			(0, react.useEffect)(() => {
				if (!tracksActivity) return;
				let active = true, busy = false, cursor = -1, timer;
				const events = /* @__PURE__ */ new Map();
				let abort;
				const visible = () => document.visibilityState !== "hidden";
				const refresh = async () => {
					if (!active || busy || !visible()) return;
					busy = true;
					abort = new AbortController();
					const deadline = setTimeout(() => abort?.abort(), 1e4);
					let again = true, delay = 2e3;
					try {
						const response = await fetch(`/api/model-fusion?view=activity&sessionId=${encodeURIComponent(sessionId)}&callId=${encodeURIComponent(callId)}&after=${cursor}`, {
							credentials: "same-origin",
							cache: "no-store",
							signal: abort.signal
						});
						if (!response.ok) throw new Error("Activity unavailable");
						const page = await response.json();
						if (!Array.isArray(page.events) || !Number.isSafeInteger(page.cursor) || page.cursor < cursor) throw new Error("Invalid activity page");
						for (const event of page.events) if (event.parentCallId === callId) events.set(event.source.seq, event);
						cursor = page.cursor;
						again = page.more || !page.done || !settled;
						delay = page.more ? 0 : 2e3;
						if (active) setSnapshot({
							key,
							events: [...events.values()].sort((a, b) => a.source.seq - b.source.seq),
							done: page.done
						});
					} catch {
						if (active) setSnapshot((previous) => ({
							key,
							events: previous?.key === key ? previous.events : [],
							done: false,
							failed: true
						}));
					} finally {
						clearTimeout(deadline);
						busy = false;
						if (active && again && visible()) timer = setTimeout(() => {
							refresh();
						}, delay);
					}
				};
				const visibility = () => {
					if (timer) clearTimeout(timer);
					if (document.visibilityState === "hidden") abort?.abort();
					else refresh();
				};
				refresh();
				document.addEventListener("visibilitychange", visibility);
				return () => {
					active = false;
					abort?.abort();
					if (timer) clearTimeout(timer);
					document.removeEventListener("visibilitychange", visibility);
				};
			}, [
				sessionId,
				callId,
				key,
				tracksActivity,
				settled
			]);
			const current = tracksActivity && snapshot?.key === key ? snapshot : void 0;
			const rows = (0, react.useMemo)(() => activityRows(current?.events ?? []), [current?.events]);
			const text = settled ? block.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") : "";
			let problem = settled && block.isError ? text : "";
			if (!problem) try {
				const result = JSON.parse(text);
				if (result.status === "needs-decision") problem = result.reason ?? tr(lang, "任务需要进一步处理。", "The task needs attention.");
			} catch {}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				rows.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: activityStyles }),
				rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActivityCard, {
					row,
					done: current?.done ?? false,
					cwd,
					openFile
				}, row.id)),
				current?.failed && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					role: "status",
					children: tr(lang, "执行记录暂时无法加载，正在重试。", "Activity is unavailable; retrying.")
				}),
				problem && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					role: "status",
					style: {
						fontSize: 13,
						whiteSpace: "pre-wrap"
					},
					children: problem
				})
			] });
		}
		//#endregion
		//#region src/client/index.ts
		const name = "dsh-model-fusion/client";
		const inject = ["slots"];
		function apply(ctx) {
			ctx.inject(["locale"], (scope) => {
				scope.effect(() => bindLocale(scope.locale));
			});
			for (const tool of fusionControlTools) ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: tool
			}, FusionTool));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "fusion",
				order: 18,
				label: () => "Fusion",
				inject: () => ({})
			}, FusionSettings));
			ctx.inject(["modelDirectories"], (scope) => {
				scope.slots.inject("conversation.input.dock", () => scope.slots.register({
					name: "conversation.input.dock",
					id: "fusion-configuration",
					order: 20,
					inject: (sessionId) => {
						const directory = scope.modelDirectories.directoryFor(sessionId);
						return {
							sessionId,
							directory: directory.store,
							load: () => {
								directory.load().catch(() => void 0);
							}
						};
					}
				}, FusionHint));
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map