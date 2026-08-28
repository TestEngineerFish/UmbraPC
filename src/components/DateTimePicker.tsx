// 自绘日期 / 时间 / 日期+时间选择器（批次 007 新稿，tokens.dateTimePicker + 通用组件页）。
// 替掉原生 date / time / datetime-local —— 原生是系统蓝的一套件，配色、圆角、语言、深色都不受控。
//
// 稿的骨架逐条照搬：
// - 字段 32 高 / 圆角 7 / --bg 底 / 14 线性前导图标（日期=日历、时间=时钟、日期+时间=日历带指针），
//   值走 tabular-nums，空值显示 --faint 占位；展开时描边转橙 + focusRing。
// - 浮层宽 240（date）/ 152（time）/ 394（datetime），圆角 11、shadowFloating（浮层级不是模态级），
//   字段下方 6px 左对齐、下方不够就上翻；顶条 34 = 待落值（含星期）+「今天 / 现在」快捷。
// - 日历：28 高格 / 圆角 7 / 恒 6 行 42 格切月不跳高 / 周一开头 / 邻月 --faint 可点跟着翻月 /
//   选中 --orange 实底白字 / **今天用描边加粗不用橙**（一屏两个橙分不清哪个是你选的）。
// - 时间：时、分两列平铺列表（不用滚轮），26 高行，分钟默认步进 5、要精确到分传 1；
//   打开把选中项滚到第 4 行，列不显示滚动条，列高刻意留半行当「还有」的提示。
// - 落值：date / time 点一下即落值并关闭；datetime 点「完成」一次落两段，中途关掉不留半个值。
// - 「清空」稿里只给可空字段；当前接入的五个字段（提醒时间 / 结束日期、周期首次 / 时间 / 结束）
//   全是必填，所以这版没有清空钮 —— 要接可空字段时再按稿加回底条左侧。
// - 浮层通过 createPortal 挂在 document.body（稿：「挂在窗口根上，弹窗壳的 overflow:hidden 裁不到」），
//   z-index 119 遮罩 / 120 面板，都在 Modal（z-50）之上；整块 no-drag，避开标题栏拖拽区。
//
// 稿里「字段可直接键入（↑↓ 调段 / Tab 换段）」这一条**这版没做**（segment 内联编辑要一套独立的
// 焦点状态机），先浮层优先；已记回流台账，别当成漏了。
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// ── 纯工具 ──────────────────────────────────────────────────────────────

const p2 = (n: number) => String(n).padStart(2, "0");

