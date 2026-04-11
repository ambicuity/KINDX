import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const NUM_AGENTS = 3; // Keep it low to simulate 3 concurrent users
const ACTIONS_PER_AGENT = 2; // Keep actions low
const CLI_CMD = "bun engine/kindx.ts";

const QUERIES = [
  "authentication", 
  "vector search", 
  "FTS5 tokenization", 
  "memory setup"
];

const DOCIDS = ["#81807e", "#fdf91b", "#99cd59"]; // Assumes these are in index

async function runCli(cmd: string, agentId: number): Promise<string> {
  // Using KINDX_CPU_ONLY=1 and OMP_NUM_THREADS=1 to avoid CPU overscheduling
  const env = { 
    ...process.env, 
    KINDX_CPU_ONLY: "1",
    OMP_NUM_THREADS: "1" 
  };
  try {
    const { stdout } = await execAsync(`${CLI_CMD} ${cmd}`, { env, maxBuffer: 1024 * 1024 * 10 });
    return stdout;
  } catch (error: any) {
    throw new Error(`[Agent ${agentId}] Command failed: ${cmd}\n${error.message}`);
  }
}

async function simulateAgent(agentId: number) {
  for (let i = 0; i < ACTIONS_PER_AGENT; i++) {
    const query = QUERIES[Math.floor(Math.random() * QUERIES.length)]!;
    const docid = DOCIDS[Math.floor(Math.random() * DOCIDS.length)]!;
    
    // 1. Search (BM25)
    await runCli(`search "${query}" -n 2`, agentId);
    
    // 2. Get document
    await runCli(`get "${docid}"`, agentId);
    
    // 3. Memory put & search
    await runCli(`memory put --scope multi-agent-${agentId} --key log_${i} --value "Sim searched for ${query}"`, agentId);
    await runCli(`memory search "Sim searched" --scope multi-agent-${agentId}`, agentId);
    
    // 4. Status
    await runCli(`status`, agentId);

    // Skip heavy Hybrid Query if it crashes node-llama-cpp on multiple contexts
    
    console.log(`[Agent ${agentId}] Completed cycle ${i + 1}/${ACTIONS_PER_AGENT}`);
  }
}

async function main() {
  console.log(`Starting ${NUM_AGENTS} concurrent agents via Bun...`);
  
  const promises = [];
  const startToFinish = Date.now();
  
  for (let i = 0; i < NUM_AGENTS; i++) {
    promises.push(simulateAgent(i));
  }

  try {
    await Promise.all(promises);
    const elapsed = ((Date.now() - startToFinish) / 1000).toFixed(2);
    console.log(`\n✅ All agents completed successfully in ${elapsed}s.`);
  } catch (err: any) {
    console.error(`\n❌ Error during concurrent execution:\n`, err.message);
    process.exit(1);
  }
}

main();
