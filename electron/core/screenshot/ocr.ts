// 截图 OCR + 翻译（无 Rust 方案）。
// OCR：macOS 用 osascript -l JavaScript(JXA) 桥接 Vision 框架；翻译：PC 直连智谱 GLM。
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface OcrResult {
  ok: boolean;
  text?: string;
  error?: string;
}

// 把 dataURL 落成临时 PNG。
async function dataUrlToTemp(dataUrl: string): Promise<string> {
  const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
  const file = path.join(os.tmpdir(), `umbra-ocr-${Date.now()}.png`);
  await fs.writeFile(file, Buffer.from(b64, "base64"));
  return file;
}

// JXA + Vision 脚本（精确模式 + 语言校正，语言优先级 zh-Hans/zh-Hant/ja/en）。
const JXA = `
ObjC.import('Vision');
ObjC.import('AppKit');
function run() {
  var p = $.NSProcessInfo.processInfo.environment.objectForKey('UMBRA_OCR_PATH').js;
  var img = $.NSImage.alloc.initWithContentsOfFile(p);
  if (!img) return 'UMBRA_ERR:图像加载失败';
  var tiff = img.TIFFRepresentation;
  var rep = $.NSBitmapImageRep.imageRepWithData(tiff);
  var cg = rep.CGImage;
  var req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = 1;
  req.usesLanguageCorrection = true;
  req.recognitionLanguages = $(['zh-Hans','zh-Hant','ja','en']);
  var handler = $.VNImageRequestHandler.alloc.initWithCGImageOptions(cg, $({}));
  var ok = handler.performRequestsError($([req]), null);
  if (!ok) return 'UMBRA_ERR:识别失败';
  var results = req.results;
  var out = [];
  for (var i = 0; i < results.count; i++) {
    var obs = results.objectAtIndex(i);
    var cand = obs.topCandidates(1);
    if (cand.count > 0) out.push(cand.objectAtIndex(0).string.js);
  }
  return out.join('\\n');
}
`;

export async function ocrImage(dataUrl: string): Promise<OcrResult> {
  if (process.platform !== "darwin") return { ok: false, error: "当前系统暂不支持 OCR（仅 macOS）" };
  let imgPath = "";
  let scriptPath = "";
  try {
    imgPath = await dataUrlToTemp(dataUrl);
    scriptPath = path.join(os.tmpdir(), `umbra-ocr-${Date.now()}.js`);
    await fs.writeFile(scriptPath, JXA, "utf-8");
    const text = await new Promise<string>((resolve, reject) => {
      execFile("osascript", ["-l", "JavaScript", scriptPath], { timeout: 20000, env: { ...process.env, UMBRA_OCR_PATH: imgPath }, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve((stdout || "").replace(/\n$/, ""));
      });
    });
    if (text.startsWith("UMBRA_ERR:")) return { ok: false, error: text.slice(10) };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: (e as Error).message || "OCR 失败" };
  } finally {
    if (imgPath) fs.rm(imgPath, { force: true }).catch(() => {});
    if (scriptPath) fs.rm(scriptPath, { force: true }).catch(() => {});
  }
}

// CJK 占比 > 50% → 视为中文为主 → 译英文；否则 → 译中文。
function targetLang(text: string): "en" | "zh" {
  const cjk = (text.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
  const letters = (text.match(/[A-Za-z一-鿿぀-ヿ가-힯]/g) || []).length || 1;
  return cjk / letters > 0.5 ? "en" : "zh";
}

export interface TranslateResult {
  ok: boolean;
  source?: string;
  translation?: string;
  error?: string;
}

// PC 直连智谱 GLM 翻译（只输出译文、保持分行）。
export async function translateImage(dataUrl: string, apiKey: string): Promise<TranslateResult> {
  const ocr = await ocrImage(dataUrl);
  if (!ocr.ok) return { ok: false, error: ocr.error };
  const source = ocr.text || "";
  if (!source.trim()) return { ok: false, error: "未识别到文字" };
  if (!apiKey) return { ok: false, error: "未配置智谱 API Key（设置 → 截图 → 翻译 Key）" };

  const target = targetLang(source) === "en" ? "英文" : "中文";
  const prompt = `把下面的文本翻译成${target}，只输出译文，保持原有分行，不要任何解释或额外内容：\n\n${source}`;
  try {
    const resp = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "glm-4-flash", messages: [{ role: "user", content: prompt }], temperature: 0.2 }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return { ok: false, source, error: `翻译请求失败(${resp.status})：${t.slice(0, 200)}` };
    }
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    const translation = data.choices?.[0]?.message?.content?.trim() || "";
    return { ok: true, source, translation };
  } catch (e) {
    return { ok: false, source, error: (e as Error).message || "翻译失败" };
  }
}
