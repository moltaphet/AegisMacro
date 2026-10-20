import js from "@eslint/js";
import globals from "globals";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Composed directly instead of through eslint-config-next: that package pulls in
// @next/eslint-plugin-next -> fast-glob -> micromatch -> braces (<= 3.0.3), an
// advisory (GHSA-vfj7-8cjw-p6xm) with no patched release, which would leave
// `npm audit` permanently at 5 high findings.
export default tseslint.config(
  { ignores: [".next/**", "out/**", "coverage/**", "next-env.d.ts", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mjs}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { react, "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    settings: { react: { version: "19" } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat["jsx-runtime"].rules,
      ...reactHooks.configs.flat["recommended-latest"].rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      "react/prop-types": "off",
    },
  },
  {
    // react-three-fiber JSX uses Three.js props (args, position, emissive, ...)
    // that the DOM-oriented rule does not know. Scoped to the one 3D scene file.
    files: ["src/components/MacroGlobe3D.tsx"],
    rules: { "react/no-unknown-property": "off" },
  },
);
