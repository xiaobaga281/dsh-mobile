// 回归：工作区堆叠会话收起时，叠层的方角/描边不能在头部圆角处露出直角阴影。
// 用户实测：收起动画期间出现「顶部圆角处一块直角阴影」。修法：
//   · 叠层改成四角圆角（顶部两角本来藏在头部后面，不改变外观）；
//   · 收起动画（is-closing）期间叠层不画，等高度收完再淡入。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = readFileSync(join(root, "app/src/main/assets/web/styles.css"), "utf8");

const layer = css.slice(css.indexOf(".ws-group::before,"), css.indexOf(".ws-group.is-stacked::before"));
if (!layer.includes("border-radius: 12px;")) {
  throw new Error("FAIL: 堆叠层不是四角圆角 —— 收起时方角会在头部圆角处露出直角阴影");
}
if (layer.includes("border-radius: 0 0 12px 12px;")) {
  throw new Error("FAIL: 堆叠层仍只圆下方两角 —— 收起时顶部直角阴影会复发");
}
const closeRule = ".ws-group.is-closing::before,\n.ws-group.is-closing::after { opacity: 0; }";
const closeAt = css.indexOf(closeRule);
const stackedAt = css.indexOf(".ws-group.is-stacked::after");
if (closeAt < 0) {
  throw new Error("FAIL: 收起动画期间没有隐藏叠层 —— 收起时会看到叠层的直角/阴影");
}
if (stackedAt < 0 || closeAt < stackedAt) {
  throw new Error("FAIL: is-closing 的隐藏规则必须在 is-stacked 之后（同权重，顺序决定生效）");
}

console.log("✔ workspace-stack-shadow: 收起时叠层四角圆角且先隐藏，不再露直角阴影");
