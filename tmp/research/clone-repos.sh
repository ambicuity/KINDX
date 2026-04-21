#!/usr/bin/env bash
set -e

REPO_DIR="./tmp/reference-repos"
mkdir -p "$REPO_DIR"

clone_if_needed() {
  local name="$1"
  local url="$2"
  local dest="$REPO_DIR/$name"
  if [ -d "$dest/.git" ]; then
    echo "SKIP: $name (already cloned)"
  else
    echo "CLONE: $name <- $url"
    git clone --depth 1 --single-branch "$url" "$dest" 2>&1 || echo "FAILED: $name"
  fi
}

# Agent reasoning / query planning
clone_if_needed langgraph https://github.com/langchain-ai/langgraph
clone_if_needed OpenDevin https://github.com/OpenDevin/OpenDevin
clone_if_needed crewAI https://github.com/joaomdmoura/crewAI

# Persistent memory
clone_if_needed MemGPT https://github.com/cpacker/MemGPT
clone_if_needed letta https://github.com/letta-ai/letta
clone_if_needed zep https://github.com/getzep/zep

# Streaming + incremental reasoning
clone_if_needed ai https://github.com/vercel/ai
clone_if_needed llama_index https://github.com/run-llama/llama_index

# Multi-modal RAG
clone_if_needed haystack https://github.com/deepset-ai/haystack
clone_if_needed unstructured https://github.com/Unstructured-IO/unstructured

# Context compression
clone_if_needed LLMLingua https://github.com/microsoft/LLMLingua

# Autonomous agent hooks
clone_if_needed AutoGPT https://github.com/Significant-Gravitas/AutoGPT
clone_if_needed SuperAGI https://github.com/TransformerOptimus/SuperAGI
clone_if_needed OpenAgents https://github.com/xlang-ai/OpenAgents

# Observability
clone_if_needed langsmith-sdk https://github.com/langchain-ai/langsmith-sdk
clone_if_needed helicone https://github.com/helicone/helicone
clone_if_needed phoenix https://github.com/Arize-ai/phoenix

# Enterprise security
clone_if_needed opa https://github.com/open-policy-agent/opa
clone_if_needed spicedb https://github.com/authzed/spicedb

# Knowledge graph
clone_if_needed graphrag https://github.com/microsoft/graphrag
clone_if_needed kuzu https://github.com/kuzudb/kuzu

# Developer experience
clone_if_needed Flowise https://github.com/FlowiseAI/Flowise
clone_if_needed langflow https://github.com/logspace-ai/langflow
clone_if_needed open-webui https://github.com/open-webui/open-webui

# Closest vision comps
clone_if_needed khoj https://github.com/khoj-ai/khoj
clone_if_needed continue https://github.com/continuedev/continue
clone_if_needed anything-llm https://github.com/Mintplex-Labs/anything-llm

echo "DONE: All repos processed"
