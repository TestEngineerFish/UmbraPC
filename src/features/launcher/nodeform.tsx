// 节点配置弹窗的一套原语。照 ClaudeDesign 上「Umbra 工作流 · 节点配置弹窗」那份稿子做。
//
// 单独开一个文件，不是为了「组件要分文件」这种教条，而是两条实际理由：
//   1. WorkflowEditor.tsx 已经接近三千行，弹窗这一坨再堆进去很难找；
//   2. 这些原语接下来还要给表格编辑器、规则卡片用，放在 WorkflowEditor 里会绕成循环引用
//      （那边要 import 这里的组件，这里又得 import 那边的 TYPE_META）。所以这一层**纯展示**，
//      不认识任何节点类型，只吃 props。
//
// 设计稿里定死、这里必须照抄的几件事：
//   · 圆角只有三档：12（弹窗）/ 8（控件、内嵌容器）/ 999（药丸）。别的一律不用。
//   · 标签在**左侧定宽 110px**，不是压在控件上方。多行控件时标签顶对齐并下沉 7px。
//   · 说明文字在右列、控件下方，11.5px --faint。长说明改用 <Fold> 收起来。
//   · 底部固定「取消 / 保存」，改动只在按保存后才落到工作流。
import { useEffect, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { IconChevronRight, IconTrash, IconX } from "../../components/icons";
import { ContextMenu } from "./menu";
import type { MenuItem } from "./menu";

type IconComp = ComponentType<{ size?: number }>;

// 控件底样式。设计稿：padding 6/9、圆角 8、--bg 底、--border 描边、12.5px。
// 等宽版小半号（12px）—— 等宽字面宽，同号数排在一起会比正文显得胖。
export const FLD = "w-full px-[9px] py-[6px] border border-border rounded-[8px] bg-bg text-text text-[12.5px] outline-none focus:border-orange";
export const FLD_MONO = "w-full px-[9px] py-[6px] border border-border rounded-[8px] bg-bg text-text text-[12px] font-mono outline-none focus:border-orange";
// 次要按钮（「选择」「选目录」这类挂在输入框右边的）
export const BTN_SEC = "flex-none whitespace-nowrap flex items-center gap-[5px] px-[11px] py-[6px] border border-border rounded-[8px] text-[12px] bg-transparent hover:border-orange hover:text-orange-text";

// 弹窗宽度三档。键就是档位名，值必须是**字面量**——Tailwind 只扫源码里出现过的类名，
// 拼出来的 `w-[${n}px]` 不会被生成。
const W: Record<string, string> = {
  sm: "w-[440px]",   // 纯表单，控件单列。多数节点用这档
  md: "w-[560px]",   // 含脚本编辑区，或内嵌两列表格
  lg: "w-[720px]",   // 一行三列以上的表格编辑器
};
export type DlgWidth = keyof typeof W;

// 「当前有没有快捷键录制在进行」。
//
// 这不是可有可无的状态：Dlg 和 HotkeyField 都在 window 上捕获阶段监听 Esc，
// 而捕获阶段的多个监听按**注册先后**触发 —— Dlg 先挂上，所以录制时按 Esc
// 会先被 Dlg 吃掉、直接把弹窗关了，而用户的本意只是取消这次录制。
// 用一个模块级计数器让 Dlg 在录制期间让路；用计数而不是布尔，是因为一个弹窗里
// 可能摆两个录制框（比如以后要给同一个节点配主副两个热键）。
let recording = 0;

// 弹窗外壳：头部（图标 + 标题 + 副标题 + 关闭）/ 正文 / 底栏（删除节点 · 取消 · 保存）。
//
// dirty 判定放在这里而不是交给调用方：所有弹窗都是「确认制」，
// 改了没保存就点遮罩/按 Esc 会丢东西，这个坑对每个节点都一样，没道理各写一遍。
// 确认用行内替换底栏，不用 window.confirm —— 后者在 Electron 里会把渲染进程整个卡住。
export function Dlg({ width = "sm", icon: Icon, title, sub, dirty, onClose, onSave, onDelete, children }: {
  width?: DlgWidth;
  icon: IconComp;
  title: string;
  sub: string;
  dirty: boolean;
  onClose: () => void;
  onSave: () => void;
  onDelete?: () => void;
  children: ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  const tryClose = () => { if (dirty) setAsking(true); else onClose(); };

  // Esc 走和点遮罩一样的路。捕获阶段接：画布那边也监听 Esc（取消连线/清选中），
  // 不抢在它前面的话，一次 Esc 会同时触发两处。
  // 故意不写依赖数组：每次渲染都重挂一次，好让闭包里的 asking / dirty 始终是最新的。
  // 加上 [] 会让它永远看到首次渲染时的值，于是「有改动」判不出来 —— 别顺手补依赖数组。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (recording) return;   // 录快捷键时这一下 Esc 是给录制用的，见 recording 的注释
      e.preventDefault(); e.stopPropagation();
      if (asking) { setAsking(false); return; }
      tryClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onMouseDown={tryClose}>
      <div className={`${W[width]} max-h-[86vh] bg-card border border-border rounded-[12px] shadow-[0_8px_24px_rgba(0,0,0,.13)] overflow-hidden flex flex-col`}
        onMouseDown={(e) => e.stopPropagation()}>

        <div className="flex items-center gap-[11px] px-[15px] py-[13px] border-b border-border flex-none">
          <span className="w-[30px] h-[30px] flex-none rounded-[8px] bg-orange-soft text-orange-text flex items-center justify-center"><Icon size={16} /></span>
          <div className="flex-1 min-w-0">
            <div className="text-[13.5px] font-semibold leading-[1.5]">{title}</div>
            {/* 副标题只给一行：它是「这个节点大概干什么」的提示，不是文档。溢出直接省略号 */}
            <div className="text-[11.5px] text-faint leading-[1.5] truncate">{sub}</div>
          </div>
          <button title="关闭" onClick={tryClose}
            className="w-[26px] h-[26px] flex-none rounded-[7px] border border-transparent bg-transparent text-muted flex items-center justify-center hover:bg-hover hover:text-text"><IconX size={14} /></button>
        </div>

        <div className="px-[15px] pt-[2px] pb-[14px] overflow-y-auto">{children}</div>

        {asking ? (
          <div className="flex items-center gap-[8px] px-[15px] py-[11px] border-t border-border bg-warning-soft flex-none">
            <span className="flex-1 min-w-0 text-[12px] text-text leading-[1.6]">有改动还没保存，关掉就没了。</span>
            <button onClick={() => setAsking(false)}
              className="flex-none whitespace-nowrap px-[14px] py-[6px] border border-border rounded-[8px] text-[12.5px] bg-card hover:bg-hover">继续编辑</button>
            <button onClick={onClose}
              className="flex-none whitespace-nowrap px-[14px] py-[6px] border border-danger rounded-[8px] text-[12.5px] text-danger bg-transparent hover:bg-danger hover:text-white">放弃改动</button>
          </div>
        ) : (
          <div className="flex items-center gap-[8px] px-[15px] py-[11px] border-t border-border bg-rail flex-none">
            {onDelete ? (
              <button onClick={onDelete}
                className="flex-none whitespace-nowrap flex items-center gap-[6px] px-[12px] py-[6px] border border-danger rounded-[8px] text-danger text-[12.5px] bg-transparent hover:bg-danger hover:text-white"><IconTrash size={13} />删除节点</button>
            ) : null}
            <span className="flex-1" />
            <button onClick={tryClose}
              className="flex-none whitespace-nowrap px-[14px] py-[6px] border border-border rounded-[8px] text-[12.5px] bg-transparent hover:bg-hover">取消</button>
            <button onClick={onSave}
              className="flex-none whitespace-nowrap px-[16px] py-[6px] border-none bg-orange text-white rounded-[8px] text-[12.5px] font-semibold hover:bg-orange-deep">保存</button>
          </div>
        )}
      </div>
    </div>
  );
}

// 表单行：左边定宽标签，右边控件。
// top=true 用于多行控件（textarea、带说明的字段）：标签顶对齐并下沉 7px 对准控件第一行。
// last=true 去掉下边框 —— 一组的最后一行不画线，否则和底栏的线叠成双线。
export function Row({ label, top, last, children }: { label: string; top?: boolean; last?: boolean; children: ReactNode }) {
  return (
    <div className={`flex gap-[12px] py-[11px] ${top ? "items-start" : "items-center"} ${last ? "" : "border-b border-border-soft"}`}>
      <span className={`w-[110px] flex-none whitespace-nowrap text-[12.5px] text-muted ${top ? "pt-[7px]" : ""}`}>{label}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

// 控件下方的说明。11.5px --faint，跟着右列走而不是通栏 —— 通栏会让它看起来像在说整个弹窗。
export function Hint({ children }: { children: ReactNode }) {
  return <div className="text-[11.5px] text-faint leading-[1.55] mt-[6px] [text-wrap:pretty]">{children}</div>;
}

// 复选框行。左边留一个和标签同宽的空位，让复选框和上面各行的控件对齐 ——
// 不留的话勾选框会顶到最左边，一列控件的左边缘就断了。
export function CheckRow({ checked, onChange, last, children }: {
  checked: boolean; onChange: (v: boolean) => void; last?: boolean; children: ReactNode;
}) {
  return (
    <label className={`flex items-center gap-[12px] py-[11px] cursor-pointer ${last ? "" : "border-b border-border-soft"}`}>
      <span className="w-[110px] flex-none" />
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="accent-orange w-[14px] h-[14px] flex-none m-0" />
      <span className="flex-1 min-w-0 text-[12.5px] leading-[1.65] [text-wrap:pretty]">{children}</span>
    </label>
  );
}

// 可折叠区：长说明和速查表放这里。
//
// 这是设计稿给「说明太长」的答案。原来那些三四行的灰字（终端命令和 Run Script 的区别、
// shebang 那段、按键权限那段）常驻在面板上，弹窗一长就糊成一片，而它们其实是
// 「第一次配的时候看一眼」的东西。收起来之后面板只剩控件，要看再展开。
export function Fold({ title, count, open: openInit, children }: {
  title: string; count?: string; open?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(!!openInit);
  return (
    <div className="mt-[12px] border border-border rounded-[8px] bg-rail overflow-hidden">
      <button onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-[8px] w-full px-[11px] py-[9px] border-none bg-transparent text-text text-[12.5px] text-left">
        <span className={`flex-none flex text-muted transition-transform duration-150 ${open ? "rotate-90" : ""}`}><IconChevronRight size={13} /></span>
        <span className="flex-1 min-w-0 whitespace-nowrap">{title}</span>
        {count ? <span className="flex-none whitespace-nowrap text-[11.5px] text-faint">{count}</span> : null}
      </button>
      {open ? <div className="px-[11px] pt-[2px] pb-[11px] text-[12px] text-muted leading-[1.7] [text-wrap:pretty]">{children}</div> : null}
    </div>
  );
}

// 内嵌编辑器上方的小节标题：左边分组名，右边一句操作提示（「拖动左侧手柄调序」这类）。
export function Sec({ title, note }: { title: string; note?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-[10px] mt-[13px] mb-[8px]">
      <span className="flex-none whitespace-nowrap text-[11px] font-semibold tracking-[.06em] text-muted">{title}</span>
      {note ? <span className="flex-none whitespace-nowrap text-[11.5px] text-faint">{note}</span> : null}
    </div>
  );
}

// 没有配置项的节点：正文只放一段说明。单独抽出来是为了让这类面板的留白和有表单的一致。
export function Blank({ children }: { children: ReactNode }) {
  return <div className="py-[13px] text-[12.5px] text-muted leading-[1.75] [text-wrap:pretty]">{children}</div>;
}

// 行内等宽片段（占位符、命令、键位）。设计稿里是 --chip 底 + 圆角 4。
export function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono bg-chip rounded-[4px] px-[5px] py-px text-orange-text">{children}</code>;
}

// 占位符速查的一行：左边等宽片段，右边一句话。
export function CodeRow({ code, children }: { code: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-[9px] text-[12px] leading-[1.6] mb-[6px] last:mb-0">
      <span className="flex-none whitespace-nowrap"><Code>{code}</Code></span>
      <span className="text-muted">{children}</span>
    </div>
  );
}

// 提示条：danger 用于「这样配跑不起来」，warn 用于「能跑但你多半不想要」。
export function Note({ kind = "warn", children }: { kind?: "warn" | "danger"; children: ReactNode }) {
  const tone = kind === "danger"
    ? "border-danger bg-danger-soft text-danger"
    : "border-warning bg-warning-soft text-warning";
  return (
    <div className={`flex items-start gap-[9px] px-[11px] py-[9px] border rounded-[8px] mt-[6px] ${tone}`}>
      <span className="flex-none flex pt-[1px]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
          <circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.01" />
        </svg>
      </span>
      <div className="flex-1 min-w-0 text-[12px] leading-[1.65] text-text [text-wrap:pretty]">{children}</div>
    </div>
  );
}

// 输入框 + 右侧按钮（选文件 / 选 App）。这个组合在弹窗里出现了七八次，抽出来省得每处对一遍间距。
export function PickField({ value, onChange, onPick, placeholder, mono, btn = "选择" }: {
  value: string; onChange: (v: string) => void; onPick: () => void | Promise<void>;
  placeholder?: string; mono?: boolean; btn?: string;
}) {
  return (
    <div className="flex items-center gap-[8px]">
      <input className={mono ? FLD_MONO : FLD} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      <button className={BTN_SEC} onClick={() => void onPick()}>{btn}</button>
    </div>
  );
}

// ── 可增删排序的行表格 ─────────────────────────────────────────────────────
//
// 设计稿把行操作定死成一套：**左侧拖拽手柄调序，右键菜单删除**，行内不再常驻删除按钮。
// 这个取舍是有道理的 —— 原来每行右边挂着 ✕ ↑ ↓ 三个字符按钮，它们
//   · 占掉一列宽度，而这列在 99% 的时间里是没用的；
//   · ✕ 紧挨着输入框，手滑一下整行就没了，还没有撤销；
//   · 字符按钮在不同系统的字体下大小不一，对不齐。
// 收进右键菜单之后，常用操作（改内容）不受打扰，破坏性操作（删）需要一次明确的右键。

// 一列的表头文案与它的宽度类。cls 同时用在表头和数据行上，保证两边永远对齐 ——
// 分开写的话改了一处忘了另一处，表头就和内容错位了，而这种错位看起来像「数据串行」。
export interface TableCol { label: string; cls: string }

const GRIP = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
    <path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" />
  </svg>
);
const ARROW_UP = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>;
const ARROW_DOWN = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M19 12l-7 7-7-7" /></svg>;
const COPY_ICON = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5h10" /></svg>;
const TRASH_ICON = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></svg>;
const PLUS_ICON = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>;
const EMPTY_ICON = <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h16M4 18h9" /></svg>;

// 拖到第 over 行上、指针是否已越过该行中线（past）时，应该换到哪个位置；null=这一下不动。
//
// 抽成纯函数是为了能单测。这条规则错了的表现是**疯狂闪烁** —— 一进入目标行就换位的话，
// 换完之后被拖的那行又落回指针下方，于是立刻再触发一次，来回横跳。
// 闪烁在自动化测试里看不见，只能靠人肉发现，所以更值得把判定本身钉死。
export function dragTarget(from: number, over: number, past: boolean): number | null {
  if (from === over) return null;
  if (from < over && !past) return null;   // 往下拖，还没过中线
  if (from > over && past) return null;    // 往上拖，已经过了中线
  return over;
}

// 把第 from 项挪到第 to 项的位置（其余项顺次让位），不是两两交换。
// 交换会让「把最后一行拖到第一行」变成「首尾对调」，中间的顺序全乱。
export function reorder<T>(rows: T[], from: number, to: number): T[] {
  const next = rows.slice();
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

// 行操作（拖拽调序 + 右键菜单）。表格和卡片列表共用这一套 ——
// 两种排布的外观完全不同，但「怎么调序、右键有哪几项」必须一模一样，
// 各写一份的结果一定是某天只改了其中一份。
function useRowOps<T>(rows: T[], onChange: (r: T[]) => void) {
  const [menu, setMenu] = useState<{ x: number; y: number; i: number } | null>(null);
  const from = useRef<number | null>(null);

  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= rows.length) return;
    const next = rows.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  // 挂在每一行/每张卡片外层：接住拖拽经过与右键
  const rowProps = (i: number) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      const f = from.current;
      if (f === null) return;
      const r = e.currentTarget.getBoundingClientRect();
      const to = dragTarget(f, i, e.clientY > r.top + r.height / 2);
      if (to === null) return;
      from.current = to;
      onChange(reorder(rows, f, to));
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault(); e.stopPropagation();
      setMenu({ x: e.clientX, y: e.clientY, i });
    },
  });

  // 拖拽手柄。只有它是 draggable —— 整行可拖的话，在输入框里选文字会被当成拖拽。
  const handle = (i: number, top?: boolean) => (
    <span draggable onDragStart={(e) => { from.current = i; e.dataTransfer.effectAllowed = "move"; }}
      onDragEnd={() => { from.current = null; }}
      title="拖动调序 · 右键更多操作"
      className={`w-[14px] flex-none text-faint flex cursor-grab active:cursor-grabbing ${top ? "pt-[6px]" : ""}`}>{GRIP}</span>
  );

  const items: MenuItem[] = menu === null ? [] : [
    { label: "复制这一行", icon: COPY_ICON, onClick: () => { const n = rows.slice(); n.splice(menu.i + 1, 0, JSON.parse(JSON.stringify(rows[menu.i]))); onChange(n); } },
    { label: "上移", icon: ARROW_UP, onClick: () => move(menu.i, -1) },
    { label: "下移", icon: ARROW_DOWN, onClick: () => move(menu.i, 1) },
    { sep: true },
    { label: "删除这一行", icon: TRASH_ICON, danger: true, onClick: () => onChange(rows.filter((_, j) => j !== menu.i)) },
  ];

  const menuNode = menu
    ? <ContextMenu x={menu.x} y={menu.y} items={items} title={`第 ${menu.i + 1} 项`} onClose={() => setMenu(null)} />
    : null;

  return { rowProps, handle, menuNode };
}

