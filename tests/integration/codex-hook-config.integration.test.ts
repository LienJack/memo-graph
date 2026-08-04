import { describe, expect, it } from "vitest";

import {
  buildManagedHookCommand,
  mergeHooksJsonDocument,
  mergeHooksTomlDocument,
  removeManagedHooksJsonDocument,
  removeManagedHooksTomlDocument,
} from "../../apps/codex-bootstrap/src/hook-config.js";

describe("Codex automatic-memory hook configuration", () => {
  const command = buildManagedHookCommand({
    nodeExecutable: "/private/runtime/node",
    hookEntryPath: "/private/release/dist/hook-command.js",
    descriptorPath: "/private/state/hook.json",
    spoolDirectory: "/private/state/hook-spool",
  });

  it("merges JSON hooks without replacing existing handlers", () => {
    const original = {
      description: "operator hooks",
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "'/existing/bridge' --source codex",
                timeout: 5,
              },
            ],
          },
        ],
      },
    };

    const once = mergeHooksJsonDocument(original, command);
    const twice = mergeHooksJsonDocument(once, command);

    expect(twice).toEqual(once);
    expect(once).toMatchObject({ description: "operator hooks" });
    expect(once.hooks.Stop).toHaveLength(2);
    expect(once.hooks.UserPromptSubmit?.[0]?.hooks[0]).toMatchObject({
      type: "command",
      command,
      timeout: 3,
      additionalContextLimit: 4_000,
    });
    expect(once.hooks.SessionEnd?.[0]?.hooks[0]).toMatchObject({
      timeout: 3,
    });
  });

  it("updates only its marked TOML block and enables the canonical feature", () => {
    const original = `model = "gpt-5.6"\n\n[features]\njs_repl = true\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "existing"\n`;
    const once = mergeHooksTomlDocument(original, command);
    const twice = mergeHooksTomlDocument(once, command);

    expect(twice).toBe(once);
    expect(once).toContain("js_repl = true");
    expect(once).toContain("hooks = true");
    expect(once).toContain('command = "existing"');
    expect(once.match(/BEGIN MEMO_GRAPH_AUTOMATIC_MEMORY/gu)).toHaveLength(1);
    expect(once).toContain("[[hooks.UserPromptSubmit]]");
    expect(once).toContain("additionalContextLimit = 4000");
  });

  it("shell-quotes every managed command path", () => {
    expect(command).toBe(
      "'/private/runtime/node' '/private/release/dist/hook-command.js' --descriptor '/private/state/hook.json' --spool '/private/state/hook-spool' --managed-by 'memo-graph'",
    );
  });

  it("replaces stale managed release paths and uninstalls only memo-graph", () => {
    const oldCommand = command.replace("/private/release", "/private/old-release");
    const original = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "existing", timeout: 5 }] },
        ],
      },
    };
    const old = mergeHooksJsonDocument(original, oldCommand);
    const upgraded = mergeHooksJsonDocument(old, command);
    expect(JSON.stringify(upgraded)).not.toContain("/private/old-release");
    expect(upgraded.hooks.Stop).toHaveLength(2);
    expect(removeManagedHooksJsonDocument(upgraded)).toEqual(original);

    const toml = mergeHooksTomlDocument(
      '[features]\nhooks = true\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "existing"\n',
      command,
    );
    const uninstalled = removeManagedHooksTomlDocument(toml);
    expect(uninstalled).toContain('command = "existing"');
    expect(uninstalled).not.toContain("MEMO_GRAPH_AUTOMATIC_MEMORY");
    expect(removeManagedHooksTomlDocument(uninstalled)).toBe(uninstalled);
  });
});
