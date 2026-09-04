// 独立图片查看窗的入口（批次 011）。正文就是通用 ImageViewer 的 window 变体，
// 内容通道走 largetype 同款范式：ready 索取 → 已开着时主进程直接推 viewer:data 换图。
import { useEffect, useRef, useState } from "react";
import { ImageViewer, type ViewerItem } from "../../components/ImageViewer";
import "../../styles/index.css";
import { mountApp } from "../../i18n/bootstrap";

interface ViewerAPI {
  ready(): Promise<{ items: ViewerItem[]; index: number } | null>;
  close(): Promise<void>;
  fit(w: number, h: number): Promise<void>;
  onData(cb: (p: { items: ViewerItem[]; index: number }) => void): () => void;
}
const api = (window as unknown as { umbraViewer: ViewerAPI }).umbraViewer;

function ViewerWindow() {
  const [data, setData] = useState<{ items: ViewerItem[]; index: number } | null>(null);
  // 窗口按图片比例适配**每个 payload 只做一次**（首图 load 时）：
  // 组内 ← → 切图、用户手动拉过窗之后，不再抢着改窗口尺寸。
  const fitDone = useRef(false);
  useEffect(() => {
    void api.ready().then((p) => { if (p) { fitDone.current = false; setData(p); } });
    return api.onData((p) => { fitDone.current = false; setData(p); });
  }, []);
  if (!data || !data.items.length) return null;
  const cur = data.items[Math.max(0, Math.min(data.index, data.items.length - 1))];
  return (
    <ImageViewer
      variant="window"
      src={cur.src}
      alt={cur.alt}
      items={data.items}
      onClose={() => void api.close()}
      onFit={(w, h) => { if (!fitDone.current) { fitDone.current = true; void api.fit(w, h); } }}
    />
  );
}

// 图片窗固定深底（--viewer-bg），主题不影响它，但组件树仍要 umbra-root 供 portal 落点。
document.documentElement.setAttribute("data-theme", "dark");
void mountApp(document.getElementById("viewer-root")!, (
  <div className="umbra-root"><ViewerWindow /></div>
));
