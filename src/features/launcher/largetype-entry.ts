// 大字显示浮层：把内容放大居中显示在半透明浮层里；自动适配字号，超长可滚动；点击/Esc 关闭。
interface LargeAPI {
  ready(): Promise<string>; rendered(): Promise<void>; close(): Promise<void>;
  onText(cb: (t: string) => void): () => void;
  onClear(cb: () => void): () => void;
}
const api = (window as unknown as { umbraLarge: LargeAPI }).umbraLarge;

const style = document.createElement("style");
style.textContent = `
  /* 永远是黑底白字的浮层，固定按深色渲染原生件（滚动条、文本选中色）。 */
  html,body{color-scheme:dark;margin:0;height:100%;background:transparent;overflow:hidden;font-family:-apple-system,"SF Pro Display",system-ui,"Segoe UI",Roboto,sans-serif;}
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

// 画好之后**等两帧**再告诉主进程可以显示了：textContent 一改 DOM 就更新，但合成器
// 手里那帧还是旧的（或者空的）。第一帧 rAF 排布局，第二帧才是真的画上去 ——
// 主进程在这之前 show 窗口，屏幕上先出现的就是上次的字（sam 第二轮实锤）。
// 窗口此刻是藏着的，rAF 在不可见页面上可能不跑（主进程已把这个窗设成不节流，但仍给一条
// 60ms 的保底定时器，谁先到谁算 —— 宁可偶尔多等一帧，也不能让窗永远不显示）。
function show(text: string): void {
  txt.textContent = text || "";
  fit();
  let done = false;
  const fire = () => { if (done) return; done = true; void api.rendered(); };
  requestAnimationFrame(() => requestAnimationFrame(fire));
  setTimeout(fire, 60);
}

api.onText(show);
// 收起时清空：下次显示前 DOM 里不留上次的字，最坏也只闪一下空白。
api.onClear(() => { txt.textContent = ""; });
void api.ready().then((t) => { if (t) show(t); });
window.addEventListener("resize", fit);
window.addEventListener("keydown", (e) => { if (e.key === "Escape") void api.close(); });
root.addEventListener("click", () => void api.close());
