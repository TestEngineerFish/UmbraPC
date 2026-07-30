// 工具 → 运行时环境：看清这台机器上装了哪些 Java / Python、谁在生效、哪里不对。
//
// 一期是**纯只读**的（不切换、不安装卸载），诊断只给可复制的命令，不代跑。
// 理由见 doc/运行时环境-设计与待办.md §2：写坏用户的 shell 配置，他的终端会当场不能用，
// 而他不会怀疑是 Umbra 干的。
//
// 布局要点：**一个语言一张卡、各自一个刷新按钮、各自的 loading**。
// Java 扫得快（一条 java_home 就够），Python 慢得多（要跑 pyenv / uv 好几个命令），
// 合成一个刷新按钮就是让快的等慢的。
import { useCallback, useEffect, useState } from "react";
import { Panel, Pill, RefreshButton } from "../../components/ui";
import { IconCheck, IconAlert, IconInfo, IconCopy, IconCpu, IconCode } from "../../components/icons";
import { RUNTIME_SOURCE, hasRuntime, runtimeApi, type RuntimeIssue, type RuntimeScan } from "./bridges";

// 两个语言的展示元数据。加语言就在这里加一行（Node / Flutter 见文档二期）。
const KINDS: { kind: "java" | "python"; label: string; hint: string }[] = [
  { kind: "java", label: "Java", hint: "JDK 装在哪、命令行和构建工具用的是不是同一个" },
  { kind: "python", label: "Python", hint: "装了哪些 Python、pyenv/uv 有没有真的生效" },
];

/** 诊断级别 → 图标 + Pill 色调。四色语义和全站一致：红=坏了、黄=要人处理、灰=只是提示。 */
const LEVEL = {
  error: { tone: "danger" as const, Icon: IconAlert, word: "有问题" },
  warn: { tone: "warning" as const, Icon: IconAlert, word: "要注意" },
  info: { tone: "neutral" as const, Icon: IconInfo, word: "提示" },
};

/** 点一下复制，按钮就地变「已复制」再变回来 —— 不弹 toast（这一页可复制的东西太多了）。 */
function CopyBtn({ text, label = "复制" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      className="flex-none whitespace-nowrap inline-flex items-center gap-[4px] bg-transparent border-none p-0 text-[11.5px] text-muted cursor-pointer hover:text-orange-text"
      onClick={() => { void navigator.clipboard.writeText(text).then(() => setDone(true)).catch(() => {}); }}
    >
      {done ? <IconCheck size={11} /> : <IconCopy size={11} />}
      {done ? "已复制" : label}
    </button>
  );
}

