import { Plugin, TFile, PluginSettingTab, Setting, App, FileSystemAdapter, Notice } from "obsidian";
import { getAPI, LocalRestApiPublicApi } from "obsidian-local-rest-api";
import * as crypto from "crypto";

interface SecondBrainPluginSettings {
	modelName: string;
	customModelName: string;
	returnDiagnosticLogs: boolean;
}

const DEFAULT_SETTINGS: SecondBrainPluginSettings = {
	modelName: "Xenova/all-MiniLM-L6-v2",
	customModelName: "",
	returnDiagnosticLogs: false
};

export default class ObsidianLocalRESTAPISecondBrainPlugin extends Plugin {
	private api!: LocalRestApiPublicApi;
	settings!: SecondBrainPluginSettings;
	private extractor: any = null;
	private hnswIndex: any = null;
	private embeddingCache: Map<string, number[]> = new Map();
	private fileHashMap: Map<string, string> = new Map();
	private idToPathMap: Map<number, string> = new Map();
	private initPromise: Promise<void> | null = null;

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	registerRoutes() {
		// Here is how you register your routes:
		//
		// 1. Get an API handle:
		this.api = getAPI(this.app, this.manifest);

		// 2. Add your routes -- `addRoute` returns a route object
		//    https://www.geeksforgeeks.org/express-js-router-route-function/
		//    that you can attach handlers to
		this.api.addRoute("/second-brain-mcp/")
			.get((request, response) => {
				response.status(200).json({
					mcp_server: "second-brain-mcp",
					status: "running",
					transport: "Streamable HTTP (stateless)"
				});
			})
			.post(async (request, response) => {
				try {
					let body = request.body;
					if (typeof body === "string") {
						body = JSON.parse(body);
					} else if (Buffer.isBuffer(body)) {
						body = JSON.parse(body.toString("utf-8"));
					}

					if (!body || typeof body !== "object") {
						return response.status(400).json({
							jsonrpc: "2.0",
							error: {
								code: -32700,
								message: "Parse error"
							},
							id: null
						});
					}

					const { jsonrpc, method, params, id } = body;

					if (jsonrpc !== "2.0") {
						return response.status(400).json({
							jsonrpc: "2.0",
							error: {
								code: -32600,
								message: "Invalid Request: expected jsonrpc: '2.0'"
							},
							id: id || null
						});
					}

					switch (method) {
						case "initialize": {
							return response.status(200).json({
								jsonrpc: "2.0",
								id: id,
								result: {
									protocolVersion: "2024-11-05",
									capabilities: {
										tools: {}
									},
									serverInfo: {
										name: "second-brain-mcp",
										version: "1.0.0"
									}
								}
							});
						}

						case "notifications/initialized": {
							return response.status(204).end();
						}

						case "tools/list": {
							return response.status(200).json({
								jsonrpc: "2.0",
								id: id,
								result: {
									tools: [
										{
											name: "wiki_card",
											description: "Retrieve the scope and capabilities of the knowledge contained in this MCP server.",
											inputSchema: {
												type: "object",
												properties: {}
											}
										},
										{
											name: "query_wiki",
											description: "Query the second brain / wiki",
											inputSchema: {
												type: "object",
												properties: {
													query: {
														type: "string",
														description: "The search query to run against the wiki"
													},
													parent_limit: {
														type: "integer",
														description: "Maximum number of files that should be included from the search (default: 5, -1 for unlimited)"
													},
													child_limit: {
														type: "integer",
														description: "Maximum number of bidirectional connections to include per file (default: 2, -1 for unlimited)"
													}
												},
												required: ["query"]
											}
										},
										{
											name: "get_wiki",
											description: "Retrieve a specific wiki page by its path or filename.",
											inputSchema: {
												type: "object",
												properties: {
													path: {
														type: "string",
														description: "The path or filename of the wiki note (if the extension or folder paths is omitted, the matching will be based on best effort)"
													}
												},
												required: ["path"]
											}
										}
									]
								}
							});
						}

						case "tools/call": {
							if (!params || typeof params !== "object" || (params.name !== "query_wiki" && params.name !== "get_wiki" && params.name !== "wiki_card")) {
								return response.status(400).json({
									jsonrpc: "2.0",
									error: {
										code: -32601,
										message: `Method not found: ${params?.name || method}`
									},
									id: id
								});
							}

							if (params.name === "wiki_card") {
								const debugLogs: string[] = [];
								const logDebug = (msg: string, isError = false) => {
									if (isError) {
										console.error(msg);
									} else {
										console.log(msg);
									}
									debugLogs.push(msg);
								};

								logDebug(`[Second Brain MCP] Initiating wiki_card.`);

								let cardFile: TFile | null = null;

								// 1. Try to find wiki-card.md in the root
								const rootCard = this.app.vault.getAbstractFileByPath("wiki-card.md");
								if (rootCard instanceof TFile) {
									cardFile = rootCard;
								}

								// 2. Try to find any file named wiki-card.md in the vault (case-insensitive)
								if (!cardFile) {
									const allFiles = this.app.vault.getMarkdownFiles();
									for (const f of allFiles) {
										if (f.name.toLowerCase() === "wiki-card.md") {
											cardFile = f;
											break;
										}
									}
								}

								// 3. Fallback: return the first TFile found in the root of the vault
								if (!cardFile) {
									const rootChildren = this.app.vault.getRoot().children;
									for (const child of rootChildren) {
										if (child instanceof TFile) {
											cardFile = child;
											break;
										}
									}
								}

								let yamlResult = "";
								if (cardFile) {
									logDebug(`[Second Brain MCP] Resolved wiki card file: "${cardFile.path}"`);
									const content = await this.app.vault.cachedRead(cardFile);
									yamlResult += `path: ${cardFile.path.replace(/\\/g, "/")}\n`;
									const contentLines = content.split("\n");
									yamlResult += `content: |\n`;
									for (const line of contentLines) {
										yamlResult += `  ${line}\n`;
									}
								} else {
									logDebug(`[Second Brain MCP] No wiki-card.md or root file could be found in the vault.`, true);
									yamlResult = `# No wiki card or root file found\n`;
								}

								if (this.settings.returnDiagnosticLogs) {
									yamlResult += "\n# Diagnostic Logs:\n";
									for (const log of debugLogs) {
										yamlResult += `# - ${log.replace(/\n/g, "\n#   ")}\n`;
									}
								}

								return response.status(200).json({
									jsonrpc: "2.0",
									id: id,
									result: {
										content: [
											{
												type: "text",
												text: yamlResult
											}
										]
									}
								});
							}

							if (params.name === "get_wiki") {
								const pathInput = params.arguments?.path;
								if (typeof pathInput !== "string") {
									return response.status(400).json({
										jsonrpc: "2.0",
										error: {
											code: -32602,
											message: "Invalid params: path must be a string"
										},
										id: id
									});
								}

								const debugLogs: string[] = [];
								const logDebug = (msg: string, isError = false) => {
									if (isError) {
										console.error(msg);
									} else {
										console.log(msg);
									}
									debugLogs.push(msg);
								};

								logDebug(`[Second Brain MCP] Initiating get_wiki. Path input: "${pathInput}"`);

								const file = this.resolveWikiFile(pathInput);
								if (!file) {
									logDebug(`[Second Brain MCP] Wiki file not found for path input: "${pathInput}"`, true);
									let errorYaml = `# Wiki page not found: ${pathInput}\n`;
									if (this.settings.returnDiagnosticLogs) {
										errorYaml += "\n# Diagnostic Logs:\n";
										for (const log of debugLogs) {
											errorYaml += `# - ${log.replace(/\n/g, "\n#   ")}\n`;
										}
									}
									return response.status(200).json({
										jsonrpc: "2.0",
										id: id,
										result: {
											content: [
												{
													type: "text",
													text: errorYaml
												}
											]
										}
									});
								}

								logDebug(`[Second Brain MCP] Successfully resolved wiki file: "${file.path}"`);
								const fileContent = await this.app.vault.cachedRead(file);

								let yamlResult = `path: ${file.path.replace(/\\/g, "/")}\n`;
								const contentLines = fileContent.split("\n");
								yamlResult += `content: |\n`;
								for (const line of contentLines) {
									yamlResult += `  ${line}\n`;
								}

								if (this.settings.returnDiagnosticLogs) {
									yamlResult += "\n# Diagnostic Logs:\n";
									for (const log of debugLogs) {
										yamlResult += `# - ${log.replace(/\n/g, "\n#   ")}\n`;
									}
								}

								return response.status(200).json({
									jsonrpc: "2.0",
									id: id,
									result: {
										content: [
											{
												type: "text",
												text: yamlResult
											}
										]
									}
								});
							}

							// Otherwise, query_wiki
							const query = params.arguments?.query;
							const parent_limit = typeof params.arguments?.parent_limit === "number" ? params.arguments.parent_limit : 5;
							const child_limit = typeof params.arguments?.child_limit === "number" ? params.arguments.child_limit : 2;

							if (typeof query !== "string") {
								return response.status(400).json({
									jsonrpc: "2.0",
									error: {
										code: -32602,
										message: "Invalid params: query must be a string"
									},
									id: id
								});
							}

							const debugLogs: string[] = [];
							const logDebug = (msg: string, isError = false) => {
								if (isError) {
									console.error(msg);
								} else {
									console.log(msg);
								}
								debugLogs.push(msg);
							};

							logDebug(`[Second Brain MCP] Initiating query_wiki. Query: "${query}", parent_limit: ${parent_limit}, child_limit: ${child_limit}`);

							// Ensure search engine is initialized
							let searchEngineReady = false;
							try {
								await this.initializeSearchEngine(logDebug);
								searchEngineReady = true;
							} catch (err) {
								logDebug(`[Second Brain MCP] Failed to initialize semantic search engine. Error: ${err}`, true);
							}

							logDebug(`[Second Brain MCP] Search engine status: searchEngineReady = ${searchEngineReady}, cacheSize = ${this.embeddingCache.size}, hasHnswIndex = ${!!this.hnswIndex}`);

							// Pre-generate query embedding
							let queryEmbedding: number[] = [];
							if (searchEngineReady) {
								try {
									queryEmbedding = await this.generateEmbedding(query);
									logDebug(`[Second Brain MCP] Generated query embedding. Length: ${queryEmbedding.length}, HasNaNs: ${queryEmbedding.some(isNaN)}`);
								} catch (err) {
									logDebug(`[Second Brain MCP] Error generating query embedding: ${err}`, true);
								}
							}

							const matchedParents: TFile[] = [];

							if (searchEngineReady && this.hnswIndex && queryEmbedding.length > 0) {
								// HNSW vector search for parent nodes
								const k = parent_limit === -1 ? this.embeddingCache.size : parent_limit;
								logDebug(`[Second Brain MCP] Running HNSW vector search with k = ${k}`);
								if (k > 0) {
									const searchResults = this.hnswIndex.searchKNN(queryEmbedding, k);
									logDebug(`[Second Brain MCP] HNSW raw search results (KNN count: ${searchResults.length}): ${JSON.stringify(searchResults)}`);
									for (const res of searchResults) {
										const path = this.idToPathMap.get(res.id);
										logDebug(`[Second Brain MCP] HNSW Raw Match: id=${res.id}, dist=${res.dist}, path="${path}"`);
										if (path) {
											const file = this.app.vault.getAbstractFileByPath(path);
											if (file instanceof TFile) {
												matchedParents.push(file);
											} else {
												logDebug(`[Second Brain MCP] Path "${path}" is not a TFile.`);
											}
										}
									}
								}
								logDebug(`[Second Brain MCP] Semantic search matched ${matchedParents.length} parent nodes.`);
							} else {
								logDebug("[Second Brain MCP] HNSW Index or Query Embedding not ready, search returning 0 matches.", true);
							}

							interface SearchResultItem {
								path: string;
								content: string;
								connections: { path: string; content: string }[];
							}
							const matchedFiles: SearchResultItem[] = [];

							for (const file of matchedParents) {
								const fileContent = await this.app.vault.cachedRead(file);
								const parentPath = file.path;

								// Gather bidirectional links for this file
								const resolvedLinks = this.app.metadataCache.resolvedLinks;

								// 1. Outgoing links
								const outgoingPaths = Object.keys(resolvedLinks[parentPath] || {});

								// 2. Incoming backlinks
								const backlinkPaths: string[] = [];
								for (const [sourcePath, destinations] of Object.entries(resolvedLinks)) {
									if (destinations[parentPath]) {
										backlinkPaths.push(sourcePath);
									}
								}

								// 3. Unique set of connection paths
								const uniqueConnPaths = Array.from(new Set([...outgoingPaths, ...backlinkPaths]));

								// Filter connections to scope (must be in wiki/ and not index.md / log.md)
								const validConnFiles: TFile[] = [];
								for (const connPath of uniqueConnPaths) {
									const normalizedConnPath = connPath.replace(/\\/g, "/");
									const normalizedConnPathLower = normalizedConnPath.toLowerCase();

									if (!normalizedConnPathLower.startsWith("wiki/")) {
										continue;
									}
									if (normalizedConnPathLower === "wiki/index.md" || normalizedConnPathLower === "wiki/log.md") {
										continue;
									}

									const connFile = this.app.vault.getAbstractFileByPath(connPath);
									if (connFile instanceof TFile) {
										validConnFiles.push(connFile);
									}
								}

								logDebug(`[Second Brain MCP] Parent document: "${parentPath}". Found ${uniqueConnPaths.length} unique connections, of which ${validConnFiles.length} are in-scope files.`);

								// Apply semantic similarity ranking to children if child_limit !== -1
								let selectedConns: TFile[] = [];
								if (child_limit === -1) {
									logDebug(`[Second Brain MCP] child_limit is -1 (unlimited). Returning all ${validConnFiles.length} child connections without ranking.`);
									selectedConns = validConnFiles;
								} else if (searchEngineReady && queryEmbedding.length > 0) {
									logDebug(`[Second Brain MCP] Calculating semantic similarity for child connections against query embedding.`);
									const scoredConns = await Promise.all(
										validConnFiles.map(async (connFile) => {
											const normalizedConnPath = connFile.path.replace(/\\/g, "/");
											let connEmbedding = this.embeddingCache.get(normalizedConnPath);

											if (!connEmbedding) {
												try {
													const connContent = await this.app.vault.cachedRead(connFile);
													const strippedConn = stripFrontmatter(connContent);
													connEmbedding = await this.generateEmbedding(strippedConn);
													this.embeddingCache.set(normalizedConnPath, connEmbedding);
												} catch (err) {
													connEmbedding = new Array(queryEmbedding.length).fill(0);
												}
											}

											const score = dotProduct(queryEmbedding, connEmbedding!);
											logDebug(`[Second Brain MCP] Connection Similarity: "${normalizedConnPath}" -> Score: ${score.toFixed(4)}`);
											return { connFile, score };
										})
									);

									// Sort descending by score
									scoredConns.sort((a, b) => b.score - a.score);
									logDebug(`[Second Brain MCP] Sorted child connections: ${scoredConns.map(item => `${item.connFile.path} (${item.score.toFixed(4)})`).join(", ")}`);
									selectedConns = scoredConns.slice(0, child_limit).map(item => item.connFile);
								} else {
									logDebug(`[Second Brain MCP] Bypassing semantic connection ranking (searchEngineReady=${searchEngineReady}, child_limit=${child_limit}). Selecting first ${child_limit} files.`);
									selectedConns = validConnFiles.slice(0, child_limit);
								}

								// Map selected connections to paths/contents
								const connections: { path: string; content: string }[] = [];
								for (const connFile of selectedConns) {
									const connContent = await this.app.vault.cachedRead(connFile);
									connections.push({
										path: connFile.path.replace(/\\/g, "/"),
										content: connContent
									});
								}

								matchedFiles.push({
									path: file.path.replace(/\\/g, "/"),
									content: fileContent,
									connections: connections
								});
							}

							let yamlResult = "";
							for (const item of matchedFiles) {
								yamlResult += `- path: ${item.path}\n`;

								const contentLines = item.content.split("\n");
								yamlResult += `  content: |\n`;
								for (const line of contentLines) {
									yamlResult += `    ${line}\n`;
								}

								if (item.connections.length > 0) {
									yamlResult += `  connections:\n`;
									for (const conn of item.connections) {
										yamlResult += `    - path: ${conn.path}\n`;
										const connLines = conn.content.split("\n");
										yamlResult += `      content: |\n`;
										for (const line of connLines) {
											yamlResult += `        ${line}\n`;
										}
									}
								}
							}

							if (yamlResult === "") {
								yamlResult = "# No matching files found\n";
							}

							// Append diagnostic logs to the YAML output if enabled
							if (this.settings.returnDiagnosticLogs) {
								yamlResult += "\n# Diagnostic Logs:\n";
								for (const log of debugLogs) {
									yamlResult += `# - ${log.replace(/\n/g, "\n#   ")}\n`;
								}
							}

							return response.status(200).json({
								jsonrpc: "2.0",
								id: id,
								result: {
									content: [
										{
											type: "text",
											text: yamlResult
										}
									]
								}
							});
						}

						case "ping": {
							return response.status(200).json({
								jsonrpc: "2.0",
								id: id,
								result: {}
							});
						}

						default: {
							if (method.endsWith("/list")) {
								return response.status(200).json({
									jsonrpc: "2.0",
									id: id,
									result: {
										[method.split("/")[0]]: []
									}
								});
							}

							return response.status(404).json({
								jsonrpc: "2.0",
								error: {
									code: -32601,
									message: `Method not found: ${method}`
								},
								id: id
							});
						}
					}

				} catch (error) {
					console.error("MCP Server Error:", error);
					return response.status(500).json({
						jsonrpc: "2.0",
						error: {
							code: -32603,
							message: error instanceof Error ? error.message : "Internal error"
						},
						id: null
					});
				}
			});

		// For more insight into what you can put into a route, have
		// a look at the existing routes that are handled by
		// the API itself: https://github.com/coddingtonbear/obsidian-local-rest-api/blob/main/src/requestHandler.ts
	}

