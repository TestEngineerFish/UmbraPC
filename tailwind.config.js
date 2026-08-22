/** @type {import('tailwindcss').Config} */
// preflight 关闭：不重置现有 vanilla 内联样式 UI；颜色映射到 CSS 变量，随 data-theme 自动浅/深。
module.exports = {
  content: ["./index.html", "./*.html", "./src/**/*.{ts,tsx}"],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        card: "var(--card)",
        titlebar: "var(--titlebar)",
        border: "var(--border)",
        "border-soft": "var(--border-soft)",
        text: "var(--text)",
        muted: "var(--muted)",
        faint: "var(--faint)",
        hover: "var(--hover)",
        rail: "var(--rail)",
        nav: "var(--nav)",
        orange: "var(--orange)",
        "orange-deep": "var(--orange-deep)",
        "orange-soft": "var(--orange-soft)",
        "orange-text": "var(--orange-text)",
        success: "var(--success)",
        "success-soft": "var(--success-soft)",
        warning: "var(--warning)",
        "warning-soft": "var(--warning-soft)",
        danger: "var(--danger)",
        "danger-soft": "var(--danger-soft)",
        chip: "var(--chip)",
        track: "var(--track)",
        desk: "var(--desk)",
        // 图表色槽（记账等分类图表按槽位取色，不表意状态）。语义四色不许进这组。
        c1: "var(--c1)", c2: "var(--c2)", c3: "var(--c3)", c4: "var(--c4)",
        c5: "var(--c5)", c6: "var(--c6)", c7: "var(--c7)", c8: "var(--c8)",
      },
      boxShadow: {
        floating: "var(--shadow-floating)",
        modal: "var(--shadow-modal)",
        focus: "var(--focus-ring)",
      },
    },
  },
  plugins: [],
};