function IssueRow({ issue }: { issue: RuntimeIssue }) {
  const meta = LEVEL[issue.level];
  return (
    <div className="flex items-start gap-[9px] py-[9px] border-b border-border-soft last:border-b-0">
      <span className={`w-[20px] h-[20px] mt-[1px] flex-none rounded-[6px] flex items-center justify-center ${
        issue.level === "error" ? "bg-danger-soft text-danger"
        : issue.level === "warn" ? "bg-warning-soft text-warning" : "bg-chip text-muted"}`}>
        <meta.Icon size={12} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-[7px] flex-wrap">
          <span className="text-[12.5px] font-semibold">{issue.title}</span>
          <span className="flex-none font-mono text-[10px] text-faint">{issue.code}</span>
        </div>
        {/* detail 里有换行（P1 会列出全部 python3 路径），必须保留 */}
        <div className="mt-[3px] text-[11.5px] leading-[1.7] text-muted whitespace-pre-wrap [text-wrap:pretty]">{issue.detail}</div>
        {issue.fix ? (
          <div className="mt-[7px] flex items-start gap-[8px]">
            <code className="flex-1 min-w-0 font-mono text-[11.5px] bg-rail border border-border rounded-[7px] px-[9px] py-[6px] break-all select-text">{issue.fix}</code>
            <div className="pt-[7px]"><CopyBtn text={issue.fix} label="复制命令" /></div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RuntimeCard({ kind, label, hint }: { kind: "java" | "python"; label: string; hint: string }) {
  const [scan, setScan] = useState<RuntimeScan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      setScan(await runtimeApi().scan(kind));
    } catch (e) {
      setErr(String(e).replace("Error: ", "").slice(0, 200));
    } finally {
      setBusy(false);
    }
  }, [kind]);

  // 进页面自动扫一次 —— 用户要的是「打开就能看到」，不是「打开后再点一下」。
  useEffect(() => { void load(); }, [load]);

  const worst = scan?.issues.find((i) => i.level === "error") ? "error"
    : scan?.issues.find((i) => i.level === "warn") ? "warn" : "";

  return (
    <Panel stack>
      {/* 卡片头：语言名 + 体检结论徽标 + 版本数 + 刷新。刷新常驻，用户随时能重扫。 */}
      <div className="flex items-center gap-[10px]">
        <span className="w-[28px] h-[28px] flex-none rounded-[8px] bg-orange-soft text-orange-text flex items-center justify-center">
          {kind === "java" ? <IconCpu size={15} /> : <IconCode size={15} />}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-[7px]">
            <span className="text-[14px] font-semibold">{label}</span>
            {scan ? (
              worst === "error" ? <Pill tone="danger" dot>有问题</Pill>
              : worst === "warn" ? <Pill tone="warning" dot>要注意</Pill>
              : <Pill tone="success" dot>正常</Pill>
            ) : null}
          </div>
          <div className="text-[11.5px] text-muted mt-[1px]">{hint}</div>
        </div>
        <div className="flex-1" />
        {scan ? (
          <span className="flex-none whitespace-nowrap text-[11.5px] text-faint">
            {scan.installs.length} 个版本 · {scan.elapsedMs}ms
          </span>
        ) : null}
        <RefreshButton onClick={() => { void load(); }} spinning={busy} title={`重新扫描 ${label}`} />
      </div>

      {err ? (
        <div className="text-[12px] text-danger bg-danger-soft rounded-[8px] px-[10px] py-[7px]">扫描失败：{err}</div>
      ) : null}

      {!scan && busy ? <div className="text-[12px] text-muted py-[6px]">正在扫描…</div> : null}

      {scan ? (<>
        {/* 「当前生效」放最上面，且允许多行 —— 只显示一个「当前：3.12」是在撒谎：
            它取决于你在哪个目录、以及谁在问（java 命令和 Maven 的答案经常不一样）。
            所以每一行都必须带「为什么是它」。 */}
        {scan.actives.length ? (
          <div>
            <div className="text-[10.5px] font-semibold tracking-[.06em] text-faint mb-[5px]">当前生效</div>
            <div className="border border-border rounded-[9px] overflow-hidden">
              {scan.actives.map((a, i) => {
                const hit = scan.installs.find((x) => x.id === a.installId);
                // 多个 active 指向不同版本 = 命令行和构建工具分叉了。就地标黄，
                // 不能只在下面的诊断区说 —— 用户的眼睛先看到这张表。
                const split = scan.actives.length > 1
                  && new Set(scan.actives.map((x) => scan.installs.find((y) => y.id === x.installId)?.version || "?")).size > 1;
                return (
                  <div key={i} className={`flex items-start gap-[10px] px-[11px] py-[8px] ${i ? "border-t border-border-soft" : ""}`}>
                    <span className="w-[104px] flex-none text-[12px] text-muted">{a.who}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-[7px] flex-wrap">
                        {hit ? (
                          <>
                            <span className="font-mono text-[13px] font-semibold">{hit.version}</span>
                            {hit.vendor ? <span className="text-[11.5px] text-muted">{hit.vendor}</span> : null}
                            {hit.arch ? <Pill tone={hit.arch === "x86_64" ? "warning" : "neutral"} mono>{hit.arch}</Pill> : null}
                          </>
                        ) : (
                          <span className="text-[12px] text-danger">指向一个探测不到的位置</span>
                        )}
                        {split ? <Pill tone="warning">不一致</Pill> : null}
                      </div>
                      <div className="text-[11px] text-faint mt-[2px] break-all">↳ {a.reason}</div>
                      <div className="font-mono text-[10.5px] text-faint mt-[1px] break-all select-text">{a.path}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="text-[12px] text-muted">没有检测到生效的 {label}。</div>
        )}

        {/* 已安装列表。自动扫描得来，用户不需要（也不能）手动添加。 */}
        {scan.installs.length ? (
          <div>
            <div className="text-[10.5px] font-semibold tracking-[.06em] text-faint mb-[5px]">已安装（自动扫描）</div>
            <div className="border border-border rounded-[9px] overflow-hidden">
              {scan.installs.map((it, i) => {
                // Java 显示 home（就是能直接塞进 JAVA_HOME 的那个目录，每个 JDK 各不相同）；
                // Python 显示 bin —— 系统装的几个 python3.x 共用 /usr 这一个 prefix，
                // 显示 home 会出现四行一模一样的「/usr」，等于什么都没说。
                const shown = kind === "java" ? it.home : it.bin;
                return (
                  <div key={it.id} className={`flex items-center gap-[9px] px-[11px] py-[7px] ${i ? "border-t border-border-soft" : ""}`}>
                    <span className="w-[58px] flex-none font-mono text-[12.5px] font-semibold">{it.version}</span>
                    <span className="w-[66px] flex-none text-[11.5px] text-muted truncate">{it.vendor || "—"}</span>
                    {it.arch ? <Pill tone={it.arch === "x86_64" ? "warning" : "neutral"} mono>{it.arch}</Pill> : <span className="w-[52px] flex-none" />}
                    <span className="flex-none text-[11px] text-faint whitespace-nowrap">{RUNTIME_SOURCE[it.source] || it.source}</span>
                    <span className="flex-1 min-w-0 font-mono text-[10.5px] text-faint truncate select-text" title={shown}>{shown}</span>
                    <CopyBtn text={shown} label={kind === "java" ? "JAVA_HOME" : "路径"} />
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* 检测到的管理器。用户常问「我到底装了 pyenv 还是 uv」——摆出来省一次翻终端。 */}
        {scan.managers.length ? (
          <div className="flex items-center gap-[8px] flex-wrap">
            <span className="text-[11.5px] text-muted flex-none">管理器</span>
            {scan.managers.map((m) => (
              <Pill key={m.name} tone="accent">{m.name}{m.version ? ` ${m.version}` : ""}</Pill>
            ))}
          </div>
        ) : null}

        {/* 别名单独一块，且必须标注「只在终端里生效」。
            用户把「别名 / shim / 符号链接」混为一谈，不说清他会一直找不到
            「为什么我改了别名，脚本里还是旧版本」。 */}
        {Object.keys(scan.aliases).length ? (
          <div>
            <div className="flex items-center gap-[7px] mb-[5px]">
              <span className="text-[10.5px] font-semibold tracking-[.06em] text-faint">终端别名</span>
              <Pill tone="neutral">只在终端里生效，脚本和程序看不到</Pill>
            </div>
            <div className="border border-border rounded-[9px] overflow-hidden">
              {Object.entries(scan.aliases).map(([k, v], i) => (
                <div key={k} className={`flex items-center gap-[9px] px-[11px] py-[6px] ${i ? "border-t border-border-soft" : ""}`}>
                  <span className="w-[104px] flex-none font-mono text-[12px]">{k}</span>
                  <span className="flex-1 min-w-0 font-mono text-[11.5px] text-muted truncate select-text" title={v}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* 诊断。坏的排最上面（sortIssues 已经排好，这里不再动顺序）。 */}
        {scan.issues.length ? (
          <div>
            <div className="text-[10.5px] font-semibold tracking-[.06em] text-faint mb-[2px]">
              诊断（{scan.issues.length} 条）
            </div>
            <div className="border border-border rounded-[9px] px-[11px]">
              {scan.issues.map((is) => <IssueRow key={is.code} issue={is} />)}
            </div>
            <div className="text-[11px] text-faint mt-[6px] [text-wrap:pretty]">
              这里只给命令，不替你执行 —— 改 shell 配置这种事出了错很难查，而且你不会想到是 Umbra 动的。
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-[7px] text-[12px] text-success">
            <IconCheck size={13} />没发现问题。
          </div>
        )}
      </>) : null}
    </Panel>
  );
}

export function RuntimeTool() {
  if (!hasRuntime) {
    return <div className="text-[12.5px] text-muted">这个功能只有桌面端能用。</div>;
  }
  return (
    <>
      {KINDS.map((k) => <RuntimeCard key={k.kind} {...k} />)}
      <div className="text-[11.5px] text-muted leading-[1.7] [text-wrap:pretty]">
        「当前生效」在 macOS 上不是一个值：它取决于你在哪个目录（<code className="font-mono">.python-version</code> 这类文件）、
        哪个 shell 会话，以及谁在问 —— <code className="font-mono">/usr/bin/java</code> 不看 <code className="font-mono">JAVA_HOME</code>，
        而 Maven 只认 <code className="font-mono">JAVA_HOME</code>。所以上面每一行都标了「为什么是它」。
        <br />
        一期只看不改。切换版本、装/删会在后面做。
      </div>
    </>
  );
}
