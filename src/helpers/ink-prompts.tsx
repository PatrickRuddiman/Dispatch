/**
 * Ink-based interactive prompt functions.
 *
 * These replace @inquirer/prompts with Ink (React for CLI) components.
 * They are extracted into a separate module so tests can mock them
 * via `vi.mock("../helpers/ink-prompts.js", ...)`.
 */

import React, { useState, useRef, useEffect } from "react";
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
  /** Max visible items before scrolling. Defaults to terminal height - 4. */
  limit?: number;
}): Promise<T> {
  return new Promise((resolve) => {
    function SelectPrompt() {
      const { exit } = useApp();
      const items = opts.choices.map((c) => ({ label: c.name, value: c.value }));
      const initialIndex = opts.default !== undefined
        ? opts.choices.findIndex((c) => c.value === opts.default)
        : 0;
      const visibleLimit = opts.limit ?? Math.max(5, (process.stdout.rows ?? 24) - 4);

      return (
        <Box flexDirection="column">
          <Box>
            <Text color={PALETTE.accent} bold>{opts.message}</Text>
          </Box>
          <SelectInput
            items={items}
            initialIndex={Math.max(0, initialIndex)}
            limit={visibleLimit}
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
 * Ink-based multi-select prompt. Returns an array of selected values.
 * Use space to toggle, enter to confirm.
 */
export function multiSelect<T>(opts: {
  message: string;
  choices: Array<{ name: string; value: T; description?: string; default?: boolean }>;
}): Promise<T[]> {
  return new Promise((resolve) => {
    function MultiSelectPrompt() {
      const { exit } = useApp();
      const [cursor, setCursor] = useState(0);
      const [selected, setSelected] = useState<Set<number>>(() => {
        const initial = new Set<number>();
        opts.choices.forEach((c, i) => { if (c.default) initial.add(i); });
        return initial;
      });
      const selectedRef = useRef(selected);
      useEffect(() => { selectedRef.current = selected; }, [selected]);

      useInput((input, key) => {
        if (key.upArrow) {
          setCursor((prev) => (prev > 0 ? prev - 1 : opts.choices.length - 1));
        } else if (key.downArrow) {
          setCursor((prev) => (prev < opts.choices.length - 1 ? prev + 1 : 0));
        } else if (input === " ") {
          setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(cursor)) next.delete(cursor);
            else next.add(cursor);
            return next;
          });
        } else if (key.return) {
          const result = opts.choices
            .filter((_, i) => selectedRef.current.has(i))
            .map((c) => c.value);
          resolve(result);
          exit();
        }
      });

      return (
        <Box flexDirection="column">
          <Box>
            <Text color={PALETTE.accent} bold>? </Text>
            <Text>{opts.message}</Text>
            <Text color={PALETTE.muted}> (space to toggle, enter to confirm)</Text>
          </Box>
          {opts.choices.map((choice, i) => {
            const isSelected = selected.has(i);
            const isCursor = i === cursor;
            const checkbox = isSelected ? "◉" : "◯";
            const pointer = isCursor ? "❯" : " ";
            return (
              <Box key={choice.name}>
                <Text color={isCursor ? PALETTE.accent : undefined}>
                  {pointer} {checkbox} {choice.name}
                </Text>
                {choice.description && isCursor && (
                  <Text color={PALETTE.muted}> — {choice.description}</Text>
                )}
              </Box>
            );
          })}
        </Box>
      );
    }

    const instance = render(<MultiSelectPrompt />);
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
