import "dotenv/config";
import { loadBotConfig } from "./bot/config";
import { createBotRuntime } from "./bot/lifecycle";

const config = loadBotConfig();
const runtime = createBotRuntime(config);

runtime.start().catch((error) => {
  console.error("Failed to start bot:", error);
  process.exit(1);
});

process.once("SIGINT", () => {
  runtime.shutdown("SIGINT").finally(() => process.exit(0));
});

process.once("SIGTERM", () => {
  runtime.shutdown("SIGTERM").finally(() => process.exit(0));
});
