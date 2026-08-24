// 线性图标集：统一 24×24 viewBox、无填充、描边取 currentColor，所以颜色跟着父级 color 走，浅深模式不用各配一套。
// 取自 Claude Design 设计稿，用来替换界面里原先的 emoji（emoji 在 Windows / macOS 上字形与基线都不一致，排版对不齐）。
import type { SVGProps } from "react";

// 所有图标共用的属性：size 控制边长（设计稿里工具二级目录用 14，一级导航用 17），其余属性透传给 <svg>。
type IconProps = Omit<SVGProps<SVGSVGElement>, "width" | "height"> & { size?: number };

// 描边类图标的公共属性，抽出来避免每个图标重复一遍。
function base({ size = 14, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...rest,
  };
}

// 剪贴板历史：写字板轮廓 + 顶部夹子 + 两行文本。
export function IconClip(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4V3h6v1M9 10h6M9 14h4" />
    </svg>
  );
}

// 截图：四角取景框 + 中心圆。
export function IconShot(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M20 8V6a2 2 0 0 0-2-2h-2M4 16v2a2 2 0 0 0 2 2h2M20 16v2a2 2 0 0 1-2 2h-2" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

// 快捷入口：火箭。
export function IconRocket(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M9 15l-3-3c4-7 9-9 13-9 0 4-2 9-9 13z" />
      <path d="M9 15H6v3M9 15l3 3v3" />
    </svg>
  );
}

// 工作流编排：两个节点方块 + 一条折线连接。
export function IconFlow(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="3" y="4" width="7" height="6" rx="1.5" />
      <rect x="14" y="14" width="7" height="6" rx="1.5" />
      <path d="M10 7h3a2 2 0 0 1 2 2v5" />
    </svg>
  );
}

// 常用语：对话气泡 + 省略号。
export function IconPhrase(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M21 11.5a8.4 8.4 0 0 1-11.9 7.6L4 20l1-4.6A8.4 8.4 0 1 1 21 11.5z" />
      <path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" />
    </svg>
  );
}

// 密码保险箱：挂锁。
export function IconLock(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2" />
    </svg>
  );
}

// 删除：垃圾桶。
export function IconTrash(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
    </svg>
  );
}

// 搜索：放大镜。
export function IconSearch(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4.3-4.3" />
    </svg>
  );
}

// 警告：三角感叹号，用在冲突/待授权这类需要提醒但不阻断的横幅上。
export function IconAlert(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 3.5 21.5 20h-19z" />
      <path d="M12 10v4M12 17h.01" />
    </svg>
  );
}

// 上移 / 下移：列表调序用的小箭头。
export function IconUp(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M6 14.5 12 8.5l6 6" />
    </svg>
  );
}
export function IconDown(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M6 9.5 12 15.5l6-6" />
    </svg>
  );
}

// 复制：前后两张卡片错位叠放。
export function IconCopy(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
    </svg>
  );
}

// 显示 / 隐藏密码：睁眼与划一道斜杠的闭眼。
export function IconEye(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}
export function IconEyeOff(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M10.6 6.7A9.9 9.9 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a18 18 0 0 1-3.2 4M6.4 8.2A17.6 17.6 0 0 0 2 12s3.6 6.5 10 6.5c1.4 0 2.6-.2 3.7-.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
    </svg>
  );
}

// 收藏星标。默认是空心描边；传 fill="currentColor" 即得到实心态（base 把 ...rest 放在最后，可覆盖 fill）。
export function IconStar(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="m12 4 2.5 5.2 5.5.8-4 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4-3.9 5.5-.8z" />
    </svg>
  );
}

// 钥匙：Secret Key 相关页面的主图标。
export function IconKey(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9M17 12v4M20 12v3" />
    </svg>
  );
}

