"use strict";
/**
 * 用 Node 内置测试运行器跑：node --test plugins/cc-toolkit/tests
 * 零依赖，不需要 npm install。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const core = require("../scripts/cc-core");

const SCRIPTS = path.join(__dirname, "..", "scripts");

// ── 测试夹具 ────────────────────────────────────────────────────────────

let tmpRoot;

test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-toolkit-test-"));
});

test.after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/**
 * 造一份假的会话 transcript。
 * 每一轮 = 一条 user 行 + 若干 assistant 内容块 + 最后一个块带 usage。
 *
 * user 行是必须的：会话跟踪器用「上一行的时间戳」当作本轮起点，
 * 真实 transcript 里这个锚点就是用户发消息的时刻。少了它，第一轮的耗时会被算短。
 *
 * 另外，最后一轮永远等不到下一个 message.id，只有显式收尾才会进入统计视图 ——
 * 这正是收尾逻辑要覆盖的行为。
 */
function writeTranscript(rounds, { name = `session-${Math.random().toString(36).slice(2)}.jsonl` } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "proj-"));
  const file = path.join(dir, name);
  const lines = [];
  let t = Date.parse("2026-01-01T00:00:00Z");

  for (const r of rounds) {
    const id = r.id;
    const chunks = r.chunks || 3;
    // 每块长度不同，避免被误当成重复内容
    const per = Math.max(1, Math.round(((r.tokens || 100) * 4) / chunks));

    // 用户发出提示 —— 本轮的起点锚在这里
    lines.push(JSON.stringify({ type: "user", timestamp: new Date(t).toISOString(), message: { role: "user", content: "prompt" } }));

    for (let i = 0; i < chunks; i++) {
      // 块的落盘时间在 [0, ms] 之间均匀分布，模拟内容块分多次写入
      t += Math.round(r.ms / chunks);
      lines.push(
        JSON.stringify({
          type: "assistant",
          timestamp: new Date(t).toISOString(),
          message: {
            id,
            role: "assistant",
            content: [{ type: "text", text: `${i}:`.padEnd(2, " ") + "x".repeat(per) }],
            usage:
              i === chunks - 1 && r.usage !== false ? { output_tokens: r.tokens } : undefined,
          },
        })
      );
    }
  }

  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

function run(script, args, { input, env } = {}) {
  return execFileSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    input: input || "",
    encoding: "utf8",
    env: { ...process.env, ...(env || {}) },
    timeout: 20000,
  });
}

// ── 单元测试 ────────────────────────────────────────────────────────────

test("estimateTokens: CJK 按 1.5 字符/token，拉丁按 4 字符/token", () => {
  assert.equal(core.estimateTokens(""), 0);
  assert.equal(core.estimateTokens(null), 0);
  // 4 个 ASCII 字符 = 1 token
  assert.equal(core.estimateTokens("abcd"), 1);
  // 3 个 CJK 字符 = 2 token
  assert.equal(core.estimateTokens("你好啊"), 2);
  assert.ok(core.estimateTokens("你好啊") > core.estimateTokens("abc"));
});

test("projectDirFor: 非字母数字一律换成连字符", () => {
  assert.equal(core.projectDirFor("D:\\workspace\\cc-toolkit"), "D--workspace-cc-toolkit");
  assert.equal(core.projectDirFor("/home/u/my_app"), "-home-u-my-app");
});

