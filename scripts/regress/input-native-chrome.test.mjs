// 回归：输入框右侧不该出现 Android WebView 的原生滚动条（白色上下箭头）。
// 用户实测：有字/聚焦时，textarea 的滚动条被 WebView 画成一条带 ▲▼ 的白色控件，
// 看起来像我们加了「上下切换」。滚动能力保留，只隐藏原生滚动条外观。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = readFileSync(join(root, "app/src/main/assets/web/styles.css"), "utf8");

const rule = css.slice(css.indexOf("#input {"), css.indexOf("#input::placeholder"));
if (!rule.includes("scrollbar-width: none;")) {
  throw new Error("FAIL: #input 没有隐藏原生滚动条（Android WebView 会画出上下箭头）");
}
if (!css.includes("#input::-webkit-scrollbar { display: none; width: 0; height: 0; }")) {
  throw new Error("FAIL: #input::-webkit-scrollbar 未隐藏 —— 输入框右侧会再出现白色上下切换");
}
console.log("✔ input-native-chrome: 输入框不再显示原生滚动条上下箭头");
