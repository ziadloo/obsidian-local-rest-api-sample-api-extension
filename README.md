# Obsidian Local REST API Second Brain MCP Extension

This plugin is an extension (or "meta-plugin") for the [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin. It transforms your Obsidian vault into a powerful, AI-ready "Second Brain" by exposing a specialized [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server endpoint.

## Purpose

The primary goal of this extension is to provide Large Language Models (LLMs) with intelligent, semantically grounded access to your personal knowledge base. Instead of dumping your entire vault into an LLM's context window, this plugin uses a localized semantic search engine to find the most relevant notes.

When an LLM queries your wiki, the plugin performs:
1. **Semantic Search:** Uses local embedding models (e.g., `all-MiniLM-L6-v2`) to find the best entry points (root nodes) based on the meaning of the query.
2. **Graph Traversal (BFS):** Navigates through Obsidian's internal links (both outgoing links and backlinks) to gather contextual knowledge surrounding those entry points.

This ensures the LLM receives highly relevant, interconnected information while remaining extremely token-efficient.

## Comparison with the Parent Plugin

The parent plugin (**Obsidian Local REST API**) provides the foundational infrastructure:
* It sets up the secure (HTTPS) and non-encrypted (HTTP) local web servers.
* It handles authentication (API keys/Bearer tokens) and certificate management.
* It exposes basic endpoints for creating, reading, updating, and deleting raw files in your vault.

This **Second Brain MCP Extension** builds on top of that infrastructure:
* It does **not** manage its own web servers or authentication; it securely registers a new route (`/second-brain-mcp/`) using the parent plugin's API.
* While the parent plugin is designed for general-purpose file manipulation (CRUD operations), this extension is specifically engineered for **AI knowledge retrieval**. It abstracts away raw files and instead provides MCP tools (`query_wiki`, `get_wiki`, `wiki_card`) tailored for agentic workflows, complete with semantic ranking and graph exploration.

## Manual Installation

1. Fork this repository.
2. Update `main.ts` to advertise your new route(s).
3. Build the project with `npm run build` (or `npm run dev` if you are iterating on some changes).
4. Link the plugin into your Obsidian vault's `.obsidian/plugins` directory.  On linux or osx, you can run `ln -s /path/to/your/cloned/fork /path/to/your/vault/.obsidian/plugins`.

## Performance Notes

Due to strict browser security constraints within Obsidian's Electron environment (specifically the disabling of `SharedArrayBuffer`), WebAssembly multi-threading is completely blocked. Furthermore, the Hugging Face WebGPU backend is currently unsupported or highly unstable in this context. Consequently, this plugin is forced to rely on a single CPU core for embedding generation to remain a safe, cross-platform Community Plugin. While the initial indexing of your vault may take some time, all generated embeddings are cached locally, ensuring that all subsequent queries are lightning fast.
