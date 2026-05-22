import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";

export class ModelIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelIntegrityError";
  }
}

export async function verifyModelIntegrity(modelPath: string): Promise<boolean> {
  const checksumPath = `${modelPath}.sha256`;

  if (!existsSync(checksumPath)) {
    return true;
  }

  const expectedHash = readFileSync(checksumPath, "utf-8").trim();
  if (!expectedHash) {
    return true;
  }

  const actualHash = await computeFileHash(modelPath);

  if (actualHash !== expectedHash) {
    throw new ModelIntegrityError(
      `Model integrity check failed for ${modelPath}: ` +
        `expected ${expectedHash}, got ${actualHash}`,
    );
  }

  return true;
}

export async function writeModelChecksum(modelPath: string): Promise<void> {
  const checksumPath = `${modelPath}.sha256`;
  const hash = await computeFileHash(modelPath);
  writeFileSync(checksumPath, hash + "\n", "utf-8");
}

async function computeFileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}
