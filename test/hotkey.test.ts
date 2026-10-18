import { test, expect } from "bun:test";
import { findHotkey, parseHotkeys } from "../src/core/hotkey.ts";

const specs = parseHotkeys(["ctrl+/", "ctrl+^"]);
const enc = (s: string) => new TextEncoder().encode(s);

test("matches every encoding of ctrl+/ and ctrl+^", () => {
  expect(findHotkey(new Uint8Array([0x1f]), specs)?.name).toBe("ctrl+/");
  expect(findHotkey(enc("\x1b[47;5u"), specs)?.name).toBe("ctrl+/");
  expect(findHotkey(enc("\x1b[27;5;47~"), specs)?.name).toBe("ctrl+/");
  expect(findHotkey(new Uint8Array([0x1e]), specs)?.name).toBe("ctrl+^");
  expect(findHotkey(enc("\x1b[94;5u"), specs)?.name).toBe("ctrl+^");
  expect(findHotkey(enc("\x1b[54;6u"), specs)?.name).toBe("ctrl+^"); // ctrl+shift+6
});

test("reports position and length inside a mixed chunk; ignores plain keys", () => {
  const hit = findHotkey(enc("ab\x1b[47;5ux"), specs)!;
  expect(hit.index).toBe(2);
  expect(hit.length).toBe(7);
  expect(findHotkey(enc("hello\x1b[A"), specs)).toBeNull();
});