/** 今天的 'YYYY-MM-DD'（本地时区）。 */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 现在的 'HH:mm'。 */
function nowHm(): string {
  const d = new Date();
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 'YYYY-MM-DD' → 「周四」。非法给空串。 */
function weekdayOf(key: string): string {
  const p = (key || "").split("-").map(Number);
  if (p.length < 3 || Number.isNaN(p[0])) return "";
  return "周" + ["日", "一", "二", "三", "四", "五", "六"][new Date(p[0], p[1] - 1, p[2]).getDay()];
}

export type DtKind = "date" | "time" | "datetime";

// ── 字段 ────────────────────────────────────────────────────────────────

/** 三种字段共用的前导图标：日期=日历、时间=时钟、日期+时间=日历带指针（稿的三个 SVG）。 */
function LeadIcon({ kind }: { kind: DtKind }) {
  const common = {
    width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  if (kind === "time") {
    return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5l3.5 2" /></svg>;
  }
  return (
    <svg {...common}>
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M8 3v4" /><path d="M16 3v4" /><path d="M3 10h18" />
      {kind === "datetime" ? <path d="M12 14v2.5l2 1.2" /> : null}
    </svg>
  );
}

/**
 * 日期 / 时间字段 + 浮层。受控组件：值由外面给（date='YYYY-MM-DD'，time='HH:mm'），
 * 落值时机按稿 —— date / time 点一下、datetime 点「完成」—— 才回调 onCommit。
 * 宽度 / flex 由调用方用 className 给（稿里提醒的 datetime 占满行、周期的日期框 150 / 时间框 104）。
 */
export function DateTimeField({ kind, date = "", time = "", onCommit, className = "", minuteStep, invalid = false }: {
  kind: DtKind;
  date?: string;
  time?: string;
  onCommit: (v: { date: string; time: string }) => void;
  className?: string;
  /** 分钟列步进。稿：默认 5，要精确到分设 1。datetime 默认 1（提醒「再等 10 分钟」会产生任意分钟）。 */
  minuteStep?: number;
  /** 校验没过时红描边（三段式出错的第一段，红字由调用方在旁边给）。 */
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const text = kind === "time" ? time : kind === "date" ? date : (date && time ? `${date} ${time}` : "");
  const placeholder = kind === "time" ? "选择时间" : kind === "date" ? "选择日期" : "选择日期与时间";

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen(true)}
        className={`h-[32px] px-[10px] rounded-[7px] border bg-bg text-[12.5px] text-left cursor-pointer
          flex items-center gap-[7px] outline-none transition-[border-color,box-shadow] duration-[130ms] ease-out
          hover:border-orange focus:border-orange ${open ? "border-orange shadow-[var(--focus-ring)]" : ""} ${className}`}
        // 出错红描边走 style：border-danger 和 border-border 同属性，靠 className 顺序覆盖不可靠。
        style={invalid && !open ? { borderColor: "var(--danger)" } : undefined}
      >
        <span className="flex-none text-faint flex"><LeadIcon kind={kind} /></span>
        <span className={`flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis ${text ? "text-text" : "text-faint"}`}
          style={{ fontVariantNumeric: "tabular-nums" }}>
          {text || placeholder}
        </span>
      </button>
      {open ? (
        <Popover
          kind={kind}
          date={date}
          time={time}
          minuteStep={minuteStep ?? (kind === "datetime" ? 1 : 5)}
          anchor={btnRef.current}
          onClose={() => setOpen(false)}
          onCommit={(v) => { setOpen(false); onCommit(v); }}
        />
      ) : null}
    </>
  );
}

// ── 浮层 ────────────────────────────────────────────────────────────────

// 三种变体的浮层宽度（稿定值）。
const PANEL_W: Record<DtKind, number> = { date: 240, time: 152, datetime: 394 };
// 估算高度只用来判上翻，取稿演示的取值。
const PANEL_H: Record<DtKind, number> = { date: 322, time: 300, datetime: 322 };

function Popover({ kind, date, time, minuteStep, anchor, onClose, onCommit }: {
  kind: DtKind;
  date: string;
  time: string;
  minuteStep: number;
  anchor: HTMLElement | null;
  onClose: () => void;
  onCommit: (v: { date: string; time: string }) => void;
}) {
  const today = todayIso();
  // 草稿：浮层开着时改的都是它，字段在落值之前不动（稿的 commit 规则）。
  const [d, setD] = useState(date || (kind === "datetime" ? today : date));
  const [t, setT] = useState(time || "09:00");
  const seed = (date || today).split("-").map(Number);
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: seed[0], m: seed[1] - 1 });

  // Esc 关浮层并回滚未落的值（草稿本来就只在这层，关掉即回滚）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // 定位：字段下方 6px 左对齐，下方不够上翻，左右各留 8px。窗口一变尺寸直接收起 ——
  // 跟着重排不值当，重新点开只是一下。
  const [pos] = useState(() => {
    const r = anchor?.getBoundingClientRect();
    if (!r) return { left: 80, top: 80 };
    const w = PANEL_W[kind];
    const h = PANEL_H[kind];
    const flipUp = r.bottom + 6 + h > window.innerHeight - 8;
    return {
      left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)),
      top: flipUp ? Math.max(8, r.top - h - 6) : r.bottom + 6,
    };
  });
  useEffect(() => {
    window.addEventListener("resize", onClose);
    return () => window.removeEventListener("resize", onClose);
  }, [onClose]);

  const hh = (t || "09:00").split(":")[0];
  const mm = (t || "09:00").split(":")[1];

  /** 日历点一天：date 变体即落值关闭；datetime 只改草稿（邻月的点了跟着翻月）。 */
  const pickDay = (key: string, y: number, m: number) => {
    if (kind === "date") { onCommit({ date: key, time: t }); return; }
    setD(key); setYm({ y, m });
  };

  /** 时间列点一格：time 变体即落值关闭；datetime 只改草稿。 */
  const pickTime = (next: string) => {
    if (kind === "time") { onCommit({ date: d, time: next }); return; }
    setT(next);
  };

  /** 顶条快捷：「今天 / 现在」。date/time 直接落值；datetime 只把草稿拨到当下（还要点完成）。 */
  const quick = () => {
    if (kind === "date") { onCommit({ date: today, time: t }); return; }
    if (kind === "time") { onCommit({ date: d, time: nowHm() }); return; }
    setD(today); setT(nowHm());
    const s = today.split("-").map(Number);
    setYm({ y: s[0], m: s[1] - 1 });
  };

  const pending = kind === "time"
    ? (t || "未选时间")
    : d ? `${d} ${weekdayOf(d)}${kind === "datetime" ? ` ${t}` : ""}` : "未选日期";

  const panel = (
    <>
      {/* 遮罩：点空白关。z-119 在 Modal（z-50）之上、面板（z-120）之下。 */}
      <div className="fixed inset-0 z-[119]" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties} onMouseDown={onClose} />
      <div
        className="fixed z-[120] bg-card border border-border rounded-[11px] shadow-[shadow:var(--shadow-floating)] overflow-hidden"
        style={{ left: pos.left, top: pos.top, width: PANEL_W[kind], WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {/* 顶条 34：待落值（tabular）+ 快捷。 */}
        <div className="flex items-center gap-[8px] h-[34px] pl-[12px] pr-[8px] border-b border-border-soft">
          <span className="flex-1 min-w-0 text-[12.5px] whitespace-nowrap overflow-hidden text-ellipsis"
            style={{ fontWeight: 560, fontVariantNumeric: "tabular-nums" }}>{pending}</span>
          <button onClick={quick}
            className="flex-none flex items-center h-[22px] px-[8px] rounded-[6px] bg-transparent text-[11.5px] text-muted cursor-pointer whitespace-nowrap hover:bg-hover hover:text-orange-text">
            {kind === "time" ? "现在" : "今天"}
          </button>
        </div>
        <div className="flex items-stretch">
          {kind !== "time" ? (
            <Calendar y={ym.y} m={ym.m} sel={d} today={today}
              onNav={(y, m) => setYm({ y, m })} onPick={pickDay} />
          ) : null}
          {kind !== "date" ? (
            <TimeColumns hh={hh} mm={mm} minuteStep={minuteStep} tall={kind === "datetime"}
              divided={kind === "datetime"} onPick={pickTime} />
          ) : null}
        </div>
        {kind === "datetime" ? (
          // datetime 底条 44：一次改两段，中途关掉不留半个值。（「清空」只给可空字段，这里是必填，没有。）
          <div className="flex items-center gap-[8px] h-[44px] px-[12px] border-t border-border-soft bg-rail">
            <span className="flex-1 min-w-0" />
            <button onClick={onClose}
              className="flex-none flex items-center h-[28px] px-[12px] rounded-[7px] bg-card border border-border text-[12px] text-muted cursor-pointer whitespace-nowrap hover:border-orange hover:text-orange-text">取消</button>
            <button onClick={() => onCommit({ date: d, time: t })}
              className="flex-none flex items-center h-[28px] px-[14px] rounded-[7px] bg-orange text-white text-[12px] cursor-pointer whitespace-nowrap hover:bg-orange-deep border-none"
              style={{ fontWeight: 560 }}>完成</button>
          </div>
        ) : (
          <div className="flex items-center gap-[8px] h-[38px] px-[10px] border-t border-border-soft">
            <button onClick={onClose}
              className="flex-none flex items-center h-[24px] px-[8px] rounded-[6px] bg-transparent text-[11.5px] text-muted cursor-pointer whitespace-nowrap hover:bg-hover hover:text-text">取消</button>
            <span className="flex-1 min-w-0 text-[11px] text-faint whitespace-nowrap text-right">点一下即落值</span>
          </div>
        )}
      </div>
    </>
  );
  // 挂在窗口根上（稿）：弹窗壳的 overflow:hidden 裁不到它。
  return createPortal(panel, document.body);
}

