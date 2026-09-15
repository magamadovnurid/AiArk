import { describe, expect, it } from "vitest";
import { buildLaunchSpec } from "../src/core/launcher";

describe("launcher", () => {
  it("passes model and prompt as arguments without a shell", () => {
    const spec = buildLaunchSpec({ runtimeExecutable: "/runtime/llama-cli", modelPath: "/ark/model.gguf", prompt: "hello; rm -rf nope" });
    expect(spec.command).toBe("/runtime/llama-cli");
    expect(spec.args).toContain("hello; rm -rf nope");
  });
});
