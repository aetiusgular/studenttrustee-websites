import js from "@eslint/js";
import html from "eslint-plugin-html";

const browserGlobals = {
  window: "readonly", document: "readonly", navigator: "readonly", location: "readonly",
  history: "readonly", fetch: "readonly", console: "readonly", performance: "readonly",
  requestAnimationFrame: "readonly", cancelAnimationFrame: "readonly", setTimeout: "readonly",
  clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly",
  getComputedStyle: "readonly", matchMedia: "readonly", localStorage: "readonly",
  sessionStorage: "readonly", URL: "readonly", URLSearchParams: "readonly", Intl: "readonly",
  AbortController: "readonly", HTMLElement: "readonly", Event: "readonly", CustomEvent: "readonly",
  IntersectionObserver: "readonly", queueMicrotask: "readonly", structuredClone: "readonly",
};

export default [
  {
    ignores: ["node_modules/**", "studenttrustee/vendor/**", "playwright-report/**", "test-results/**", ".cache/**"],
  },
  js.configs.recommended,
  {
    files: ["studenttrustee/**/*.html", "volunteer/**/*.html", "studenttrustee/assets/**/*.js", "volunteer/**/*.js"],
    plugins: { html },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...browserGlobals, L: "readonly", VOLUNTEER_DATA: "readonly" },
    },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-undef": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["tools/**/*.js", "tests/**/*.js", "playwright.config.js", "eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...browserGlobals, process: "readonly", Buffer: "readonly", NodeFilter: "readonly" },
    },
  },
];
