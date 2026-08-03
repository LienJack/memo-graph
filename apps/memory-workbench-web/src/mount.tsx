import { createRoot, type Root } from "react-dom/client";

import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";

import { App, type AppProps } from "./app/App.js";
import "./styles/workbench.css";

export function mountWorkbench(container: HTMLElement, props: AppProps = {}): Root {
  const root = createRoot(container);
  root.render(<App {...props} />);
  return root;
}
