import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../config-prompts.js", () => ({
  runInteractiveConfigWizard: vi.fn().mockResolvedValue(undefined),
}));

import { handleConfigCommand } from "../config.js";
import { runInteractiveConfigWizard } from "../config-prompts.js";

describe("handleConfigCommand", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls the interactive wizard", async () => {
    await handleConfigCommand([]);
    expect(runInteractiveConfigWizard).toHaveBeenCalled();
  });
});