// 底部整行的「加一条」。表格和卡片列表都用它，样式只此一处。
function AddRow({ label, onClick, framed }: { label: string; onClick: () => void; framed?: boolean }) {
  return (
    <button onClick={onClick}
      className={framed
        ? "flex items-center justify-center gap-[6px] w-full py-[9px] border border-border rounded-[8px] bg-transparent text-muted text-[12.5px] whitespace-nowrap hover:border-orange hover:text-orange-text"
        : "flex items-center justify-center gap-[6px] w-full py-[8px] border-none bg-transparent text-[12.5px] whitespace-nowrap text-muted hover:bg-hover hover:text-orange-text"}>
      {PLUS_ICON}{label}
    </button>
  );
}

// 空态：图标块 + 一句话。表格用它套在边框里，卡片列表直接用。
function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-[8px] px-[18px] py-[26px]">
      <span className="w-[34px] h-[34px] flex-none rounded-[9px] bg-chip text-faint flex items-center justify-center">{EMPTY_ICON}</span>
      <div className="text-[12.5px] text-muted leading-[1.65] text-center [text-wrap:pretty]">{text}</div>
    </div>
  );
}

export function RowTable<T>({ rows, cols, onChange, blank, addLabel, emptyText, cell, scroll, extra }: {
  rows: T[];
  cols: TableCol[];
  onChange: (rows: T[]) => void;
  /** 新行长什么样。不给就没有「加一条」按钮（调用方自己提供添加入口，比如「选 App」） */
  blank?: () => T;
  addLabel?: string;
  emptyText: string;
  /** 一行渲染成几个单元格，顺序和 cols 一一对应 */
  cell: (row: T, i: number) => ReactNode[];
  /** 行区最大高度的 Tailwind 类（字面量），超了自己滚 */
  scroll?: string;
  /** 表格下面额外的入口（CSV 导入这类） */
  extra?: ReactNode;
}) {
  const { rowProps, handle, menuNode } = useRowOps(rows, onChange);
  return (
    <div className="border border-border rounded-[8px] overflow-hidden">
      {rows.length ? (
        <div className="flex items-center gap-[8px] px-[10px] py-[6px] bg-rail border-b border-border">
          <span className="w-[14px] flex-none" />
          {cols.map((col) => (
            <span key={col.label} className={`${col.cls} text-[11px] font-semibold tracking-[.06em] text-faint whitespace-nowrap overflow-hidden`}>{col.label}</span>
          ))}
        </div>
      ) : null}

      <div className={scroll || ""}>
        {rows.map((row, i) => {
          const cells = cell(row, i);
          return (
            <div key={i} {...rowProps(i)}
              className="flex items-center gap-[8px] px-[10px] py-[7px] border-b border-border-soft hover:bg-hover">
              {handle(i)}
              {cols.map((col, j) => <div key={col.label} className={col.cls}>{cells[j]}</div>)}
            </div>
          );
        })}
      </div>

      {!rows.length ? <Empty text={emptyText} /> : null}
      {blank ? (
        <div className={rows.length ? "border-t border-border-soft" : ""}>
          <AddRow label={addLabel || "加一条"} onClick={() => onChange([...rows, blank()])} />
        </div>
      ) : null}
      {extra}
      {menuNode}
    </div>
  );
}

