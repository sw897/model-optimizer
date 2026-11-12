import { expect, it } from "vitest";
import { inspectPE } from "../scripts/pe.mjs";

function fixture(name = "KERNEL32.dll", delayed = false): Buffer {
  const b = Buffer.alloc(0x800), pe = 0x80, opt = pe + 24;
  b.writeUInt16LE(0x5a4d); b.writeUInt32LE(pe, 0x3c); b.writeUInt32LE(0x4550, pe);
  b.writeUInt16LE(0x8664, pe + 4); b.writeUInt16LE(1, pe + 6); b.writeUInt16LE(240, pe + 20);
  b.writeUInt16LE(0x20b, opt); b.writeUInt32LE(0x200, opt + 60); b.writeUInt32LE(16, opt + 108);
  const section = opt + 240;
  b.writeUInt32LE(0x1000, section + 12); b.writeUInt32LE(0x600, section + 16); b.writeUInt32LE(0x200, section + 20);
  const entry = opt + 112 + (delayed ? 13 : 1) * 8;
  b.writeUInt32LE(0x1000, entry); b.writeUInt32LE(delayed ? 64 : 40, entry + 4);
  if (delayed) { b.writeUInt32LE(1, 0x200); b.writeUInt32LE(0x1100, 0x204); }
  else b.writeUInt32LE(0x1100, 0x20c);
  b.write(name, 0x300);
  return b;
}

it("reads normal and delayed x64 imports", () => {
  expect(inspectPE(fixture()).imports).toEqual(["KERNEL32.dll"]);
  expect(inspectPE(fixture("node.exe", true)).delayImports).toEqual(["node.exe"]);
  expect(inspectPE(fixture("user32.dll", true)).delayImports).toEqual(["user32.dll"]);
});
it("rejects debug runtime imports even when no DLL file is present", () => {
  for (const delayed of [false, true]) expect(() => inspectPE(fixture("ucrtbased.dll", delayed))).toThrow("debug runtime import");
});
it("rejects wrong architecture, truncated headers and unmapped imports", () => {
  const wrong = fixture(); wrong.writeUInt16LE(0x14c, 0x84);
  expect(() => inspectPE(wrong)).toThrow("x64");
  expect(() => inspectPE(fixture().subarray(0, 80))).toThrow("range");
  const corrupt = fixture(); corrupt.writeUInt32LE(0xfffff, 0x20c);
  expect(() => inspectPE(corrupt)).toThrow("unmapped");
});
