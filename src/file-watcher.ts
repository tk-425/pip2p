/**
 * File Watcher - watches inbox directory for new messages (fallback mode)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PipMessage } from "./types.js";

export type MessageHandler = (message: PipMessage) => void;

export class FileWatcher {
  private watcher: fs.FSWatcher | null = null;
  private inboxDir: string;
  private handler: MessageHandler;
  private knownFiles: Set<string> = new Set();

  constructor(inboxDir: string, handler: MessageHandler) {
    this.inboxDir = inboxDir;
    this.handler = handler;
  }

  start(): void {
    // Ensure directory exists
    fs.mkdirSync(this.inboxDir, { recursive: true });

    // Track existing files so we don't trigger on them
    const existing = fs.readdirSync(this.inboxDir).filter((f) => f.endsWith(".json"));
    this.knownFiles = new Set(existing);

    // Start watching
    this.watcher = fs.watch(this.inboxDir, (eventType, filename) => {
      if (!filename || !filename.endsWith(".json")) return;

      // Only handle new files
      if (this.knownFiles.has(filename)) return;
      this.knownFiles.add(filename);

      try {
        const filePath = path.join(this.inboxDir, filename);
        const data = fs.readFileSync(filePath, "utf-8");
        const message = JSON.parse(data) as PipMessage;
        this.handler(message);
      } catch {
        // File might not be fully written yet, ignore
      }
    });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