// ── 卡片式列表 ──────────────────────────────────────────────────────────────
// 规则类的东西（条件分支、过滤、文件条件）不走表格：一条规则有两行内容
// （比较式一行、出口名一行），塞进表格的一行会挤成一条难读的长带子。
// 卡片之间用间距分隔，每张卡片自己是一个小方框，读起来是「一条一条」而不是「一片」。
export function CardList<T>({ rows, onChange, blank, addLabel, emptyText, card, tail }: {
  rows: T[];
  onChange: (rows: T[]) => void;
  blank: () => T;
  addLabel: string;
  emptyText: string;
  card: (row: T, i: number) => ReactNode;
  /** 卡片列表末尾固定挂的东西（条件分支的「兜底」那一条） */
  tail?: ReactNode;
}) {
  const { rowProps, handle, menuNode } = useRowOps(rows, onChange);
  return (
    <div className="flex flex-col gap-[9px]">
      {rows.map((row, i) => (
        <div key={i} {...rowProps(i)}
          className="flex items-start gap-[9px] border border-border rounded-[8px] p-[10px] hover:border-orange">
          {handle(i, true)}
          <div className="flex-1 min-w-0 flex flex-col gap-[8px]">{card(row, i)}</div>
        </div>
      ))}
      {!rows.length ? <div className="border border-border rounded-[8px]"><Empty text={emptyText} /></div> : null}
      <AddRow framed label={addLabel} onClick={() => onChange([...rows, blank()])} />
      {tail}
      {menuNode}
    </div>
  );
}

