// 工作流编辑器的页头（批次 013 · 页头变体 E · 《PC 常用语与带图入口.dc.html》第 06 节 / tokens.pageHeader.variantE）。
// 从 WorkflowEditor 抽出来：那个文件已经近四千行，页头这一块又是纯布局，单独放着好找。
//
// 第一行照通用 PageHeader（components/layout）：
//   lead 22 图标块（--chip 底 / 圆角 6 / WfIcon 13）· 名称 16/600 · 启停胶囊 · 「N 个节点 · 上次 14:22 成功」
//   ｜ 次级「编辑信息」（独立窗口再加「完成」）｜ 齿轮 = 配置工作流 ｜ ⋯ = 低频 / 破坏性动作。
//   描述**不上页头** —— 它是详情内容，进左侧工作流列表的头部（WorkflowEditor 里画）。
// 第二行 44 / --rail 当工具条（PageHeader 的 secondRow）：
//   运行参数 240×28（--card 底 1px 描边 圆角 7 等宽 12px，Enter = 运行）+ 橙实心 28「▶ 运行」+ 1px×18 分隔
//   + 图标钮 28 一排（撤销 / 重做 / 目录 / 调试 / 对象库）+ 右端 note 11px --faint。
//
// ⚠️ 主按钮「运行」落在第二行是**全站唯一例外**（tokens.pageHeader.variantE.exception）：
// 它吃的是同一行那个参数输入框，拆到第一行去就和参数分家了。除画布工作台外不准照抄这一条。
import type { ReactNode } from "react";
import { PageHeader, headerIconBtn } from "../../components/layout";
import { btn, type MenuAction } from "../../components/ui";
import { IconBug, IconFolder, IconPanel, IconPlay, IconRedo, IconUndo } from "../../components/icons";

export interface WorkflowHeaderProps {
  /** 当前工作流。没选中时传 null：标题「工作流」、副标题「左侧新建或选择一个」，其余槽空。 */
  wf: { id: string; name: string; enabled: boolean; nodes: unknown[] } | null;
  /** 22 图标块里的图标（编辑器给 WfIcon 13；图标数据在 WorkflowEditor 里，这边不认它）。 */
  icon?: ReactNode;
  /** 上次运行：开始时刻 + 成败。null = 这条工作流还没跑过。 */
  lastRun: { at: number; ok: boolean } | null;
  /** 内嵌在主窗口里：没有「完成」钮（没有窗口可关），「在独立窗口打开」由调用方放进 ⋯。 */
  embedded?: boolean;
  onEditInfo: () => void;
  /** 独立窗口的「完成」（关窗）。embedded 时不用。 */
  onDone?: () => void;
  /** 齿轮：配置工作流（给使用者填的表单，密钥进保险箱）。 */
  onSettings: () => void;
  more: MenuAction[];
  // ── 第二行 ──
  runArg: string;
  onRunArg: (v: string) => void;
  onRun: () => void;
  running: boolean;
  /** 选中了某个节点 → 从那个节点开始跑（按钮 title 跟着变）。 */
  runFromNode: boolean;
  canUndo: boolean; onUndo: () => void;
  canRedo: boolean; onRedo: () => void;
  onOpenDir: () => void;
  drawer: boolean; onToggleDrawer: () => void;
  lib: boolean; onToggleLib: () => void;
  /** 一闪而过的提示（导入导出结果、运行结果）。空串 = 不显示。 */
  note: string;
}

// 「上次 14:22」：当天只给时分；不是当天的补上月-日，免得三天前的一次运行看着像刚跑过。
function fmtRunAt(at: number): string {
  const d = new Date(at), now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}

// 选中态（调试抽屉开着 / 对象库开着）用内联样式而不是拼 bg-orange-soft：
// headerIconBtn 自带 bg-transparent 与 hover:bg-hover，同属性的工具类靠 className 顺序盖不掉。
const ON_STYLE = { background: "var(--orange-soft)", color: "var(--orange-text)" } as const;

