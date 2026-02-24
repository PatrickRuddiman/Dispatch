/**
 * Minimal structured logger for CLI output.
 */

import chalk from "chalk";

export const log = {
  info(msg: string) {
    console.log(chalk.blue("ℹ"), msg);
  },
  success(msg: string) {
    console.log(chalk.green("✔"), msg);
  },
  warn(msg: string) {
    console.log(chalk.yellow("⚠"), msg);
  },
  error(msg: string) {
    console.error(chalk.red("✖"), msg);
  },
  task(index: number, total: number, msg: string) {
    console.log(chalk.cyan(`[${index + 1}/${total}]`), msg);
  },
  dim(msg: string) {
    console.log(chalk.dim(msg));
  },
};
