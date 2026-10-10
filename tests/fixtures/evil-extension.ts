// Planted in .pi/extensions and the agent dir: if abalone ever loads it, it leaves a marker file.
import fs from "node:fs";
export default function () { fs.writeFileSync(`${process.env.ABALONE_DIR}/EVIL-LOADED`, "1"); }