	//
	//
	//
	//
	// Everything below this point can be left as it is -- this is just
	// setting up machinery to properly register your routes with
	// Obsidian Local REST API
	//
	//
	//
	//

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new ObsidianLocalRESTAPISecondBrainSettingsTab(this.app, this));

		this.initializeSearchEngine().catch((err) => {
			console.error("[Second Brain MCP] Initial search engine startup failed:", err);
		});

		if (this.app.plugins.enabledPlugins.has("obsidian-local-rest-api")) {
			this.registerRoutes();
		}

		this.registerEvent(
			this.app.workspace.on(
				"obsidian-local-rest-api:loaded",
				this.registerRoutes.bind(this)
			)
		);

		this.registerEvent(
			this.app.vault.on("modify", async (file) => {
				if (file instanceof TFile) {
					await this.updateFileEmbedding(file);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", async (file) => {
				await this.onFileDeleted(file.path);
			})
		);
	}

	onunload() {
		if (this.api) {
			(this.api as any).unregister();
		}
	}

	async reinitializeSearchEngine() {
		this.extractor = null;
		this.hnswIndex = null;
		this.embeddingCache.clear();
		this.fileHashMap.clear();
		this.idToPathMap.clear();
		this.initPromise = null;
		await this.initializeSearchEngine();
	}

	async initializeSearchEngine(logFn?: (msg: string, isError?: boolean) => void) {
		const localLog = logFn || ((msg: string, isError?: boolean) => isError ? console.error(msg) : console.log(msg));

		if (this.initPromise) {
			return this.initPromise;
		}

		this.initPromise = (async () => {
			try {
				const modelToLoad = this.settings.modelName === "custom"
					? this.settings.customModelName
					: this.settings.modelName;

				if (!modelToLoad) {
					localLog("[Second Brain MCP] No embedding model configured yet.");
					return;
				}

				localLog(`[Second Brain MCP] Initializing search engine with model: ${modelToLoad}`);

				// Load @huggingface/transformers using Node's require with an absolute path resolved from vault
				const pathObj = require("path");
				let tfModulePath = "";
				const adapter = this.app.vault.adapter;
				if (adapter instanceof FileSystemAdapter) {
					const basePath = adapter.getBasePath();
					tfModulePath = pathObj.join(basePath, ".obsidian", "plugins", this.manifest.id, "node_modules", "@huggingface/transformers");
				} else {
					tfModulePath = "@huggingface/transformers";
				}
				localLog(`[Second Brain MCP] Requiring @huggingface/transformers from absolute path: ${tfModulePath}`);
				const tfModule = require(tfModulePath);
				localLog(`[Second Brain MCP] tfModule keys: ${Object.keys(tfModule).join(", ")}`);

				const pipeline = tfModule.pipeline || (tfModule as any).default?.pipeline;
				const env = tfModule.env || (tfModule as any).default?.env;

				if (!pipeline) {
					throw new Error("Failed to resolve 'pipeline' from @huggingface/transformers module.");
				}

				if (env) {
					try {
						// Configure env to disable local filesystem models
						env.allowLocalModels = false;
						if (env.backends?.onnx?.wasm) {
							env.backends.onnx.wasm.numThreads = 1;
						}
						localLog("[Second Brain MCP] Transformers env successfully configured.");
					} catch (envErr) {
						localLog(`[Second Brain MCP] Warning configuring Transformers env: ${envErr}`, true);
					}
				} else {
					localLog("[Second Brain MCP] Warning: 'env' object not found in @huggingface/transformers module, skipping environment override.", true);
				}

				// Load feature-extraction pipeline
				this.extractor = await pipeline("feature-extraction", modelToLoad);
				localLog("[Second Brain MCP] Transformer model loaded successfully.");

				// Pre-index all files
				await this.indexAllFiles(logFn);
				localLog("[Second Brain MCP] Search engine initialization complete.");
			} catch (err) {
				localLog(`[Second Brain MCP] Failed to initialize search engine: ${err}`, true);
				this.initPromise = null; // Let it retry next time
				throw err;
			}
		})();

		return this.initPromise;
	}

	async indexAllFiles(logFn?: (msg: string, isError?: boolean) => void) {
		const localLog = logFn || ((msg: string, isError?: boolean) => isError ? console.error(msg) : console.log(msg));
		const allFiles = this.app.vault.getMarkdownFiles();
		this.embeddingCache.clear();
		this.fileHashMap.clear();

		localLog(`[Second Brain MCP] Indexing all ${allFiles.length} files in the vault.`);

		const diskCache = await this.loadEmbeddingCache();
		let cacheHitCount = 0;
		let cacheMissCount = 0;

		for (const file of allFiles) {
			const normalizedPath = file.path.replace(/\\/g, "/");
			const normalizedPathLower = normalizedPath.toLowerCase();

			if (!normalizedPathLower.startsWith("wiki/")) {
				continue;
			}
			if (normalizedPathLower === "wiki/index.md" || normalizedPathLower === "wiki/log.md") {
				continue;
			}

			try {
				const content = await this.app.vault.cachedRead(file);
				const stripped = stripFrontmatter(content);
				const fileHash = crypto.createHash("md5").update(stripped).digest("hex");

				// Try to load from disk cache first using file content MD5 hash integrity check
				if (diskCache && diskCache[normalizedPath] && diskCache[normalizedPath].hash === fileHash) {
					this.embeddingCache.set(normalizedPath, diskCache[normalizedPath].vector);
					this.fileHashMap.set(normalizedPath, fileHash);
					cacheHitCount++;
					continue;
				}

				// Cache miss: generate embedding
				const embedding = await this.generateEmbedding(stripped);
				this.embeddingCache.set(normalizedPath, embedding);
				this.fileHashMap.set(normalizedPath, fileHash);
				cacheMissCount++;
			} catch (err) {
				localLog(`[Second Brain MCP] Error indexing file ${file.path}: ${err}`, true);
			}
		}

		localLog(`[Second Brain MCP] Vault indexing finished. Cache hits: ${cacheHitCount}, Cache misses (recalculated): ${cacheMissCount}.`);

		// Rebuild HNSW index
		await this.rebuildHNSWIndex(logFn);

		// If there were any misses (new/modified files), save the updated cache to disk
		if (cacheMissCount > 0) {
			await this.saveEmbeddingCache();
		}
	}

	async generateEmbedding(text: string): Promise<number[]> {
		if (!this.extractor) {
			throw new Error("Extractor is not initialized");
		}
		// Empty strings can cause model issues, use a fallback
		const queryText = text.trim() === "" ? "empty" : text;
		const output = await this.extractor(queryText, { pooling: "mean", normalize: true });
		return Array.from(output.data as Float32Array);
	}

	async rebuildHNSWIndex(logFn?: (msg: string, isError?: boolean) => void) {
		const localLog = logFn || ((msg: string, isError?: boolean) => isError ? console.error(msg) : console.log(msg));
		this.idToPathMap.clear();
		const HNSWClass = (await import("hnsw")).HNSW;

		// Auto-detect dimension from caching embeddings, fallback to 384
		let dimension = 384;
		if (this.embeddingCache.size > 0) {
			const firstVal = this.embeddingCache.values().next().value;
			if (firstVal) {
				dimension = firstVal.length;
			}
		}

		// new HNSW(M, efConstruction, d, metric, efSearch)
		this.hnswIndex = new HNSWClass(16, 200, dimension, "cosine", 50);

		const data: { id: number; vector: number[] }[] = [];
		let indexCounter = 0;

		for (const [path, vector] of this.embeddingCache.entries()) {
			const id = indexCounter++;
			this.idToPathMap.set(id, path);
			data.push({ id, vector });
		}

		if (data.length > 0) {
			await this.hnswIndex.buildIndex(data);
		}
		localLog(`[Second Brain MCP] HNSW Index rebuilt with ${data.length} documents.`);
	}

	async updateFileEmbedding(file: TFile) {
		const normalizedPath = file.path.replace(/\\/g, "/");
		const normalizedPathLower = normalizedPath.toLowerCase();

		if (!normalizedPathLower.startsWith("wiki/")) {
			return;
		}
		if (normalizedPathLower === "wiki/index.md" || normalizedPathLower === "wiki/log.md") {
			return;
		}

		try {
			if (!this.extractor) return;

			const content = await this.app.vault.cachedRead(file);
			const stripped = stripFrontmatter(content);
			const fileHash = crypto.createHash("md5").update(stripped).digest("hex");

			// Skip re-calculation if the content has not changed
			if (this.fileHashMap.get(normalizedPath) === fileHash) {
				return;
			}

			const embedding = await this.generateEmbedding(stripped);
			this.embeddingCache.set(normalizedPath, embedding);
			this.fileHashMap.set(normalizedPath, fileHash);
			await this.rebuildHNSWIndex();
			await this.saveEmbeddingCache();
		} catch (err) {
			console.error(`[Second Brain MCP] Error updating embedding for ${file.path}:`, err);
		}
	}

	async onFileDeleted(path: string) {
		const normalizedPath = path.replace(/\\/g, "/");
		if (this.embeddingCache.delete(normalizedPath)) {
			await this.rebuildHNSWIndex();
			await this.saveEmbeddingCache();
		}
	}

	async loadEmbeddingCache(): Promise<Record<string, { hash: string; vector: number[] }> | null> {
		const cachePath = `.obsidian/plugins/${this.manifest.id}/embeddings-cache.json`;
		const adapter = this.app.vault.adapter;

		if (!(await adapter.exists(cachePath))) {
			return null;
		}

		try {
			const cacheContent = await adapter.read(cachePath);
			const parsed = JSON.parse(cacheContent);

			const modelToLoad = this.settings.modelName === "custom"
				? this.settings.customModelName
				: this.settings.modelName;

			if (parsed.modelName === modelToLoad && parsed.embeddings) {
				return parsed.embeddings;
			}
		} catch (err) {
			console.error("[Second Brain MCP] Failed to load embeddings cache from disk:", err);
		}
		return null;
	}

	async saveEmbeddingCache() {
		const cachePath = `.obsidian/plugins/${this.manifest.id}/embeddings-cache.json`;
		const adapter = this.app.vault.adapter;

		const modelToLoad = this.settings.modelName === "custom"
			? this.settings.customModelName
			: this.settings.modelName;

		const serializedEmbeddings: Record<string, { hash: string; vector: number[] }> = {};

		for (const [path, vector] of this.embeddingCache.entries()) {
			const hash = this.fileHashMap.get(path) || "";
			serializedEmbeddings[path] = {
				hash,
				vector
			};
		}

		try {
			const payload = {
				modelName: modelToLoad,
				embeddings: serializedEmbeddings
			};
			await adapter.write(cachePath, JSON.stringify(payload, null, 2));
		} catch (err) {
			console.error("[Second Brain MCP] Failed to save embeddings cache to disk:", err);
		}
	}

	resolveWikiFile(pathInput: string): TFile | null {
		const normalizedInput = pathInput.replace(/\\/g, "/");

		// 1. Try Obsidian's native link resolver
		let file = this.app.metadataCache.getFirstLinkpathDest(normalizedInput, "");
		if (file instanceof TFile) return file;

		// 2. Try raw vault paths
		let abstractFile = this.app.vault.getAbstractFileByPath(normalizedInput);
		if (abstractFile instanceof TFile) return abstractFile;

		abstractFile = this.app.vault.getAbstractFileByPath(normalizedInput + ".md");
		if (abstractFile instanceof TFile) return abstractFile;

		// 3. Fallback: Search all markdown files for a path suffix or filename match
		const allMarkdown = this.app.vault.getMarkdownFiles();
		const inputLower = normalizedInput.toLowerCase();
		const inputLowerNoExt = inputLower.endsWith(".md") ? inputLower.slice(0, -3) : inputLower;

		// Match suffix (e.g. "sources/peaa-030-miscellaneous-points" matching "wiki/sources/peaa-030-miscellaneous-points.md")
		for (const f of allMarkdown) {
			const fPathLower = f.path.replace(/\\/g, "/").toLowerCase();
			const fPathLowerNoExt = fPathLower.endsWith(".md") ? fPathLower.slice(0, -3) : fPathLower;

			if (fPathLower === inputLower || fPathLowerNoExt === inputLowerNoExt) {
				return f;
			}
			if (fPathLower.endsWith("/" + inputLower) || fPathLowerNoExt.endsWith("/" + inputLowerNoExt)) {
				return f;
			}
		}

		// Match exact filename (e.g. "peaa-030-miscellaneous-points" matching "wiki/sources/peaa-030-miscellaneous-points.md")
		const inputFilename = normalizedInput.substring(normalizedInput.lastIndexOf("/") + 1).toLowerCase();
		const inputFilenameNoExt = inputFilename.endsWith(".md") ? inputFilename.slice(0, -3) : inputFilename;
		for (const f of allMarkdown) {
			const fNameLower = f.name.toLowerCase();
			const fNameLowerNoExt = fNameLower.endsWith(".md") ? fNameLower.slice(0, -3) : fNameLower;

			if (fNameLower === inputFilename || fNameLowerNoExt === inputFilenameNoExt) {
				return f;
			}
		}

		return null;
	}
}

