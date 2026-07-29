// 本地文件检索层。
//
// mdfind 那条路在 Linux 容器里跑不了（也不该跑——那是在测 Spotlight），所以这里测两件事：
//   1. 拼给 mdfind 的查询串对不对 —— 拼错一个引号就是零结果，而「零结果」和「真的没有」
//      在界面上长得一模一样，是最难查的那种错，必须锁住。
//   2. 兜底遍历这条路的真实行为 —— 造一棵真目录树走一遍。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildMdfindQuery, describe as describeFile, matchesFilters, parseExts, searchFiles, walkSearch,
  type FileQuery,
} from "../electron/core/launcher/filesearch";

const q = (over: Partial<FileQuery> = {}): FileQuery => ({
  keyword: "", scopes: [], kind: "any", exts: [], limit: 50, ...over,
});

describe("扩展名解析", () => {
  it("各种写法都认，统一成小写无点", () => {
    expect(parseExts("PNG, .jpg;jpeg 、 pdf")).toEqual(["png", "jpg", "jpeg", "pdf"]);
  });
  it("空串给空数组，不是 ['']", () => {
    expect(parseExts("  ")).toEqual([]);
  });
});

describe("路径拆解", () => {
  it("拿到文件名和小写扩展名", () => {
    expect(describeFile("/a/b/报告.PDF")).toMatchObject({ name: "报告.PDF", ext: "pdf", dir: false });
  });
  it("没有扩展名时 ext 是空串", () => {
    expect(describeFile("/a/b/Makefile").ext).toBe("");
  });
  it("点开头的隐藏文件不算有扩展名（.gitignore 的 ext 不该是 gitignore）", () => {
    expect(describeFile("/a/.gitignore").ext).toBe("");
  });
});

describe("mdfind 查询串", () => {
  it("关键词用忽略大小写 + 忽略音标", () => {
    expect(buildMdfindQuery(q({ keyword: "报告" }))).toBe("kMDItemFSName == '*报告*'cd");
  });
  it("类别走 ContentTypeTree（认继承，png/jpeg 都算图片）", () => {
    expect(buildMdfindQuery(q({ kind: "image" }))).toContain("kMDItemContentTypeTree == 'public.image'");
  });
  it("关键词和类别同时给时用 && 串起来", () => {
    const s = buildMdfindQuery(q({ keyword: "a", kind: "pdf" }));
    expect(s).toContain("&&");
    expect(s).toContain("com.adobe.pdf");
  });
  it("关键词里的单引号要转义，否则整条查询被截断", () => {
    expect(buildMdfindQuery(q({ keyword: "it's" }))).toContain("it\\'s");
  });
  it("什么都没给时也要是一条合法查询，不能是空串", () => {
    expect(buildMdfindQuery(q())).toBe("kMDItemFSName == '*'");
  });
});

describe("后置过滤", () => {
  const png = describeFile("/x/a.png");
  it("扩展名不在清单里就滤掉", () => {
    expect(matchesFilters(png, q({ exts: ["jpg"] }), false)).toBe(false);
    expect(matchesFilters(png, q({ exts: ["png"] }), false)).toBe(true);
  });
  it("兜底路径按扩展名粗筛类别", () => {
    expect(matchesFilters(png, q({ kind: "image" }), true)).toBe(true);
    expect(matchesFilters(png, q({ kind: "audio" }), true)).toBe(false);
  });
  it("Spotlight 那条路不重复筛类别（UTI 已经筛过了）", () => {
    expect(matchesFilters(png, q({ kind: "audio" }), false)).toBe(true);
  });
});

describe("兜底遍历", () => {
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "umbra-fs-"));
    await mkdir(path.join(root, "子目录/更深"), { recursive: true });
    await mkdir(path.join(root, ".隐藏目录"), { recursive: true });
    await writeFile(path.join(root, "报告.pdf"), "x");
    await writeFile(path.join(root, "照片.png"), "x");
    await writeFile(path.join(root, "笔记.md"), "x");
    await writeFile(path.join(root, "子目录/报告草稿.pdf"), "x");
    await writeFile(path.join(root, ".隐藏目录/报告.pdf"), "x");
    await writeFile(path.join(root, ".隐藏文件.pdf"), "x");
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it("按关键词递归找到（含子目录）", async () => {
    const hits = await walkSearch(q({ keyword: "报告", scopes: [root] }));
    expect(hits.map((h) => h.name).sort()).toEqual(["报告.pdf", "报告草稿.pdf"]);
  });

  it("点开头的文件和目录一律跳过", async () => {
    const hits = await walkSearch(q({ keyword: "", scopes: [root], exts: ["pdf"] }));
    expect(hits.every((h) => !h.path.includes("/."))).toBe(true);
  });

  it("按类别粗筛", async () => {
    const hits = await walkSearch(q({ scopes: [root], kind: "image" }));
    expect(hits.map((h) => h.name)).toEqual(["照片.png"]);
  });

  it("按扩展名精确筛", async () => {
    const hits = await walkSearch(q({ scopes: [root], exts: ["md"] }));
    expect(hits.map((h) => h.name)).toEqual(["笔记.md"]);
  });

  it("只要文件夹", async () => {
    const hits = await walkSearch(q({ scopes: [root], kind: "folder" }));
    expect(hits.map((h) => h.name)).toEqual(["子目录", "更深"]);
  });

  it("limit 是硬上限", async () => {
    expect((await walkSearch(q({ scopes: [root], limit: 2 }))).length).toBe(2);
  });

  it("不给搜索目录就不走 —— 没有索引时全盘现走会卡死", async () => {
    expect(await walkSearch(q({ keyword: "报告" }))).toEqual([]);
  });

  it("目录不存在或没权限时跳过，不抛异常", async () => {
    const hits = await walkSearch(q({ keyword: "报告", scopes: [root, "/根本没有这个目录"] }));
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("检索入口", () => {
  it("非 macOS 上退回遍历，所以必须给目录", async () => {
    if (process.platform === "darwin") return;
    expect(await searchFiles({ keyword: "报告" })).toEqual([]);
  });

  it("什么筛选条件都没有时直接返回空，不去全盘扫", async () => {
    expect(await searchFiles({})).toEqual([]);
  });
});
