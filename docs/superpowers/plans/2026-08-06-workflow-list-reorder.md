# 工作流列表拖拽调序 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 左侧工作流列表支持手柄拖拽调序，松手落盘，搜索中禁用，不进 ⌘Z。

**Architecture:** 对齐 `PhrasesTool.tsx`：手柄发起 HTML5 DnD、中线换位、FLIP 让位动画；拖拽中只改 `wfs` 内存，`dragEnd` 用 `wfsRef.current` 调 `api.setWorkflows`。不抽公共 hook，不改主进程。

**Tech Stack:** React（`useLayoutEffect` + refs）、现有 `IconGrip`、HTML5 Drag and Drop

**Spec:** `docs/superpowers/specs/2026-08-06-workflow-list-reorder-design.md`

## Global Constraints

- 仅手柄发起拖拽；无文案、无 `title` 提示
- `wfQ.trim()` 非空时禁用拖拽
- 不调用 `commit()`，不进撤销/重做栈
- 只改 `WorkflowEditor.tsx`；不加依赖

---

### Task 1: 列表拖拽调序

**Files:**
- Modify: `src/features/launcher/WorkflowEditor.tsx`
- Amend docs already at: `docs/superpowers/specs/2026-08-06-workflow-list-reorder-design.md`（手柄无 title）

**Interfaces:**
- Consumes: `wfs` / `setWfs` / `wfsRef` / `wfQ` / `api.setWorkflows` / `IconGrip`
- Produces: 列表行可拖；`endDrag` 落盘

- [ ] **Step 1: 补 import 与常量**

在 icons import 中加入 `IconGrip`；`react` import 加入 `useLayoutEffect`；在文件常量区加 `const FLIP_MS = 180;`。

- [ ] **Step 2: 在 `WorkflowEditor` 内加入拖拽状态与逻辑**

在 `wfQ` state 附近加入（对齐 PhrasesTool）：

```ts
const canReorder = !wfQ.trim();
const [dragId, setDragId] = useState<string | null>(null);
const fromHandle = useRef(false);
const rowRefs = useRef(new Map<string, HTMLElement>());
const prevRects = useRef(new Map<string, DOMRect>());
const orderDirty = useRef(false);
const lockUntil = useRef(0);

const snapshot = () => {
  const m = new Map<string, DOMRect>();
  rowRefs.current.forEach((el, id) => m.set(id, el.getBoundingClientRect()));
  prevRects.current = m;
};

useLayoutEffect(() => {
  rowRefs.current.forEach((el, id) => {
    const before = prevRects.current.get(id);
    if (!before) return;
    const after = el.getBoundingClientRect();
    const dy = before.top - after.top;
    if (!dy) return;
    if (id === dragId) return;
    el.style.transition = "none";
    el.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => {
      el.style.transition = `transform ${FLIP_MS}ms cubic-bezier(.2,.7,.3,1)`;
      el.style.transform = "";
    });
  });
  prevRects.current.clear();
}, [wfs, dragId]);

const moveTo = (targetId: string, clientY: number) => {
  if (!canReorder || !dragId || dragId === targetId) return;
  if (Date.now() < lockUntil.current) return;
  const list = wfsRef.current;
  const from = list.findIndex((w) => w.id === dragId);
  const to = list.findIndex((w) => w.id === targetId);
  if (from < 0 || to < 0) return;
  const el = rowRefs.current.get(targetId);
  if (!el) return;
  const r = el.getBoundingClientRect();
  const mid = r.top + r.height / 2;
  if (to > from ? clientY < mid : clientY > mid) return;
  lockUntil.current = Date.now() + FLIP_MS;
  snapshot();
  const next = list.slice();
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  orderDirty.current = true;
  setWfs(next);
};

const endDrag = () => {
  setDragId(null);
  lockUntil.current = 0;
  fromHandle.current = false;
  if (orderDirty.current) {
    orderDirty.current = false;
    void api.setWorkflows(wfsRef.current);
  }
};
```

- [ ] **Step 3: 改写左侧列表行 JSX（约 1443–1474 行）**

外层由 `button` 改为 `div`（`role="button"` 可选），结构：

```tsx
<div className="flex-1 overflow-y-auto p-2 flex flex-col gap-px" onDragEnd={endDrag}>
  {wfList.map((w) => {
    const sel = w.id === curId;
    return (
      <div
        key={w.id}
        ref={(el) => { if (el) rowRefs.current.set(w.id, el); else rowRefs.current.delete(w.id); }}
        draggable={canReorder}
        onDragStart={(e) => {
          if (!canReorder || !fromHandle.current) { e.preventDefault(); return; }
          lockUntil.current = 0;
          setDragId(w.id);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", w.id);
        }}
        onDragEnd={endDrag}
        onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; moveTo(w.id, e.clientY); } }}
        onDrop={(e) => { e.preventDefault(); endDrag(); }}
        onClick={() => { setCurId(w.id); setSelNode(null); setSelConn(null); setSelSet([]); }}
        onContextMenu={(e) => {
          e.preventDefault(); e.stopPropagation();
          setCurId(w.id); setSelNode(null); setSelConn(null); setSelSet([]);
          setWfMenu({ x: e.clientX, y: e.clientY, id: w.id });
        }}
        className={`w-full flex items-center gap-[7px] px-[6px] py-[7px] rounded-[8px] text-[12.5px] cursor-pointer ${
          dragId === w.id ? "opacity-45 " : ""
        }${sel ? "bg-orange-soft text-orange-text font-semibold" : "bg-transparent text-text font-normal hover:bg-hover"}`}
      >
        <span
          onMouseDown={(e) => { if (!canReorder) return; e.stopPropagation(); fromHandle.current = true; }}
          onMouseUp={() => { fromHandle.current = false; }}
          className={`w-[12px] flex-none flex items-center justify-center ${
            canReorder ? "text-faint cursor-grab active:cursor-grabbing hover:text-orange-text" : "text-faint opacity-35 cursor-default"}`}
        >
          <IconGrip size={12} />
        </span>
        {/* 原有图标方块 / 名称描述 / 启停点 —— 图标方块可收至 22px */}
        ...
      </div>
    );
  })}
  ...
</div>
```

注意：手柄无 `title`、无旁侧文案。

- [ ] **Step 4: 手动验收**

按 spec 验收 1–5：无搜索拖拽落盘、点击/右键正常、搜索禁用、⌘Z 不回滚列表、顶底无闪烁。

- [ ] **Step 5: Commit**

```bash
git add src/features/launcher/WorkflowEditor.tsx \
  docs/superpowers/specs/2026-08-06-workflow-list-reorder-design.md \
  docs/superpowers/plans/2026-08-06-workflow-list-reorder.md
git commit -m "$(cat <<'EOF'
feat(工作流): 左侧列表支持手柄拖拽调序

对齐常用语：跟手重排 + FLIP；搜索中禁用；松手落盘且不进撤销栈。
EOF
)"
```
