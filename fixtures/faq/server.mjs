import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const stateDir = process.argv[2];
if (!stateDir || !process.env.CHATBOT_API_KEY) {
  throw new Error("Set CHATBOT_API_KEY and pass a temporary state directory.");
}
const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/chat") {
    response.writeHead(404).end();
    return;
  }
  if (request.headers.authorization !== `Bearer ${process.env.CHATBOT_API_KEY}`) {
    response.writeHead(403).end();
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { message } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (message !== "How long do I have to return an item?") {
      response.writeHead(400).end();
      return;
    }
    const answer = (await readFile(join(stateDir, "answer"), "utf8")).trim();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ answer, finished: true }));
  } catch {
    response.writeHead(500).end();
  }
});

server.listen(0, "127.0.0.1", async () => {
  await writeFile(join(stateDir, "url"), `http://127.0.0.1:${server.address().port}\n`);
});