class ObsidianLocalRESTAPISecondBrainSettingsTab extends PluginSettingTab {
	plugin: ObsidianLocalRESTAPISecondBrainPlugin;

	constructor(app: App, plugin: ObsidianLocalRESTAPISecondBrainPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Second Brain MCP Settings" });

		new Setting(containerEl)
			.setName("Embedding Model")
			.setDesc("Select the local model used to generate embeddings.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("Xenova/all-MiniLM-L6-v2", "all-MiniLM-L6-v2 (Light, 384 dim)")
					.addOption("Xenova/bge-small-en-v1.5", "bge-small-en-v1.5 (High Accuracy English, 384 dim)")
					.addOption("nomic-ai/nomic-embed-text-v1.5", "nomic-embed-text-v1.5 (Large Context, 768 dim)")
					.addOption("custom", "Custom Model Path (Specify Below)")
					.setValue(this.plugin.settings.modelName)
					.onChange(async (value) => {
						const prevModel = this.plugin.settings.modelName;
						this.plugin.settings.modelName = value;
						await this.plugin.saveSettings();
						this.display(); // re-render to toggle custom path field visibility

						if (prevModel !== value && value !== "custom") {
							await this.plugin.reinitializeSearchEngine();
						}
					})
			);

		new Setting(containerEl)
			.setName("Return Diagnostic Logs")
			.setDesc("Include detailed execution logs in the tool response.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.returnDiagnosticLogs)
					.onChange(async (value) => {
						this.plugin.settings.returnDiagnosticLogs = value;
						await this.plugin.saveSettings();
					})
			);

		if (this.plugin.settings.modelName === "custom") {
			new Setting(containerEl)
				.setName("Custom Model Path")
				.setDesc("Enter the Hugging Face model path (e.g. Xenova/all-MiniLM-L6-v2).")
				.addText((text) =>
					text
						.setPlaceholder("Enter model path")
						.setValue(this.plugin.settings.customModelName)
						.onChange(async (value) => {
							this.plugin.settings.customModelName = value.trim();
						})
				)
				.addButton((button) =>
					button
						.setButtonText("Apply & Reload")
						.setCta()
						.onClick(async () => {
							await this.plugin.saveSettings();
							await this.plugin.reinitializeSearchEngine();
						})
				);
		}

		containerEl.createEl("h3", { text: "Cache Management" });

		new Setting(containerEl)
			.setName("Clear Embeddings Cache")
			.setDesc("Delete the stored embedding vectors from disk. The next semantic search query will re-index your files.")
			.addButton((button) =>
				button
					.setButtonText("Clear Cache")
					.setWarning()
					.onClick(async () => {
						const cachePath = `.obsidian/plugins/${this.plugin.manifest.id}/embeddings-cache.json`;
						const adapter = this.plugin.app.vault.adapter;
						try {
							if (await adapter.exists(cachePath)) {
								await adapter.remove(cachePath);
							}
							await this.plugin.reinitializeSearchEngine();
							new Notice("Embeddings cache successfully cleared!");
						} catch (err) {
							console.error("[Second Brain MCP] Failed to clear embeddings cache:", err);
							new Notice("Failed to clear embeddings cache: " + err);
						}
					})
			);
	}
}

function stripFrontmatter(content: string): string {
	const trimmed = content.trim();
	if (trimmed.startsWith("---")) {
		const nextDashIndex = trimmed.indexOf("---", 3);
		if (nextDashIndex !== -1) {
			return trimmed.substring(nextDashIndex + 3).trim();
		}
	}
	return trimmed;
}

function dotProduct(a: number[], b: number[]): number {
	let sum = 0;
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		sum += a[i] * b[i];
	}
	return sum;
}

declare module "obsidian" {
	interface App {
		plugins: {
			enabledPlugins: Set<string>;
		};
	}
	interface Workspace {
		on(
			name: "obsidian-local-rest-api:loaded",
			callback: () => void,
			ctx?: any
		): EventRef;
	}
}
