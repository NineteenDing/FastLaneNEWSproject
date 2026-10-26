import type { ChildProcess } from "node:child_process";

// Windows kill(SIGTERM) forcibly terminates a process; it cannot deliver a POSIX signal handler.
// The IPC fixture exercises that same graceful-shutdown handler and its real queue/DB work.
// Unix still verifies native signal delivery. This is not a Windows service-manager acceptance test.
export const gracefulStopBridge = `
  if (process.platform === 'win32') process.on('message', message => {
    if (message?.type === 'test:graceful-stop') process.emit('SIGTERM');
  });
`;

export function requestGracefulStop(child: ChildProcess): void {
  if (process.platform === "win32") child.send({ type: "test:graceful-stop" });
  else child.kill("SIGTERM");
}