// 更多操作：三个实心点（描边画不出小圆点，这里单独给 fill）。
export function IconDots(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="5.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

// 关闭 / 移除。
export function IconX(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

// 折角箭头：右用于「已选中」的行尾指示，下用于下拉触发器。
// 拖拽手柄（可排序列表的行首）。三道短横是这个交互的通用符号，一眼就知道能拖。
export function IconGrip(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M7 7h10M7 12h10M7 17h10" />
    </svg>
  );
}

// 直箭头（灵感详情「让 Umbra 去做这件事」这类行动号召用，比 chevron 更有推进感）。
export function IconArrowRight(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

// 运行（工作流编辑器顶栏）。线性三角，和其余描边图标同一套观感，不用实心播放键。
export function IconPlay(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M7 4.5v15l13-7.5z" />
    </svg>
  );
}

export function IconChevronRight(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />
    </svg>
  );
}
export function IconChevronDown(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="m5.5 9.5 6.5 6.5 6.5-6.5" />
    </svg>
  );
}

// 新增：加号。
export function IconPlus(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

// 下载 / 导出到本地文件。
export function IconDownload(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14" />
    </svg>
  );
}

// 在外部打开（浏览器里打开网址）。
export function IconExternal(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M14 4h6v6M20 4l-8.5 8.5" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </svg>
  );
}

// 拉到独立窗口：窗口外框 + 标题栏一横。
export function IconWindow(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M3 9h18" />
    </svg>
  );
}

// 文件（附件列表用）。
export function IconFile(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

// 编辑：铅笔。
export function IconPencil(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
      <path d="m15 6 3 3" />
    </svg>
  );
}

// 勾选：确认态、已选中的菜单项。
export function IconCheck(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

// 重新生成 / 换一个：环形箭头。
export function IconRefresh(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4h-4" />
    </svg>
  );
}

// Touch ID / 生物识别：指纹的三道弧线。
export function IconTouchId(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 4.5a7.5 7.5 0 0 0-7.5 7.5v2.5" />
      <path d="M19.5 12a7.5 7.5 0 0 0-3.2-6.1M8 19.5A9 9 0 0 0 9.5 15v-3a2.5 2.5 0 0 1 5 0v3" />
      <path d="M12 12v3.5a8 8 0 0 1-.7 3.3" />
    </svg>
  );
}

// 云同步。
export function IconCloud(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M7 18h10a4 4 0 0 0 .6-8A6 6 0 0 0 6 11.2 3.4 3.4 0 0 0 7 18z" />
    </svg>
  );
}

// 全部 / 网格视图：四个小方块。
export function IconGrid(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  );
}

// 账号控件：人像。
export function IconUser(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 19.5a7 7 0 0 1 14 0" />
    </svg>
  );
}

// 字段控件：标签牌。
export function IconTag(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M11 3H4v7l10 10 7-7L11 3z" />
      <path d="M7.5 7.5h.01" />
    </svg>
  );
}

// 文本控件：几行文字。
export function IconText(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M5 6h14M5 11h14M5 16h9" />
    </svg>
  );
}

// 图片控件：相框 + 山与太阳。
export function IconImage(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m5 17 4.5-4.5 3.5 3.5 2.5-2.5L20 17" />
    </svg>
  );
}

// 浅色模式：太阳（圆心 + 八条光芒）。用于保险箱独立窗口右上角的深浅色切换。
export function IconSun(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
    </svg>
  );
}

// 深色模式：月牙。与 IconSun 成对，切换按钮上二选一显示。
export function IconMoon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M20 13.5A8 8 0 0 1 10.5 4a8 8 0 1 0 9.5 9.5Z" />
    </svg>
  );
}

// 骰子：密码生成器入口。六个点用实心小圆，描边画不出点。
export function IconDice(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <circle cx="9" cy="9" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="9" cy="15" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  );
}

// 文件夹：保险箱左栏「新建分组」与类型行的兜底图标。
export function IconFolder(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M3.5 7a2 2 0 0 1 2-2h3.2l2 2.4h7.8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

// 撤销：向左的回环箭头（工作流编辑器顶栏）。
export function IconUndo(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h9a7 7 0 0 1 0 14H8" />
    </svg>
  );
}

// 重做：撤销的镜像。
export function IconRedo(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9h-9a7 7 0 0 0 0 14h5" />
    </svg>
  );
}

