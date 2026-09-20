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

/**
 * 按行改一份 transcript 再写回。
 *
 * 比在整份文本上做正则替换可靠：正则很容易被 JSON 里的引号、
 * 嵌套括号和行尾换行搞错，而且改错了不会报错，只会静默地什么都不改。
 */
function patchLines(file, fn) {
  const rows = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const r = JSON.parse(l);
      return fn(r) || r;
    });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return file;
}

/** 给所有 assistant 行补 usage 字段，返回被改写的那一轮 */
function patchUsage(file, extra) {
  patchLines(file, (r) => {
    if (r.type !== "assistant") return r;
    r.message.usage = { ...(r.message.usage || {}), ...extra };
    return r;
  });
  return file;
}

/** 给所有 assistant 行设一个顶层字段 */
function patchAssistant(file, extra) {
  patchLines(file, (r) => (r.type === "assistant" ? { ...r, ...extra } : r));
  return file;
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

  core.writeCache(id, { v: 2, at: Date.now(), samples: [{ tps: 1 }] });
  assert.deepEqual(core.readCache(id).samples, [{ tps: 1 }]);

  // 过期判定要显式造一个旧时间戳：用 maxAgeMs=0 会依赖「写入与读取至少差 1ms」，
  // 同一毫秒内完成时不会过期，测试会随机失败。
  core.writeCache(id, { v: 2, at: Date.now() - 10_000, samples: [{ tps: 1 }] });
  assert.equal(core.readCache(id, 1000), null, "超过 maxAgeMs 应失效");
  assert.notEqual(core.readCache(id, 60_000), null, "未超期则仍可读");
  fs.rmSync(core.cacheFileFor(id), { force: true });
});