// ── 日历（240 宽，恒 6 行）─────────────────────────────────────────────

function Calendar({ y, m, sel, today, onNav, onPick }: {
  y: number; m: number; sel: string; today: string;
  onNav: (y: number, m: number) => void;
  onPick: (key: string, y: number, m: number) => void;
}) {
  interface Cell { key: string; label: number; other: boolean; y: number; m: number }
  const cells: Cell[] = [];
  const push = (yy: number, mm: number, day: number, other: boolean) =>
    cells.push({ key: `${yy}-${p2(mm + 1)}-${p2(day)}`, label: day, other, y: yy, m: mm });
  // 周一开头（稿）：getDay() 周日=0，挪成周一=0。
  const firstDow = (new Date(y, m, 1).getDay() + 6) % 7;
  const prevLen = new Date(y, m, 0).getDate();
  for (let i = firstDow; i > 0; i--) push(m === 0 ? y - 1 : y, m === 0 ? 11 : m - 1, prevLen - i + 1, true);
  const len = new Date(y, m + 1, 0).getDate();
  for (let day = 1; day <= len; day++) push(y, m, day, false);
  for (let day = 1; cells.length < 42; day++) push(m === 11 ? y + 1 : y, m === 11 ? 0 : m + 1, day, true);

  return (
    <div className="flex-none w-[240px]">
      <div className="flex items-center gap-[2px] pt-[8px] pr-[8px] pl-[12px]">
        <span className="flex-1 min-w-0 text-[12.5px] font-semibold whitespace-nowrap">{y}年{m + 1}月</span>
        {([["prev", "M15 18l-6-6 6-6"], ["next", "M9 6l6 6-6 6"]] as const).map(([k, path]) => (
          <button key={k}
            onClick={() => { const nm = k === "prev" ? m - 1 : m + 1; onNav(nm < 0 ? y - 1 : nm > 11 ? y + 1 : y, (nm + 12) % 12); }}
            className="flex-none flex items-center justify-center w-[22px] h-[22px] rounded-[6px] bg-transparent text-muted cursor-pointer hover:bg-hover hover:text-orange-text">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-[2px] pt-[6px] pb-[2px] px-[10px]">
        {["一", "二", "三", "四", "五", "六", "日"].map((w) => (
          <span key={w} className="flex items-center justify-center h-[18px] text-[11px] text-faint">{w}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-[2px] px-[10px] pb-[10px]">
        {cells.map((c) => {
          const on = c.key === sel;
          const isToday = c.key === today;
          // 选中 = 橙实底白字；今天 = 描边 + 650 字重，**不用橙** —— 一屏两个橙分不清哪个是你选的。
          const skin = on
            ? "bg-orange text-white font-semibold hover:bg-orange-deep border-transparent"
            : c.other
              ? "bg-transparent text-faint hover:bg-hover border-transparent"
              : isToday
                ? "bg-transparent text-text border-border hover:bg-hover"
                : "bg-transparent text-text hover:bg-hover border-transparent";
          return (
            <button key={c.key} onClick={() => onPick(c.key, c.y, c.m)}
              className={`flex items-center justify-center h-[28px] border rounded-[7px] text-[12.5px] cursor-pointer transition-colors duration-[120ms] ${skin}`}
              style={{ fontVariantNumeric: "tabular-nums", fontWeight: !on && isToday ? 650 : undefined }}>
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── 时间两列（时 / 分，平铺列表不用滚轮）───────────────────────────────

function TimeColumns({ hh, mm, minuteStep, tall, divided, onPick }: {
  hh: string; mm: string; minuteStep: number; tall: boolean; divided: boolean;
  onPick: (t: string) => void;
}) {
  // 分钟列按步进铺；当前值不在格点上（「再等 10 分钟」会产生 14:37）就按序插进去，不然选中态没处落。
  const mins: string[] = [];
  for (let i = 0; i < 60; i += Math.max(1, minuteStep)) mins.push(p2(i));
  if (!mins.includes(mm)) { mins.push(mm); mins.sort(); }
  const hours = Array.from({ length: 24 }, (_, i) => p2(i));

  /** 打开时把选中项滚到第 4 行；行距 28 = 26 行高 + 2 间隙。只在首次挂载做，之后不抢用户的滚动。 */
  const initScroll = (idx: number) => (node: HTMLDivElement | null) => {
    if (!node || node.dataset.dtInit) return;
    node.dataset.dtInit = "1";
    node.scrollTop = Math.max(0, (idx - 3) * 28);
  };

  const col = (head: string, list: string[], cur: string, make: (v: string) => string) => (
    <div className="flex-1 min-w-0 flex flex-col gap-[4px]">
      <span className="text-[11px] text-faint text-center">{head}</span>
      {/* 列高刻意留半行（190/216 对 28 行距），露出的半行就是「还有」的提示；不显示滚动条。 */}
      <div ref={initScroll(list.indexOf(cur))} data-thin="1"
        className={`${tall ? "h-[216px]" : "h-[190px]"} overflow-auto flex flex-col gap-[2px]`}
        style={{ scrollbarWidth: "none" }}>
        {list.map((v) => {
          const on = v === cur;
          return (
            <button key={v} onClick={() => onPick(make(v))}
              className={`flex-none flex items-center justify-center h-[26px] rounded-[6px] text-[12px] cursor-pointer border-none transition-colors duration-[120ms]
                ${on ? "bg-orange text-white font-semibold hover:bg-orange-deep" : "bg-transparent text-text hover:bg-hover"}`}
              style={{ fontVariantNumeric: "tabular-nums" }}>
              {v}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className={`flex-1 min-w-0 flex gap-[6px] pt-[8px] px-[12px] pb-[10px] ${divided ? "border-l border-border-soft" : ""}`}>
      {col("时", hours, hh, (v) => `${v}:${mm}`)}
      {col("分", mins, mm, (v) => `${hh}:${v}`)}
    </div>
  );
}
