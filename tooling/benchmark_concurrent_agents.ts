import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const NUM_AGENTS = 5;
const ACTIONS_PER_AGENT = 3;
const CLI_CMD = "npx tsx engine/kindx.ts";

const QUERIES = [
  "authentication", 
  "vector search", 
  "FTS5 tokenization", 
  "query expansion tuning", 
  "memory setup and scoping"
];

const DOCIDS = ["#81807e", "#fdf91b", "#99cd59"]; // Ensure we have these indexed

async function runCli(cmd: string, agentId: number): Promise<string> {
  const env = { 
    ...process.env, 
    KINDX_CPU_ONLY: "1" // Force CPU so multiple node-llama-cpp contexts don't clash on VRAM / Metal
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
    
    // 3. Memory Put (Write concurrency test)
    await runCli(`memory put --scope agent-${agentId} --key last_action_${i} --value "Simulated search for ${query} and got ${docid}"`, agentId);
    
    // 4. Memory Search (Read concurrency test)
    await runCli(`memory search "Simulated search" --scope agent-${agentId}`, agentId);
    
    // 5. Status / Collections
    await runCli(`collection list`, agentId);

    // 6. Query (Hybrid Search - includes LLM calls if CPU_ONLY permits)
    await runCli(`query "${query}" -n 1`, agentId);
    
    console.log(`[Agent ${agentId}] Completed cycle ${i + 1}/${ACTIONS_PER_AGENT}`);
  }
}

async function main() {
  console.log(`Starting ${NUM_AGENTS} concurrent agents...`);
  console.log(`Actions per agent: ${ACTIONS_PER_AGENT} cycles (each cycle = 6 commands)`);
  
  const promises = [];
  const startToFinish = Date.now();
  
  for (let i = 0; i < NUM_AGENTS; i++) {
    promises.push(simulateAgent(i));
  }

  try {
    await Promise.all(promises);
    const elapsed = ((Date.now() - startToFinish) / 1000).toFixed(2);
    console.log(`\n✅ All agents completed ${NUM_AGENTS * ACTIONS_PER_AGENT * 6} total CLI requests successfully in ${elapsed}s.`);
  } catch (err: any) {
    console.error(`\n❌ Error during concurrent execution:\n`, err.message);
    process.exit(1);
  }
}

main();
