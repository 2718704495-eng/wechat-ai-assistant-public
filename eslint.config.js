import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "native/**/.build/**"] },
  eslint.configs.recommended,
  {
    files: ["tests/fixtures/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        setTimeout: "readonly",
      },
    },
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts"],
  })),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
