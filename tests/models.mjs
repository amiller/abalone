import { createAciProvider } from "../aci/provider/dist/index.js";
const p = createAciProvider({ baseURL: process.argv[2], trust: {}, models: { isTeeOnly: true }, receipts: { verification: "response", historySize: 32 } });
const models = await p.discoverModels();
console.log(models.length, models.slice(0, 5).map((m) => m.id).join(" "));
await p.close();
