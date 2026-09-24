import { styleText } from "node:util";

function stamp(): string {
  return new Date().toLocaleTimeString("id-ID", { hour12: false });
}

export const log = {
  info(msg: string): void {
    console.log(`${styleText("dim", stamp())} ${msg}`);
  },
  step(msg: string): void {
    console.log(`${styleText("dim", stamp())} ${styleText("cyan", "›")} ${msg}`);
  },
  ok(msg: string): void {
    console.log(`${styleText("dim", stamp())} ${styleText("green", "✔")} ${msg}`);
  },
  warn(msg: string): void {
    console.warn(`${styleText("dim", stamp())} ${styleText("yellow", "!")} ${msg}`);
  },
  error(msg: string): void {
    console.error(`${styleText("dim", stamp())} ${styleText("red", "✘")} ${msg}`);
  },
};