// 调试：瓢虫轮廓（工作流编辑器的执行轨迹抽屉）。
export function IconBug(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M8 4h8M12 4v3" />
      <rect x="6" y="7" width="12" height="13" rx="6" />
      <path d="M6 12H3M21 12h-3M6.5 17 4 19M17.5 17 20 19M6.5 9 4 7M17.5 9 20 7" />
    </svg>
  );
}

// 侧栏面板：矩形右侧一道竖线，表示「右边那一列」（对象库开关）。
export function IconPanel(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </svg>
  );
}

// ── 以下为工作流对象清单用的图标：每个节点类型都要有一个线性图标（画布节点头部、右键菜单、对象库共用一套）。

// 键盘：Keyword 触发 / Dispatch Key Combo。
export function IconKeyboard(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h2M11 10h2M16 10h2M8 14h8" />
    </svg>
  );
}

// ⌘ 符号轮廓：全局热键。
export function IconCommand(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M9 9h6v6H9z" />
      <path d="M9 9V7a2 2 0 1 0-2 2zM15 9V7a2 2 0 1 1 2 2zM9 15v2a2 2 0 1 1-2-2zM15 15v2a2 2 0 1 0 2-2z" />
    </svg>
  );
}

// 无穷符号：兜底触发（怎么都跑）。
export function IconInfinity(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M7 9a3 3 0 0 0 0 6c2 0 3-2 5-3s3-3 5-3a3 3 0 0 1 0 6c-2 0-3-2-5-3S9 9 7 9Z" />
    </svg>
  );
}

// 准心：Universal Action（选中即用）。
export function IconTarget(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  );
}

// 剪刀：Snippet 片段 / Split 拆分。
export function IconScissors(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="6" cy="18" r="2.4" />
      <circle cx="6" cy="6" r="2.4" />
      <path d="M8 7.5 20 18M8 16.5 20 6" />
    </svg>
  );
}

// 手机：远程触发（手机点一下跑桌面工作流）。
export function IconPhone(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="7" y="2.5" width="10" height="19" rx="2.4" />
      <path d="M11 18.5h2" />
    </svg>
  );
}

// 列表：List Filter / 全选。
export function IconList(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01" />
    </svg>
  );
}

// 尖括号：编解码 / 文本变换 / 脚本类。
export function IconCode(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="m9 8-4 4 4 4M15 8l4 4-4 4" />
    </svg>
  );
}

// 计算器：计算器输入。
export function IconCalc(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M8 7h8M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 16h.01M12 16h.01M15.5 16h.01" />
    </svg>
  );
}

// 三角尺：单位换算。
export function IconRuler(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 20V6l14 14H4Z" />
      <path d="M8 16v-2M11 17v-2M14 18v-2" />
    </svg>
  );
}

// 书：词典查询 / 大字显示。
export function IconBook(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v18H6.5A1.5 1.5 0 0 1 5 19.5Z" />
      <path d="M5 17h14" />
    </svg>
  );
}

// 分叉：Conditional 条件分流 / Junction 汇流。
export function IconBranch(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M7 4v7a4 4 0 0 0 4 4h6" />
      <path d="m14 12 3 3-3 3" />
      <path d="M7 15v5" />
    </svg>
  );
}

// 时钟：Delay 延时 / 定时。
export function IconClock(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

// 链环：Join 合并 / 打开网址类的连接语义。
export function IconLink(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1" />
      <path d="M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" />
    </svg>
  );
}

// 漏斗：Filter 过滤。
export function IconFilter(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 5h16l-6 7v7l-4-2v-5Z" />
    </svg>
  );
}

// 地球：打开网址 / 网页搜索。
export function IconGlobe(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.4 2.4 14.6 0 17M12 3.5c-2.4 2.4-2.4 14.6 0 17" />
    </svg>
  );
}

// 终端：Run Script / 终端命令。
export function IconTerminal(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 10 2.5 2L7 14M12.5 14H17" />
    </svg>
  );
}

// 对话气泡：发给秘书 / 问秘书。
export function IconChat(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M20 12a7.5 7.5 0 0 1-7.5 7.5H8l-4 2.5.9-4.2A7.5 7.5 0 0 1 12.5 4.5A7.5 7.5 0 0 1 20 12Z" />
    </svg>
  );
}