// 序号药丸。规则卡片左上角那颗，也用于「兜底」那条（用 dim 换成灰底）。
export function Pill({ children, dim }: { children: ReactNode; dim?: boolean }) {
  return (
    <span className={`flex-none whitespace-nowrap min-w-[22px] h-[22px] px-[6px] rounded-full text-[11px] font-semibold flex items-center justify-center ${dim ? "bg-chip text-faint" : "bg-orange-soft text-orange-text"}`}>{children}</span>
  );
}

// 表格里的单元格控件。比表单里的输入框小半号（padding 5/8），一行才塞得下三四列。
export const CELL = "w-full px-[8px] py-[5px] border border-border rounded-[8px] bg-bg text-text text-[12.5px] outline-none focus:border-orange";
export const CELL_MONO = "w-full px-[8px] py-[5px] border border-border rounded-[8px] bg-bg text-text text-[12px] font-mono outline-none focus:border-orange";

// 两个配置对象是否等价。用来判断「有没有未保存的改动」。
//
// 直接 JSON.stringify 比较是不行的：键序不同会误判成有改动（用户只是点开又关上，
// 而 React 的 setState 展开顺序和存盘时的顺序未必一致），于是每次关闭都弹一次确认。
// 所以按键名排序后再比，并且把 undefined 当成「没这个键」。
export function sameConfig(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (x === undefined && y === undefined) continue;
    if (JSON.stringify(x) !== JSON.stringify(y)) return false;
  }
  return true;
}

