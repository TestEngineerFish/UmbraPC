// 大字显示浮层：把内容放大居中显示在半透明浮层里；自动适配字号，超长可滚动；点击/Esc 关闭。
interface LargeAPI { ready(): Promise<string>; rendered(): Promise<void>; close(): Promise<void>; onText(cb: (t: string) => void): () => void }
const api = (window as unknown as { umbraLarge: LargeAPI }).umbraLarge;

const style = document.createElement("style");
style.textContent = `
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;font-family:-apple-system,"SF Pro Display",system-ui,"Segoe UI",Roboto,sans-serif;}
  #large-root{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;cursor:default;}
  .panel{max-width:88vw;max-height:84vh;overflow:auto;padding:40px 56px;border-radius:28px;
    background:rgba(0,0,0,.82);box-shadow:0 30px 90px rgba(0,0,0,.5);backdrop-filter:blur(6px);}
  .panel::-webkit-scrollbar{width:8px;} .panel::-webkit-scrollbar-thumb{background:rgba(255,255,255,.25);border-radius:999px;}
  .txt{color:#fff;font-weight:600;text-align:center;line-height:1.18;white-space:pre-wrap;word-break:break-word;}
`;
document.head.appendChild(style);

const root = document.getElementById("large-root")!;
root.innerHTML = `<div class="panel"><div class="txt" id="lt-txt"></div></div>`;
const txt = document.getElementById("lt-txt") as HTMLDivElement;

// 二分搜索最大可容纳字号（宽度受 maxWidth 约束自动换行，按高度判定是否溢出）。
function fit(): void {
  const availW = Math.floor(window.innerWidth * 0.80);
  const availH = Math.floor(window.innerHeight * 0.74);
  txt.style.maxWidth = availW + "px";
  let lo = 16, hi = 300, best = 16;
  for (let i = 0; i < 9; i++) {
    const mid = (lo + hi) / 2;
    txt.style.fontSize = mid + "px";
    if (txt.scrollWidth <= availW && txt.scrollHeight <= availH) { best = mid; lo = mid; }
    else hi = mid;
  }
  txt.style.fontSize = Math.floor(best) + "px";
}

function show(text: string): void { txt.textContent = text || ""; fit(); void api.rendered(); }

api.onText(show);
void api.ready().then((t) => { if (t) show(t); });
window.addEventListener("resize", fit);
window.addEventListener("keydown", (e) => { if (e.key === "Escape") void api.close(); });
root.addEventListener("click", () => void api.close());
