import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, createReadStream } from "node:fs";
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

function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (data) => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
