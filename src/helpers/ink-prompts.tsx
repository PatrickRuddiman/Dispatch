/**
 * Ink-based interactive prompt functions.
 *
 * These replace @inquirer/prompts with Ink (React for CLI) components.
 * They are extracted into a separate module so tests can mock them
 * via `vi.mock("../helpers/ink-prompts.js", ...)`.
 */

import React, { useState } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import { PALETTE } from "./format.js";

/**
 * Ink-based select prompt. Returns the selected value.
 */
export function select<T>(opts: {
  message: string;
  choices: Array<{ name: string; value: T; description?: string }>;
  default?: T;
}): Promise<T> {
  return new Promise((resolve) => {
    function SelectPrompt() {
      const { exit } = useApp();
      const items = opts.choices.map((c) => ({ label: c.name, value: c.value }));
      const initialIndex = opts.default !== undefined
        ? opts.choices.findIndex((c) => c.value === opts.default)
        : 0;

      return (
        <Box flexDirection="column">
          <Box>
            <Text color={PALETTE.accent} bold>? </Text>
            <Text>{opts.message}</Text>
          </Box>
          <SelectInput
            items={items}
            initialIndex={Math.max(0, initialIndex)}
            onSelect={(item) => {
              resolve(item.value as T);
              exit();
            }}
          />
        </Box>
      );
    }

    const instance = render(<SelectPrompt />);
    instance.waitUntilExit().catch(() => {});
  });
}

/**
 * Ink-based confirm prompt (y/N). Returns boolean.
 */
export function confirm(opts: {
  message: string;
  default?: boolean;
}): Promise<boolean> {
  const defaultVal = opts.default ?? true;

  return new Promise((resolve) => {
    function ConfirmPrompt() {
      const { exit } = useApp();
      const hint = defaultVal ? "(Y/n)" : "(y/N)";

      useInput((input) => {
        const lower = input.toLowerCase();
        if (lower === "y") { resolve(true); exit(); }
        else if (lower === "n") { resolve(false); exit(); }
        else if (input === "\r" || input === "\n" || input === "") { resolve(defaultVal); exit(); }
      });

      return (
        <Box>
          <Text color={PALETTE.accent} bold>? </Text>
          <Text>{opts.message} </Text>
          <Text color={PALETTE.muted}>{hint} </Text>
        </Box>
      );
    }

    const instance = render(<ConfirmPrompt />);
    instance.waitUntilExit().catch(() => {});
  });
}

/**
 * Ink-based text input prompt. Returns the user's text input.
 */
export function input(opts: {
  message: string;
  default?: string;
}): Promise<string> {
  return new Promise((resolve) => {
    function InputPrompt() {
      const { exit } = useApp();
      const [value, setValue] = useState(opts.default ?? "");

      return (
        <Box>
          <Text color={PALETTE.accent} bold>? </Text>
          <Text>{opts.message} </Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={(val) => {
              resolve(val);
              exit();
            }}
          />
        </Box>
      );
    }

    const instance = render(<InputPrompt />);
    instance.waitUntilExit().catch(() => {});
  });
}
