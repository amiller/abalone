// A tiny OpenAI-compatible server on loopback standing in for ollama/llama-server. Prints its port.
import http from "node:http";
const s = http.createServer((req, res) => {
  if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "tiny" }] }));
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "tiny", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.end(chunk({ role: "assistant", content: "hello from the local model" }) + chunk({}, "stop") + "data: [DONE]\n\n");
  });
}).listen(0, "127.0.0.1", () => console.log(s.address().port));
