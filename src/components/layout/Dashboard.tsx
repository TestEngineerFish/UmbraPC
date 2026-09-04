// T4 仪表盘（批次 012 · tokens.pageTemplate.dashboard）。
// 记账统计 / 电脑操作 / 运行时套它：卡片网格一档 flex:1 1 300px; min-width:280px + wrap；
// 图表区高 220、迷你趋势 64（页面自己画图，这里只给容器）；状态卡 --card + 1px + 圆角 12 +
// padding 15/17；底栏合计 40 高 / --rail / tabular-nums；单卡取不到数在卡内写一行，不用整页空态。
import React from "react";
import { useTranslation } from "react-i18next";

/** T4 的滚动容器：padding 18/22。 */
export function Dashboard({ children, footer }: { children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-[18px_22px_28px] flex flex-col gap-[16px]">{children}</div>
      </div>
      {footer ? <FooterTotal>{footer}</FooterTotal> : null}
    </>
  );
}

/** 卡片网格：子项 flex:1 1 300px; min-width:280px。 */
export function CardGrid({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-[12px] [&>*]:flex-[1_1_300px] [&>*]:min-w-[280px]">{children}</div>;
}

/** 仪表盘卡：--card + 1px --border + 圆角 12 + padding 15/17。empty 时卡内一行「这段时间没有数据」。 */
export function DashCard({ title, aside, empty, children }: { title?: React.ReactNode; aside?: React.ReactNode; empty?: boolean; children?: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <section className="bg-card border border-border rounded-[12px] px-[17px] py-[15px] flex flex-col gap-[10px] min-w-0">
      {title || aside ? (
        <div className="flex items-center gap-[8px]">
          {title ? <span className="flex-1 min-w-0 truncate text-[12.5px] font-semibold">{title}</span> : <span className="flex-1" />}
          {aside}
        </div>
      ) : null}
      {empty ? <span className="text-[12px] text-faint">{t("layout.cardEmpty")}</span> : children}
    </section>
  );
}

/** 状态卡：左状态点 + 图标文字，右动作。 */
export function StatusCard({ dot, icon, title, sub, actions }: {
  dot?: "success" | "warning" | "danger" | "faint";
  icon?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const dotCls = dot === "success" ? "bg-success" : dot === "warning" ? "bg-warning" : dot === "danger" ? "bg-danger" : "bg-faint";
  return (
    <section className="bg-card border border-border rounded-[12px] px-[17px] py-[15px] flex items-center gap-[12px] min-w-0">
      {dot ? <span className={`w-[7px] h-[7px] flex-none rounded-full ${dotCls}`} /> : null}
      {icon ? <span className="flex-none flex text-muted">{icon}</span> : null}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold truncate">{title}</div>
        {sub ? <div className="text-[11.5px] text-faint mt-[2px] leading-[1.55]">{sub}</div> : null}
      </div>
      {actions ? <span className="flex-none flex items-center gap-[8px]">{actions}</span> : null}
    </section>
  );
}

/** 底栏合计：40 高 / --rail 底 / 上边 1px / tabular-nums。 */
export function FooterTotal({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-none h-[40px] flex items-center gap-[14px] px-[22px] bg-rail border-t border-border text-[12px] text-muted [font-variant-numeric:tabular-nums] whitespace-nowrap">
      {children}
    </div>
  );
}
