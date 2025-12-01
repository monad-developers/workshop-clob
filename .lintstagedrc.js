const path = require("path");

const buildNextEslintCommand = filenames =>
  `pnpm --filter @se-2/nextjs exec next lint --fix --file ${filenames
    .map(f => path.relative(path.join("packages", "nextjs"), f))
    .join(" --file ")}`;

const checkTypesNextCommand = () =>
  "pnpm --filter @se-2/nextjs run check-types";

const buildHardhatEslintCommand = filenames =>
  `pnpm --filter @se-2/hardhat exec eslint --fix ${filenames
    .map(f => path.relative(path.join("packages", "hardhat"), f))
    .join(" ")}`;

module.exports = {
  "packages/nextjs/**/*.{ts,tsx}": [
    buildNextEslintCommand,
    checkTypesNextCommand,
  ],
  "packages/hardhat/**/*.{ts,tsx}": [buildHardhatEslintCommand],
};
