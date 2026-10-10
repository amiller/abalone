import assert from "node:assert/strict";
import { keepValues } from "./keep.mjs";
assert.deepEqual(keepValues([0, null, false, "", undefined, 3]), [0, false, "", 3]);
console.log("PASS keeps 0, false and empty strings; drops null and undefined");
