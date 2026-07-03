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
        text: "var(--text)",
        muted: "var(--muted)",
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
      },
    },
  },
  plugins: [],
};
