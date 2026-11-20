import assert from "node:assert/strict";
import { test } from "node:test";
import { unsizedButtons } from "./check-raw-controls.mjs";

test("flags a Button without size sm, single or multi-line", () => {
  assert.deepEqual(unsizedButtons('<Button variant="secondary">Go</Button>'), [1]);
  assert.deepEqual(
    unsizedButtons('<Button size="sm">A</Button>\n<Button\n  variant="x"\n  onClick={() => go()}\n>B</Button>'),
    [2],
  );
});

test("accepts size sm anywhere in the tag, and ignores other components", () => {
  assert.deepEqual(unsizedButtons('<Button\n  onClick={() => go()}\n  size="sm"\n>A</Button>'), []);
  assert.deepEqual(unsizedButtons('<IconButton label="x" /><ButtonGroup>'), []);
});
