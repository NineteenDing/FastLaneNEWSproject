import { randomInt } from "node:crypto";
import type { Server } from "node:http";
import type { FastifyInstance } from "fastify";

/** Some Windows ephemeral ranges include ports refused by fetch (e.g. 6000). Keep real HTTP
 * tests on high loopback ports. Windows can also deny a reserved high port;
 * retry that address without changing firewall policy or transport checks. */
export async function listenForFetch(app: FastifyInstance): Promise<string> {
  return reserveFetchPort(port => app.listen({ host: "127.0.0.1", port }));
}

/** Provider stubs use the same safe port range as real Fastify HTTP tests. */
export async function listenHttpForFetch(server: Server): Promise<string> {
  return reserveFetchPort(port => new Promise<string>((resolve, reject) => {
    const failed = (error: Error) => { server.removeListener("listening", ready); reject(error); };
    const ready = () => { server.removeListener("error", failed); resolve(`http://127.0.0.1:${port}`); };
    server.once("error", failed);
    server.once("listening", ready);
    server.listen(port, "127.0.0.1");
  }));
}

async function reserveFetchPort(listen: (port: number) => Promise<string>): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try { return await listen(randomInt(20000, 60000)); }
    catch (error) { if (!["EADDRINUSE", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  throw new Error("Could not reserve a loopback HTTP test port after 10 attempts");
}
