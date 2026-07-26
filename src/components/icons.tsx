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