test("缓存：v1 旧格式被拒绝（字段语义已变，宁可不显示也不显示错的）", () => {
  const id = `cache-v1-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(
    core.cacheFileFor(id),
    JSON.stringify({ v: 1, at: Date.now(), samples: [{ tps: 999 }] }),
    "utf8"
  );
  assert.equal(core.readCache(id), null, "v1 缓存必须当作没有");
  fs.rmSync(core.cacheFileFor(id), { force: true });
});

// ── cc-resolve：插件路径定位 ────────────────────────────────────────────

/** 在临时目录里造一个「像插件的」目录树 */
function fakePluginRoot(parent, name = "cc-toolkit") {
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), '{"name":"cc-toolkit"}');
  fs.writeFileSync(path.join(root, "scripts", "cc-core.js"), "module.exports={};");
  fs.writeFileSync(path.join(root, "scripts", "cc-hook.js"), "process.exit(0);");
  fs.writeFileSync(path.join(root, "scripts", "cc-resolve.js"), fs.readFileSync(path.join(SCRIPTS, "cc-resolve.js")));
  return root;
}

/** 造一个假的 Claude 配置目录 */
function fakeConfigDir({ installPath, market, version } = {}) {
  const cfg = fs.mkdtempSync(path.join(tmpRoot, "cfg-"));

  if (installPath) {
    fs.mkdirSync(path.join(cfg, "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(cfg, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "cc-toolkit@cc-plugins": [{ installPath }] } })
    );
  }

  // 造 plugins/cache/<market>/cc-toolkit/<version>/ 这一层
  if (market && version) {
    const pluginDir = path.join(cfg, "plugins", "cache", market, "cc-toolkit");
    fakePluginRoot(pluginDir, version);
  }

  return cfg;
}

const runResolve = (args, cfgDir, extraEnv) =>
  execFileSync(process.execPath, [path.join(SCRIPTS, "cc-resolve.js"), ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir, ...(extraEnv || {}) },
    timeout: 20000,
  });

test("cc-resolve: 从 installed_plugins.json 的 installPath 定位（跟随版本）", () => {
  const root = fakePluginRoot(fs.mkdtempSync(path.join(tmpRoot, "inst-")));
  const cfg = fakeConfigDir({ installPath: root });

  assert.equal(runResolve(["--print"], cfg).trim(), root);
  assert.equal(runResolve(["--which", "cc-hook.js"], cfg).trim(), path.join(root, "scripts", "cc-hook.js"));
});

test("cc-resolve: CLAUDE_PLUGIN_ROOT 优先级高于注册表", () => {
  const registered = fakePluginRoot(fs.mkdtempSync(path.join(tmpRoot, "reg-")), "cc-toolkit");
  const override = fakePluginRoot(fs.mkdtempSync(path.join(tmpRoot, "ovr-")), "cc-toolkit");
  const cfg = fakeConfigDir({ installPath: registered });

  const out = runResolve(["--print"], cfg, { CLAUDE_PLUGIN_ROOT: override });
  assert.equal(out.trim(), override);
});

test("cc-resolve: CC_TOOLKIT_PLUGIN_ROOT 优先级最高", () => {
  const explicit = fakePluginRoot(fs.mkdtempSync(path.join(tmpRoot, "exp-")), "cc-toolkit");
  const cfg = fakeConfigDir({ market: "cc-plugins", version: "1.0.0" });

  const out = runResolve(["--print"], cfg, { CC_TOOLKIT_PLUGIN_ROOT: explicit });
  assert.equal(out.trim(), explicit);
});

test("cc-resolve: 注册表缺失时回退到目录扫描", () => {
  const cfg = fakeConfigDir({ market: "cc-plugins", version: "1.0.0" });
  const out = runResolve(["--print"], cfg).replace(/\\/g, "/");
  assert.match(out, /plugins\/cache\/cc-plugins\/cc-toolkit\/1\.0\.0\s*$/);
});

test("cc-resolve: 扫描时多个版本取字典序最大的", () => {
  const cfg = fakeConfigDir({ market: "cc-plugins", version: "1.0.0" });
  for (const v of ["1.10.0", "2.0.0"]) {
    const dir = path.join(cfg, "plugins", "cache", "cc-plugins", "cc-toolkit", v);
    fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), '{"name":"cc-toolkit"}');
    fs.writeFileSync(path.join(dir, "scripts", "cc-core.js"), "module.exports={};");
  }
  const out = runResolve(["--print"], cfg).replace(/\\/g, "/").trim();
  assert.match(out, /2\.0\.0$/, "应选中最新版本");
});

test("cc-resolve: 找不到插件时非 0 退出并给出可操作指引", () => {
  const cfg = fs.mkdtempSync(path.join(tmpRoot, "empty-"));
  assert.throws(
    () => runResolve(["--print"], cfg),
    (err) => {
      const msg = String(err.stderr || "");
      assert.match(msg, /找不到 cc-toolkit 插件的安装目录/);
      assert.match(msg, /CC_TOOLKIT_PLUGIN_ROOT/, "应提示可用的补救手段");
      assert.match(msg, /plugin install/, "应提示安装命令");
      return err.status === 1;
    }
  );
});

test("cc-resolve: --which 缺参数时报错退出", () => {
  const cfg = fakeConfigDir({ market: "cc-plugins", version: "1.0.0" });
  assert.throws(
    () => runResolve(["--which"], cfg),
    (err) => err.status === 2
  );
});

test("cc-resolve: 转发时保持 stdout 协议与退出码", () => {
  const cfg = fakeConfigDir({ market: "cc-plugins", version: "1.0.0" });
  const root = path.join(cfg, "plugins", "cache", "cc-plugins", "cc-toolkit", "1.0.0");

  // 让被转发的脚本回一个 hook 协议 JSON，验证 stdin/stdout 直连没被破坏
  fs.writeFileSync(
    path.join(root, "scripts", "cc-hook.js"),
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.stringify({systemMessage:"ok:"+s.trim()}));});'
  );

  const out = execFileSync(process.execPath, [path.join(SCRIPTS, "cc-resolve.js"), "cc-hook.js"], {
    input: "hello",
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
    timeout: 20000,
  });
  assert.deepEqual(JSON.parse(out), { systemMessage: "ok:hello" });
});

test("cc-resolve: 转发时透传子进程退出码", () => {
  const cfg = fakeConfigDir({ market: "cc-plugins", version: "1.0.0" });
  const root = path.join(cfg, "plugins", "cache", "cc-plugins", "cc-toolkit", "1.0.0");
  fs.writeFileSync(path.join(root, "scripts", "cc-hook.js"), "process.exit(3);");

  assert.throws(
    () => execFileSync(process.execPath, [path.join(SCRIPTS, "cc-resolve.js"), "cc-hook.js"], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
      timeout: 20000,
    }),
    (err) => err.status === 3
  );
});

test("cc-resolve: 目标脚本不存在时报错非 0", () => {
  const cfg = fakeConfigDir({ market: "cc-plugins", version: "1.0.0" });
  assert.throws(
    () => runResolve(["cc-nonexistent.js"], cfg),
    (err) => err.status === 1
  );
});

// ── cc-install-hook：写入 settings.json ─────────────────────────────────

const runInstall = (args, cfgDir, env) =>
  execFileSync(process.execPath, [path.join(SCRIPTS, "cc-install-hook.js"), ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir, ...(env || {}) },
    timeout: 20000,
  });

test("cc-install-hook: 写入跨版本的 glob 命令，而不是写死绝对路径", () => {
  const cfg = fakeConfigDir({ market: "cc-plugins", version: "1.0.0" });
  runInstall([], cfg);

  const settings = JSON.parse(fs.readFileSync(path.join(cfg, "settings.json"), "utf8"));
  const cmd = settings.hooks.Stop[0].hooks[0].command;

  // 关键：不能出现具体版本号，否则插件升级后失效
  assert.doesNotMatch(cmd, /1\.0\.0/, "命令里不应出现写死的版本号");
  assert.match(cmd, /\*\/cc-toolkit\/\*/, "市场名与版本号都应留成通配符");
  assert.match(cmd, /cc-hook\.js/, "应指向 hook 脚本");
  assert.equal(settings.hooks.Stop[0].hooks[0].type, "command");
});

test("cc-install-hook: 重复执行不追加第二条，只更新已有那条", () => {
  const cfg = fakeConfigDir({ market: "cc-plugins", version: "1.0.0" });
  runInstall([], cfg);
  const out2 = runInstall([], cfg);

  const settings = JSON.parse(fs.readFileSync(path.join(cfg, "settings.json"), "utf8"));
  assert.equal(settings.hooks.Stop.length, 1, "不应出现重复 hook");
  assert.match(out2, /已更新/);
});

test("cc-install-hook: 保留用户已有的其他 hook", () => {
  const cfg = fakeConfigDir({ market: "cc-plugins", version: "1.0.0" });
  const file = path.join(cfg, "settings.json");
  const mine = { type: "command", command: "node /somewhere/else/user-script.js" };
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [mine] }] }, model: "x" }));

  runInstall([], cfg);

  const settings = JSON.parse(fs.readFileSync(file, "utf8"));
  const all = settings.hooks.Stop.flatMap((g) => g.hooks);
  assert.ok(all.some((h) => h.command === mine.command), "用户原有的 hook 必须保留");
  assert.ok(all.some((h) => h.command.includes("cc-hook.js")), "本插件的 hook 应被加入");
  assert.equal(settings.model, "x", "其他顶层字段不受影响");
});

test("cc-install-hook: --print 只预览不落盘", () => {
  const cfg = fakeConfigDir({ market: "cc-plugins", version: "1.0.0" });
  const out = runInstall(["--print"], cfg);

  assert.doesNotThrow(() => JSON.parse(out), "预览应是合法 JSON");
  assert.equal(fs.existsSync(path.join(cfg, "settings.json")), false, "不应写文件");
});

test("cc-install-hook: --uninstall 只移除本插件的 hook", () => {
  const cfg = fakeConfigDir({ market: "cc-plugins", version: "1.0.0" });
  const file = path.join(cfg, "settings.json");
  const theirs = { type: "command", command: "node /elsewhere/theirs.js" };
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [theirs] }] } }));
  runInstall([], cfg);

  runInstall(["--uninstall"], cfg);

  const settings = JSON.parse(fs.readFileSync(file, "utf8"));
  const all = ((settings.hooks && settings.hooks.Stop) || []).flatMap((g) => g.hooks || []);
  assert.equal(all.length, 1);
  assert.equal(all[0].command, theirs.command, "别人的 hook 必须留下");
});

test("cc-install-hook: 卸载后 hooks 为空则整个键被清掉", () => {
  const cfg = fakeConfigDir({ market: "cc-plugins", version: "1.0.0" });
  runInstall([], cfg);
  runInstall(["--uninstall"], cfg);

  const settings = JSON.parse(fs.readFileSync(path.join(cfg, "settings.json"), "utf8"));
  assert.equal(settings.hooks, undefined, "没有 hook 了就不该留空壳");
});

test("cc-install-hook: 插件目录找不到时非 0 退出", () => {
  const cfg = fs.mkdtempSync(path.join(tmpRoot, "empty2-"));
  assert.throws(
    () => runInstall([], cfg),
    (err) => {
      assert.match(String(err.stderr), /找不到 cc-toolkit 插件目录/);
      return err.status === 1;
    }
  );
});

test("cc-install-hook: 生成的命令能被 bash 正确解析（语法自洽）", () => {
  const cfg = fakeConfigDir({ market: "cc-plugins", version: "1.0.0" });
  runInstall([], cfg);

  const settings = JSON.parse(fs.readFileSync(path.join(cfg, "settings.json"), "utf8"));
  const cmd = settings.hooks.Stop[0].hooks[0].command;

  // 交给 bash -n 做语法检查，避免引号嵌套写错却无人发现
  const res = require("child_process").spawnSync("bash", ["-n", "-c", cmd], { encoding: "utf8" });
  if (res.error && res.error.code === "ENOENT") return; // 没有 bash 就跳过
  assert.equal(res.status, 0, `bash 语法检查失败: ${res.stderr}`);
});

test("SessionTracker: 短回复不进统计样本，但仍能被 latestRound 读到", () => {
  // 回归测试：曾经统计过滤器（MIN_SAMPLE_TOKENS=50）会把短轮次整个丢掉，
  // 导致 hook 取不到本轮读数 —— 用户设的 CC_TOOLKIT_MIN_TOKENS 形同虚设。
  const file = writeTranscript([
    { id: "short_1", ms: 2400, tokens: 46 }, // 「你好」量级：< 50，会被归档
    { id: "short_2", ms: 2000, tokens: 400 }, // 触发对 short_1 的归档，自己留作当前轮
  ]);
  const tracker = new core.SessionTracker(file).start();

  // short_1 已被归档，但太小 → 不进统计样本；short_2 还是当前轮，尚未归档
  assert.equal(tracker.samples.length, 0, "46 token 的轮次不该进统计样本");

  // 但 latestRound 必须能拿到最新一轮（当前轮 short_2）
  const r = tracker.latestRound({ force: true });
  assert.ok(r, "latestRound 必须返回最新一轮");
  assert.equal(r.tokens, 400);
});

test("SessionTracker: latestRound 在会话只有一条短回复时也能返回它", () => {
  const file = writeTranscript([{ id: "only", ms: 2400, tokens: 46 }]);
  const tracker = new core.SessionTracker(file).start();

  assert.equal(tracker.samples.length, 0, "短轮次不进统计样本");
  assert.equal(tracker.recentSamples(undefined, { force: true }).length, 0, "统计视图也为空");

  const r = tracker.latestRound({ force: true });
  assert.ok(r, "即便统计视图为空，本轮读数也必须拿得到");
  assert.equal(r.tokens, 46);
  assert.equal(r.durMs, 2400);
  assert.equal(Math.round(r.tps), 19);
  assert.equal(r.estimated, false);
});

test("SessionTracker: latestRound 丢弃无 token 或零耗时的轮次", () => {
  const file = writeTranscript([{ id: "tiny", ms: 100, tokens: 0.5 }]);
  const tracker = new core.SessionTracker(file).start();
  const r = tracker.latestRound({ force: true });
  assert.equal(r, null, "token 不足 1 的轮次没有可报告的速度");
});

test("SessionTracker: 已归档的短轮次也会被 lastRound 记住", () => {
  // 短轮次归档时该记进 lastRound；之后每归档一轮就覆盖它。
  const file = writeTranscript([
    { id: "short", ms: 2400, tokens: 46 }, // 归档（太小，不进样本）
    { id: "big", ms: 2000, tokens: 400 }, // 归档（进样本），覆盖 lastRound
    { id: "big2", ms: 2000, tokens: 500 }, // 当前轮，未归档
  ]);
  const tracker = new core.SessionTracker(file).start();

  assert.equal(tracker.lastRound.tokens, 400, "lastRound 应指向最新归档的那条");
  assert.deepEqual(
    tracker.samples.map((d) => d.tokens),
    [400],
    "统计样本只收够大的 big"
  );

  // 当前轮（big2）优先于 lastRound
  assert.equal(tracker.latestRound({ force: true }).tokens, 500);
});

test("hook: 短回复（低于统计下限但高于 CC_TOOLKIT_MIN_TOKENS）仍会报告", () => {
  // 回归测试：46 tok 的「你好」回复应被报告，而不是静默
  const file = writeTranscript([{ id: "m", ms: 2400, tokens: 46 }], { name: "short-session.jsonl" });
  const out = run("cc-hook.js", [], {
    input: JSON.stringify({ session_id: "s", transcript_path: file }),
  });
  assert.notEqual(out, "", "短回复不该静默");
  const payload = JSON.parse(out);
  assert.match(payload.systemMessage, /⚡ 本轮 19 tok\/s/);
  assert.match(payload.systemMessage, /2\.4s/, "应带上本轮耗时");
});

test("hook: 默认把首字等待与纯解码分开报（不再只给一个合成数字）", () => {
  // 3 个块、每块间隔 800ms：整轮 2.4s，但纯解码跨度只有 1.6s。
  // 合成一个 tok/s 会让 prefill 被误读成模型变慢，所以两个口径都要在。
  const file = writeTranscript([{ id: "m", ms: 2400, tokens: 400, chunks: 3 }]);
  const out = run("cc-hook.js", [], {
    input: JSON.stringify({ session_id: "split-session", transcript_path: file }),
  });
  const msg = JSON.parse(out).systemMessage;
  assert.match(msg, /首字 \d+\.\d+s/, "应报告首字等待（TTFT）");
  assert.match(msg, /解码 \d+/, "应报告纯解码速度");
});

test("hook: CC_TOOLKIT_SHOW 能裁剪输出行", () => {
  const file = writeTranscript([{ id: "m", ms: 2400, tokens: 400, chunks: 3 }]);
  const out = run("cc-hook.js", [], {
    input: JSON.stringify({ session_id: "show-session", transcript_path: file }),
    env: { CC_TOOLKIT_SHOW: "tps" },
  });
  const msg = JSON.parse(out).systemMessage;
  assert.match(msg, /tok\/s/);
  assert.doesNotMatch(msg, /首字/, "首字不在 show 里就不该出现");
  assert.doesNotMatch(msg, /解码/, "解码不在 show 里就不该出现");
  assert.doesNotMatch(msg, /近\d+条中位/, "median 不在 show 里就不该出现");
});

test("hook: max_tokens 截断时给出告警", () => {
  const file = writeTranscript([{ id: "m", ms: 2000, tokens: 400 }]);
  patchLines(file, (r) => {
    if (r.type !== "assistant") return r;
    r.message.stop_reason = "max_tokens";
    return r;
  });
  const out = run("cc-hook.js", [], {
    input: JSON.stringify({ session_id: "trunc-session", transcript_path: file }),
  });
  assert.match(JSON.parse(out).systemMessage, /max_tokens 截断/);
});

test("hook: 缓存命中过低时给出告警", () => {
  // 命中率 = read/(read+write+fresh) = 10/1010 ≈ 1%
  const file = patchUsage(writeTranscript([{ id: "m", ms: 2000, tokens: 400 }]), {
    input_tokens: 1000,
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: 0,
  });
  const out = run("cc-hook.js", [], {
    input: JSON.stringify({ session_id: "cache-alert-session", transcript_path: file }),
  });
  assert.match(JSON.parse(out).systemMessage, /prompt 缓存命中仅/);
});

test("hook: CC_TOOLKIT_ALERTS=0 时关掉告警", () => {
  const file = writeTranscript([{ id: "m", ms: 2000, tokens: 400 }]);
  patchLines(file, (r) => {
    if (r.type !== "assistant") return r;
    r.message.stop_reason = "max_tokens";
    return r;
  });
  const out = run("cc-hook.js", [], {
    input: JSON.stringify({ session_id: "noalert-session", transcript_path: file }),
    env: { CC_TOOLKIT_ALERTS: "0" },
  });
  assert.doesNotMatch(JSON.parse(out).systemMessage, /截断/);
});

test("hook: QUIET 模式下慢速提示有冷却，不会每轮刷屏", () => {
  const id = `cool-${Math.random().toString(36).slice(2)}`;
  const file = writeTranscript([{ id: "m", ms: 5000, tokens: 100 }]); // 20 tok/s
  const event = JSON.stringify({ session_id: id, transcript_path: file });
  const env = { CC_TOOLKIT_QUIET: "1", CC_TOOLKIT_SLOW_TOKENS_PER_SEC: "40" };

  assert.match(JSON.parse(run("cc-hook.js", [], { input: event, env })).systemMessage, /🐢/);
  // 同一会话紧接着再来一次：应被冷却吃掉
  assert.equal(run("cc-hook.js", [], { input: event, env }), "", "冷却期内不应重复提示");
  fs.rmSync(path.join(os.tmpdir(), `cc-toolkit-state-${id}.json`), { force: true });
});

test("hook: CC_TOOLKIT_NOTIFY=1 且偏慢时附带桌面通知序列", () => {
  const id = `notify-${Math.random().toString(36).slice(2)}`;
  const file = writeTranscript([{ id: "m", ms: 5000, tokens: 100 }]); // 20 tok/s
  const out = run("cc-hook.js", [], {
    input: JSON.stringify({ session_id: id, transcript_path: file }),
    env: { CC_TOOLKIT_NOTIFY: "1", CC_TOOLKIT_SLOW_TOKENS_PER_SEC: "40" },
  });
  const payload = JSON.parse(out);
  assert.ok(payload.terminalSequence, "应带上 terminalSequence");
  assert.match(payload.terminalSequence, /^\x1b\]777;notify;/, "应为 OSC 777 通知序列");
  assert.match(payload.terminalSequence, /\x07$/, "应以 BEL 结束");
  fs.rmSync(path.join(os.tmpdir(), `cc-toolkit-state-${id}.json`), { force: true });
});

test("hook: 默认不发桌面通知（不打扰）", () => {
  const id = `nonotify-${Math.random().toString(36).slice(2)}`;
  const file = writeTranscript([{ id: "m", ms: 5000, tokens: 100 }]);
  const out = run("cc-hook.js", [], {
    input: JSON.stringify({ session_id: id, transcript_path: file }),
    env: { CC_TOOLKIT_SLOW_TOKENS_PER_SEC: "40" },
  });
  assert.equal(JSON.parse(out).terminalSequence, undefined);
  fs.rmSync(path.join(os.tmpdir(), `cc-toolkit-state-${id}.json`), { force: true });
});

test("hook: CC_TOOLKIT_MIN_TOKENS 高于本轮时仍然静默", () => {
  const file = writeTranscript([{ id: "m", ms: 2400, tokens: 46 }]);
  const out = run("cc-hook.js", [], {
    input: JSON.stringify({ transcript_path: file }),
    env: { CC_TOOLKIT_MIN_TOKENS: "100" },
  });
  assert.equal(out, "", "用户把下限调到 100，46 tok 就该静默");
});

test("statusline: 短回复也能显示读数", () => {
  const file = writeTranscript([{ id: "m", ms: 2400, tokens: 46 }], { name: "sl-short.jsonl" });
  const out = run("cc-statusline.js", [], {
    input: JSON.stringify({ session_id: "sl-short", transcript_path: file }),
  });
  assert.match(out, /⚡ 19 tok\/s/, "状态栏不该因统计过滤而空掉");
});

test("snapshot: 缓存里带 lastRound，且不经统计过滤", () => {
  const file = writeTranscript([{ id: "m", ms: 2400, tokens: 46 }]);
  const tracker = new core.SessionTracker(file).start();
  const snap = tracker.snapshot({ force: true });

  assert.deepEqual(snap.samples, [], "统计样本为空");
  assert.ok(snap.lastRound, "但 lastRound 必须在");
  assert.equal(snap.lastRound.tokens, 46);
});

test("statusline: v1 旧缓存被忽略后，仍能从 transcript 重算出读数", () => {
  const id = `legacy-${Math.random().toString(36).slice(2)}`;
  const file = writeTranscript([{ id: "m", ms: 2000, tokens: 400 }], { name: "sl-legacy.jsonl" });
  // 写一份 v1 缓存：里面的 tps 是旧口径（含 prefill），不能信
  fs.writeFileSync(
    core.cacheFileFor(id),
    JSON.stringify({
      v: 1,
      at: Date.now(),
      samples: [{ tokens: 9999, durMs: 1000, tps: 9999, estimated: false, at: Date.now() }],
    }),
    "utf8"
  );

  const out = run("cc-statusline.js", [], {
    input: JSON.stringify({ session_id: id, transcript_path: file }),
  });
  assert.doesNotMatch(out, /9999/, "不该复用 v1 缓存里的数字");
  assert.match(out, /⚡ 200 tok\/s/, "应从 transcript 重算出真实读数");
  fs.rmSync(core.cacheFileFor(id), { force: true });
});

test("SessionTracker: 拆分首字等待(TTFT)与纯解码速度", () => {
  // 3 个块，每块间隔 800ms：整轮 2.4s / 400 tok = 167 tok/s，
  // 但首字等了 800ms，真正的解码跨度只有 1.6s → 250 tok/s。
  // 合成一个数字时，这个差别会被完全掩盖。
  const file = writeTranscript([{ id: "m", ms: 2400, tokens: 400, chunks: 3 }]);
  const tracker = new core.SessionTracker(file).start();
  const r = tracker.latestRound({ force: true });

  assert.equal(r.durMs, 2400);
  assert.equal(r.ttftMs, 800, "首字等待 = 本轮起点 → 第一个块");
  assert.equal(r.decodeMs, 1600, "解码跨度 = 首块 → 末块");
  assert.equal(Math.round(r.tps), 167, "整轮口径含 prefill");
  assert.equal(Math.round(r.decodeTps), 250, "纯解码口径不含 prefill");
  assert.ok(r.decodeTps > r.tps, "拆开后解码速度应高于合成值");
});

test("SessionTracker: 单块回复无法拆分 decode，decodeTps 为 null", () => {
  // 只有一个内容块时，首块即末块，没有可测的解码跨度。
  // 这时必须诚实地返回 null，而不是拿整轮速度冒充解码速度。
  const file = writeTranscript([{ id: "m", ms: 2000, tokens: 400, chunks: 1 }]);
  const r = new core.SessionTracker(file).start().latestRound({ force: true });

  assert.equal(r.blocks, 1);
  assert.equal(r.decodeTps, null, "单块无法拆分");
  assert.equal(r.decodeMs, null);
  assert.equal(r.decodeReason, "single-block");
  assert.ok(r.tps > 0, "整轮速度仍然可用");
});

test("SessionTracker: 单块回复的首字等待被标记为无意义", () => {
  // 单块回复里首块即末块，ttft 恒等于整轮耗时。把它和「整轮 2.0s」一起显示
  // 只是重复，看起来像算错了 —— 所以标记出来，由渲染层决定不显示。
  const single = writeTranscript([{ id: "m", ms: 2000, tokens: 400, chunks: 1 }]);
  const r1 = new core.SessionTracker(single).start().latestRound({ force: true });
  assert.equal(r1.ttftMs, 2000, "首字等待等于整轮耗时");
  assert.equal(r1.ttftMeaningful, false, "没有后续内容 → 首字等待无展示意义");

  // 多个块、跨度足够时才有意义
  const multi = writeTranscript([{ id: "m", ms: 2400, tokens: 400, chunks: 3 }]);
  const r2 = new core.SessionTracker(multi).start().latestRound({ force: true });
  assert.equal(r2.ttftMeaningful, true);
});

test("SessionTracker: 块被一次性写盘时不报解码速度", () => {
  // Claude Code 常把多个块一次性写盘，时间戳只差 1ms。
  // 按 token/跨度 会算出上百万 tok/s —— 必须报 null 而不是假数字。
  const dir = fs.mkdtempSync(path.join(tmpRoot, "burst-"));
  const file = path.join(dir, "burst.jsonl");
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  fs.writeFileSync(
    file,
    JSON.stringify({ type: "user", timestamp: new Date(t0).toISOString(), message: { role: "user", content: "p" } }) +
      "\n" +
      [
        { t: 5000, b: "thinking" },
        { t: 5001, b: "text" },
        { t: 5002, b: "tool_use" },
      ]
        .map((x) =>
          JSON.stringify({
            type: "assistant",
            timestamp: new Date(t0 + x.t).toISOString(),
            message: { id: "msg_burst", role: "assistant", content: [{ type: x.b }], usage: { output_tokens: 2406 } },
          })
        )
        .join("\n") +
      "\n",
    "utf8"
  );

  const r = new core.SessionTracker(file).start().latestRound({ force: true });
  assert.equal(r.blocks, 3);
  assert.equal(r.decodeMs, 2, "跨度只有 2ms");
  assert.equal(r.decodeTps, null, "跨度太短 → 不报解码速度");
  assert.equal(r.decodeReason, "not-measurable");
  assert.ok(r.tps < 1000, "整轮口径不会被这种轮次污染");
  assert.equal(r.ttftMeaningful, false);
});

test("SessionTracker: 解析 thinking token 数与占比", () => {
  const file = patchUsage(
    writeTranscript([{ id: "m", ms: 2000, tokens: 400, chunks: 2 }]),
    { output_tokens_details: { thinking_tokens: 300 } } // thinking 是 output 的子集
  );
  const r = new core.SessionTracker(file).start().latestRound({ force: true });

  assert.equal(r.thinkingTokens, 300);
  assert.equal(r.thinkingShare, 0.75);
  assert.equal(r.tokens, 400, "thinking 不该被加进总 token 里（它是子集）");
});

test("SessionTracker: thinking_tokens 大于 output_tokens 时被 clamp", () => {
  // 实测 29509 行里有 7 行出现这种越界，直接除会得到 >100% 的荒谬占比
  const file = patchUsage(writeTranscript([{ id: "m", ms: 2000, tokens: 100, chunks: 2 }]), {
    output_tokens_details: { thinking_tokens: 999 },
  });
  const r = new core.SessionTracker(file).start().latestRound({ force: true });
  assert.equal(r.thinkingTokens, 100, "应被 clamp 到 output_tokens");
  assert.equal(r.thinkingShare, 1);
});

test("SessionTracker: 解析缓存命中率与分层字段", () => {
  const file = writeTranscript([{ id: "m", ms: 2000, tokens: 400, chunks: 2 }]);
  patchUsage(file, {
    input_tokens: 1000,
    cache_read_input_tokens: 8000,
    cache_creation_input_tokens: 1000,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 },
  });
  patchAssistant(file, { effort: "xhigh", attributionSkill: "code-review" });
  patchLines(file, (r) => {
    if (r.type !== "assistant") return r;
    r.message.model = "claude-opus-5";
    r.message.stop_reason = "end_turn";
    return r;
  });

  const r = new core.SessionTracker(file).start().latestRound({ force: true });
  assert.equal(r.cache.read, 8000);
  assert.equal(r.cache.write, 1000);
  assert.equal(r.cache.fresh, 1000);
  assert.equal(r.cache.hitRatio, 0.8, "8000 / (8000+1000+1000)");
  assert.equal(r.cache.ephemeral5m, 1000);
  assert.equal(r.effort, "xhigh");
  assert.equal(r.model, "claude-opus-5");
  assert.equal(r.skill, "code-review");
  assert.equal(r.stopReason, "end_turn");
  assert.equal(r.stoppedByLimit, false);
});

test("SessionTracker: 累计式 usage（第三方 provider）不会让读数虚高", () => {
  // 第三方 provider 只在末尾块写总数（0,0,1573,1573），且末块时间戳
  // 可能早于最后一个内容块。若用「max 值 ÷ 到带 usage 那块的耗时」，
  // 分子分母就会错配，算出偏高的速度。
  const dir = fs.mkdtempSync(path.join(tmpRoot, "prov-"));
  const file = path.join(dir, "cumulative.jsonl");
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  const line = (ms, usage) =>
    JSON.stringify({
      type: "assistant",
      timestamp: new Date(t0 + ms).toISOString(),
      message: { id: "msg_c", role: "assistant", content: [{ type: "text", text: "x".repeat(80) }], usage },
    }) + "\n";

  fs.writeFileSync(
    file,
    JSON.stringify({ type: "user", timestamp: new Date(t0).toISOString(), message: { role: "user", content: "p" } }) +
      "\n" +
      line(500, { output_tokens: 0 }) +
      line(1000, { output_tokens: 0 }) +
      line(1500, { output_tokens: 1500 }) +
      line(2000, { output_tokens: 1500 }), // 最后一个内容块
    "utf8"
  );

  const r = new core.SessionTracker(file).start().latestRound({ force: true });
  assert.equal(r.tokens, 1500, "取的是累计总数（max），不是把每块相加");
  assert.equal(r.durMs, 2000, "耗时算到最后一块，而不是带 usage 的那块");
  assert.equal(r.blocks, 4);
  assert.equal(Math.round(r.tps), 750, "1500 tok / 2s");
});

test("SessionTracker: max_tokens 截断与 refusal 被标记", () => {
  const mk = (reason, name) => {
    const file = writeTranscript([{ id: "m", ms: 2000, tokens: 400 }], { name });
    patchLines(file, (r) => {
      if (r.type !== "assistant") return r;
      r.message.stop_reason = reason;
      return r;
    });
    return new core.SessionTracker(file).start().latestRound({ force: true });
  };
  assert.equal(mk("max_tokens", "mt.jsonl").stoppedByLimit, true);
  assert.equal(mk("refusal", "rf.jsonl").refused, true);
  assert.equal(mk("end_turn", "et.jsonl").stoppedByLimit, false);
});

test("SessionTracker: 解析 system 行的 api_error / turn_duration / hook 摘要", () => {
  const file = writeTranscript([{ id: "m", ms: 2000, tokens: 400 }]);
  fs.appendFileSync(
    file,
    [
      JSON.stringify({
        type: "system",
        subtype: "api_error",
        timestamp: "2026-01-01T00:10:00.000Z",
        error: { message: "Connection error.", connection: { code: "ECONNRESET" } },
        retryAttempt: 2,
        maxRetries: 10,
        source: "request_retry",
      }),
      JSON.stringify({
        type: "system",
        subtype: "turn_duration",
        timestamp: "2026-01-01T00:11:00.000Z",
        durationMs: 6373,
        messageCount: 15,
      }),
      JSON.stringify({
        type: "system",
        subtype: "stop_hook_summary",
        timestamp: "2026-01-01T00:12:00.000Z",
        hookCount: 2,
        hookInfos: [{ command: "node cc-hook.js" }],
        hookErrors: [],
        hasOutput: true,
        preventedContinuation: false,
      }),
    ].join("\n") + "\n",
    "utf8"
  );

  const t = new core.SessionTracker(file).start();
  const f = t.sessionFacts();
  assert.equal(f.apiErrors.count, 1);
  assert.equal(f.apiErrors.byCode[0].code, "ECONNRESET");
  assert.equal(f.apiErrors.retried, 1);
  assert.equal(f.turnDurations.count, 1);
  assert.equal(f.turnDurations.medianMs, 6373);
  assert.equal(f.hookRuns.count, 1);
  assert.equal(f.hookRuns.withOutput, 1);
  assert.equal(f.hookRuns.withErrors, 0);
});

test("SessionTracker: 分层对比按 effort / 技能 / 工具调用切分", () => {
  const rounds = [];
  for (let i = 0; i < 4; i++) rounds.push({ id: `hi_${i}`, ms: 1000, tokens: 400 }); // 400 tok/s
  for (let i = 0; i < 4; i++) rounds.push({ id: `lo_${i}`, ms: 4000, tokens: 400 }); // 100 tok/s
  const file = writeTranscript(rounds, { name: "breakdown.jsonl" });

  const rows = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  fs.writeFileSync(
    file,
    rows
      .map((r) => {
        if (r.type !== "assistant") return JSON.stringify(r);
        const fast = r.message.id.startsWith("hi_");
        r.effort = fast ? "low" : "xhigh";
        r.attributionSkill = fast ? "quick-fix" : "deep-review";
        // 慢的那些轮次带一个 tool_use 块
        if (!fast) r.message.content = [...r.message.content, { type: "tool_use", id: "t1", name: "Bash", input: {} }];
        return JSON.stringify(r);
      })
      .join("\n") + "\n",
    "utf8"
  );

  const b = new core.SessionTracker(file).start().breakdown();
  const low = b.byDifficulty.find((g) => g.key === "low");
  const xhigh = b.byDifficulty.find((g) => g.key === "xhigh");
  assert.equal(low.count, 4);
  assert.equal(xhigh.count, 4);
  assert.ok(low.medianTps > xhigh.medianTps, "low 档应明显更快");
  assert.ok(b.bySkill.find((g) => g.key === "deep-review"), "应按技能分组");
  assert.ok(b.byToolUse.find((g) => g.key === "含工具调用"), "应能区分是否调用工具");

  // 样本量 <3 的分组应被过滤掉，避免过度解读
  const plain = writeTranscript(
    Array.from({ length: 4 }, (_, i) => ({ id: `p_${i}`, ms: 2000, tokens: 400 })),
    { name: "thin-groups.jsonl" }
  );
  const thin = new core.SessionTracker(plain).start().breakdown();
  assert.equal(thin.byDifficulty.length, 0, "没有 effort 字段就没有分组");
  assert.equal(thin.bySkill.length, 0, "没有技能归因就没有分组");
});

test("analyze: 提供分层、会话事实与双口径趋势", () => {
  const rounds = [];
  for (let i = 0; i < 22; i++) rounds.push({ id: `m_${i}`, ms: 2000, tokens: 400, chunks: 3 });
  const a = core.analyze(new core.SessionTracker(writeTranscript(rounds)).start());

  assert.ok(a.breakdown, "应给出分层结果");
  assert.ok(a.session, "应给出会话级事实");
  assert.equal(typeof a.session.cache.sampleCount, "number");
  assert.ok("decodeTrendPct" in a, "应提供纯解码口径的趋势");
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
  assert.equal(data.stats.trendPct, undefined, "趋势不再放在 stats 里");
  assert.equal(data.trendPct, null, "单样本无法判断趋势");
});

test("CLI --json: 带上分层指标与会话级事实", () => {
  // 造够样本量，让每个 effort 分组都能过 n>=3 的阈值
  const rounds = Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, ms: 2000, tokens: 400, chunks: 3 }));
  const file = writeTranscript(rounds, { name: "json-insights.jsonl" });

  patchUsage(file, {
    input_tokens: 1000,
    cache_read_input_tokens: 9000,
    cache_creation_input_tokens: 0,
  });
  patchAssistant(file, { effort: "high" });
  patchLines(file, (r) => {
    if (r.type !== "assistant") return r;
    r.message.model = "claude-opus-5";
    r.message.stop_reason = "end_turn";
    return r;
  });

  const data = JSON.parse(run("cc-watch.js", ["--json", "--history=5", file]));
  const eff = data.breakdown.byEffort.find((g) => g.key === "high");
  assert.ok(eff, "应按 effort 分组");
  assert.equal(eff.count, 4);
  assert.ok(eff.medianTtftMs != null, "分组里应带首字等待");
  assert.equal(data.samples[0].cacheHitRatio, 0.9, "缓存命中率应被解析出来（9000/10000）");
  assert.equal(data.sessionFacts.cache.sampleCount, 4);
  assert.equal(data.sessionFacts.anomalies.maxTokens, 0);
});

test("CLI --insights: 输出分层对比与会话级事实，且无色码", () => {
  const rounds = [];
  for (let i = 0; i < 4; i++) rounds.push({ id: `hi_${i}`, ms: 1000, tokens: 400, chunks: 3 });
  for (let i = 0; i < 4; i++) rounds.push({ id: `lo_${i}`, ms: 4000, tokens: 400, chunks: 3 });
  const file = writeTranscript(rounds, { name: "insights.jsonl" });

  patchLines(file, (r) => {
    if (r.type !== "assistant") return r;
    r.effort = r.message.id.startsWith("hi_") ? "low" : "xhigh";
    r.message.usage = { ...r.message.usage, input_tokens: 1000, cache_read_input_tokens: 9000 };
    return r;
  });

  const out = run("cc-watch.js", ["--insights", file]);
  assert.match(out, /── 指标分层 ──/);
  assert.match(out, /按 effort 档位/);
  assert.match(out, /── 会话级事实 ──/);
  assert.match(out, /缓存: /);
  assert.match(out, /low /, "应出现 low 档分组");
  assert.doesNotMatch(out, /\x1b\[/, "报告不应含 ANSI 色码");
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
  assert.match(out, /⚡ \d+ tok\/s/, "应给出本轮速度");
  assert.equal(out.trim().split("\n").length, 1, "状态栏必须是单行");
});

test("statusline: CC_TOOLKIT_STATUSLINE_FIELDS 控制显示哪些段", () => {
  const file = writeTranscript([{ id: "m", ms: 2400, tokens: 400, chunks: 3 }], { name: "sl-fields.jsonl" });
  const input = JSON.stringify({ session_id: "sl-fields", transcript_path: file });

  const only = run("cc-statusline.js", [], {
    input,
    env: { CC_TOOLKIT_STATUSLINE_FIELDS: "tps" },
  });
  assert.match(only, /tok\/s/);
  assert.doesNotMatch(only, /首字/, "未选中的字段不该出现");

  const full = run("cc-statusline.js", [], {
    input,
    env: { CC_TOOLKIT_STATUSLINE_FIELDS: "tps,ttft,decode,median" },
  });
  assert.match(full, /tok\/s/);
  assert.match(full, /首字/);
  assert.match(full, /解码/);
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
