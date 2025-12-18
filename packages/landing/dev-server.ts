import { watch } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

const PORT = 5174;
const clients = new Set<ReadableStreamDefaultController>();

const reloadScript = `
<script>
  const eventSource = new EventSource('/sse');
  eventSource.onmessage = (event) => {
    if (event.data === 'reload') {
      location.reload();
    }
  };
</script>
`;

async function serveFile(path: string): Promise<Response> {
  try {
    const content = await readFile(join(import.meta.dir, path), "utf-8");
    const contentType = path.endsWith(".css")
      ? "text/css"
      : path.endsWith(".html")
      ? "text/html"
      : "text/plain";

    let body = content;
    if (path === "index.html") {
      body = content.replace("</body>", `${reloadScript}</body>`);
    }

    return new Response(body, {
      headers: { "Content-Type": contentType },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/sse") {
      const stream = new ReadableStream({
        start(controller) {
          clients.add(controller);
          controller.enqueue("data: connected\n\n");
        },
        cancel(controller) {
          clients.delete(controller);
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return serveFile("index.html");
    }

    if (url.pathname === "/styles.css") {
      return serveFile("styles.css");
    }

    return new Response("Not Found", { status: 404 });
  },
});

watch(import.meta.dir, { recursive: false }, (event, filename) => {
  if (filename && (filename.endsWith(".html") || filename.endsWith(".css"))) {
    console.log(`[${new Date().toLocaleTimeString()}] ${filename} changed, reloading...`);
    for (const controller of clients) {
      try {
        controller.enqueue("data: reload\n\n");
      } catch {
        clients.delete(controller);
      }
    }
  }
});

console.log(`Dev server running at http://0.0.0.0:${PORT}`);
