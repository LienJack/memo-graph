import { mountWorkbench } from "./mount.js";

const container = document.querySelector<HTMLElement>("#root");
if (container === null) {
  throw new Error("workbench root element is missing");
}

mountWorkbench(container);