// 灯泡：记为灵感。
export function IconBulb(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M9 17h6M10 20.5h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9V17h7v-3.1A6 6 0 0 0 12 3Z" />
    </svg>
  );
}

// 日历：建任务 / 定时。
export function IconCalendar(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}

// 齿轮：自动化任务 / 快捷指令。
export function IconGear(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.4M12 18.8v2.4M4.5 7.6l2 1.2M17.5 15.2l2 1.2M4.5 16.4l2-1.2M17.5 8.8l2-1.2" />
    </svg>
  );
}

// 音符：音乐控制。
export function IconMusic(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="7" cy="17.5" r="2.6" />
      <circle cx="17" cy="15.5" r="2.6" />
      <path d="M9.6 17.5V6l9.8-2v11.5" />
    </svg>
  );
}

// 铃铛：系统通知。
export function IconBell(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M10.3 21a2 2 0 0 0 3.4 0" />
    </svg>
  );
}

// 音量：朗读 / 播放提示音。
export function IconVolume(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M11 5 6.5 9H3v6h3.5L11 19Z" />
      <path d="M15 9.5a3.5 3.5 0 0 1 0 5M17.8 7a7 7 0 0 1 0 10" />
    </svg>
  );
}

// 减号：画布缩放胶囊的「缩小」。
export function IconMinus(p: IconProps) {
  return (
    <svg {...base(p)} strokeWidth={2.2}>
      <path d="M5 12h14" />
    </svg>
  );
}

// 四角内收：画布缩放胶囊的「适应画布」。
export function IconFit(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />
    </svg>
  );
}

// ── 设置页二级目录用的图标（取自 ClaudeDesign 的设置稿）──

// 滑杆：设置 → 通用。
export function IconSliders(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2.2" />
      <circle cx="8" cy="17" r="2.2" />
    </svg>
  );
}

// 插头：设置 → 连接。
export function IconPlug(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0zM12 18v3" />
    </svg>
  );
}

// 芯片：设置 → 设备与引擎。
export function IconCpu(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M4 10v4M20 10v4M10 4h4M10 20h4" />
    </svg>
  );
}

// 盾牌：设置 → 权限。
export function IconShield(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 3l7 3v6c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6z" />
    </svg>
  );
}

// 鼠标：设置 → 电脑操作授权。
export function IconMouse(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="7" y="3" width="10" height="18" rx="5" />
      <path d="M12 7v3" />
    </svg>
  );
}

// 信息：设置 → 关于。
export function IconInfo(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

// ── 能力页的 provider 图标 ────────────────────────────────────────────────────
// 取值逐个照抄设计稿（Umbra PC 端.dc.html 1842 / 1856 / 1882 / 1895 四行的 <svg> 内容）。
// 之前这五张卡共用一个字符「▤」，撞了「图标只用线性描边，不用填充图标、彩色图标、emoji」
// 这条硬规则 —— 字符图标的字形和基线在 Windows / macOS 上都不一样，排版也对不齐。
// 稿里第三张（系统）用的形状和已有的 IconWindow 完全一致，就不再重复定义了。

// Claude Code：一对尖括号 + 中间一道斜杠。
export function IconBrackets(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13 5l-2 14" />
    </svg>
  );
}

// Codex：裸终端提示符（不带外框，跟 IconTerminal 的带框版是两回事）。
export function IconPrompt(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 17l6-6-6-6M12 19h8" />
    </svg>
  );
}

// FFmpeg：摄像机 —— 机身 + 右侧镜筒。
export function IconVideo(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="m22 8-6 4 6 4V8z" />
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </svg>
  );
}

// 电脑操作：显示器 + 底座。实时操作页的空态也用它（稿 1928 同一张）。
export function IconMonitor(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

// 停止：圆角方块。用于实时操作的紧急停止（稿 1921，描边 2.2）。
export function IconStop(p: IconProps) {
  return (
    <svg {...base(p)} strokeWidth={2.2}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

// 记账：钱包/账本轮廓 + 中缝线 + 两个记账位。取自稿一级导航 MODULES 的记账项。
export function IconWallet(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d="M4 10h16M9 15h2M15 15h.01" />
    </svg>
  );
}