// 快捷键录制的三态按钮（设计稿 05 的「录制按钮三态」）。
// 空=虚线框，录制中=橙底 + 圆点，已录=chip 底等宽字。三态各配一句提示。
export function HotkeyField({ value, onChange, hint }: {
  value: string; onChange: (v: string) => void; hint?: ReactNode;
}) {
  const [rec, setRec] = useState(false);
  const ref = useRef(onChange);
  ref.current = onChange;

  useEffect(() => {
    if (!rec) return;
    recording++;   // 录制期间让 Dlg 的 Esc 让路
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setRec(false); return; }
      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;   // 只按修饰键不算录完
      const mods: string[] = [];
      if (e.metaKey) mods.push("Command"); if (e.ctrlKey) mods.push("Control");
      if (e.altKey) mods.push("Alt"); if (e.shiftKey) mods.push("Shift");
      const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
      ref.current([...mods, key].join("+"));
      setRec(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => { recording--; window.removeEventListener("keydown", onKey, true); };
  }, [rec]);

  const base = "flex-none whitespace-nowrap flex items-center gap-[7px] px-[13px] py-[6px] rounded-[8px] text-[12.5px]";
  return (
    <>
      <div className="flex items-center gap-[8px]">
        {rec ? (
          <button onClick={() => setRec(false)} className={`${base} border border-orange bg-orange-soft text-orange-text`}>
            <span className="w-[7px] h-[7px] rounded-full bg-orange flex-none" />按下快捷键…
          </button>
        ) : value ? (
          <button onClick={() => setRec(true)} className={`${base} border border-border bg-chip text-text font-mono`}>{value}</button>
        ) : (
          <button onClick={() => setRec(true)} className={`${base} border border-dashed border-border bg-transparent text-muted`}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>设置快捷键
          </button>
        )}
        {value && !rec ? (
          <button onClick={() => onChange("")}
            className="flex-none whitespace-nowrap px-[11px] py-[6px] border border-border rounded-[8px] text-[12px] bg-transparent hover:border-danger hover:text-danger">清除</button>
        ) : null}
      </div>
      <Hint>{rec ? "松手即录入，Esc 取消。" : value ? <>点按钮可以重录。{hint}</> : <>至少要带一个修饰键。{hint}</>}</Hint>
    </>
  );
}
