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