export function WorkflowHeader(p: WorkflowHeaderProps) {
  const { wf } = p;
  const subtitle = wf
    ? `${wf.nodes.length} 个节点${p.lastRun ? ` · 上次 ${fmtRunAt(p.lastRun.at)} ${p.lastRun.ok ? "成功" : "失败"}` : ""}`
    : "左侧新建或选择一个";
  // 「完成」是独立窗口的关窗出口，不跟着「有没有选中工作流」走；「编辑信息」只在选中时出。
  const secondary = [
    ...(wf ? [{ label: "编辑信息", title: "改名称、描述、图标", onClick: p.onEditInfo }] : []),
    ...(!p.embedded && p.onDone ? [{ label: "完成", onClick: p.onDone }] : []),
  ];

  // 启停胶囊：启用 = --success-soft / --success + 实心绿点；停用 = --chip / --muted + 空心圈
  // （和左侧列表行尾的圆点同一套语义：实心绿 = 启用，空心圈 = 停用）。
  return (
    <PageHeader
      title={wf ? wf.name : "工作流"}
      lead={wf ? (
        <span className="w-[22px] h-[22px] flex-none rounded-[6px] overflow-hidden bg-chip text-muted flex items-center justify-center">{p.icon}</span>
      ) : undefined}
      badge={wf ? (wf.enabled === false ? (
        <span className="flex-none flex items-center gap-[5px] px-[8px] py-[2px] rounded-full bg-chip text-muted text-[11px] font-semibold whitespace-nowrap">
          <span className="w-[6px] h-[6px] flex-none rounded-full border-[1.5px] border-muted" />已停用
        </span>
      ) : (
        <span className="flex-none flex items-center gap-[5px] px-[8px] py-[2px] rounded-full bg-success-soft text-success text-[11px] font-semibold whitespace-nowrap">
          <span className="w-[6px] h-[6px] flex-none rounded-full bg-success" />已启用
        </span>
      )) : undefined}
      subtitle={subtitle}
      secondary={secondary}
      onSettings={wf ? p.onSettings : undefined}
      more={p.more.length ? p.more : undefined}
      toolbarRow
      secondRow={<>
        {/* 运行：参数输入 + 「▶ 运行」。参数等价于用户在快捷入口里输入的那段，跑的是「回车」分支，
            走的和真实触发同一条执行路径，所以轨迹可以直接当真。没选中工作流时这一组不画
            （裁定 8：空态不出橙钮），撤销 / 重做 / 调试 / 对象库仍在 —— 删掉最后一条工作流之后还得能撤销回来。 */}
        {wf ? (<>
          <input value={p.runArg} onChange={(e) => p.onRunArg(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") p.onRun(); }}
            placeholder="运行参数（可留空）"
            title="相当于在快捷入口里输入的那段文字，下游用 {query} 取它"
            className="flex-[0_1_240px] min-w-[150px] h-[28px] px-[10px] rounded-[7px] bg-card border border-border text-text font-mono text-[12px] outline-none transition-colors duration-[130ms] ease-out hover:border-orange focus:border-orange" />
          {/* 主按钮落在第二行 —— 全站唯一例外，见文件头。 */}
          <button className={`${btn("primary", "sm")} gap-[6px]`} disabled={p.running}
            title={p.runFromNode ? "从选中的节点开始跑（回车分支）" : "从第一个触发器开始跑（回车分支）"}
            onClick={p.onRun}><IconPlay size={12} strokeWidth={2} />运行</button>
          <span className="flex-none w-px h-[18px] bg-border mx-[3px]" />
        </>) : null}
        <button className={headerIconBtn} disabled={!p.canUndo} title="撤销 ⌘Z" onClick={p.onUndo}><IconUndo size={15} /></button>
        <button className={headerIconBtn} disabled={!p.canRedo} title="重做 ⇧⌘Z" onClick={p.onRedo}><IconRedo size={15} /></button>
        {/* 稿里画成「节点目录」，实际就是这条工作流的磁盘目录（脚本节点默认在这里跑），语义照旧。 */}
        <button className={headerIconBtn} disabled={!wf} title="打开这条工作流的目录（脚本节点默认就在这里跑）" onClick={p.onOpenDir}><IconFolder size={15} /></button>
        <button className={headerIconBtn} style={p.drawer ? ON_STYLE : undefined} title="调试：最近若干次执行的逐节点轨迹" onClick={p.onToggleDrawer}><IconBug size={15} /></button>
        <button className={headerIconBtn} style={p.lib ? ON_STYLE : undefined} title="对象库（右侧面板）" onClick={p.onToggleLib}><IconPanel size={15} /></button>
        {/* 右端：一闪而过的提示（没有就只是占位的弹簧）。工作流的每一笔改动都是即时落盘的，
            没有「保存时刻」这个数据，所以稿里的「已保存 14:31」这里没有对应物。 */}
        <span className="flex-1 min-w-0 text-right text-[11px] text-faint whitespace-nowrap truncate" title={p.note || undefined}>{p.note}</span>
      </>}
    />
  );
}
