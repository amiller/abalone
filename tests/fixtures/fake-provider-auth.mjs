// Loopback stand-in for a provider's auth check: keys starting "good-" get 400 (body rejected, key accepted)
// after a pause long enough to inspect the adding process; anything else gets 401. Prints its port.
import http from "node:http";
const s = http.createServer((req, res) => {
  const good = /^Bearer good-/.test(req.headers.authorization ?? "");
  setTimeout(() => { res.writeHead(good ? 400 : 401); res.end(good ? '{"error":"empty messages"}' : '{"error":"invalid api key"}'); }, good ? 1500 : 0);
}).listen(0, "127.0.0.1", () => console.log(s.address().port));