test("median / percentile: 奇偶长度都正确", () => {
  assert.equal(core.median([]), null);
  assert.equal(core.median([1, 2, 3]), 2);
  assert.equal(core.median([1, 2, 3, 4]), 2.5);
  assert.equal(core.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

test("SessionTracker: 用 usage 精确值计算 tok/s", () => {
  // 一轮：400 token，耗时 2000ms → 200 tok/s
  const file = writeTranscript([{ id: "msg_a", ms: 2000, tokens: 400, chunks: 4 }]);
  const tracker = new core.SessionTracker(file).start();

  // 最后一轮还没归档，要靠收尾才进入统计视图
  assert.equal(tracker.samples.length, 0, "未收尾时最后一轮不应出现在已归档样本里");
  const rows = tracker.recentSamples();
  assert.equal(rows.length, 1, "收尾后最后一轮应出现在统计视图里");

  const s = tracker.stats();
  assert.equal(s.count, 1);
  // 样本的 tokens 必须来自 usage.output_tokens，而不是字符估算
  assert.equal(rows[0].tokens, 400);
  assert.equal(rows[0].estimated, false);
  assert.equal(rows[0].durMs, 2000);
  assert.equal(Math.round(rows[0].tps), 200);
  // 收尾视图不应改变 tracker 内部状态
  assert.equal(tracker.samples.length, 0, "finalizedSamples 不应有副作用");
});

test("SessionTracker: 已结束的当前轮会被自动收尾（不必等下一轮）", async () => {
  const file = writeTranscript([{ id: "msg_only", ms: 2000, tokens: 400 }]);
  const tracker = new core.SessionTracker(file).start();
  assert.equal(tracker.samples.length, 0);

  // 等过 3 秒的流式窗口后，视为已结束
  await new Promise((r) => setTimeout(r, core.STREAMING_WINDOW_MS + 200));
  assert.equal(tracker.recentSamples().length, 1, "超过流式窗口后应自动纳入样本");
  // 但 currentSpeed 仍然能报出「最近一轮」
  assert.ok(tracker.currentSpeed(), "收尾不应让 currentSpeed 失效");
});

test("SessionTracker: 小样本与短响应被过滤掉", () => {
  const file = writeTranscript([
    { id: "msg_small", ms: 2000, tokens: 10 }, // token 太少
    { id: "msg_fast", ms: 100, tokens: 500 }, // 太快
    { id: "msg_ok", ms: 2000, tokens: 500 }, // 合格
  ]);
  const tracker = new core.SessionTracker(file).start();
  // msg_small / msg_fast 在遇到下一轮时就被归档并过滤，msg_ok 靠收尾进入视图
  const rows = tracker.recentSamples();
  assert.equal(rows.length, 1);
  assert.equal(Math.round(rows[0].tps), 250);
});

test("SessionTracker: 新 message.id 出现时归档上一轮", () => {
  const file = writeTranscript([
    { id: "msg_1", ms: 2000, tokens: 400 },
    { id: "msg_2", ms: 1000, tokens: 300 },
  ]);
  const tracker = new core.SessionTracker(file).start();
  assert.equal(tracker.samples.length, 1, "msg_1 遇到 msg_2 时被归档");
  assert.equal(tracker.currentId, "msg_2");
  assert.equal(tracker.recentSamples().length, 2, "msg_2 靠收尾进入统计视图");
});

test("SessionTracker: 没等到 usage 时用字符数估算，并标记 estimated", () => {
  const file = writeTranscript([{ id: "msg_est", ms: 2000, tokens: 400, usage: false, chunks: 4 }]);
  const tracker = new core.SessionTracker(file).start();
  const snap = tracker.currentSpeed();

  assert.ok(snap, "应该有进行中的响应");
  assert.equal(snap.estimated, true, "usage 未落盘 → 必须标记为估算");
  assert.ok(snap.tokens > 0);
});

test("SessionTracker: 忽略子代理(isSidechain)的输出", () => {
  const file = writeTranscript([
    { id: "msg_main", ms: 2000, tokens: 400 },
    { id: "msg_next", ms: 1000, tokens: 300 },
  ]);
  const extra =
    JSON.stringify({
      type: "assistant",
      isSidechain: true,
      timestamp: new Date(Date.parse("2026-01-01T00:01:00Z")).toISOString(),
      message: {
        id: "msg_side",
        content: [{ type: "text", text: "y".repeat(4000) }],
        usage: { output_tokens: 9999 },
      },
    }) + "\n";
  fs.appendFileSync(file, extra, "utf8");

  const tracker = new core.SessionTracker(file).start();
  const rows = tracker.recentSamples();
  assert.equal(rows.length, 2, "子代理那轮不应变成样本");
  assert.equal(rows[0].tokens, 400);
  assert.equal(rows[1].tokens, 300);
  assert.ok(!rows.some((d) => d.tokens === 9999), "子代理的 9999 token 不应混入");
});

test("SessionTracker: 增量 pump 只消费新增字节，不重复计数", () => {
  const file = writeTranscript([{ id: "msg_1", ms: 2000, tokens: 400 }]);
  const tracker = new core.SessionTracker(file).start();
  assert.equal(tracker.samples.length, 0, "读完后最后一轮尚未归档");
  assert.equal(tracker.recentSamples().length, 1);

  // 追加第二轮
  const t = Date.parse("2026-01-01T01:00:00Z");
  fs.appendFileSync(
    file,
    [
      JSON.stringify({
        type: "user",
        timestamp: new Date(t).toISOString(),
        message: { role: "user", content: "second prompt" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(t + 1000).toISOString(),
        message: { id: "msg_2", content: [{ type: "text", text: "hello" }], usage: { output_tokens: 300 } },
      }),
    ].join("\n") + "\n",
    "utf8"
  );

  tracker.pump();
  assert.equal(tracker.samples.length, 1, "msg_1 应被 msg_2 归档");
  assert.equal(tracker.samples[0].tokens, 400, "重复 pump 不应把已有内容再算一遍");

  tracker.pump(); // 幂等
  assert.equal(tracker.samples.length, 1);
  assert.equal(tracker.recentSamples().length, 2, "msg_2 靠收尾进入统计视图");
});

test("SessionTracker: 不完整的一行会被留到下次读取", () => {
  const file = writeTranscript([{ id: "msg_1", ms: 2000, tokens: 400 }]);
  const tracker = new core.SessionTracker(file);
  tracker.file = file;
  tracker.offset = fs.statSync(file).size;

  // 写半行
  fs.appendFileSync(file, '{"type":"assistant","timestamp":"2026-01-01T00:20:00.000Z","mess', "utf8");
  tracker.pump();
  assert.equal(tracker.parseErrors, 0, "半行不应被当成坏行解析");

  // 补全
  fs.appendFileSync(
    file,
    'age":{"id":"msg_3","content":[],"usage":{"output_tokens":200}}}\n',
    "utf8"
  );
  tracker.pump();
  assert.equal(tracker.parseErrors, 0);
  assert.ok(tracker.groups.has("msg_3"), "补全后的行应被正确解析");
});

test("analyze: 给出趋势、离群与估算占比", () => {
  const rounds = [];
  for (let i = 0; i < 12; i++) rounds.push({ id: `slow_${i}`, ms: 4000, tokens: 200 }); // 50 tok/s
  for (let i = 0; i < 12; i++) rounds.push({ id: `fast_${i}`, ms: 1000, tokens: 400 }); // 400 tok/s
  const file = writeTranscript(rounds);

  const a = core.analyze(new core.SessionTracker(file).start());
  assert.equal(a.sampleCount, 24);
  assert.ok(a.recent.median > a.earlier.median, "后半段更快");
  assert.ok(a.trendPct > 0, "趋势应为正（变快）");
  assert.ok(a.outliers.length > 0, "应识别出偏慢的离群样本");
  assert.equal(a.estimatedShare, 0, "全都有 usage，估算占比为 0");
});

test("listSessions / pickSessionFile: 按项目目录名与 cwd 过滤", () => {
  const projectsDir = fs.mkdtempSync(path.join(tmpRoot, "projects-"));
  const projDir = path.join(projectsDir, "D--workspace-demo");
  fs.mkdirSync(projDir, { recursive: true });
  const f = path.join(projDir, "abc.jsonl");
  fs.writeFileSync(f, "", "utf8");

  const list = core.listSessions({ projectsDir });
  assert.equal(list.length, 1);
  assert.equal(list[0].project, "D--workspace-demo");
  assert.equal(list[0].session, "abc");

  const picked = core.pickSessionFile({ projectsDir, cwd: "D:\\workspace\\demo" });
  assert.equal(picked, f);

  // 项目名过滤支持子串
  assert.equal(core.listSessions({ projectsDir, project: "workspace" }).length, 1);
  assert.equal(core.listSessions({ projectsDir, project: "nonexistent" }).length, 0);
});

test("缓存：写入后可按 sessionId 读回，过期则失效", () => {
  const id = `cache-${Math.random().toString(36).slice(2)}`;
  assert.equal(core.readCache(id), null, "还没写时应为 null");

  core.writeCache(id, { v: 1, at: Date.now(), samples: [{ tps: 1 }] });
  assert.deepEqual(core.readCache(id).samples, [{ tps: 1 }]);

  // maxAgeMs = 0 → 立刻过期
  assert.equal(core.readCache(id, 0), null);
  fs.rmSync(core.cacheFileFor(id), { force: true });
});

// ── 端到端：CLI ─────────────────────────────────────────────────────────

test("CLI --report: 输出含表头、样本行与统计事实", () => {
  const file = writeTranscript([
    { id: "msg_1", ms: 2000, tokens: 400 },
    { id: "msg_2", ms: 1000, tokens: 500 },
  ]);
  const out = run("cc-watch.js", ["--report", "--history=5", file]);

  assert.match(out, /会话 \w+/);
  assert.match(out, /最近 2 条已完成的响应/);
  assert.match(out, /中位 \d+ tok\/s/);
  assert.match(out, /── 统计事实 ──/);
  assert.doesNotMatch(out, /\x1b\[/, "报告不应含 ANSI 色码");
});

test("CLI --json: 是合法 JSON，且字段齐全", () => {
  const file = writeTranscript([{ id: "msg_1", ms: 2000, tokens: 400 }]);
  const data = JSON.parse(run("cc-watch.js", ["--json", "--history=5", file]));

  assert.equal(data.samples.length, 1);
  assert.equal(data.samples[0].tokens, 400);
  assert.equal(data.samples[0].estimated, false);
  assert.equal(typeof data.stats.median, "number");
  assert.equal(data.stats.trendPct, null, "单样本无法判断趋势");
});

test("CLI --once: 单行输出", () => {
  const file = writeTranscript([{ id: "msg_1", ms: 2000, tokens: 400 }]);
  const out = run("cc-watch.js", ["--once", file]);
  assert.equal(out.trim().split("\n").length, 1);
  assert.match(out, /tok\/s/);
});

test("CLI: 文件不存在时退出码非 0", () => {
  assert.throws(
    () => run("cc-watch.js", ["--once", path.join(tmpRoot, "nope.jsonl")]),
    (err) => err.status === 1
  );
});

// ── 端到端：Stop hook ───────────────────────────────────────────────────

test("hook: 收到事件后输出 {systemMessage}，且不含 extra 字段", () => {
  const file = writeTranscript(
    Array.from({ length: 5 }, (_, i) => ({ id: `msg_${i}`, ms: 1500, tokens: 400 })),
    { name: "hook-session.jsonl" }
  );
  const out = run("cc-hook.js", [], {
    input: JSON.stringify({
      session_id: "sess-1",
      transcript_path: file,
      cwd: "D:\\workspace\\demo",
      hook_event_name: "Stop",
      stop_hook_active: false,
    }),
  });
  const payload = JSON.parse(out);
  // Stop hook 是控制类 hook，不接受 decision/continue，只回 systemMessage 最安全
  assert.equal(Object.keys(payload).length, 1);
  assert.match(payload.systemMessage, /⚡ 本轮 \d+ tok\/s/);
  assert.match(payload.systemMessage, /近\d+条中位/);
});

test("hook: stop_hook_active 时静默，防止递归", () => {
  const file = writeTranscript([{ id: "m", ms: 2000, tokens: 400 }]);
  const out = run("cc-hook.js", [], {
    input: JSON.stringify({ transcript_path: file, stop_hook_active: true }),
  });
  assert.equal(out, "");
});

test("hook: CC_TOOLKIT_DISABLE=1 时静默", () => {
  const file = writeTranscript([{ id: "m", ms: 2000, tokens: 400 }]);
  const out = run("cc-hook.js", [], {
    input: JSON.stringify({ transcript_path: file }),
    env: { CC_TOOLKIT_DISABLE: "1" },
  });
  assert.equal(out, "");
});

test("hook: CC_TOOLKIT_MIN_TOKENS 高于实际输出时静默", () => {
  const file = writeTranscript([{ id: "m", ms: 2000, tokens: 100 }]);
  const out = run("cc-hook.js", [], {
    input: JSON.stringify({ transcript_path: file }),
    env: { CC_TOOLKIT_MIN_TOKENS: "100000" },
  });
  assert.equal(out, "");
});

test("hook: CC_TOOLKIT_QUIET=1 在速度正常时静默，偏慢时告警", () => {
  const fast = writeTranscript([{ id: "m", ms: 1000, tokens: 500 }]); // 500 tok/s
  assert.equal(
    run("cc-hook.js", [], { input: JSON.stringify({ transcript_path: fast }), env: { CC_TOOLKIT_QUIET: "1" } }),
    ""
  );

  const slow = writeTranscript([{ id: "m", ms: 5000, tokens: 100 }]); // 20 tok/s
  const out = run("cc-hook.js", [], {
    input: JSON.stringify({ transcript_path: slow }),
    env: { CC_TOOLKIT_QUIET: "1", CC_TOOLKIT_SLOW_TOKENS_PER_SEC: "40" },
  });
  assert.match(JSON.parse(out).systemMessage, /🐢 本轮偏慢/);
});

test("hook: stdin 不是合法 JSON 也不崩，退出码 0", () => {
  const out = run("cc-hook.js", [], { input: "not json at all" });
  assert.equal(out === "" || JSON.parse(out).systemMessage !== undefined, true);
});

test("hook: transcript 指向不存在的文件时不崩", () => {
  const out = run("cc-hook.js", [], {
    input: JSON.stringify({ transcript_path: path.join(tmpRoot, "missing.jsonl"), cwd: tmpRoot }),
  });
  assert.equal(typeof out, "string"); // 退出码 0 由 execFileSync 保证
});

// ── 端到端:statusline ──────────────────────────────────────────────────

test("statusline: 有 transcript 时输出单行读数", () => {
  const file = writeTranscript(
    Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, ms: 1500, tokens: 600 })),
    { name: "statusline-session.jsonl" }
  );
  const out = run("cc-statusline.js", [], {
    input: JSON.stringify({ session_id: "sess-status", transcript_path: file }),
  });
  assert.match(out, /⚡ \d+ tok\/s \(中位 \d+\)/);
});

test("statusline: 空 stdin 与禁用开关都安全退出", () => {
  assert.equal(run("cc-statusline.js", [], { input: "" }), "");
  assert.equal(
    run("cc-statusline.js", [], {
      input: JSON.stringify({ transcript_path: "x.jsonl" }),
      env: { CC_TOOLKIT_DISABLE: "1" },
    }),
    ""
  );
});

test("statusline: 自定义前缀生效", () => {
  const file = writeTranscript([{ id: "m", ms: 1500, tokens: 600 }], { name: "sl2.jsonl" });
  const out = run("cc-statusline.js", [], {
    input: JSON.stringify({ session_id: "sess-prefix", transcript_path: file }),
    env: { CC_TOOLKIT_STATUSLINE_PREFIX: "[tps] " },
  });
  assert.match(out, /^\[tps\] /);
});

// ── doctor ──────────────────────────────────────────────────────────────

test("doctor: 正常退出并打印检查项", () => {
  const out = run("cc-doctor.js", []);
  assert.match(out, /cc-toolkit 环境自检/);
  assert.match(out, /Node\.js/);
  assert.match(out, /Stop hook/);
});
