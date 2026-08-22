export function installShutdownHandler(cleanup: () => Promise<void>): void {
  let shuttingDown = false;
  const handle = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await cleanup();
      process.exit(0);
    } catch (error) {
      console.error("Shutdown failed", error);
      process.exit(1);
    }
  };
  process.once("SIGINT", handle);
  process.once("SIGTERM", handle);
}
